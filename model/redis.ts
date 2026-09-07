import { Redis } from "@upstash/redis";
import type { Redis as RedisClient } from "@upstash/redis";
import type {
  RedisGetString,
  RedisSetString,
  RedisSetExpiryString,
  RedisZAddPayload,
  RedisZRangePayload,
  RedisLPushPayload,
  RedisLRangePayload,
  RedisHSetPayload,
  RedisHGetPayload,
  RedisSAddPayload,
  RedisSPopPayload,
} from "./model.js";
import { logger } from "../utils/logger.js";

/**
 * In-memory stand-in for Upstash, used when UPSTASH_REDIS_REST_URL/TOKEN are
 * not configured (local dev, tests). Keeps the whole app functional without a
 * Redis connection — sessions, caches, and dedup sets just live in-process
 * and are lost on restart, which is the correct trade-off for dev.
 */
class MemoryStore {
  private strings = new Map<string, { value: string; expiresAt: number | null }>();
  private zsets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();

  private alive(entry: { value: string; expiresAt: number | null } | undefined): string | null {
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) return null;
    return entry.value;
  }

  get(key: string): string | null {
    return this.alive(this.strings.get(key));
  }

  set(key: string, value: string): void {
    this.strings.set(key, { value, expiresAt: null });
  }

  setWithExpiry(key: string, value: string, expirySeconds: number): void {
    this.strings.set(key, { value, expiresAt: Date.now() + expirySeconds * 1000 });
  }

  delete(key: string): void {
    this.strings.delete(key);
    this.zsets.delete(key);
    this.lists.delete(key);
    this.hashes.delete(key);
    this.sets.delete(key);
  }

  increment(key: string): number {
    const current = Number(this.get(key) ?? "0");
    const next = (Number.isFinite(current) ? current : 0) + 1;
    this.set(key, String(next));
    return next;
  }

  zadd(key: string, score: number, member: string): void {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    zset.set(member, score);
  }

  zrange(key: string, start: number, stop: number): string[] {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const normalizedStart = start < 0 ? Math.max(sorted.length + start, 0) : start;
    const normalizedStop = stop < 0 ? sorted.length + stop + 1 : Math.min(stop + 1, sorted.length);
    return sorted.slice(normalizedStart, normalizedStop);
  }

  zrem(key: string, member: string): void {
    this.zsets.get(key)?.delete(member);
  }

  lpush(key: string, value: string): void {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
  }

  lrange(key: string, start: number, stop: number): string[] {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);
  }

  lrem(key: string, count: number, value: string): void {
    const list = this.lists.get(key) ?? [];
    const removals = count === 0 ? list.length : Math.abs(count);
    for (let i = 0; i < removals; i++) {
      const idx = list.indexOf(value);
      if (idx === -1) break;
      list.splice(idx, 1);
    }
    this.lists.set(key, list);
  }

  hset(key: string, field: string, value: string): void {
    const hash = this.hashes.get(key) ?? new Map();
    hash.set(field, value);
    this.hashes.set(key, hash);
  }

  hget(key: string, field: string): string | null {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  hgetall(key: string): Record<string, string> | null {
    const hash = this.hashes.get(key);
    if (!hash || hash.size === 0) return null;
    return Object.fromEntries(hash);
  }

  hdel(key: string, field: string): void {
    this.hashes.get(key)?.delete(field);
  }

  sadd(key: string, member: string): void {
    const set = this.sets.get(key) ?? new Set();
    set.add(member);
    this.sets.set(key, set);
  }

  spop(key: string, count: number): string[] {
    const set = this.sets.get(key);
    if (!set) return [];
    const popped: string[] = [];
    for (const member of set) {
      if (popped.length >= count) break;
      popped.push(member);
      set.delete(member);
    }
    return popped;
  }

  smembers(key: string): string[] {
    return [...(this.sets.get(key) ?? [])];
  }

  sismember(key: string, member: string): boolean {
    return this.sets.get(key)?.has(member) ?? false;
  }

  srem(key: string, member: string): void {
    this.sets.get(key)?.delete(member);
  }

  scard(key: string): number {
    return this.sets.get(key)?.size ?? 0;
  }
}

const memoryStore = new MemoryStore();

class RedisModel {
  private client: RedisClient | null;
  /** True when no Upstash env is configured — all ops hit the in-process store. */
  readonly isMemoryOnly: boolean;
  /** Circuit breaker: after a client failure, ops go to memory for this long
   * so a unreachable Redis doesn't add multi-second timeouts to every call. */
  private static BREAKER_MS = 30_000;
  private breakerUntil = 0;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    this.isMemoryOnly = !url || !token;
    if (this.isMemoryOnly) {
      logger.warn("[Redis] UPSTASH_REDIS_REST_URL/TOKEN not set — using in-memory store (data lost on restart)");
      this.client = null;
    } else {
      this.client = new Redis({ url, token });
    }
  }

  /** Run a client op; on failure or open breaker, fall back to memory. */
  private async viaClient<T>(op: () => Promise<T>, fallback: () => T, label: string): Promise<T> {
    if (!this.client || Date.now() < this.breakerUntil) {
      return fallback();
    }
    try {
      return await op();
    } catch (e) {
      this.breakerUntil = Date.now() + RedisModel.BREAKER_MS;
      logger.error(`[Redis] ${label} failed (${String(e).slice(0, 120)}) — degrading to in-memory for ${RedisModel.BREAKER_MS / 1000}s`);
      return fallback();
    }
  }

  // ── Strings ─────────────────────────────────────────────────

  async get(payload: RedisGetString): Promise<string | null> {
    return this.viaClient(
      async () => {
        const val = await this.client!.get(payload.key);
        if (val == null) return null;
        // Upstash auto-deserializes JSON — stringify back so callers can JSON.parse()
        return typeof val === "string" ? val : JSON.stringify(val);
      },
      () => memoryStore.get(payload.key),
      `get ${payload.key}`,
    );
  }

  async set(payload: RedisSetString): Promise<boolean> {
    return this.viaClient(
      () => this.client!.set(payload.key, payload.value).then(() => true),
      () => { memoryStore.set(payload.key, payload.value); return true; },
      `set ${payload.key}`,
    );
  }

  async setWithExpiry(payload: RedisSetExpiryString): Promise<boolean> {
    return this.viaClient(
      () => this.client!.set(payload.key, payload.value, { ex: payload.expiry }).then(() => true),
      () => { memoryStore.setWithExpiry(payload.key, payload.value, payload.expiry); return true; },
      `setWithExpiry ${payload.key}`,
    );
  }

  async delete(key: string): Promise<boolean> {
    return this.viaClient(
      () => this.client!.del(key).then(() => true),
      () => { memoryStore.delete(key); return true; },
      `del ${key}`,
    );
  }

  async increment(key: string): Promise<number | null> {
    return this.viaClient(
      () => this.client!.incr(key),
      () => memoryStore.increment(key),
      `incr ${key}`,
    );
  }

  // ── Sorted Sets ─────────────────────────────────────────────

  async zadd(payload: RedisZAddPayload): Promise<boolean> {
    return this.viaClient(
      () => this.client!.zadd(payload.key, { score: payload.score, member: payload.member }).then(() => true),
      () => { memoryStore.zadd(payload.key, payload.score, payload.member); return true; },
      `zadd ${payload.key}`,
    );
  }

  async zrange(payload: RedisZRangePayload): Promise<string[]> {
    return this.viaClient(
      async () => (await this.client!.zrange(payload.key, payload.start, payload.stop)) as string[],
      () => memoryStore.zrange(payload.key, payload.start, payload.stop),
      `zrange ${payload.key}`,
    );
  }

  async zrem(key: string, member: string): Promise<boolean> {
    return this.viaClient(
      () => this.client!.zrem(key, member).then(() => true),
      () => { memoryStore.zrem(key, member); return true; },
      `zrem ${key}`,
    );
  }

  // ── Lists ───────────────────────────────────────────────────

  async lpush(payload: RedisLPushPayload): Promise<boolean> {
    return this.viaClient(
      () => this.client!.lpush(payload.key, payload.value).then(() => true),
      () => { memoryStore.lpush(payload.key, payload.value); return true; },
      `lpush ${payload.key}`,
    );
  }

  async lrange(payload: RedisLRangePayload): Promise<string[]> {
    return this.viaClient(
      async () => await this.client!.lrange(payload.key, payload.start, payload.stop),
      () => memoryStore.lrange(payload.key, payload.start, payload.stop),
      `lrange ${payload.key}`,
    );
  }

  async lrem(key: string, count: number, value: string): Promise<boolean> {
    return this.viaClient(
      () => this.client!.lrem(key, count, value).then(() => true),
      () => { memoryStore.lrem(key, count, value); return true; },
      `lrem ${key}`,
    );
  }

  // ── Hashes ──────────────────────────────────────────────────

  async hset(payload: RedisHSetPayload): Promise<boolean> {
    return this.viaClient(
      () => this.client!.hset(payload.key, { [payload.field]: payload.value }).then(() => true),
      () => { memoryStore.hset(payload.key, payload.field, payload.value); return true; },
      `hset ${payload.key}`,
    );
  }

  async hget(payload: RedisHGetPayload): Promise<string | null> {
    return this.viaClient(
      () => this.client!.hget<string>(payload.key, payload.field),
      () => memoryStore.hget(payload.key, payload.field),
      `hget ${payload.key}`,
    );
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    return this.viaClient(
      () => this.client!.hgetall<Record<string, string>>(key),
      () => memoryStore.hgetall(key),
      `hgetall ${key}`,
    );
  }

  async hdel(key: string, field: string): Promise<boolean> {
    return this.viaClient(
      () => this.client!.hdel(key, field).then(() => true),
      () => { memoryStore.hdel(key, field); return true; },
      `hdel ${key}`,
    );
  }

  // ── Sets ────────────────────────────────────────────────────

  async sadd(payload: RedisSAddPayload): Promise<boolean> {
    return this.viaClient(
      () => this.client!.sadd(payload.key, payload.member).then(() => true),
      () => { memoryStore.sadd(payload.key, payload.member); return true; },
      `sadd ${payload.key}`,
    );
  }

  async spop(payload: RedisSPopPayload): Promise<string | string[] | null> {
    const count = payload.count ?? 1;
    return this.viaClient(
      async () => {
        if (count === 1) return await this.client!.spop<string>(payload.key);
        return await this.client!.spop<string[]>(payload.key, count);
      },
      () => {
        const vals = memoryStore.spop(payload.key, count);
        return count === 1 ? (vals[0] ?? null) : vals;
      },
      `spop ${payload.key}`,
    );
  }

  async smembers(key: string): Promise<string[]> {
    return this.viaClient(
      async () => (await this.client!.smembers(key)) ?? [],
      () => memoryStore.smembers(key),
      `smembers ${key}`,
    );
  }

  async isMember(key: string, member: string): Promise<boolean> {
    return this.viaClient(
      async () => (await this.client!.sismember(key, member)) === 1,
      () => memoryStore.sismember(key, member),
      `sismember ${key}`,
    );
  }

  async srem(key: string, member: string): Promise<boolean> {
    return this.viaClient(
      () => this.client!.srem(key, member).then(() => true),
      () => { memoryStore.srem(key, member); return true; },
      `srem ${key}`,
    );
  }

  async scard(key: string): Promise<number> {
    return this.viaClient(
      async () => (await this.client!.scard(key)) ?? 0,
      () => memoryStore.scard(key),
      `scard ${key}`,
    );
  }
}

export type RedisLike = Pick<
  RedisModel,
  "get" | "setWithExpiry" | "delete" | "increment"
>;

export { RedisModel };

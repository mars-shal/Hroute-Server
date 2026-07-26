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

class RedisModel {
  private client: RedisClient;

  constructor() {
    this.client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    });
  }

  // ── Strings ─────────────────────────────────────────────────

  async get(payload: RedisGetString): Promise<string | null> {
    try {
      const val = await this.client.get(payload.key);
      if (val == null) {
        logger.info(`[Redis] get ${payload.key}: null`);
        return null;
      }
      // Upstash auto-deserializes JSON — stringify back so callers can JSON.parse()
      const str = typeof val === "string" ? val : JSON.stringify(val);
      const preview = str.slice(0, 80);
      logger.info(`[Redis] get ${payload.key}: ${preview}...`);
      return str;
    } catch (e) {
      logger.error(`[Redis] get ${payload.key}:`, e);
      return null;
    }
  }

  async set(payload: RedisSetString): Promise<boolean> {
    try {
      await this.client.set(payload.key, payload.value);
      logger.info(`[Redis] set ${payload.key}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] set ${payload.key}:`, e);
      return false;
    }
  }

  async setWithExpiry(payload: RedisSetExpiryString): Promise<boolean> {
    try {
      await this.client.set(payload.key, payload.value, {
        ex: payload.expiry,
      });
      logger.info(`[Redis] setWithExpiry ${payload.key} (ttl=${payload.expiry}s)`);
      return true;
    } catch (e) {
      logger.error(`[Redis] setWithExpiry ${payload.key}:`, e);
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.client.del(key);
      logger.info(`[Redis] del ${key}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] del ${key}:`, e);
      return false;
    }
  }

  async increment(key: string): Promise<number | null> {
    try {
      const value = await this.client.incr(key);
      logger.info(`[Redis] incr ${key}: ${value}`);
      return value;
    } catch (e) {
      logger.error(`[Redis] incr ${key}:`, e);
      return null;
    }
  }

  // ── Sorted Sets ─────────────────────────────────────────────

  async zadd(payload: RedisZAddPayload): Promise<boolean> {
    try {
      await this.client.zadd(payload.key, {
        score: payload.score,
        member: payload.member,
      });
      logger.info(`[Redis] zadd ${payload.key} score=${payload.score}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] zadd ${payload.key}:`, e);
      return false;
    }
  }

  async zrange(payload: RedisZRangePayload): Promise<string[]> {
    try {
      const data = await this.client.zrange(
        payload.key,
        payload.start,
        payload.stop,
      ) as string[];
      logger.info(`[Redis] zrange ${payload.key} ${payload.start}-${payload.stop}: ${data.length} items`);
      return data ?? [];
    } catch (e) {
      logger.error(`[Redis] zrange ${payload.key}:`, e);
      return [];
    }
  }

  async zrem(key: string, member: string): Promise<boolean> {
    try {
      await this.client.zrem(key, member);
      logger.info(`[Redis] zrem ${key} ${member}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] zrem ${key}:`, e);
      return false;
    }
  }

  // ── Lists ───────────────────────────────────────────────────

  async lpush(payload: RedisLPushPayload): Promise<boolean> {
    try {
      await this.client.lpush(payload.key, payload.value);
      logger.info(`[Redis] lpush ${payload.key}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] lpush ${payload.key}:`, e);
      return false;
    }
  }

  async lrange(payload: RedisLRangePayload): Promise<string[]> {
    try {
      const data = await this.client.lrange(
        payload.key,
        payload.start,
        payload.stop,
      );
      logger.info(`[Redis] lrange ${payload.key} ${payload.start}-${payload.stop}: ${data.length} items`);
      return data ?? [];
    } catch (e) {
      logger.error(`[Redis] lrange ${payload.key}:`, e);
      return [];
    }
  }

  async lrem(key: string, count: number, value: string): Promise<boolean> {
    try {
      await this.client.lrem(key, count, value);
      logger.info(`[Redis] lrem ${key} count=${count}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] lrem ${key}:`, e);
      return false;
    }
  }

  // ── Hashes ──────────────────────────────────────────────────

  async hset(payload: RedisHSetPayload): Promise<boolean> {
    try {
      await this.client.hset(payload.key, {
        [payload.field]: payload.value,
      });
      logger.info(`[Redis] hset ${payload.key} field=${payload.field}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] hset ${payload.key}:`, e);
      return false;
    }
  }

  async hget(payload: RedisHGetPayload): Promise<string | null> {
    try {
      const val = await this.client.hget<string>(payload.key, payload.field);
      logger.info(`[Redis] hget ${payload.key} field=${payload.field}: ${val ? 'found' : 'null'}`);
      return val;
    } catch (e) {
      logger.error(`[Redis] hget ${payload.key}:`, e);
      return null;
    }
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    try {
      const val = await this.client.hgetall<Record<string, string>>(key);
      logger.info(`[Redis] hgetall ${key}: ${val ? Object.keys(val).length + ' fields' : 'null'}`);
      return val;
    } catch (e) {
      logger.error(`[Redis] hgetall ${key}:`, e);
      return null;
    }
  }

  async hdel(key: string, field: string): Promise<boolean> {
    try {
      await this.client.hdel(key, field);
      logger.info(`[Redis] hdel ${key} field=${field}`);
      return true;
    } catch (e) {
      logger.error(`[Redis] hdel ${key}:`, e);
      return false;
    }
  }

  // ── Sets ────────────────────────────────────────────────────

  async sadd(payload: RedisSAddPayload): Promise<boolean> {
    try {
      await this.client.sadd(payload.key, payload.member);
      logger.info(`[Redis] sadd ${payload.key}: ${payload.member.slice(0, 80)}...`);
      return true;
    } catch (e) {
      logger.error(`[Redis] sadd ${payload.key}:`, e);
      return false;
    }
  }

  async spop(payload: RedisSPopPayload): Promise<string | string[] | null> {
    try {
      const count = payload.count ?? 1;
      if (count === 1) {
        const val = await this.client.spop<string>(payload.key);
        logger.info(`[Redis] spop ${payload.key}: ${val ? 'popped' : 'empty'}`);
        return val;
      }
      const vals = await this.client.spop<string[]>(payload.key, count);
      logger.info(`[Redis] spop ${payload.key} count=${count}: ${vals?.length ?? 0} items`);
      return vals;
    } catch (e) {
      logger.error(`[Redis] spop ${payload.key}:`, e);
      return null;
    }
  }

  async smembers(key: string): Promise<string[]> {
    try {
      const result = await this.client.smembers(key);
      logger.info(`[Redis] smembers ${key}: ${result.length} members`);
      return result ?? [];
    } catch (e) {
      logger.error(`[Redis] smembers ${key}:`, e);
      return [];
    }
  }

  async isMember(key: string, member: string): Promise<boolean> {
    try {
      const result = await this.client.sismember(key, member);
      // Avoid spam: only log when actually a member
      if (result === 1) {
        logger.info(`[Redis] isMember ${key}: ${member.slice(0, 80)}... is a member`);
      }
      return result === 1;
    } catch (e) {
      logger.error(`[Redis] isMember ${key}:`, e);
      return false;
    }
  }

  async srem(key: string, member: string): Promise<boolean> {
    try {
      await this.client.srem(key, member);
      logger.info(`[Redis] srem ${key}: ${member.slice(0, 80)}...`);
      return true;
    } catch (e) {
      logger.error(`[Redis] srem ${key}:`, e);
      return false;
    }
  }
}

export type RedisLike = Pick<
  RedisModel,
  "get" | "setWithExpiry" | "delete" | "increment"
>;

export { RedisModel };

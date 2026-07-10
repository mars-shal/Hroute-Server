import { randomUUID } from "crypto";
import type { Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Database } from "../model/database";
import { RedisModel } from "../model/redis";
import { JobApplicationController } from "./jobApplication";
import type { MatchFilters } from "./jobMatcher";
import { logger } from "../utils/logger";

const CONNECTION_TTL_SECONDS = 60;

type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "jobs.match.request"; request_id: string; filters?: MatchFilters }
  | { type: "ping"; timestamp?: number };

class JobsWsController {
  private db: Database;
  private jobs: JobApplicationController;
  private redis: RedisModel;

  constructor(db: Database) {
    this.db = db;
    this.jobs = new JobApplicationController(db);
    this.redis = new RedisModel();
  }

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ server, path: "/api/ws/jobs" });

    wss.on("connection", async (socket, request) => {
      const connectionId = randomUUID();
      const url = new URL(request.url ?? "/api/ws/jobs", "http://localhost");
      const token = url.searchParams.get("token");
      let userId: string | null = null;
      let accessToken: string | null = null;

      if (token) {
        const auth = await this.db.authenticateToken(token);
        if (auth.status === 200 && auth.userId) {
          userId = auth.userId;
          accessToken = token;
          await this.refreshConnection(userId, connectionId);
          this.send(socket, { type: "auth.ok" });
        } else {
          this.send(socket, { type: "auth.required" });
        }
      } else {
        this.send(socket, { type: "auth.required" });
      }

      socket.on("message", async (raw) => {
        const message = this.parseMessage(raw.toString());
        if (!message) {
          this.send(socket, { type: "jobs.match.error", code: "BAD_MESSAGE", message: "Invalid message" });
          return;
        }

        if (message.type === "ping") {
          if (userId) await this.refreshConnection(userId, connectionId);
          this.send(socket, { type: "pong", timestamp: message.timestamp ?? Date.now() });
          return;
        }

        if (message.type === "auth") {
          const auth = await this.db.authenticateToken(message.token);
          if (auth.status !== 200 || !auth.userId) {
            this.send(socket, { type: "jobs.match.error", code: "AUTH_FAILED", message: "Invalid token" });
            return;
          }

          userId = auth.userId;
          accessToken = message.token;
          await this.refreshConnection(userId, connectionId);
          this.send(socket, { type: "auth.ok" });
          return;
        }

        if (!accessToken) {
          this.send(socket, { type: "jobs.match.error", request_id: message.request_id, code: "UNAUTHENTICATED", message: "Authenticate before requesting matches" });
          return;
        }

        this.send(socket, { type: "jobs.match.accepted", request_id: message.request_id });
        const result = await this.jobs.Search(accessToken, message.filters ?? {}, (progress) => {
          this.send(socket, { type: "jobs.match.progress", request_id: message.request_id, ...progress });
        });

        if (result.status !== 200) {
          this.send(socket, { type: "jobs.match.error", request_id: message.request_id, code: "MATCH_FAILED", message: result.error ?? "Unable to match jobs" });
          return;
        }

        if (result.source === "cache") {
          this.send(socket, { type: "jobs.match.cache_hit", request_id: message.request_id, generated_at: result.generated_at });
        }

        this.send(socket, {
          type: "jobs.match.results",
          request_id: message.request_id,
          source: result.source ?? "computed",
          generated_at: result.generated_at,
          results: result.jobs,
        });
      });

      socket.on("close", () => {
        logger.info(`[JobsWS] closed ${connectionId}`);
      });
    });
  }

  private async refreshConnection(userId: string, connectionId: string): Promise<void> {
    await this.redis.setWithExpiry({
      key: `ws:user:${userId}:connection:${connectionId}`,
      value: String(Date.now()),
      expiry: CONNECTION_TTL_SECONDS,
    });
  }

  private parseMessage(raw: string): ClientMessage | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!this.isRecord(parsed) || typeof parsed.type !== "string") return null;
      if (parsed.type === "auth" && typeof parsed.token === "string") return { type: "auth", token: parsed.token };
      if (parsed.type === "ping") return { type: "ping", timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined };
      if (parsed.type === "jobs.match.request" && typeof parsed.request_id === "string") {
        return { type: "jobs.match.request", request_id: parsed.request_id, filters: this.isRecord(parsed.filters) ? parsed.filters : undefined };
      }
      return null;
    } catch (e) {
      logger.warn(`[JobsWS] parse failed: ${e}`);
      return null;
    }
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function attachJobsWebSocket(server: HttpServer, db: Database): void {
  new JobsWsController(db).attach(server);
}

export { attachJobsWebSocket };

import { Router } from "express";
import type { Request, Response } from "express";
import type { DatabaseLike } from "../model/database.js";
import { AuthController } from "./authController.js";
import { ChatController } from "./chatController.js";
import { JobApplicationController } from "./jobApplication.js";
import { JobMaintenanceController } from "./jobMaintenance.js";
import { ResumeController } from "./resumeController.js";
import { ResumeBuilderController } from "./resumeBuilder.js";
import { log, logger } from "../utils/logger.js";

type ApiControllerDeps = {
  auth?: AuthController;
  chat?: ChatController;
  jobs?: JobApplicationController;
  jobMaintenance?: JobMaintenanceController;
  resume?: ResumeController;
  resumeBuilder?: ResumeBuilderController;
};

export function createApiRouter(db: DatabaseLike, deps: ApiControllerDeps = {}): Router {
  const router = Router();
  const auth = deps.auth ?? new AuthController(db);
  const chat = deps.chat ?? new ChatController(db);
  const jobs = deps.jobs ?? new JobApplicationController(db);
  const jobMaintenance = deps.jobMaintenance ?? new JobMaintenanceController(db);
  const resume = deps.resume ?? new ResumeController(db);
  const resumeBuilder = deps.resumeBuilder ?? new ResumeBuilderController();

  // ── Auth routes ──────────────────────────────────────────────

  router.post("/auth/register", async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    logger.info(`[API] POST /auth/register ${email ?? '?'}`);
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: "email and password required" });
        return;
      }
      const result = await auth.Register({ email, password });
      logger.info(`[API] POST /auth/register → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /auth/register]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/auth/login", async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    logger.info(`[API] POST /auth/login ${email ?? '?'}`);
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: "email and password required" });
        return;
      }
      const result = await auth.Login({ email, password });
      logger.info(`[API] POST /auth/login → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /auth/login]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/auth/refresh", async (req: Request, res: Response) => {
    logger.info(`[API] POST /auth/refresh`);
    try {
      const { refresh_token } = req.body as { refresh_token?: string };
      if (!refresh_token) {
        res.status(400).json({ error: "refresh_token required" });
        return;
      }
      const result = await auth.RefreshToken(refresh_token);
      logger.info(`[API] POST /auth/refresh → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /auth/refresh]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/auth/logout", async (req: Request, res: Response) => {
    logger.info(`[API] POST /auth/logout`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await auth.Logout(token);
      logger.info(`[API] POST /auth/logout → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /auth/logout]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/auth/me", async (req: Request, res: Response) => {
    logger.info(`[API] GET /auth/me`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await auth.GetProfile(token);
      logger.info(`[API] GET /auth/me → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[GET /auth/me]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.put("/auth/profile", async (req: Request, res: Response) => {
    logger.info(`[API] PUT /auth/profile`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await auth.UpdateProfile(token, req.body);
      logger.info(`[API] PUT /auth/profile → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[PUT /auth/profile]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.put("/auth/password", async (req: Request, res: Response) => {
    logger.info(`[API] PUT /auth/password`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const { current_password, new_password } = req.body as {
        current_password?: string;
        new_password?: string;
      };
      if (!current_password || !new_password) {
        res.status(400).json({ error: "current_password and new_password required" });
        return;
      }
      const result = await auth.ChangePassword(token, { current_password, new_password });
      logger.info(`[API] PUT /auth/password → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[PUT /auth/password]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete("/auth/account", async (req: Request, res: Response) => {
    logger.info(`[API] DELETE /auth/account`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await auth.DeleteAccount(token);
      logger.info(`[API] DELETE /auth/account → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[DELETE /auth/account]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/auth/isme", async (req: Request, res: Response) => {
    logger.info(`[API] GET /auth/isme`);
    try {
      const token = extractToken(req);
      const refreshToken = req.headers["x-refresh-token"] as string | undefined;

      if (!token && !refreshToken) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      if (token) {
        const profile = await auth.GetProfile(token);
        if (profile.status === 200) {
          logger.info(`[API] GET /auth/isme → 200 (access token)`);
          res.status(200).json({ status: 200, user: profile });
          return;
        }
      }

      if (refreshToken) {
        const refreshed = await auth.RefreshToken(refreshToken);
        if (refreshed.status === 200 && refreshed.access_token) {
          const profile = await auth.GetProfile(String(refreshed.access_token));
          if (profile.status === 200) {
            logger.info(`[API] GET /auth/isme → 200 (refreshed)`);
            res.status(200).json({
              status: 200,
              user: profile,
              access_token: refreshed.access_token,
              expires_in: refreshed.expires_in,
            });
            return;
          }
        }
      }

      res.status(404).json({ error: "User not found" });
    } catch (e) {
      logger.error("[GET /auth/isme]", e);
      res.status(404).json({ error: "User not found" });
    }
  });

  router.post("/chat", async (req: Request, res: Response) => {
    logger.info(`[API] POST /chat`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const result = await chat.Chat(token, req.body as { message?: string; system?: string });
      logger.info(`[API] POST /chat → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /chat]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Job routes ───────────────────────────────────────────────

  router.post("/jobs/discover", async (req: Request, res: Response) => {
    // Optional API key guard — set DISCOVER_API_KEY to enable
    const discoverApiKey = process.env.DISCOVER_API_KEY;
    if (discoverApiKey) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== discoverApiKey) {
        res.status(401).json({ error: "Invalid or missing discover API key" });
        return;
      }
    }

    const body = (req.body ?? {}) as {
      seedUrls?: string[];
      limit?: number;
      dry_run?: boolean;
      prune_old?: boolean;
      recompute_embeddings?: boolean;
    };
    const { seedUrls } = body;
    logger.info(`[API] POST /jobs/discover (seedUrls=${seedUrls?.length ?? 'default (35)'})`);
    await log(`[API] POST /jobs/discover start`);
    try {
      const cleanupResult = await jobMaintenance.CleanupJobs({
        limit: body.limit,
        dry_run: body.dry_run,
        prune_old: body.prune_old ?? true,
        recompute_embeddings: body.recompute_embeddings,
      });
      if (cleanupResult.status !== 200) {
        logger.error(`[API] POST /jobs/discover cleanup failed → ${cleanupResult.status}`);
        await log(`[API] POST /jobs/discover cleanup failed: ${cleanupResult.message}`);
        res.status(cleanupResult.status).json({ cleanup: cleanupResult });
        return;
      }

      // Defaults to SEARCHURLS from utils/search.ts when nothing sent
      const result = await jobs.Discover(
        Array.isArray(seedUrls) ? seedUrls : undefined,
      );
      logger.info(`[API] POST /jobs/discover → ${result.status} (${result.total_jobs} jobs)`);
      await log(`[API] POST /jobs/discover done: ${result.total_jobs} jobs`);
      res.json({ ...result, cleanup: cleanupResult });
    } catch (e) {
      logger.error("[POST /jobs/discover]", e);
      await log(`[API] POST /jobs/discover ERROR: ${e}`);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/jobs/cleanup", async (req: Request, res: Response) => {
    const discoverApiKey = process.env.DISCOVER_API_KEY;
    if (discoverApiKey) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== discoverApiKey) {
        res.status(401).json({ error: "Invalid or missing discover API key" });
        return;
      }
    }

    const body = (req.body ?? {}) as {
      limit?: number;
      dry_run?: boolean;
      prune_old?: boolean;
      recompute_embeddings?: boolean;
    };

    logger.info(`[API] POST /jobs/cleanup (limit=${body.limit ?? 1000}, dry_run=${body.dry_run ?? false}, prune_old=${body.prune_old ?? false})`);
    await log(`[API] POST /jobs/cleanup start`);
    try {
      const result = await jobMaintenance.CleanupJobs(body);
      logger.info(`[API] POST /jobs/cleanup → ${result.status} (updated=${result.updated}, pruned=${result.pruned})`);
      await log(`[API] POST /jobs/cleanup done: updated=${result.updated} pruned=${result.pruned}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /jobs/cleanup]", e);
      await log(`[API] POST /jobs/cleanup ERROR: ${e}`);
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Resume routes ───────────────────────────────────────────

  router.post("/resume/upload", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume/upload`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await resume.upload(token, req.body as { resume_text?: string; file_data?: string; file_type?: string });
      logger.info(`[API] POST /resume/upload → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /resume/upload]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/resume/file", async (req: Request, res: Response) => {
    logger.info(`[API] GET /resume/file`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await resume.getFile(token);
      logger.info(`[API] GET /resume/file → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[GET /resume/file]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/resume/improve", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume/improve`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const { message } = req.body as { message?: string };
      if (!message) {
        res.status(400).json({ error: "message required" });
        return;
      }
      const result = await resume.improve(token, message);
      logger.info(`[API] POST /resume/improve → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /resume/improve]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/resume/export", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume/export`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await resume.exportPdf(token);
      logger.info(`[API] POST /resume/export → ${result.status}`);
      res.status(result.status).json(result);
    } catch (e) {
      logger.error("[POST /resume/export]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Resume Builder routes ───────────────────────────────────

  router.post("/resume-builder/session", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume-builder/session`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const authResult = await db.authenticateToken(token);
      if (authResult.status !== 200 || !authResult.userId) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }

      const userId = authResult.userId;
      const initialData = req.body as Record<string, unknown> | undefined;

      const session = await resumeBuilder.createSession(userId, initialData);
      logger.info(`[API] POST /resume-builder/session → 200 (session=${session.id})`);
      res.status(200).json(session);
    } catch (e) {
      logger.error("[POST /resume-builder/session]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/resume-builder/session/:sessionId", async (req: Request, res: Response) => {
    logger.info(`[API] GET /resume-builder/session/${req.params.sessionId}`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const { sessionId } = req.params;
      const session = await resumeBuilder.getSession(sessionId);
      
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      logger.info(`[API] GET /resume-builder/session/${sessionId} → 200`);
      res.status(200).json(session);
    } catch (e) {
      logger.error(`[GET /resume-builder/session/${req.params.sessionId}]`, e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/resume-builder/chat", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume-builder/chat`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const { sessionId, message } = req.body as { sessionId?: string; message?: string };
      if (!sessionId || !message) {
        res.status(400).json({ error: "sessionId and message required" });
        return;
      }

      const response = await resumeBuilder.processMessage(sessionId, message);
      logger.info(`[API] POST /resume-builder/chat → 200 (score=${response.ats_score.score})`);
      res.status(200).json(response);
    } catch (e) {
      logger.error("[POST /resume-builder/chat]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.put("/resume-builder/session/:sessionId", async (req: Request, res: Response) => {
    logger.info(`[API] PUT /resume-builder/session/${req.params.sessionId}`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const { sessionId } = req.params;
      const updates = req.body as Record<string, unknown>;

      const session = await resumeBuilder.updateSession(sessionId, updates);
      logger.info(`[API] PUT /resume-builder/session/${sessionId} → 200`);
      res.status(200).json(session);
    } catch (e) {
      logger.error(`[PUT /resume-builder/session/${req.params.sessionId}]`, e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/resume-builder/generate/:sessionId", async (req: Request, res: Response) => {
    logger.info(`[API] POST /resume-builder/generate/${req.params.sessionId}`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const { sessionId } = req.params;
      const result = await resumeBuilder.generateResume(sessionId);
      
      logger.info(`[API] POST /resume-builder/generate/${sessionId} → 200 (score=${result.ats_score.score})`);
      res.status(200).json(result);
    } catch (e) {
      logger.error(`[POST /resume-builder/generate/${req.params.sessionId}]`, e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete("/resume-builder/session/:sessionId", async (req: Request, res: Response) => {
    logger.info(`[API] DELETE /resume-builder/session/${req.params.sessionId}`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }

      const { sessionId } = req.params;
      await resumeBuilder.deleteSession(sessionId);
      
      logger.info(`[API] DELETE /resume-builder/session/${sessionId} → 200`);
      res.status(200).json({ message: "Session deleted" });
    } catch (e) {
      logger.error(`[DELETE /resume-builder/session/${req.params.sessionId}]`, e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/jobs/recent", async (_req: Request, res: Response) => {
    logger.info(`[API] GET /jobs/recent (random active browse)`);
    try {
      const result = await db.getRandomActiveJobs(50);
      const data = (result.data ?? []) as unknown[];
      logger.info(`[API] GET /jobs/recent → 200 (${data.length} jobs, random active browse)`);
      res.json(data);
    } catch (e) {
      logger.error("[GET /jobs/recent]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/jobs/search", async (req: Request, res: Response) => {
    logger.info(`[API] POST /jobs/search (public query)`);
    try {
      const body = (req.body ?? {}) as {
        query?: string;
        location?: string;
        remote?: boolean;
        skills?: string[];
        limit?: number;
      };

      if (body.skills !== undefined && !Array.isArray(body.skills)) {
        res.status(400).json({ error: "skills must be an array of strings" });
        return;
      }
      if (body.remote !== undefined && typeof body.remote !== "boolean") {
        res.status(400).json({ error: "remote must be a boolean" });
        return;
      }

      const result = await db.searchJobsByQuery(body);
      const data = (result.data ?? []) as unknown[];
      logger.info(`[API] POST /jobs/search → ${result.status} (${data.length} jobs)`);
      res.status(result.status ?? 500).json(data);
    } catch (e) {
      logger.error("[POST /jobs/search]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/jobs/match", async (req: Request, res: Response) => {
    logger.info(`[API] POST /jobs/match`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await jobs.Search(token, req.body ?? {});
      logger.info(`[API] POST /jobs/match → ${result.status} (${result.jobs.length} jobs)`);
      res.json(result);
    } catch (e) {
      logger.error("[POST /jobs/match]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

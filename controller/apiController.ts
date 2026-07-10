import { Router } from "express";
import type { Request, Response } from "express";
import type { DatabaseLike } from "../model/database.js";
import { AuthController } from "./authController.js";
import { ChatController } from "./chatController.js";
import { JobApplicationController } from "./jobApplication.js";
import { ResumeController } from "./resumeController.js";
import { log, logger } from "../utils/logger.js";

type ApiControllerDeps = {
  auth?: AuthController;
  chat?: ChatController;
  jobs?: JobApplicationController;
  resume?: ResumeController;
};

export function createApiRouter(db: DatabaseLike, deps: ApiControllerDeps = {}): Router {
  const router = Router();
  const auth = deps.auth ?? new AuthController(db);
  const chat = deps.chat ?? new ChatController(db);
  const jobs = deps.jobs ?? new JobApplicationController(db);
  const resume = deps.resume ?? new ResumeController(db);

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
    const { seedUrls } = req.body as { seedUrls?: string[] };
    logger.info(`[API] POST /jobs/discover (seedUrls=${seedUrls?.length ?? 'default (35)'})`);
    await log(`[API] POST /jobs/discover start`);
    try {
      // Defaults to SEARCHURLS from utils/search.ts when nothing sent
      const result = await jobs.Discover(
        Array.isArray(seedUrls) ? seedUrls : undefined,
      );
      logger.info(`[API] POST /jobs/discover → ${result.status} (${result.total_jobs} jobs)`);
      await log(`[API] POST /jobs/discover done: ${result.total_jobs} jobs`);
      res.json(result);
    } catch (e) {
      logger.error("[POST /jobs/discover]", e);
      await log(`[API] POST /jobs/discover ERROR: ${e}`);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/jobs/search", async (req: Request, res: Response) => {
    logger.info(`[API] POST /jobs/search`);
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
      }
      const result = await jobs.Search(token, req.body ?? {});
      logger.info(`[API] POST /jobs/search → ${result.status} (${result.jobs.length} jobs)`);
      res.json(result);
    } catch (e) {
      logger.error("[POST /jobs/search]", e);
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

  router.get("/jobs/recent", async (_req: Request, res: Response) => {
    logger.info(`[API] GET /jobs/recent`);
    try {
      const result = await db.getJobsRecent(50);
      const data = (result.data ?? []) as unknown[];
      logger.info(`[API] GET /jobs/recent → 200 (${data.length} jobs)`);
      res.json(data);
    } catch (e) {
      logger.error("[GET /jobs/recent]", e);
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

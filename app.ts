import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "http";
import type { DatabaseLike } from "./model/database.js";
import { createApiRouter } from "./controller/apiController.js";

type AppDeps = {
  api?: Parameters<typeof createApiRouter>[1];
};

export function createApp(db: DatabaseLike, deps: AppDeps = {}) {
  const app = express();

  app.use(express.json({ limit: "3mb" }));

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/ping", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api", createApiRouter(db, deps.api));

  return app;
}

export function createHttpServer(db: DatabaseLike, deps: AppDeps = {}): HttpServer {
  const app = createApp(db, deps);
  return createServer(app);
}

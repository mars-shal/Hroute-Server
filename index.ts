import express from "express";
import { createServer } from "http";
import type { Request, Response } from "express";
import { connectDatabase } from "./model/database.js";
import { createApiRouter } from "./controller/apiController.js";
import { attachJobsWebSocket } from "./controller/jobsWsController.js";
import { log, logger } from "./utils/logger.js";

const app = express();
const port = parseInt(process.env.PORT || "8080", 10);

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

async function init() {
  const db = await connectDatabase();
  app.use("/api", createApiRouter(db));
  const server = createServer(app);
  attachJobsWebSocket(server, db);

  server.listen(port, () => {
    logger.info(`hrout server listening on port ${port}`);
    log(`[Server] Started on port ${port}`);
  });
}

init().catch((e) => {
  logger.error("Failed to start server:", e);
  log(`[Server] Failed to start: ${e}`);
  process.exit(1);
});

export default app;

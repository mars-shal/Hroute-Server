import chalk from 'chalk';
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

async function ensureLogDir(file: string) {
  const dir = file.substring(0, file.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

const defaultLogFile =
  process.env.LOG_FILE ??
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? "/tmp/logs/log.log"
    : "./logs/log.log");

export const log = async (text: any, file: string = defaultLogFile) => {
  try {
    await appendFile(file, `\n${text}`);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      await ensureLogDir(file);
      try {
        await appendFile(file, `\n${text}`);
      } catch {
        // Logging must never break request handling in serverless runtimes.
      }
      return;
    }
    // Ignore non-fatal filesystem failures such as read-only deployments.
  }
};

export const logger = {
  info: (...args: unknown[]) => console.log(chalk.green('[Server]'), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow('[Server]'), ...args),
  error: (...args: unknown[]) => console.error(chalk.red('[Server]'), ...args),
};

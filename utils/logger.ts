import chalk from 'chalk';
import { appendFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

async function ensureLogDir(file: string) {
  const dir = file.substring(0, file.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export const log = async (text: any, file: string = "./logs/log.log") => {
  try {
    await appendFile(file, `\n${text}`);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      await ensureLogDir(file);
      await appendFile(file, `\n${text}`);
    }
  }
}

export const logger = {
  info: (...args: unknown[]) => console.log(chalk.green('[Server]'), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow('[Server]'), ...args),
  error: (...args: unknown[]) => console.error(chalk.red('[Server]'), ...args),
};

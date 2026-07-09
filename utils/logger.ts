import chalk from 'chalk';
import { appendFile } from "node:fs/promises"

export const log = async (text: any, file: string = "./logs/log.log") => {
  await appendFile(file, `\n${text}`)
}

export const logger = {
  info: (...args: unknown[]) => console.log(chalk.green('[Server]'), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow('[Server]'), ...args),
  error: (...args: unknown[]) => console.error(chalk.red('[Server]'), ...args),
};

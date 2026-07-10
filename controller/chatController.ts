import type { Database } from "../model/database";
import { LLM } from "../model/LLM";
import { logger } from "../utils/logger";

const MAX_CHAT_MESSAGE_CHARS = 4_000;
const DEFAULT_CHAT_SYSTEM =
  "You are Hroute's job-search assistant. Help users improve resumes, understand job matches, and plan applications. Be concise, practical, and honest when information is missing.";

type ChatBody = {
  message?: string;
  system?: string;
};

type ChatResult = {
  status: number;
  reply?: string;
  error?: string;
};

class ChatController {
  private db: Database;
  private llm: LLM;

  constructor(db: Database) {
    this.db = db;
    this.llm = new LLM();
  }

  async Chat(token: string, body: ChatBody): Promise<ChatResult> {
    const auth = await this.db.authenticateToken(token);
    if (auth.status !== 200) {
      return { status: 401, error: "Invalid token" };
    }

    const message = this.normalizeMessage(body.message);
    if (!message) {
      return { status: 400, error: "message is required" };
    }

    try {
      const reply = await this.llm.chat(message, body.system ?? DEFAULT_CHAT_SYSTEM, {
        temperature: 0.4,
        max_tokens: 700,
      });

      return { status: 200, reply };
    } catch (e) {
      logger.error("[Chat] Error:", e);
      return { status: 500, error: String(e) };
    }
  }

  private normalizeMessage(message: string | undefined): string | null {
    const trimmed = message?.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.length <= MAX_CHAT_MESSAGE_CHARS
      ? trimmed
      : trimmed.slice(0, MAX_CHAT_MESSAGE_CHARS);
  }
}

export { ChatController };
export type { ChatBody };

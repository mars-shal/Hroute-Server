import Groq from 'groq-sdk';
import { log, logger } from "../utils/logger";
import { RedisModel } from "./redis";

type Role = 'system' | 'user' | 'assistant';

interface Message {
  role: Role;
  content: string;
}

type LLMModel =
  | 'llama-3.3-70b-versatile'
  | 'llama-3.1-8b-instant'
  | 'mixtral-8x7b-32768'
  | 'gemma2-9b-it';

interface CompletionOptions {
  model?: LLMModel;
  temperature?: number;
  max_tokens?: number;
}

class LLM {
  private client: Groq;
  private redis: RedisModel | null;

  constructor() {
    this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    // Redis is optional — used to persist rate-limit cooldowns across restarts
    this.redis =
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new RedisModel()
        : null;
  }

  private async isRateLimited(model: string): Promise<boolean> {
    if (!this.redis) return false;
    const key = `ratelimit:${model}`;
    const until = await this.redis.get({ key });
    if (!until) return false;
    const untilTs = Number(until);
    if (Date.now() < untilTs) {
      const remaining = Math.round((untilTs - Date.now()) / 1000);
      logger.warn(`[LLM] rate-limit cooldown for ${model}: ${remaining}s remaining`);
      return true;
    }
    await this.redis.delete(key);
    return false;
  }

  /** Persist a rate-limit cooldown in Redis with auto-expiry. */
  private async persistRateLimit(model: string, retryAfterSeconds: number): Promise<void> {
    if (!this.redis) return;
    const key = `ratelimit:${model}`;
    const untilTs = Date.now() + retryAfterSeconds * 1000;
    await this.redis.setWithExpiry({
      key,
      value: String(untilTs),
      expiry: retryAfterSeconds + 60,
    });
    const untilStr = new Date(untilTs).toISOString();
    logger.warn(`[LLM] persisted rate-limit cooldown for ${model} until ${untilStr}`);
    await log(`[LLM] rate-limit cooldown ${model} until ${untilStr}`);
  }

  /** Parse retry-after seconds from a Groq 429 error message. */
  private parseRetryAfter(msg: string): number | null {
    const hours = msg.match(/try again in (\d+)h/);
    const minutes = msg.match(/(\d+)m/);
    const seconds = msg.match(/([\d.]+)s/);
    if (hours || minutes || seconds) {
      let total = 0;
      if (hours) total += parseInt(hours[1]) * 3600;
      if (minutes) total += parseInt(minutes[1]) * 60;
      if (seconds) total += Math.ceil(parseFloat(seconds[1]));
      return total;
    }
    return null;
  }

  private async complete(
    messages: Message[],
    options: CompletionOptions = {},
    retries = 3,
  ): Promise<string> {
    const {
      model = 'llama-3.3-70b-versatile',
      temperature = 0.7,
      max_tokens = 1024,
    } = options;

    for (let attempt = 1; attempt <= retries; attempt++) {
      // Skip the call if the model is in cooldown (e.g. daily TPD exhausted)
      if (attempt === 1 && (await this.isRateLimited(model))) {
        throw new Error(`Rate limited: ${model} is in cooldown`);
      }

      try {
        logger.info(`[LLM] complete calling ${model} attempt=${attempt} (messages=${messages.length}, max_tokens=${max_tokens})`);
        if (attempt === 1) await log(`[LLM] complete: model=${model} messages=${messages.length}`);

        const res = await this.client.chat.completions.create({
          messages,
          model,
          temperature,
          max_tokens,
        });

        const content = res.choices[0]?.message?.content;
        if (!content) throw new Error('Empty response from Groq');

        logger.info(`[LLM] complete success (${content.length} chars)`);
        return content;
      } catch (err) {
        const isRateLimit =
          (err as { status?: number })?.status === 429 ||
          (err as { status?: number })?.status === 413 ||
          String(err).includes('rate_limit_exceeded') ||
          String(err).includes('Rate limit reached');

        if (isRateLimit && attempt < retries) {
          const waitMs = Math.min(5000 * attempt, 30000);
          logger.warn(`[LLM] rate limit on ${model} (attempt ${attempt}/${retries}), waiting ${waitMs}ms`);
          await log(`[LLM] rate limit wait ${waitMs}ms (attempt ${attempt}/${retries})`);

          // Persist cooldown if the retry-after is hours-scale (TPD, not TPM)
          const retryAfter = this.parseRetryAfter(String(err));
          if (retryAfter && retryAfter > 120) {
            await this.persistRateLimit(model, retryAfter);
            // Don't keep retrying for daily limits — skip the rest
            logger.warn(`[LLM] daily rate limit detected (${retryAfter}s cooldown), aborting retries`);
            await log(`[LLM] daily rate limit (${retryAfter}s), aborting retries for ${model}`);
            throw err;
          }

          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        logger.error('[LLM] complete error:', err);
        await log(`[LLM] complete ERROR: ${err}`);
        throw err;
      }
    }

    throw new Error(`[LLM] complete exhausted ${retries} retries for ${model}`);
  }

  async chat(
    message: string,
    system?: string,
    options?: CompletionOptions,
  ): Promise<string> {
    const messages: Message[] = [];

    if (system) {
      messages.push({ role: 'system', content: system });
    }

    messages.push({ role: 'user', content: message });

    return this.complete(messages, {
      temperature: 0.7,
      ...options,
    });
  }

  async reason(
    prompt: string,
    options?: CompletionOptions,
  ): Promise<string> {
    return this.complete(
      [
        {
          role: 'system',
          content:
            'You are a reasoning engine. Think step by step. Be concise, analytical, and precise. If uncertain, state your confidence level.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.3, ...options },
    );
  }

  async structured<T>(
    prompt: string,
    parse: (raw: string) => T,
    options?: CompletionOptions,
  ): Promise<T> {
    const system =
      'You are a data extraction engine. Respond with valid JSON only. No markdown, no explanation.';
    const raw = await this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, model: 'llama-3.1-8b-instant', ...options },
    );
    return parse(raw);
  }

  /** Derive a logo.dev URL from a company name. */
  private companyLogoUrl(company: string): string | null {
    if (!company) return null;
    const domain = company
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/\.com$/, "") + ".com";
    const token = process.env.LOGO_DEV_TOKEN ?? 'live_6a1a28fd-6420-4492-aeb0-b297461d9de2';
    return `https://img.logo.dev/${domain}?token=${token}&size=128&retina=true&format=png&theme=dark`;
  }

  async extractJob(text: string): Promise<Record<string, unknown>> {
    if (await this.isRateLimited('llama-3.1-8b-instant')) {
      logger.warn('[LLM] extractJob skipped — rate limited');
      await log('[LLM] extractJob SKIPPED (rate limited)');
      return {};
    }

    const MAX = 4000;
    const truncated = text.length <= MAX ? text : text.slice(0, 1500) + "\n[...]\n" + text.slice(-(MAX - 1500 - 5));
    logger.info(`[LLM] extractJob (text.length=${text.length}, truncated=${truncated.length})`);
    await log(`[LLM] extractJob starting (${text.length} chars, truncated=${truncated.length})`);
    const result = await this.structured(
      `Extract structured job info from the following text. Return a JSON object with fields: title, company, location, description, skills[], remote_status, salary_range, apply_url, posted_date, source_site. Use null for missing fields.\n\n${truncated}`,
      (raw: string) => {
        const cleaned = raw.replace(/```(?:json)?\s*/gi, "").trim();
        return JSON.parse(cleaned) as Record<string, unknown>;
      },
      { temperature: 0.1 },
    );

    const company = (result.company as string) ?? "";
    if (company) {
      result.logo_url = this.companyLogoUrl(company);
    }

    logger.info(`[LLM] extractJob done`);
    await log(`[LLM] extractJob result: ${JSON.stringify(result).slice(0, 300)}`);
    return result;
  }

  async matchResumeToJob(
    resume: string,
    job: string,
  ): Promise<string> {
    logger.info(`[LLM] matchResumeToJob (resume=${resume.length} chars, job=${job.length} chars)`);
    await log(`[LLM] matchResumeToJob starting`);
    const result = await this.reason(
      `Given this resume:\n${resume}\n\nAnd this job description:\n${job}\n\n1. Score the fit from 0.0 to 1.0.\n2. List missing skills.\n3. Explain briefly why this job fits or doesn't.\n\nRespond in JSON: { "similarity": number, "missing_skills": string[], "reason": string }`,
      { temperature: 0.2 },
    );
    logger.info(`[LLM] matchResumeToJob done`);
    await log(`[LLM] matchResumeToJob result: ${result.slice(0, 300)}`);
    return result;
  }
}

export { LLM };
export type { LLMModel, CompletionOptions };

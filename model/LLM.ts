import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import { log, logger } from "../utils/logger.js";
import { reformatResumeMarkdown } from '../utils/resumeReformat.js';
import { RedisModel } from "./redis.js";

/**
 * Escape literal control characters (newlines, tabs, carriage returns)
 * inside JSON string values so JSON.parse does not choke.
 * Walks the string character-by-character, tracking whether we are
 * inside a quoted JSON string.
 */
function sanitizeJsonString(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
      if (ch < '\x1f') { result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    }
    result += ch;
  }
  return result;
}

type Role = 'system' | 'user' | 'assistant';

interface Message {
  role: Role;
  content: string;
}

type LLMModel =
  | 'llama-3.3-70b-versatile'
  | 'llama-3.1-8b-instant';

interface CompletionOptions {
  model?: LLMModel;
  temperature?: number;
  max_tokens?: number;
  fallbackModels?: LLMModel[];
}

const MODEL_FALLBACKS: Record<LLMModel, LLMModel[]> = {
  'llama-3.3-70b-versatile': ['llama-3.1-8b-instant'],
  'llama-3.1-8b-instant': ['llama-3.3-70b-versatile'],
};

class LLM {
  private client: Groq;
  private redis: RedisModel | null;
  private maxConcurrent: number;
  private active = 0;
  private pending: Array<() => void> = [];
  primaryModel: LLMModel;
  fastModel: LLMModel;
  private googleAi: GoogleGenAI | null = null;
  private googleModel: string;

  constructor(maxConcurrent = 2) {
    this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    this.maxConcurrent = maxConcurrent;
    this.primaryModel = (process.env.LLM_PRIMARY_MODEL as LLMModel) || 'llama-3.3-70b-versatile';
    this.fastModel = (process.env.LLM_FAST_MODEL as LLMModel) || 'llama-3.1-8b-instant';
    this.googleModel = process.env.GOOGLE_MODEL || 'gemini-3.6-flash';
    this.redis =
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new RedisModel()
        : null;
  }

  private getGoogleClient(): GoogleGenAI | null {
    if (!process.env.GOOGLE_API_KEY) return null;
    if (!this.googleAi) {
      this.googleAi = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    }
    return this.googleAi;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  private release(): void {
    const next = this.pending.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
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
      if (hours?.[1]) total += parseInt(hours[1]) * 3600;
      if (minutes?.[1]) total += parseInt(minutes[1]) * 60;
      if (seconds?.[1]) total += Math.ceil(parseFloat(seconds[1]));
      return total;
    }
    return null;
  }

  private async complete(
    messages: Message[],
    options: CompletionOptions = {},
    retries = 1,
  ): Promise<string> {
    const {
      model: primaryModel,
      temperature = 0.7,
      max_tokens = 1024,
      fallbackModels,
    } = options;

    const actualPrimary = primaryModel ?? this.primaryModel;
    const modelsToTry: LLMModel[] = [
      actualPrimary,
      ...(fallbackModels ?? MODEL_FALLBACKS[actualPrimary] ?? []),
    ];

    let lastError: Error | undefined;

    for (const model of modelsToTry) {
      if (await this.isRateLimited(model)) {
        logger.warn(`[LLM] skipping ${model} — in cooldown, trying next model`);
        lastError = new Error(`Rate limited: ${model} is in cooldown`);
        continue;
      }

      for (let attempt = 1; attempt <= retries; attempt++) {
        await this.acquire();
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

          logger.info(`[LLM] complete success (${content.length} chars, model=${model})`);
          return content;
        } catch (err) {
          const status = (err as { status?: number })?.status;
          const errMsg = String(err);
          const errorBody = (err as { error?: { code?: string; message?: string } })?.error;
          const code = errorBody?.code;
          const isRateLimit = status === 429 || status === 413 || errMsg.includes('rate_limit_exceeded') || errMsg.includes('Rate limit reached');

          if (isRateLimit) {
            const retryAfter = this.parseRetryAfter(errMsg);
            if (retryAfter && retryAfter > 120) {
              await this.persistRateLimit(model, retryAfter);
            }
            logger.warn(`[LLM] rate limited ${model} (retryAfter=${retryAfter ?? '?'}s), trying next model`);
            await log(`[LLM] rate limited ${model}, switching`);
            lastError = err instanceof Error ? err : new Error(String(err));
            break;
          }

          if (status === 400 && (code === 'model_decommissioned' || errMsg.includes('decommissioned') || errMsg.includes('not found') || errMsg.includes('not supported'))) {
            logger.error(`[LLM] MODEL DECOMMISSIONED: ${model} — permanently unavailable, remove from config`);
            await log(`[LLM] DECOMMISSIONED ${model}`);
            lastError = err instanceof Error ? err : new Error(String(err));
            break;
          }

          if (status && status >= 500) {
            logger.warn(`[LLM] server error ${status} on ${model}, trying next model`);
            await log(`[LLM] server error ${status} ${model}, switching`);
            lastError = err instanceof Error ? err : new Error(String(err));
            break;
          }

          if (status === 401 || status === 403) {
            logger.error(`[LLM] auth error ${status} on ${model} — API key issue, NOT retrying other models`);
            await log(`[LLM] auth error ${status}, aborting`);
            throw err;
          }

          if (status === 400 && errMsg.includes('invalid') && !errMsg.includes('decommissioned')) {
            logger.error(`[LLM] invalid request on ${model}: ${errMsg.slice(0, 200)}`);
            await log(`[LLM] invalid request, aborting`);
            throw err;
          }

          logger.error(`[LLM] unexpected error on ${model}:`, err);
          await log(`[LLM] unexpected error ${model}: ${errMsg.slice(0, 200)}`);
          lastError = err instanceof Error ? err : new Error(String(err));
          break;
        } finally {
          this.release();
        }
      }
    }

    const googleClient = this.getGoogleClient();
    if (googleClient) {
      logger.warn(`[LLM] all Groq models failed, falling back to Google ${this.googleModel}`);
      await log(`[LLM] falling back to Google ${this.googleModel}`);
      try {
        return await this.completeGoogle(messages, { temperature, max_tokens });
      } catch (googleErr) {
        lastError = googleErr instanceof Error ? googleErr : new Error(String(googleErr));
        logger.error(`[LLM] Google fallback also failed:`, googleErr);
        await log(`[LLM] Google fallback failed: ${String(googleErr).slice(0, 200)}`);
      }
    }

    throw lastError ?? new Error(`[LLM] all models exhausted for ${actualPrimary}`);
  }

  private async completeGoogle(
    messages: Message[],
    options: CompletionOptions,
  ): Promise<string> {
    const client = this.getGoogleClient();
    const model = this.googleModel;
    const { temperature = 0.7, max_tokens = 1024 } = options;

    const systemMsg = messages.find((m) => m.role === 'system');
    const userContent = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n');

    logger.info(`[LLM] calling Google ${model} (messages=${messages.length}, max_tokens=${max_tokens})`);
    await log(`[LLM] Google fallback: model=${model}`);

    const response = await client.models.generateContent({
      model,
      contents: userContent,
      systemInstruction: systemMsg?.content,
      config: {
        temperature,
        maxOutputTokens: max_tokens,
      },
    });

    const text = response.text;
    if (!text) throw new Error('Empty response from Google GenAI');

    logger.info(`[LLM] Google ${model} success (${text.length} chars)`);
    await log(`[LLM] Google fallback success`);
    return text;
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
      { temperature: 0.1, model: this.fastModel, ...options },
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
    if (await this.isRateLimited(this.fastModel)) {
      logger.warn('[LLM] extractJob skipped — rate limited');
      await log('[LLM] extractJob SKIPPED (rate limited)');
      return {};
    }

    const MAX = 4000;
    const truncated = text.length <= MAX ? text : text.slice(0, 1500) + "\n[...]\n" + text.slice(-(MAX - 1500 - 5));
    logger.info(`[LLM] extractJob (text.length=${text.length}, truncated=${truncated.length})`);
    await log(`[LLM] extractJob starting (${text.length} chars, truncated=${truncated.length})`);
    const result = await this.structured(
      `Extract structured job info from the following text. Return a JSON object with these fields:
        - title: job title (string, required)
        - company: company name (string, required)
        - location: job location (string or null)
        - description: a clean, readable paragraph with excess whitespace and newlines removed (string)
        - skills: array of skills mentioned, extracted from description context if not explicitly listed (string[], required — if none found return [])
        - remote_status: "true" if fully remote, "hybrid" if partly remote, "false" if onsite. Infer from location/description context if not explicit. Default "unknown" only if no clue (string)
        - salary_range: salary or pay range if mentioned (string or null)
        - apply_url: direct application URL if found (string or null)
        - posted_date: original posted date string as-is from the text, or relative like "2 days ago" (string or null)
        - source_site: domain name of the source (string or null)
        - experience_level: "entry" for junior/graduate/intern/NYSC, "mid" for mid-level (no strong senior/junior signal), "senior" for senior/sr/staff/lead/principal/manager/director/head of, "unspecified" if unclear (string)
      Use null for truly missing fields. Do NOT include markdown formatting in description.\n\n${truncated}`,
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

  async extractProfile(text: string): Promise<Record<string, unknown>> {
    if (await this.isRateLimited(this.fastModel)) {
      logger.warn('[LLM] extractProfile skipped — rate limited');
      return { skills: [] };
    }

    const MAX = 6000;
    const truncated = text.length <= MAX ? text : text.slice(0, 2000) + "\n[...]\n" + text.slice(-(MAX - 2000 - 5));
    logger.info(`[LLM] extractProfile (text.length=${text.length}, truncated=${truncated.length})`);
    await log(`[LLM] extractProfile starting`);
    const result = await this.structured(
      `Extract structured profile data from this resume. Return a JSON object with these fields:
        - role: best job title fit for this person (string)
        - location: their location (string, or null)
        - work_style: "Remote" | "Hybrid" | "Onsite" | null
        - work_style_hint: extra context like "open to relocate" (string, or null)
        - experience: total experience as a readable string, e.g. "3 years", "1 year" (string)
        - experience_hint: extra context like "incl. 2 internships" (string, or null)
        - salary_target: salary expectation if mentioned, e.g. "₦400k – ₦700k / mo" (string, or null)
        - skills: array of skills (string[])
      Use null for missing optional fields. Use empty array for missing skills.\n\n${truncated}`,
      (raw: string) => {
        const cleaned = raw.replace(/```(?:json)?\s*/gi, "").trim();
        return JSON.parse(cleaned) as Record<string, unknown>;
      },
      { temperature: 0.1 },
    );
    logger.info(`[LLM] extractProfile done`);
    await log(`[LLM] extractProfile result: ${JSON.stringify(result).slice(0, 300)}`);
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

  async resumeScore(
    resumeText: string,
  ): Promise<{
    score: number;
    summary: string;
    issues: Array<{ category: string; severity: string; description: string }>;
    suggestions: string[];
  }> {
    logger.info(`[LLM] resumeScore (text=${resumeText.length} chars)`);
    await log(`[LLM] resumeScore starting`);
    const result = await this.structured(
      `You are an ATS resume analyzer. Score this resume from 0.0 to 1.0.
      Criteria:
      - ATS compatibility: standard section headers (Experience, Education, Skills), no tables/columns, clean formatting
      - Content quality: quantifiable achievements, action verbs, Google XYZ format (Accomplished X by doing Y resulting in Z)
      - Completeness: contact info, summary/objective, skills, experience with dates, education
      - Conciseness: one page, no fluff, relevant content only

      Resume:
      ${resumeText.slice(0, 6000)}

      Return JSON with:
      - score: number (0.0-1.0)
      - summary: string (one-sentence assessment)
      - issues: array of { category: "ats"|"content"|"format"|"completeness", severity: "high"|"medium"|"low", description: string }
      - suggestions: string[] (actionable improvement tips)`,
      (raw: string) => {
        const cleaned = sanitizeJsonString(raw.replace(/```(?:json)?\s*/gi, "").trim());
        return JSON.parse(cleaned) as {
          score: number;
          summary: string;
          issues: Array<{ category: string; severity: string; description: string }>;
          suggestions: string[];
        };
      },
      { temperature: 0.1, max_tokens: 2048 },
    );
    logger.info(`[LLM] resumeScore done — score=${result.score}`);
    await log(`[LLM] resumeScore result: score=${result.score} issues=${result.issues.length}`);
    return result;
  }

  private async rewriteSections(
    resumeText: string,
    sections: string[],
    instruction: string,
  ): Promise<string> {
    logger.info(`[LLM] rewriteSections (text=${resumeText.length} chars, sections=${sections.length})`);
    await log(`[LLM] rewriteSections starting (${sections.join(", ")})`);

    const targetSections = new Set(
      sections
        .map((section) => section.trim().toLowerCase())
        .filter((section) => section.length > 0),
    );
    const matches = Array.from(resumeText.matchAll(/^##\s+(.+)$/gm));

    if (matches.length === 0 || targetSections.size === 0) {
      logger.info(`[LLM] rewriteSections done — rewritten=0`);
      await log(`[LLM] rewriteSections result: rewritten=0`);
      return resumeText;
    }

    const firstMatch = matches[0];
    const firstHeaderIndex = firstMatch?.index ?? 0;
    const reassembled: string[] = [resumeText.slice(0, firstHeaderIndex)];
    let rewrittenCount = 0;

    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      if (!match || match.index === undefined) continue;

      const sectionName = match[1]?.trim() ?? "";
      const header = match[0];
      const contentStart = match.index + header.length;
      const nextHeaderIndex = matches[index + 1]?.index ?? resumeText.length;
      const sectionContent = resumeText.slice(contentStart, nextHeaderIndex);
      let content = sectionContent;

      if (targetSections.has(sectionName.toLowerCase())) {
        const result = await this.structured(
          `Rewrite this resume section in Google XYZ format:
"Accomplished X by doing Y resulting in Z"

Section name: ${sectionName}
Current content:
${sectionContent}

User instruction: ${instruction}

Return JSON with:
- content: string (rewritten section in markdown)`,
          (raw: string) => {
            const cleaned = sanitizeJsonString(raw.replace(/```(?:json)?\s*/gi, "").trim());
            return JSON.parse(cleaned) as { content: string };
          },
          { temperature: 0.1, max_tokens: 2048 },
        );
        content = result.content;
        rewrittenCount += 1;
      }

      reassembled.push(`${header}${content}`);
    }

    const rewrittenResume = reassembled.join("");
    logger.info(`[LLM] rewriteSections done — rewritten=${rewrittenCount}`);
    await log(`[LLM] rewriteSections result: rewritten=${rewrittenCount}`);
    return rewrittenResume;
  }

  async improveResume(
    resumeText: string,
    instruction: string,
  ): Promise<{
    resume_text: string;
    changes: string[];
    score: number;
    issues: Array<{ category: string; severity: string; description: string }>;
    suggestions: string[];
  }> {
    logger.info(`[LLM] improveResume (text=${resumeText.length} chars)`);
    await log(`[LLM] improveResume starting`);
    const stage1 = await this.structured(
      `You are a professional resume writer. Rewrite the resume below in Google XYZ format:
      "Accomplished X by doing Y resulting in Z"

      Requirements:
      - Google XYZ format for EVERY bullet point
      - One page maximum — trim irrelevant content
      - ATS-friendly: standard section headers, clean markdown, no tables
      - Quantifiable achievements with metrics
      - Keep all factual information accurate — do not fabricate numbers
      - Use strong action verbs (delivered, increased, reduced, led, built)

      User's improvement request:
      ${instruction}

      Current resume:
      ${resumeText.slice(0, 6000)}

      Return JSON with:
      - resume_text: string (the FULL rewritten resume as clean markdown)
      - changes: string[] (list of what was changed)
      - score: number (new ATS score 0.0-1.0)
      - issues: array of { category: string, severity: string, description: string }
      - suggestions: string[]`,
      (raw: string) => {
        const cleaned = sanitizeJsonString(raw.replace(/```(?:json)?\s*/gi, "").trim());
        return JSON.parse(cleaned) as {
          resume_text: string;
          changes: string[];
          score: number;
          issues: Array<{ category: string; severity: string; description: string }>;
          suggestions: string[];
        };
      },
      { temperature: 0.3, max_tokens: 4096 },
    );

    let validation: {
      xyz_compliant: boolean;
      section_headers_valid: boolean;
      one_page: boolean;
      issues: Array<{ category: string; severity: string; description: string }>;
      sections_to_rewrite: string[];
    };
    try {
      validation = await this.validateResume(stage1.resume_text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[LLM] improveResume validation failed (non-fatal): ${message}`);
      validation = {
        xyz_compliant: false,
        section_headers_valid: false,
        one_page: false,
        issues: [],
        sections_to_rewrite: [],
      };
    }

    const { resume_text, fixes_applied, issues_remaining } = reformatResumeMarkdown(stage1.resume_text);

    let finalText = resume_text;
    if (validation.sections_to_rewrite.length > 0 && !validation.xyz_compliant) {
      try {
        finalText = await this.rewriteSections(resume_text, validation.sections_to_rewrite, instruction);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[LLM] improveResume rewriteSections failed (non-fatal): ${message}`);
        finalText = resume_text;
      }
    }

    let finalScore: {
      score: number;
      summary: string;
      issues: Array<{ category: string; severity: string; description: string }>;
      suggestions: string[];
    };
    try {
      finalScore = await this.resumeScore(finalText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[LLM] improveResume finalScore failed (non-fatal): ${message}`);
      finalScore = { score: stage1.score, summary: '', issues: [], suggestions: [] };
    }

    const changesCount = stage1.changes.length + fixes_applied.length;
    logger.info(`[LLM] improveResume done — score=${finalScore.score} changes=${changesCount}`);
    await log(`[LLM] improveResume result: score=${finalScore.score} changes=${changesCount}`);

    return {
      resume_text: finalText,
      changes: [...stage1.changes, ...fixes_applied],
      score: finalScore.score,
      issues: [
        ...finalScore.issues,
        ...issues_remaining.map((issue) => ({
          category: 'format',
          severity: 'medium',
          description: issue,
        })),
      ],
      suggestions: finalScore.suggestions,
    };
  }

  async validateResume(
    resumeText: string,
  ): Promise<{
    xyz_compliant: boolean;
    section_headers_valid: boolean;
    one_page: boolean;
    issues: Array<{ category: string; severity: string; description: string }>;
    sections_to_rewrite: string[];
  }> {
    logger.info(`[LLM] validateResume (text=${resumeText.length} chars)`);
    await log(`[LLM] validateResume starting`);

    if (await this.isRateLimited(this.primaryModel)) {
      logger.warn('[LLM] validateResume skipped — rate limited');
      await log('[LLM] validateResume SKIPPED (rate limited)');
      return {
        xyz_compliant: false,
        section_headers_valid: false,
        one_page: false,
        issues: [
          {
            category: 'rate_limit',
            severity: 'high',
            description: 'Resume validation could not be completed because the LLM is rate limited.',
          },
        ],
        sections_to_rewrite: [],
      };
    }

    const raw = await this.reason(
      `Analyze this resume for Google XYZ format compliance and structural rules.

Resume:
${resumeText}

Check:
1. XYZ FORMAT: Is every bullet point in "Accomplished X by doing Y resulting in Z" format?
2. SECTION HEADERS: Does it have required sections (Experience, Education, Skills)?
3. ONE PAGE: Is content concise enough for one page (~3000 chars)?

Return JSON with:
- xyz_compliant: boolean
- section_headers_valid: boolean
- one_page: boolean
- issues: array of { category, severity, description }
- sections_to_rewrite: string[] (list of section names that need rewriting)`,
      { temperature: 0.2, max_tokens: 2048 },
    );
    const cleaned = sanitizeJsonString(raw.replace(/```(?:json)?\s*/gi, "").trim());
    const result = JSON.parse(cleaned) as {
      xyz_compliant: boolean;
      section_headers_valid: boolean;
      one_page: boolean;
      issues: Array<{ category: string; severity: string; description: string }>;
      sections_to_rewrite: string[];
    };

    logger.info(`[LLM] validateResume done — issues=${result.issues.length} rewrite_sections=${result.sections_to_rewrite.length}`);
    await log(`[LLM] validateResume result: xyz=${result.xyz_compliant} headers=${result.section_headers_valid} one_page=${result.one_page} issues=${result.issues.length}`);
    return result;
  }
}

export { LLM };
export type { LLMModel, CompletionOptions };

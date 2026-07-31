/**
 * Resume Builder Controller
 * 
 * Manages interactive resume building sessions:
 * - Redis session storage for structured resume fields
 * - Hybrid LLM-driven chat for data collection
 * - ATS scoring and optimization
 * - PDF generation via Render server
 */

import { RedisModel } from '../model/redis.js';
import { LLM } from '../model/LLM.js';
import { scoreResume, type ATSScoreResult } from '../utils/atsScorer.js';
import { log, logger } from '../utils/logger.js';
import type { DatabaseLike } from '../model/database.js';
import { htmlToPdf } from '../utils/pdfGenerator.js';

// ── Constants ──────────────────────────────────────────────────

const EMPTY_ATS_SCORE: ATSScoreResult = {
  score: 0,
  grade: 'F',
  sections: [],
  issues: [],
  suggestions: [],
};

// ── Types ──────────────────────────────────────────────────────

interface ResumeSession {
  id: string;
  userId: string;
  full_name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  summary: string;
  skills: SkillCategory[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  certifications: CertificationEntry[];
  chat_history: ChatMessage[];
  pending_facts?: PendingFact[];
  ats_score: ATSScoreResult | null;
  resume_text: string;
  created_at: string;
  updated_at: string;
}

interface PendingFact {
  claim: string;
  status: 'claimed' | 'verified';
}

interface SkillCategory {
  name: string;
  skills: string[];
}

interface ExperienceEntry {
  company: string;
  role: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface ProjectEntry {
  name: string;
  description: string[];
  technologies: string[];
}

interface EducationEntry {
  institution: string;
  degree: string;
  year: string;
}

interface CertificationEntry {
  name: string;
  issuer: string;
  year: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatResponse {
  message: string;
  session: Partial<ResumeSession>;
  ats_score: ATSScoreResult;
  missing_fields: string[];
  is_complete: boolean;
}

/** Structured interview state — tracks what evidence has been extracted per entry */
interface CVState {
  experience_completeness: Record<number, ExperienceCompleteness>;
  skills_asked: boolean;
  education_depth: 'none' | 'basic' | 'detailed';
  summary_quality: 'none' | 'basic' | 'good' | 'strong';
  contacted: boolean;
  what_else_offered: boolean;
}

interface ExperienceCompleteness {
  has_role: boolean;
  has_company: boolean;
  has_dates: boolean;
  has_bullets: boolean;
  has_impact: boolean;
  has_technologies: boolean;
  has_projects: boolean;
  depth: 'none' | 'basic' | 'detailed' | 'deep';
}

// ── Constants ──────────────────────────────────────────────────

const SESSION_PREFIX = 'resume:session:';
const SESSION_EXPIRY = 86400 * 7; // 7 days

const REQUIRED_FIELDS = [
  'full_name',
  'email',
  'phone',
  'location',
  'summary',
  'skills',
  'experience',
  'education',
] as const;

const OPTIONAL_FIELDS = [
  'linkedin_url',
  'github_url',
  'portfolio_url',
  'projects',
  'certifications',
] as const;

/** LLM response shape — the ONLY thing the model is allowed to return */
interface ParsedLlmResponse {
  message: string;
  updates?: Partial<ResumeSession>;
  extracted_facts?: {
    achievements: string[] | null;
    technologies: string[] | null;
    impact: string | null;
    projects: string[] | null;
    skills_mentioned: string[] | null;
  };
  pending_verification?: string[] | null;
  next_focus?: string;
}

/**
 * Parse a raw LLM response as strict JSON. Strips accidental markdown fences,
 * then validates. Returns null when the response is not parseable as JSON —
 * the caller must re-prompt rather than pass raw text through.
 */
function parseLlmJson(raw: string): ParsedLlmResponse | null {
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<ParsedLlmResponse>;
    if (typeof parsed?.message !== 'string' || parsed.message.length === 0) return null;
    return parsed as ParsedLlmResponse;
  } catch {
    return null;
  }
}

/**
 * Deterministic plausibility gate — flags claims that should be corroborated
 * before they become resume bullet points. Catches: currency amounts, "X%
 * increase"-style impact, awards, and large adoption/revenue figures. This is
 * intentionally a cheap regex heuristic, not an LLM judgment call.
 */
function detectSuspiciousClaims(text: string): string[] {
  const patterns: RegExp[] = [
    /(?:[$€£₦]|USD|NGN)\s?\d[\d,.]*\s?(?:thousand|million|billion|k|m|b)?/gi,
    /\d[\d,.]*\s?(?:thousand|million|billion|k|m|b)?\s?(?:users|customers|clients|downloads|revenue|requests|transactions|ARR|MRR|DAU|MAU)/gi,
    /\d[\d,.]*\s?%\s?(?:increase|growth|reduction|improvement|boost|uplift|rise|jump|decrease|drop)/gi,
    /\d[\d,.]*(?:x|X)\s?(?:increase|growth|improvement|faster|speedup|boost)/gi,
    /\b(?:won|awarded|award|recognized as|named|recipient of)\b/gi,
  ];
  const hits = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const snippet = m[0].trim();
      if (snippet.length > 1) hits.add(snippet);
    }
  }
  return [...hits].slice(0, 5);
}

function claimTokens(claim: string): string[] {
  const matches = claim.match(/\$?[\d,.]+\s*(?:%|percent|thousand|million|billion|k|m|b)?/gi) ?? [];
  return matches
    .map(m => m.toLowerCase().replace(/[^a-z0-9%$]/g, ''))
    .filter(t => /\d/.test(t));
}

/**
 * Best-effort check: does a resume value (bullet/summary/project description)
 * contain a claim we're holding as unverified? Uses compact-form matching so
 * "2 million" in a claim matches "2m" in a bullet and vice versa.
 */
function containsClaim(value: string, claim: string): boolean {
  const compact = value.toLowerCase().replace(/\s+/g, '');
  const claimLower = claim.toLowerCase().replace(/\s+/g, '');
  if (compact.includes(claimLower)) return true;
  for (const t of claimTokens(claim)) {
    if (compact.includes(t)) return true;
    const short = t.replace(/(million|thousand|billion)$/, c =>
      c === 'million' ? 'm' : c === 'thousand' ? 'k' : 'b');
    if (short !== t && compact.includes(short)) return true;
  }
  return false;
}

/**
 * Does the user's message read as an explicit confirmation of pending claims?
 * Short affirmative answers count; longer messages need measurement context so
 * a plain "yes, and also I led the team" doesn't accidentally verify numbers.
 */
function isClaimConfirmation(message: string, pendingFacts: PendingFact[]): boolean {
  if (pendingFacts.length === 0) return false;
  const lower = message.toLowerCase().trim();
  if (lower.length === 0) return false;
  const confirmToken = /\b(yes|correct|that'?s right|accurate|verified|confirmed|exactly|indeed|sure|go ahead|include it|100%)\b/.test(lower);
  if (!confirmToken) return false;
  if (lower.length < 40) return true;
  return /\b(measured|tracked|data|metrics?|reported|analytics|dashboard|internal|estimate|report|confirmed|verified)\b/.test(lower);
}

const CV_COACH_SYSTEM_PROMPT = `You are Hroute's CV Interviewer — a sharp, warm assistant whose job is to extract strong, evidence-based CV content from the user.

YOUR PURPOSE IS NOT TO COMPLETE A FORM.
Your purpose is to discover evidence that makes the user's CV stronger.

CORE INTERVIEW STRATEGY

Every user message should either:
1. Provide new CV information
2. Clarify existing information
3. Answer your previous question
4. Ask for guidance ("what else?")
5. Change the topic
6. Indicate they want to stop

Extract useful information from EVERY response before deciding what to ask next.

QUESTION PRIORITY (high to low):
1. Achievements and outcomes — what changed because of their work
2. Quantifiable impact — numbers, percentages, scale, users, revenue
3. Projects they shipped — what they personally built
4. Personal contribution — what THEY did, not the team
5. Responsibilities — what they owned
6. Technologies — how they used them
7. Leadership and collaboration — what they led, team size
8. Problems solved — specific challenges
9. Dates and context
10. Contact/administrative details

Do NOT ask for lower-priority information when higher-priority information is still missing for an experience entry.

CONVERSATION RULES:
- Ask only ONE question at a time. No stacked questions.
- Questions must be specific to what the user just said. Never generic.
- Never repeat a question that's already been answered.
- Do NOT use filler like "That's a good start" or "Great experience."
- Do NOT unnecessarily restate what the user said — brief acknowledgment is fine.
- Do NOT declare the CV complete — the application decides that.
- If the user asks "what else?", explain what useful information is still missing based on what they've told you so far. Give them 2-3 concrete options.
- If the user gives a vague answer, ask for a concrete example.
- If the user mentions a project, investigate that project before changing topics.
- If the user mentions an achievement, ask about its impact.
- If the user mentions a technology, ask how they used it.
- If the user mentions a leadership, ask what they led and what the result was.

CLAIM VERIFICATION:
- If a user's claim seems inflated or hard to verify (e.g., large revenue figures, awards, adoption numbers), ask one clarifying question before accepting it into the resume data. Don't refuse or accuse — just ask for the source or context.
- For quantifiable claims (numbers, percentages, dollar amounts), ask how it was measured: "How did you measure that?" or "Was this an internal metric you had access to, or an estimate?"
- Claims that have not been substantiated go into "pending_verification", NOT into "updates". Only once the user confirms the figure or explains how it was measured should the value move into "updates".
- Do not put a pending figure into both "pending_verification" and "updates" — it must be in exactly one place.

DIGGING INTO EXPERIENCE — PROGRESSIVE QUESTION PATTERN:
Level 1: "What did you personally build or do there?"
Level 2: "What technologies did you use?"
Level 3: "How many users/clients was it serving?"
Level 4: "What changed after you shipped it?"

Each level reveals a stronger CV bullet point.

WHAT NOT TO DO:
- Never follow a fixed question order
- Never ask for phone number if they just told you about a project they shipped
- Never ask about education if they just described a leadership achievement
- Never say the resume is ready — that's the app's job
- Never invent details about the user

CALIBRATION:
Talk like a recruiter who's good at interviewing candidates — attentive, specific, evidence-seeking. Not a form, not a hype-man. Short messages, one question, mobile-chat length. If something is weak, say so plainly and suggest a concrete fix.

OUTPUT FORMAT — respond with ONLY a single valid JSON object. No text before or after it. Do not repeat the "message" field's content outside the JSON. Do not wrap it in markdown code fences. Failure to return valid JSON will be rejected and re-prompted:
{
  "message": "string — your response to the user, ONE question at the end",
  "updates": { /* Partial<ResumeSession> — any fields to update based on what the user just said. Unverified claims must NOT appear here. */ },
  "extracted_facts": {
    "achievements": ["string"] | null,
    "technologies": ["string"] | null,
    "impact": "string" | null,
    "projects": ["string"] | null,
    "skills_mentioned": ["string"] | null
  },
  "pending_verification": ["string"] | null,
  "next_focus": "experience" | "education" | "skills" | "projects" | "summary" | "contact" | "achievements" | "guidance"
}`;

// ── Main Controller ────────────────────────────────────────────

class ResumeBuilderController {
  private redis: RedisModel;
  private llm: LLM;
  private db: DatabaseLike;
  private lastScoredLength = 0;

  constructor(db: DatabaseLike) {
    this.redis = new RedisModel();
    this.llm = new LLM();
    this.db = db;
  }

  /**
   * Create a new resume session
   */
  async createSession(userId: string, token?: string, initialData?: Partial<ResumeSession>): Promise<ResumeSession> {
    const sessionId = this.generateSessionId();
    const now = new Date().toISOString();

    let preFilled: Partial<ResumeSession> = {};
    if (token) {
      preFilled = await this.fetchExistingProfile(token);
    }

    const merged = { ...preFilled, ...initialData };

    const session: ResumeSession = {
      id: sessionId,
      userId,
      full_name: merged.full_name ?? '',
      email: merged.email ?? '',
      phone: merged.phone ?? '',
      location: merged.location ?? '',
      linkedin_url: merged.linkedin_url,
      github_url: merged.github_url,
      portfolio_url: merged.portfolio_url,
      summary: merged.summary ?? '',
      skills: merged.skills ?? [],
      experience: merged.experience ?? [],
      projects: merged.projects ?? [],
      education: merged.education ?? [],
      certifications: merged.certifications ?? [],
      chat_history: merged.chat_history ?? [],
      pending_facts: merged.pending_facts ?? [],
      ats_score: null,
      resume_text: '',
      created_at: now,
      updated_at: now,
    };

    // Store in Redis
    await this.redis.setWithExpiry({
      key: `${SESSION_PREFIX}${sessionId}`,
      value: JSON.stringify(session),
      expiry: SESSION_EXPIRY,
    });

    // Update user profile
    await this.updateUserProfile(userId, { resume_session_id: sessionId });

    logger.info(`[ResumeBuilder] Created session ${sessionId} for user ${userId}`);
    await log(`[ResumeBuilder] Session created: ${sessionId}`);

    return session;
  }

  /**
   * Get an existing session
   */
  async getSession(sessionId: string): Promise<ResumeSession | null> {
    const data = await this.redis.get({ key: `${SESSION_PREFIX}${sessionId}` });
    if (!data) return null;

    try {
      return JSON.parse(data) as ResumeSession;
    } catch (e) {
      logger.error(`[ResumeBuilder] Failed to parse session ${sessionId}: ${e}`);
      return null;
    }
  }

  /**
   * Process a chat message and update session
   */
  async processMessage(
    sessionId: string,
    message: string
  ): Promise<ChatResponse> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Promote previously-claimed facts to verified when the user confirms them
    const unverifiedFacts = (session.pending_facts ?? []).filter(f => f.status === 'claimed');
    if (unverifiedFacts.length > 0 && isClaimConfirmation(message, unverifiedFacts)) {
      session.pending_facts = session.pending_facts!.map(f =>
        f.status === 'claimed' ? { ...f, status: 'verified' } : f
      );
    }

    // Compute structured interview state
    const state = this.computeInterviewState(session);

    // Deterministic plausibility gate — flag claims for corroboration before
    // they can become resume bullet points
    const suspiciousClaims = detectSuspiciousClaims(message);

    // Build context for LLM — no fixed field order, feed state
    const context = this.buildChatContext(session, state);

    // Call LLM with full chat history threaded as proper messages
    let llmResponse: string;
    try {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: "system", content: CV_COACH_SYSTEM_PROMPT },
      ];

      // Thread chat history from Redis so the LLM sees the full conversation
      for (const m of session.chat_history ?? []) {
        messages.push({ role: m.role, content: m.content });
      }

      // Current message with session context
      let userContent = `${context}\n\nUser just said: ${message}`;
      if (suspiciousClaims.length > 0) {
        userContent += `\n\nCLAIM CHECK: The user just made the following claim(s) that need corroboration before they can enter the resume data: ${suspiciousClaims.join('; ')}. Ask ONE question about how the most significant claim was measured or verified (e.g. "How did you measure that?" or "Was that an internal company metric you had access to, or an estimate?"). Do NOT write these figures into "updates" this turn — list them under "pending_verification" instead.`;
      }
      messages.push({ role: "user", content: userContent });

      llmResponse = await this.llm.complete(
        messages,
        { temperature: 0.3, max_tokens: 2048 },
      );
    } catch (err) {
      logger.error(`[ResumeBuilder] LLM call failed for session ${sessionId}:`, err);
      await log(`[ResumeBuilder] LLM error: ${String(err).slice(0, 200)}`);
      return {
        message: "I'm having trouble connecting right now. Please try again in a moment.",
        session,
        ats_score: session.ats_score ?? EMPTY_ATS_SCORE,
        missing_fields: this.getMissingFields(session),
        is_complete: false,
      };
    }

    // Strict JSON contract — never pass raw text through. If the response is
    // not valid JSON, re-prompt once with a corrective instruction.
    let parsed = parseLlmJson(llmResponse);
    if (!parsed) {
      logger.warn(`[ResumeBuilder] LLM returned non-JSON for session ${sessionId}; re-prompting`);
      await log(`[ResumeBuilder] LLM non-JSON response: ${llmResponse.slice(0, 200)}`);
      try {
        const retryMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: "system", content: CV_COACH_SYSTEM_PROMPT },
          ...(session.chat_history ?? []).map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: `${context}\n\nUser just said: ${message}` },
          { role: "assistant", content: llmResponse },
          { role: "user", content: "Your last output was not valid JSON. Return ONLY the single JSON object described in the system prompt. No text before or after it, no markdown fences." },
        ];
        llmResponse = await this.llm.complete(retryMessages, { temperature: 0.3, max_tokens: 2048 });
        parsed = parseLlmJson(llmResponse);
      } catch (retryErr) {
        logger.error(`[ResumeBuilder] JSON retry failed for session ${sessionId}:`, retryErr);
      }
    }
    if (!parsed) {
      logger.warn(`[ResumeBuilder] LLM still non-JSON for session ${sessionId}; degrading gracefully`);
      return {
        message: "I'm having trouble formulating my response right now. Please try again in a moment.",
        session,
        ats_score: session.ats_score ?? EMPTY_ATS_SCORE,
        missing_fields: this.getMissingFields(session),
        is_complete: false,
      };
    }

    const updatedSession = await this.processLlmResponse(session, parsed, message);

    // Chat message is always pulled from the parsed JSON — never raw text
    const chatMessage = parsed.message;

    const now = new Date().toISOString();
    updatedSession.chat_history = [
      ...(updatedSession.chat_history ?? []),
      { role: "user", content: message, timestamp: now },
      { role: "assistant", content: chatMessage, timestamp: now },
    ];

    // Recalculate combined score (ATS structural + LLM quality)
    // Skip LLM scoring on every message to avoid score fluctuation — only re-score
    // when the resume text has grown >30% since last LLM call.
    const resumeText = this.generateResumeText(updatedSession);
    const shouldRunLLM = resumeText.length > this.lastScoredLength * 1.3;
    const atsScore = shouldRunLLM
      ? await this.computeScore(resumeText)
      : scoreResume(resumeText);
    if (shouldRunLLM) this.lastScoredLength = resumeText.length;

    updatedSession.ats_score = atsScore;
    updatedSession.resume_text = resumeText;
    updatedSession.updated_at = new Date().toISOString();

    // Save updated session
    await this.redis.setWithExpiry({
      key: `${SESSION_PREFIX}${sessionId}`,
      value: JSON.stringify(updatedSession),
      expiry: SESSION_EXPIRY,
    });

    // App-level completion: build is ready when we have sufficient data
    const stateAfterSave = this.computeInterviewState(updatedSession);
    const isComplete = this.isReadyToBuild(stateAfterSave, updatedSession);

    // Generate response message
    const responseMessage = this.generateResponseMessage(
      chatMessage,
      atsScore,
      isComplete
    );

    return {
      message: responseMessage,
      session: updatedSession,
      ats_score: atsScore,
      missing_fields: this.getMissingFields(updatedSession),
      is_complete: isComplete,
    };
  }

  /**
   * Update session fields manually
   */
  async updateSession(
    sessionId: string,
    updates: Partial<ResumeSession>
  ): Promise<ResumeSession> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Merge updates
    const updatedSession: ResumeSession = {
      ...session,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    // Recalculate ATS score if resume text changed
    if (updates.resume_text || updates.summary || updates.skills || updates.experience) {
      const resumeText = this.generateResumeText(updatedSession);
      updatedSession.resume_text = resumeText;
      updatedSession.ats_score = this.computeScore(resumeText);
    }

    // Save updated session
    await this.redis.setWithExpiry({
      key: `${SESSION_PREFIX}${sessionId}`,
      value: JSON.stringify(updatedSession),
      expiry: SESSION_EXPIRY,
    });

    logger.info(`[ResumeBuilder] Updated session ${sessionId}`);
    return updatedSession;
  }

  /**
   * Generate final resume text from session
   */
  async generateResume(sessionId: string, token?: string): Promise<{
    resume_text: string;
    ats_score: ATSScoreResult;
    pdf_url?: string;
  }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const resumeText = this.generateResumeText(session);
    const atsScore = await this.computeScore(resumeText);

    await this.updateSession(sessionId, {
      resume_text: resumeText,
      ats_score: atsScore,
    });

    let pdfUrl: string | undefined;
    if (token) {
      pdfUrl = await this.uploadPdfToStorage(token, resumeText, session.full_name || 'Resume');
    }

    return {
      resume_text: resumeText,
      ats_score: atsScore,
      pdf_url: pdfUrl,
    };
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await this.redis.delete(`${SESSION_PREFIX}${sessionId}`);
    logger.info(`[ResumeBuilder] Deleted session ${sessionId}`);
    return true;
  }

  // ── Private Helpers ──────────────────────────────────────────

  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private getMissingFields(session: ResumeSession): string[] {
    const missing: string[] = [];

    for (const field of REQUIRED_FIELDS) {
      const value = session[field];

      if (field === 'experience') {
        const entries = value as typeof session.experience;
        if (!Array.isArray(entries) || entries.length === 0) {
          missing.push(field);
        } else {
          const hasSubstantive = entries.some(e =>
            e.company.trim() && e.role.trim() && e.bullets.some(b => b.trim().length > 10)
          );
          if (!hasSubstantive) missing.push(field);
        }
      } else if (field === 'skills') {
        const entries = value as typeof session.skills;
        if (!Array.isArray(entries) || entries.length === 0) {
          missing.push(field);
        } else {
          const hasSubstantive = entries.some(c =>
            c.skills.some(s => s.trim().length > 0)
          );
          if (!hasSubstantive) missing.push(field);
        }
      } else if (field === 'education') {
        const entries = value as typeof session.education;
        if (!Array.isArray(entries) || entries.length === 0) {
          missing.push(field);
        } else {
          const hasSubstantive = entries.some(e =>
            e.institution.trim() && e.degree.trim()
          );
          if (!hasSubstantive) missing.push(field);
        }
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          missing.push(field);
        }
      } else if (!value || (typeof value === 'string' && value.trim() === '')) {
        missing.push(field);
      }
    }

    return missing;
  }

  /**
   * Compute structured interview state — tracks what evidence has
   * been collected and how deep each entry's coverage is. Used by the
   * app layer (not the LLM) for completion & context decisions.
   */
  private computeInterviewState(session: ResumeSession): CVState {
    return {
      experience_completeness: session.experience.map(e => ({
        has_role: e.role.trim().length > 0,
        has_company: e.company.trim().length > 0,
        has_dates: e.start_date.trim().length > 0 || e.end_date.trim().length > 0,
        has_bullets: e.bullets.some(b => b.trim().length > 10),
        has_impact: e.bullets.some(b => /\d+|reduce|increase|grew|led|managed|built|created|designed|improved|delivered|launched|shipped|scaled|optimized/i.test(b)),
        has_technologies: e.bullets.some(b => /[A-Z][a-z]+|[A-Z]{2,}/.test(b)),
        has_projects: false,
        depth: !e.bullets.length ? 'none' : e.bullets.length <= 2 ? 'basic' : e.bullets.length <= 4 ? 'detailed' : 'deep',
      })),
      skills_asked: session.skills.length > 0,
      education_depth: !session.education.length ? 'none'
        : session.education.some(e => e.institution.trim() && e.degree.trim()) ? 'detailed' : 'basic',
      summary_quality: !session.summary ? 'none'
        : session.summary.length < 50 ? 'basic'
        : session.summary.length < 150 ? 'good' : 'strong',
      contacted: session.email.trim().length > 0 && session.full_name.trim().length > 0,
      what_else_offered: false,
    };
  }

  /**
   * App-level completion check. Returns true when we have sufficient
   * data to build a reasonable resume — does NOT require every field
   * to be filled perfectly.
   */
  private isReadyToBuild(state: CVState, session: ResumeSession): boolean {
    // Must have contact info
    if (!state.contacted) return false;

    // Must have at least one experience with role + company + bullet
    const hasGoodExperience = state.experience_completeness.some(
      e => e.has_role && e.has_company && e.has_bullets
    );
    if (!hasGoodExperience) return false;

    // Must have at least one skill
    if (!state.skills_asked) return false;

    // Must have basic education
    if (state.education_depth === 'none') return false;

    // Must have some summary
    if (state.summary_quality === 'none') return false;

    // If all basics are met AND one experience entry has deep coverage → ready
    const hasDeepExperience = state.experience_completeness.some(e => e.depth === 'deep' || e.depth === 'detailed');
    if (hasDeepExperience) return true;

    // If ATS score is already decent (60+) → ready
    if (session.ats_score && session.ats_score.score >= 60) return true;

    // If at least 2 higher-priority things have quality → ready
    const qualityCount = [
      state.summary_quality === 'good' || state.summary_quality === 'strong',
      hasGoodExperience,
      state.experience_completeness.some(e => e.has_impact),
      state.education_depth === 'detailed',
    ].filter(Boolean).length;
    return qualityCount >= 2;
  }

  private buildChatContext(
    session: ResumeSession,
    state: CVState,
  ): string {
    const currentData = JSON.stringify(session, null, 2);

    const stateSummary = `Experience: ${session.experience.map((e, i) => {
      const s = state.experience_completeness[i];
      return s ? `[${i}] ${e.role || e.company || 'entry'} — role=${s.has_role}, company=${s.has_company}, bullets=${s.has_bullets}, impact=${s.has_impact}, depth=${s.depth}` : `[${i}] raw`;
    }).join('; ') || 'none'}

Skills: ${state.skills_asked ? `collected (${session.skills.length} categories)` : 'not yet discussed'}
Education: ${state.education_depth}
Summary: ${state.summary_quality}
Contact: ${state.contacted ? 'complete' : 'incomplete'}`;

    const claimStatus = (session.pending_facts ?? []).length > 0
      ? `\n\nClaim verification status:
${(session.pending_facts ?? []).map(f => `- "${f.claim}" — ${f.status}`).join('\n')}`
      : '';

    return `Current session data:
${currentData}

Coverage state (what's been collected so far):
${stateSummary}
${claimStatus}

Follow the system prompt's interview strategy. Respond with the OUTPUT FORMAT shown in the system prompt.`;
  }

  private async processLlmResponse(
    session: ResumeSession,
    parsed: ParsedLlmResponse,
    userMessage: string
  ): Promise<ResumeSession> {
    try {
      const updatedSession = { ...session };
      const pendingFacts = [...(updatedSession.pending_facts ?? [])];
      for (const claim of parsed.pending_verification ?? []) {
        const c = claim.trim();
        if (c.length > 0 && !pendingFacts.some(f => f.claim.toLowerCase() === c.toLowerCase())) {
          pendingFacts.push({ claim: c, status: 'claimed' });
        }
      }
      updatedSession.pending_facts = pendingFacts;

      // Backstop: strip unverified claims from updates before they reach the resume
      const unverified = pendingFacts.filter(f => f.status === 'claimed').map(f => f.claim);
      if (unverified.length > 0 && parsed.updates) {
        const stripValues = (values: string[]): string[] =>
          values.filter(v => !unverified.some(c => containsClaim(v, c)));
        const summary = parsed.updates.summary;
        if (typeof summary === 'string' && unverified.some(c => containsClaim(summary, c))) {
          parsed.updates.summary = '';
        }
        if (Array.isArray(parsed.updates.experience)) {
          parsed.updates.experience = parsed.updates.experience.map(e => ({
            ...e,
            bullets: Array.isArray(e.bullets) ? stripValues(e.bullets) : e.bullets,
          }));
        }
        if (Array.isArray(parsed.updates.projects)) {
          parsed.updates.projects = parsed.updates.projects.map(p => ({
            ...p,
            description: Array.isArray(p.description) ? stripValues(p.description) : p.description,
          }));
        }
      }

      // Apply updates to session
      if (parsed.updates) {
        for (const [key, value] of Object.entries(parsed.updates)) {
          if (key in updatedSession && value !== undefined) {
            (updatedSession as Record<string, unknown>)[key] = value;
          }
        }
      }

      // If LLM sent extracted_facts with skills_mentioned, merge into skills
      if (parsed.extracted_facts?.skills_mentioned?.length) {
        const existingNames = new Set(
          (updatedSession.skills ?? []).flatMap(c => c.skills.map(s => s.toLowerCase()))
        );
        const newSkills = parsed.extracted_facts.skills_mentioned
          .map(s => s.trim())
          .filter(s => s.length > 0 && !existingNames.has(s.toLowerCase()));
        if (newSkills.length > 0) {
          if (!updatedSession.skills) updatedSession.skills = [];
          const existing = updatedSession.skills.find(c => c.name === 'General');
          if (existing) {
            existing.skills.push(...newSkills);
          } else {
            updatedSession.skills.push({ name: 'General', skills: newSkills });
          }
        }
      }

      // Normalize skills — LLM may return a string instead of SkillCategory[]
      if (typeof updatedSession.skills === "string") {
        const raw = updatedSession.skills as unknown as string;
        updatedSession.skills = [{ name: "General", skills: raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean) }];
      } else if (Array.isArray(updatedSession.skills)) {
        updatedSession.skills = updatedSession.skills.map((s: unknown) => {
          if (typeof s === "string") return { name: "General", skills: [s] };
          return s;
        });
      }

      // Normalize experience — LLM may return bullets as string or missing
      if (Array.isArray(updatedSession.experience)) {
        updatedSession.experience = updatedSession.experience.map((e: unknown) => {
          if (typeof e !== "object" || e === null) return { company: String(e ?? "Unknown"), role: "", start_date: "", end_date: "", bullets: [] };
          const exp = e as Record<string, unknown>;
          let bullets: string[] = [];
          if (Array.isArray(exp.bullets)) {
            bullets = exp.bullets.map(b => typeof b === "string" ? b : String(b));
          } else if (typeof exp.bullets === "string") {
            bullets = exp.bullets.split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
          } else if (exp.bullets === null || exp.bullets === undefined) {
            bullets = [];
          }
          return {
            company: String(exp.company ?? "Unknown"),
            role: String(exp.role ?? ""),
            start_date: String(exp.start_date ?? ""),
            end_date: String(exp.end_date ?? ""),
            bullets,
          };
        });
      }

      // Normalize projects — description and technologies may be strings
      if (Array.isArray(updatedSession.projects)) {
        updatedSession.projects = updatedSession.projects.map((p: unknown) => {
          if (typeof p !== "object" || p === null) return { name: String(p ?? "Project"), description: [], technologies: [] };
          const proj = p as Record<string, unknown>;
          const normalizeArr = (v: unknown): string[] => {
            if (Array.isArray(v)) return v.map(i => String(i));
            if (typeof v === "string") return [v];
            return [];
          };
          return {
            name: String(proj.name ?? "Project"),
            description: normalizeArr(proj.description),
            technologies: normalizeArr(proj.technologies),
          };
        });
      }

      // Normalize education
      if (Array.isArray(updatedSession.education)) {
        updatedSession.education = updatedSession.education.map((e: unknown) => {
          if (typeof e !== "object" || e === null) return { institution: String(e ?? ""), degree: "", field: "", start_date: "", end_date: "" };
          const edu = e as Record<string, unknown>;
          return {
            institution: String(edu.institution ?? ""),
            degree: String(edu.degree ?? ""),
            field: String(edu.field ?? ""),
            start_date: String(edu.start_date ?? ""),
            end_date: String(edu.end_date ?? ""),
          };
        });
      }

      return updatedSession;
    } catch (e) {
      logger.warn(`[ResumeBuilder] Failed to parse LLM response: ${e}`);
      // Return original session if parsing fails
      return session;
    }
  }

  private generateResumeText(session: ResumeSession): string {
    const lines: string[] = [];

    // Header
    lines.push(`# ${session.full_name}`);
    lines.push('');
    lines.push(`${session.location} • ${session.email} • ${session.phone}`);
    if (session.linkedin_url) lines.push(`LinkedIn: ${session.linkedin_url}`);
    if (session.github_url) lines.push(`GitHub: ${session.github_url}`);
    if (session.portfolio_url) lines.push(`Portfolio: ${session.portfolio_url}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Summary
    if (session.summary) {
      lines.push('# Summary');
      lines.push('');
      lines.push(session.summary);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Skills
    if (session.skills.length > 0) {
      lines.push('# Technical Skills');
      lines.push('');
      for (const category of session.skills) {
        lines.push(`## ${category.name}`);
        lines.push('');
        for (const skill of category.skills) {
          lines.push(`- ${skill}`);
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    // Experience
    if (session.experience.length > 0) {
      lines.push('# Work Experience');
      lines.push('');
      for (const exp of session.experience) {
        lines.push(`## ${exp.company} — ${exp.role}`);
        lines.push('');
        lines.push(`**${exp.start_date} – ${exp.end_date}**`);
        lines.push('');
        for (const bullet of exp.bullets) {
          lines.push(`- ${bullet}`);
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    // Projects
    if (session.projects.length > 0) {
      lines.push('# Projects');
      lines.push('');
      for (const project of session.projects) {
        lines.push(`## ${project.name}`);
        lines.push('');
        for (const desc of project.description) {
          lines.push(`- ${desc}`);
        }
        if (project.technologies.length > 0) {
          lines.push(`- Technologies: ${project.technologies.join(', ')}`);
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    // Education
    if (session.education.length > 0) {
      lines.push('# Education');
      lines.push('');
      for (const edu of session.education) {
        lines.push(`## ${edu.institution}`);
        lines.push('');
        lines.push(`${edu.degree}`);
        lines.push('');
        lines.push(`${edu.year}`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    // Certifications
    if (session.certifications.length > 0) {
      lines.push('# Certifications');
      lines.push('');
      for (const cert of session.certifications) {
        lines.push(`- ${cert.name} — ${cert.issuer} (${cert.year})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private generateResponseMessage(
    llmMessage: string,
    atsScore: ATSScoreResult,
    isComplete: boolean
  ): string {
    if (isComplete) {
      return llmMessage + '\n\nYour resume is ready! Click "Build" to generate it.';
    }
    if (atsScore.score >= 70 && isComplete) {
      return llmMessage;
    }
    return llmMessage;
  }

  private async updateUserProfile(
    userId: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    try {
      // This would call the database to update the user profile
      // For now, we'll just log it
      logger.info(`[ResumeBuilder] Updating profile for user ${userId}`);
    } catch (e) {
      logger.error(`[ResumeBuilder] Failed to update profile: ${e}`);
    }
  }

  private async fetchExistingProfile(token: string): Promise<Partial<ResumeSession>> {
    try {
      const profile = await this.db.getUser(token);
      if (profile.status !== 200) return {};

      const resumeText = String(profile.resume_text ?? '');
      if (!resumeText || resumeText.length < 20) return {};

      logger.info(`[ResumeBuilder] Pre-filling from existing resume (${resumeText.length} chars)`);
      await log(`[ResumeBuilder] Pre-filling session from existing resume`);

      const extracted = await this.llm.extractProfile(resumeText);

      const location = String(extracted.location ?? profile.location ?? '');

      let skills: SkillCategory[] = [];
      const rawSkills = extracted.skills;
      if (Array.isArray(rawSkills)) {
        const strings = rawSkills.filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
        if (strings.length > 0) {
          skills = [{ name: "General", skills: strings }];
        }
      }

      const experience: ExperienceEntry[] = [];
      const profileExp = profile.experience;
      if (typeof profileExp === "string" && profileExp.length > 0) {
        experience.push({
          company: '',
          role: String(extracted.role ?? ''),
          start_date: '',
          end_date: 'Present',
          bullets: profileExp.split(/\n/).filter((l: string) => l.trim().length > 0),
        });
      }

      return {
        full_name: String(profile.display_name ?? ''),
        email: String(profile.email ?? ''),
        location,
        summary: `Experienced ${String(extracted.role ?? 'professional')} based in ${location || 'unknown location'}.`,
        skills,
        experience,
      };
    } catch (e) {
      logger.warn(`[ResumeBuilder] Failed to pre-fill from profile: ${e}`);
      return {};
    }
  }

  private async computeScore(resumeText: string): Promise<ATSScoreResult> {
    const W_LLM = 0.4;
    const W_ATS = 0.6;
    const atsResult = scoreResume(resumeText);

    try {
      const llmResult = await this.llm.resumeScore(resumeText);
      const llmNormalized = Math.round(llmResult.score * 100);
      const combined = Math.round(W_LLM * llmNormalized + W_ATS * atsResult.score);

      return {
        ...atsResult,
        score: combined,
        suggestions: [...new Set([...llmResult.suggestions, ...atsResult.suggestions])],
      };
    } catch {
      return atsResult;
    }
  }

  private async uploadPdfToStorage(token: string, resumeText: string, name: string): Promise<string | undefined> {
    try {
      const html = `<html><body><div style="max-width:800px;margin:0 auto;font-family:Arial,sans-serif;line-height:1.6;">${resumeText.split('\n').map(line => {
        if (line.startsWith('# ')) return `<h1 style="margin:0 0 8px;">${line.slice(2)}</h1>`;
        if (line.startsWith('## ')) return `<h2 style="margin:16px 0 8px;font-size:14px;text-transform:uppercase;border-bottom:1px solid #ccc;padding-bottom:4px;">${line.slice(3)}</h2>`;
        if (line.startsWith('- ')) return `<li style="margin:2px 0;">${line.slice(2)}</li>`;
        if (line.startsWith('**') && line.endsWith('**')) return `<p style="margin:4px 0;"><strong>${line.slice(2, -2)}</strong></p>`;
        if (line.trim() === '---') return `<hr style="margin:12px 0;border:none;border-top:1px solid #ddd;">`;
        if (line.trim() === '') return '<br>';
        return `<p style="margin:2px 0;">${line}</p>`;
      }).join('\n')}</div></body></html>`;
      const pdfBuf = await htmlToPdf(html);
      const pdfBase64 = pdfBuf.toString('base64');

      const uploadResult = await this.db.uploadFile(token, {
        fileData: pdfBase64,
        filePath: 'generated',
        fileName: 'resume.pdf',
        contentType: 'application/pdf',
      });

      if (uploadResult.status !== 200) {
        logger.error(`[ResumeBuilder] Storage upload failed: ${uploadResult.response ?? 'unknown'}`);
        return undefined;
      }

      const signedUrlResult = await this.db.getGeneratedResumeUrl(token);
      const url = signedUrlResult.status === 200 && signedUrlResult.url ? signedUrlResult.url : undefined;

      logger.info(`[ResumeBuilder] PDF uploaded to storage (${pdfBuf.length} bytes)`);
      await log(`[ResumeBuilder] PDF uploaded: ${pdfBuf.length} bytes`);
      return url;
    } catch (e) {
      logger.warn(`[ResumeBuilder] PDF upload failed (non-fatal): ${e}`);
      return undefined;
    }
  }
}

// ── Exports ────────────────────────────────────────────────────

export { ResumeBuilderController };
export type {
  ResumeSession,
  SkillCategory,
  ExperienceEntry,
  ProjectEntry,
  EducationEntry,
  CertificationEntry,
  ChatMessage,
  ChatResponse,
};

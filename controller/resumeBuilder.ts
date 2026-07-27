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
  ats_score: ATSScoreResult | null;
  resume_text: string;
  created_at: string;
  updated_at: string;
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

// ── Main Controller ────────────────────────────────────────────

class ResumeBuilderController {
  private redis: RedisModel;
  private llm: LLM;
  private db: DatabaseLike;

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

    // Get current missing fields
    const missingFields = this.getMissingFields(session);

    // Build context for LLM
    const context = this.buildChatContext(session, missingFields, message);

    // Call LLM for response — use complete() directly, not reason(), to avoid
    // the "reasoning engine" system prompt overriding our casual tone instructions
    const llmResponse = await this.llm.complete(
      [
        {
          role: "system",
          content: "You are a fun, hype friend helping someone build their resume. Always respond with valid JSON only — no markdown fences, no explanation outside the JSON.",
        },
        { role: "user", content: context },
      ],
      { temperature: 0.3, max_tokens: 2048 },
    );

    // Parse LLM response and update session
    const updatedSession = await this.processLlmResponse(session, llmResponse, message);

    // Extract chat message from parsed LLM response (strip code fences, parse JSON)
    let chatMessage = llmResponse;
    try {
      const cleaned = llmResponse.replace(/```(?:json)?\s*/gi, "").trim();
      const parsed = JSON.parse(cleaned) as { message?: string };
      if (parsed.message) chatMessage = parsed.message;
    } catch {
      // LLM returned plain text — use as-is
    }

    const now = new Date().toISOString();
    updatedSession.chat_history = [
      ...(updatedSession.chat_history ?? []),
      { role: "user", content: message, timestamp: now },
      { role: "assistant", content: chatMessage, timestamp: now },
    ];

    // Recalculate ATS score
    const resumeText = this.generateResumeText(updatedSession);
    const atsScore = scoreResume(resumeText);

    // Update session with score
    updatedSession.ats_score = atsScore;
    updatedSession.resume_text = resumeText;
    updatedSession.updated_at = new Date().toISOString();

    // Save updated session
    await this.redis.setWithExpiry({
      key: `${SESSION_PREFIX}${sessionId}`,
      value: JSON.stringify(updatedSession),
      expiry: SESSION_EXPIRY,
    });

    // Get updated missing fields
    const updatedMissingFields = this.getMissingFields(updatedSession);
    const isComplete = updatedMissingFields.length === 0;

    // Generate response message
    const responseMessage = this.generateResponseMessage(
      chatMessage,
      atsScore,
      updatedMissingFields,
      isComplete
    );

    return {
      message: responseMessage,
      session: updatedSession,
      ats_score: atsScore,
      missing_fields: updatedMissingFields,
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
      updatedSession.ats_score = scoreResume(resumeText);
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
    const atsScore = scoreResume(resumeText);

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
      if (Array.isArray(value)) {
        if (value.length === 0) {
          missing.push(field);
        }
      } else if (!value || (typeof value === 'string' && value.trim() === '')) {
        missing.push(field);
      }
    }

    return missing;
  }

  private buildChatContext(
    session: ResumeSession,
    missingFields: string[],
    userMessage: string
  ): string {
    const currentData = JSON.stringify(session, null, 2);
    const nextField = missingFields[0] ?? null;

    const historyBlock = (session.chat_history ?? []).length > 0
      ? (session.chat_history ?? []).map(m => `${m.role}: ${m.content}`).join('\n')
      : '(no prior messages)';

    return `You are a fun, hype friend helping someone build their resume. Think excited best friend, not career coach. You're genuinely excited about their journey.

Current session data:
${currentData}

Conversation history:
${historyBlock}

User just said: ${userMessage}

Missing fields (your internal tracking only — never show this list): ${missingFields.join(', ')}

RULES — follow strictly:
1. Extract information the user just gave you and update session data.
2. If the user provides ANY non-empty answer to the field you just asked about, accept it, put it in updates, and move to the next field. Do NOT re-ask. Do NOT judge quality. Weak answers lower the score — that's a scoring problem, not a re-ask problem.
3. React with genuine excitement to what they said. Be playful. Example: "Oh you're from Lagos? That's fire! 🔥" or "Wait, React AND TypeScript? You're built different."
4. Ask for exactly ONE missing field per turn, in this priority order:
   full_name → email → phone → location → summary → skills → experience → education
5. Never list multiple missing fields. Never mention the score, a numeric grade, or a letter grade inside message.
6. Keep message short — 1-2 sentences, one question. Like texting your favorite person.
7. NO corporate speak. No "please provide", no "this information is crucial", no "ATS", no "as measured by". Just talk like a human.
8. If all fields are complete, be hyped! Celebrate with them.
9. NEVER ask the same question twice in a row. If you just asked about summary and they replied, that field is DONE — move on.

The next field to ask about is: ${nextField ?? 'NONE — all fields filled'}

Return JSON:
- message: string (fun, hyped-up, casual — ask about ONLY the next single field)
- updates: Partial<ResumeSession> (any fields to update — accept whatever they gave you)
- missing_fields: string[] (full remaining list, for your tracking only)`;
  }

  private async processLlmResponse(
    session: ResumeSession,
    llmResponse: string,
    userMessage: string
  ): Promise<ResumeSession> {
    try {
      // Clean and parse the response
      const cleaned = llmResponse.replace(/```(?:json)?\s*/gi, '').trim();
      const parsed = JSON.parse(cleaned) as {
        message: string;
        updates: Partial<ResumeSession>;
        missing_fields: string[];
      };

      // Apply updates to session
      const updatedSession = { ...session };
      if (parsed.updates) {
        for (const [key, value] of Object.entries(parsed.updates)) {
          if (key in updatedSession && value !== undefined) {
            (updatedSession as Record<string, unknown>)[key] = value;
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
    missingFields: string[],
    isComplete: boolean
  ): string {
    if (isComplete) {
      return llmMessage + '\n\nYour resume is ready! Click "Build" to generate it.';
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

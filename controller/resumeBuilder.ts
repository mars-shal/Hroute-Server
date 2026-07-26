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

  constructor() {
    this.redis = new RedisModel();
    this.llm = new LLM();
  }

  /**
   * Create a new resume session
   */
  async createSession(userId: string, initialData?: Partial<ResumeSession>): Promise<ResumeSession> {
    const sessionId = this.generateSessionId();
    const now = new Date().toISOString();

    const session: ResumeSession = {
      id: sessionId,
      userId,
      full_name: initialData?.full_name ?? '',
      email: initialData?.email ?? '',
      phone: initialData?.phone ?? '',
      location: initialData?.location ?? '',
      linkedin_url: initialData?.linkedin_url,
      github_url: initialData?.github_url,
      portfolio_url: initialData?.portfolio_url,
      summary: initialData?.summary ?? '',
      skills: initialData?.skills ?? [],
      experience: initialData?.experience ?? [],
      projects: initialData?.projects ?? [],
      education: initialData?.education ?? [],
      certifications: initialData?.certifications ?? [],
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

    // Call LLM for response
    const llmResponse = await this.llm.reason(context, {
      temperature: 0.3,
      max_tokens: 2048,
    });

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
  async generateResume(sessionId: string): Promise<{
    resume_text: string;
    ats_score: ATSScoreResult;
    html?: string;
  }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const resumeText = this.generateResumeText(session);
    const atsScore = scoreResume(resumeText);

    // Update session with final resume
    await this.updateSession(sessionId, {
      resume_text: resumeText,
      ats_score: atsScore,
    });

    return {
      resume_text: resumeText,
      ats_score: atsScore,
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

    return `You are an ATS resume builder assistant. Help the user build an ATS-optimized resume.

Current session data:
${currentData}

Missing fields (full list for tracking): ${missingFields.join(', ')}

User message: ${userMessage}

RULES — follow strictly:
1. Extract relevant information from the user's message and update session data.
2. Ask for exactly ONE missing field per turn — the next one in this priority order:
   full_name → email → phone → location → summary → skills → experience → education
3. Never list multiple missing fields in your message to the user.
4. Once the user provides a field, move to the next one in the SAME response.
5. If all fields are complete, tell the user their resume is ready.
6. Use Google XYZ format for experience bullets: "Accomplished [X] as measured by [Y], by doing [Z]"

The next field to ask about is: ${nextField ?? 'NONE — all fields filled'}

Return JSON:
- message: string (your response to the user — ask about ONLY the next single field)
- updates: Partial<ResumeSession> (any fields to update)
- missing_fields: string[] (full remaining list, for tracking)`;
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
    let message = llmMessage;

    message += `\n\n**ATS Score: ${atsScore.score}/100 (${atsScore.grade})**`;

    if (isComplete) {
      message += '\n\n✅ Your resume is complete! Click "Build" to generate your PDF.';
    }

    return message;
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

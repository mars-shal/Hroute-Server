import { extractText } from 'unpdf';
import type { DatabaseLike } from '../model/database.js';
import { EmbeddingService } from '../utils/embedding.js';
import { LLM } from '../model/LLM.js';
import { log, logger } from '../utils/logger.js';
import markdownpdf from 'markdown-pdf';

const MAX_RESUME_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESUME_FILE_BASE64_CHARS = Math.ceil(MAX_RESUME_FILE_BYTES / 3) * 4;
const MAX_RESUME_LLM_TEXT_CHARS = 8_000;
const MAX_RESUME_EMBED_TEXT_CHARS = 2_000;

type ResumeIssue = { category: string; severity: string; description: string };

type ResumeAssessment = {
  score: number;
  summary: string;
  issues: ResumeIssue[];
  suggestions: string[];
};

interface UploadResult {
  status: number;
  profile?: Record<string, unknown>;
  assessment?: ResumeAssessment | null;
  url?: string;
  error?: string;
}

type ImproveResult = {
  status: number;
  resume_text?: string;
  score?: number;
  changes?: string[];
  issues?: ResumeIssue[];
  suggestions?: string[];
  error?: string;
};

type ExportResult = {
  status: number;
  url?: string;
  error?: string;
};

/** Convert markdown to PDF buffer via markdown-pdf */
function mdToPdf(md: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    markdownpdf()
      .from.string(md)
      .to.buffer((err: Error | null, buf: Buffer) => {
        if (err) reject(err);
        else resolve(buf);
      });
  });
}

class ResumeController {
  private db: DatabaseLike;
  private llm: LLM;

  constructor(db: DatabaseLike) {
    this.db = db;
    this.llm = new LLM();
  }

  async upload(token: string, body: { resume_text?: string; file_data?: string; file_type?: string }): Promise<UploadResult> {
    try {
      let resumeText = this.boundResumeText(body.resume_text ?? '');
      let resumeFileType: 'pdf' | 'txt' | null = null;

      if (!resumeText && body.file_data) {
        const fileType = body.file_type === 'txt' ? 'txt' : 'pdf';
        if (body.file_data.length > MAX_RESUME_FILE_BASE64_CHARS) {
          return {
            status: 413,
            error: `Resume file is too large. Max size is ${Math.floor(MAX_RESUME_FILE_BYTES / (1024 * 1024))} MB.`,
          };
        }

        const buf = Buffer.from(body.file_data, 'base64');
        if (buf.byteLength > MAX_RESUME_FILE_BYTES) {
          return {
            status: 413,
            error: `Resume file is too large. Max size is ${Math.floor(MAX_RESUME_FILE_BYTES / (1024 * 1024))} MB.`,
          };
        }

        const uploadResult = await this.db.uploadResumeFile(token, buf, fileType);
        if (uploadResult.status !== 200) {
          logger.error(`[Resume] Storage upload failed: ${uploadResult.response ?? 'unknown'}`);
          return { status: 500, error: uploadResult.response ?? 'Failed to upload resume file' };
        }
        resumeFileType = fileType;

        if (fileType === 'pdf') {
          const pdfData = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          resumeText = this.boundResumeText(await this.extractPdfText(pdfData));
        } else {
          resumeText = this.boundResumeText(buf.toString('utf-8'));
        }
      }

      if (!resumeText || resumeText.trim().length < 20) {
        return { status: 400, error: 'No valid resume text provided. Send resume_text or a file_data + file_type.' };
      }

      logger.info(`[Resume] extracted ${resumeText.length} chars of text`);

      const extracted = await this.llm.extractProfile(resumeText);

      const profilePayload: Record<string, unknown> = {
        resume_text: resumeText,
        role: extracted.role ?? null,
        location: extracted.location ?? null,
        work_style: extracted.work_style ?? null,
        work_style_hint: extracted.work_style_hint ?? null,
        experience: extracted.experience ?? null,
        experience_hint: extracted.experience_hint ?? null,
        salary_target: extracted.salary_target ?? null,
        skills: extracted.skills ?? [],
      };

      if (resumeFileType) {
        profilePayload.resume_file_type = resumeFileType;
      }

      const profileResult = await this.db.updateUser(token, profilePayload);
      if (profileResult.status !== 200) {
        logger.error(`[Resume] Failed to save profile: ${profileResult.response}`);
        return { status: 500, error: profileResult.response ?? 'Failed to save profile' };
      }

      if (resumeText.length > 20) {
        try {
          const embeddingService = await EmbeddingService.getInstance();
          const embedding = await embeddingService.embed(resumeText.slice(0, MAX_RESUME_EMBED_TEXT_CHARS));
          await this.db.saveResumeEmbedding(token, embedding);
          logger.info(`[Resume] Embedding saved (dim=${embedding.length})`);
        } catch (embedErr) {
          logger.warn(`[Resume] Embedding failed (non-fatal): ${embedErr}`);
        }
      }

      let assessment: ResumeAssessment | null = null;
      try {
        assessment = await this.llm.resumeScore(resumeText);
        if (assessment) {
          profilePayload.resume_score = assessment.score;
          await this.db.updateUser(token, { resume_score: assessment.score }).catch(() => {});
        }
        logger.info(`[Resume] Assessment complete — score=${assessment?.score ?? '?'}`);
      } catch (assessErr) {
        logger.warn(`[Resume] Assessment LLM call failed (non-fatal): ${assessErr}`);
      }

      const profile: Record<string, unknown> = {
        resume_text: resumeText,
        ...profilePayload,
      };

      const skillCount = (extracted.skills as string[] | undefined)?.length ?? 0;
      logger.info(`[Resume] Upload + extraction + assessment complete`);
      await log(`[Resume] success: skills=${skillCount} score=${assessment?.score ?? '?'}`);
      return { status: 200, profile, assessment };
    } catch (e) {
      const msg = String(e);
      logger.error(`[Resume] Error: ${msg}`);
      return { status: 500, error: msg };
    }
  }

  async getFile(token: string): Promise<UploadResult> {
    try {
      const result = await this.db.getResumeSignedUrl(token);
      if (result.status !== 200 || !result.url) {
        return { status: result.status ?? 500, error: String(result.response ?? 'Failed to create signed URL') };
      }

      return { status: 200, url: result.url };
    } catch (e) {
      const msg = String(e);
      logger.error(`[Resume] Signed URL Error: ${msg}`);
      return { status: 500, error: msg };
    }
  }

  private async extractPdfText(data: Uint8Array): Promise<string> {
    const { text } = await extractText(data);
    return String(text ?? '');
  }

  async improve(token: string, message: string): Promise<ImproveResult> {
    try {
      if (!message || message.trim().length < 2) {
        return { status: 400, error: 'Improvement message required' };
      }

      const profile = await this.db.getUser(token);
      if (profile.status !== 200) {
        return { status: 401, error: 'Invalid token' };
      }

      const resumeText = String(profile.resume_text ?? '');
      if (!resumeText || resumeText.trim().length < 20) {
        return { status: 400, error: 'No resume found. Upload a resume first.' };
      }

      const result = await this.llm.improveResume(resumeText, message);

      const update: Record<string, unknown> = {
        resume_text: result.resume_text,
        resume_score: result.score,
      };
      const saveResult = await this.db.updateUser(token, update);
      if (saveResult.status !== 200) {
        logger.warn(`[Resume] improve: failed to persist updated resume: ${saveResult.response}`);
      }

      logger.info(`[Resume] improve complete — score=${result.score} changes=${result.changes.length}`);
      await log(`[Resume] improve: score=${result.score} changes=${result.changes.join(", ").slice(0, 100)}`);

      return {
        status: 200,
        resume_text: result.resume_text,
        score: result.score,
        changes: result.changes,
        issues: result.issues,
        suggestions: result.suggestions,
      };
    } catch (e) {
      const msg = String(e);
      logger.error(`[Resume] improve error: ${msg}`);
      return { status: 500, error: msg };
    }
  }

  async exportPdf(token: string): Promise<ExportResult> {
    try {
      const profile = await this.db.getUser(token);
      if (profile.status !== 200) {
        return { status: 401, error: 'Invalid token' };
      }

      const resumeText = String(profile.resume_text ?? '');
      if (!resumeText || resumeText.trim().length < 20) {
        return { status: 400, error: 'No resume found. Upload or create a resume first.' };
      }

      const md = `# ${profile.display_name ?? 'Resume'}\n\n${resumeText}`;

      logger.info(`[Resume] exportPdf: converting ${md.length} chars to PDF`);
      const pdfBuf = await mdToPdf(md);

      const pdfBase64 = pdfBuf.toString('base64');
      const uploadResult = await this.db.uploadFile(token, {
        fileData: pdfBase64,
        filePath: 'generated',
        fileName: 'resume.pdf',
        contentType: 'application/pdf',
      });

      if (uploadResult.status !== 200) {
        logger.error(`[Resume] exportPdf: storage upload failed: ${uploadResult.response ?? 'unknown'}`);
        return { status: 500, error: uploadResult.response ?? 'Failed to upload PDF' };
      }

      const signedUrlResult = await this.db.getGeneratedResumeUrl(token);
      const url = signedUrlResult.status === 200 && signedUrlResult.url
        ? signedUrlResult.url
        : null;

      logger.info(`[Resume] exportPdf complete — ${pdfBuf.length} bytes`);
      await log(`[Resume] exportPdf: ${pdfBuf.length} bytes`);

      return { status: 200, url: url ?? undefined };
    } catch (e) {
      const msg = String(e);
      logger.error(`[Resume] exportPdf error: ${msg}`);
      return { status: 500, error: msg };
    }
  }

  private boundResumeText(text: string): string {
    if (text.length <= MAX_RESUME_LLM_TEXT_CHARS) {
      return text;
    }

    logger.warn(`[Resume] Truncating oversized resume text (${text.length} chars)`);
    return text.slice(0, MAX_RESUME_LLM_TEXT_CHARS);
  }
}

export { ResumeController };

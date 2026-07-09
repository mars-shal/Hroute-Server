import { getDocument } from 'pdfjs-dist';
import type { Database } from '../model/database';
import { EmbeddingService } from '../utils/embedding';
import { LLM } from '../model/LLM';
import { log, logger } from '../utils/logger';

interface UploadResult {
  status: number;
  profile?: Record<string, unknown>;
  error?: string;
}

class ResumeController {
  private db: Database;
  private llm: LLM;

  constructor(db: Database) {
    this.db = db;
    this.llm = new LLM();
  }

  async upload(token: string, body: { resume_text?: string; file_data?: string; file_type?: string }): Promise<UploadResult> {
    try {
      let resumeText = body.resume_text ?? '';

      if (!resumeText && body.file_data && body.file_type) {
        const buf = Buffer.from(body.file_data, 'base64');
        if (body.file_type === 'pdf') {
          resumeText = await this.extractPdfText(buf);
        } else {
          resumeText = buf.toString('utf-8');
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

      const profileResult = await this.db.updateUser(token, profilePayload);
      if (profileResult.status !== 200) {
        logger.error(`[Resume] Failed to save profile: ${profileResult.response}`);
        return { status: 500, error: profileResult.response ?? 'Failed to save profile' };
      }

      if (resumeText.length > 20) {
        try {
          const embeddingService = await EmbeddingService.getInstance();
          const embedding = await embeddingService.embed(resumeText.slice(0, 2000));
          await this.db.saveResumeEmbedding(token, embedding);
          logger.info(`[Resume] Embedding saved (dim=${embedding.length})`);
        } catch (embedErr) {
          logger.warn(`[Resume] Embedding failed (non-fatal): ${embedErr}`);
        }
      }

      const profile: Record<string, unknown> = {
        resume_text: resumeText,
        ...profilePayload,
      };

      const skillCount = (extracted.skills as string[] | undefined)?.length ?? 0;
      logger.info(`[Resume] Upload + extraction complete`);
      await log(`[Resume] success: skills=${skillCount}`);
      return { status: 200, profile };
    } catch (e) {
      const msg = String(e);
      logger.error(`[Resume] Error: ${msg}`);
      return { status: 500, error: msg };
    }
  }

  private async extractPdfText(buf: Buffer): Promise<string> {
    const doc = await getDocument({ data: buf }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str).join(' ');
      pages.push(text);
    }
    return pages.join('\n');
  }
}

export { ResumeController };

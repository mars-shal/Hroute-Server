/**
 * Render Server Entry Point
 * 
 * Handles PDF generation for resume builder:
 * - Receives session data from Vercel server
 * - Generates HTML from template
 * - Converts HTML to PDF using Puppeteer
 * - Uploads PDF to Supabase Storage
 * - Returns signed URL
 */

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { generateResumeHtml } from '../utils/resumeHtmlTemplate.js';
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
  skills: Array<{ name: string; skills: string[] }>;
  experience: Array<{
    company: string;
    role: string;
    start_date: string;
    end_date: string;
    bullets: string[];
  }>;
  projects: Array<{
    name: string;
    description: string[];
    technologies: string[];
  }>;
  education: Array<{
    institution: string;
    degree: string;
    year: string;
  }>;
  certifications: Array<{
    name: string;
    issuer: string;
    year: string;
  }>;
}

interface BuildRequest {
  sessionId: string;
  session: ResumeSession;
  apiKey: string;
}

interface BuildResponse {
  success: boolean;
  url?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
const API_KEY = process.env.RENDER_API_KEY ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? '';

// ── Express App ────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Health Check ───────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Build Resume PDF ──────────────────────────────────────────

app.post('/create/resume', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { sessionId, session, apiKey } = req.body as BuildRequest;

    // Validate API key
    if (!apiKey || apiKey !== API_KEY) {
      logger.warn('[Render] Invalid API key');
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    if (!sessionId || !session) {
      logger.warn('[Render] Missing sessionId or session');
      res.status(400).json({ success: false, error: 'sessionId and session required' });
      return;
    }

    logger.info(`[Render] Building resume for session ${sessionId}`);

    // Generate HTML
    const html = generateResumeHtml(session);
    logger.info(`[Render] Generated HTML (${html.length} chars)`);

    // Convert to PDF
    const pdfBuffer = await htmlToPdf(html);
    logger.info(`[Render] Generated PDF (${pdfBuffer.length} bytes)`);

    // Upload to Supabase Storage
    const url = await uploadToSupabase(session.userId, pdfBuffer);
    logger.info(`[Render] Uploaded to Supabase: ${url}`);

    const duration = Date.now() - startTime;
    logger.info(`[Render] Build complete in ${duration}ms`);
    await log(`[Render] Build complete: session=${sessionId} size=${pdfBuffer.length} duration=${duration}ms`);

    res.json({ success: true, url });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`[Render] Build failed: ${message}`);
    await log(`[Render] Build failed: ${message}`);
    res.status(500).json({ success: false, error: message });
  }
});

// ── PDF Generation ────────────────────────────────────────────

async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Supabase Upload ───────────────────────────────────────────

async function uploadToSupabase(userId: string, pdfBuffer: Buffer): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const filePath = `${userId}/generated/resume.pdf`;
  const { error: uploadError } = await supabase.storage
    .from('user-data')
    .upload(filePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  // Get signed URL
  const { data: urlData, error: urlError } = await supabase.storage
    .from('user-data')
    .createSignedUrl(filePath, 3600);

  if (urlError) {
    throw new Error(`URL generation failed: ${urlError.message}`);
  }

  return urlData.signedUrl;
}

// ── Start Server ──────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`[Render] Server running on port ${PORT}`);
  console.log(`[Render] Server running on port ${PORT}`);
});

export { app };

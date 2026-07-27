import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import { logger } from './logger.js';

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
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

    logger.info(`[PDF] Generated ${pdf.length} bytes from HTML (${html.length} chars)`);
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

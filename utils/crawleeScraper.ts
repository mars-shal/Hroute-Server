import axios from "axios";
import * as cheerio from "cheerio";
import { log, logger } from "./logger.js";

const TIMEOUT = 30000;

/**
 * Scrape a single page using axios + cheerio.
 * Returns clean text content (not true markdown, but sufficient for LLM extraction).
 * Designed as a Firecrawl fallback — returns the same shape { markdown }.
 */
export async function scrapePage(
  url: string,
): Promise<{ markdown: string } | null> {
  logger.info(`[Crawlee] scrapePage entry: ${url}`);
  await log(`[Crawlee] scrapePage: ${url}`);

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(res.data);
    $("script, style, nav, footer, header, aside, .sidebar, .menu, iframe").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();

    if (text) {
      logger.info(`[Crawlee] scrapePage success: ${url} (${text.length} chars)`);
      await log(`[Crawlee] scrapePage success: ${url} (${text.length} chars)`);
      return { markdown: text };
    }

    logger.warn(`[Crawlee] scrapePage no content: ${url}`);
    await log(`[Crawlee] scrapePage no content: ${url}`);
    return null;
  } catch (e) {
    logger.error(`[Crawlee] scrapePage error ${url}:`, e);
    await log(`[Crawlee] scrapePage ERROR: ${url} — ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Discover all links from a seed URL using axios + cheerio.
 * Extracts all <a href> values from the page, resolving relative URLs.
 * Returns an array of absolute URL strings.
 */
export async function discoverPageLinks(seedUrl: string): Promise<string[]> {
  logger.info(`[Crawlee] discoverPageLinks entry: ${seedUrl}`);
  await log(`[Crawlee] discoverPageLinks: ${seedUrl}`);

  const links = new Set<string>();

  try {
    const res = await axios.get(seedUrl, {
      timeout: TIMEOUT,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(res.data);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      try {
        const absolute = new URL(href, seedUrl).href;
        links.add(absolute);
      } catch {
        // Skip malformed URLs
      }
    });

    const result = Array.from(links);
    logger.info(`[Crawlee] discoverPageLinks: ${result.length} links from ${seedUrl}`);
    await log(`[Crawlee] discoverPageLinks: ${result.length} links from ${seedUrl}`);
    return result;
  } catch (e) {
    logger.error(`[Crawlee] discoverPageLinks error ${seedUrl}:`, e);
    await log(`[Crawlee] discoverPageLinks ERROR: ${seedUrl} — ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

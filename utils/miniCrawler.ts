/**
 * Mini Crawler — free, self-hosted job-page discovery and scraping.
 *
 * Zero external credits: axios + cheerio link discovery with robots.txt
 * compliance, job-URL heuristics, and polite pooled scraping. Serves as the
 * zero-credit tier inside Crawler (used when Firecrawl is out of credits,
 * unconfigured, or CRAWLER_MODE=mini).
 *
 * Design notes:
 * - Link discovery keeps only same-domain URLs that look like job pages
 *   (path heuristics), so a seed page doesn't explode into the whole site.
 * - robots.txt is fetched once per host and consulted for both discovery
 *   and scraping; disallowed paths are skipped entirely.
 * - Politeness: per-host minimum delay + bounded concurrency.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { log, logger } from "./logger.js";
import { isNonJobUrl } from "./crawleeScraper.js";
import { isJunkUrl } from "./jobPipeline.js";
import { mapWithConcurrency, sleep } from "./limiter.js";

const TIMEOUT = 15_000;
const USER_AGENT = "hroute-job-discovery (+https://github.com/hroute; respectful crawler)";
/** Politeness delay between consecutive requests to the same host. */
const PER_HOST_DELAY_MS = Math.max(250, Number(process.env.MINI_CRAWLER_DELAY_MS) || 1000);
/** Concurrency across hosts — per-host delay still throttles same-host bursts. */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MINI_CRAWLER_CONCURRENCY) || 3);
/** Hard cap on links discovered from a single seed. */
const MAX_LINKS_PER_SEED = Math.max(1, Number(process.env.MINI_CRAWLER_MAX_LINKS) || 30);

/** Path patterns that indicate an individual job posting. */
const JOB_PATH_PATTERNS = [
  /\/job(s)?\//i,
  /\/job[s]?[-_/][\w-]+/i,
  /\/careers?\//i,
  /\/vacanc(y|ies)\//i,
  /\/opening(s)?\//i,
  /\/position(s)?\//i,
  /\/listing(s)?\//i,
  /\/requisition\//i,
  /\/opportunit(y|ies)\//i,
  /\/graduate[-_/]/i,
  /\/internship(s)?[-_/]/i,
  /\?j=p\//i, // hiringcafe style
] as const;

/** robots.txt cache — one entry per host, entries expire after 1 hour. */
type RobotsFile = ReturnType<typeof robotsParser> | null;
type RobotsEntry = { robot: RobotsFile; fetchedAt: number };
const robotsCache = new Map<string, RobotsEntry>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function sameHost(a: string, b: string): boolean {
  const hostA = extractHost(a);
  const hostB = extractHost(b);
  return hostA !== null && hostA === hostB;
}

async function getRobots(pageUrl: string): Promise<ReturnType<typeof robotsParser> | null> {
  const host = extractHost(pageUrl);
  if (!host) return null;

  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached.robot;
  }

  let robot: ReturnType<typeof robotsParser> | null = null;
  try {
    const robotsUrl = new URL("/robots.txt", pageUrl).href;
    const res = await axios.get(robotsUrl, {
      timeout: TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
      // A missing robots.txt is the common case — don't retry or follow far.
      maxRedirects: 2,
    });
    if (typeof res.data === "string" && res.data.length > 0) {
      robot = robotsParser(robotsUrl, res.data);
    }
  } catch {
    // No robots.txt (404 / block) → treat as allowed
  }

  robotsCache.set(host, { robot, fetchedAt: Date.now() });
  return robot;
}

async function isAllowed(url: string): Promise<boolean> {
  const robot = await getRobots(url);
  if (!robot) return true;
  return robot.isAllowed(url, USER_AGENT) !== false;
}

/** Heuristic: does this same-domain URL look like an individual job page? */
function looksLikeJobUrl(url: string): boolean {
  if (isNonJobUrl(url) || isJunkUrl(url)) return false;
  return JOB_PATH_PATTERNS.some((p) => p.test(url));
}

/**
 * Discover candidate job-page URLs from a seed page — same-domain <a href>
 * values that match job path heuristics, robots.txt-allowed, deduped.
 */
export async function miniDiscover(seedUrl: string): Promise<string[]> {
  logger.debug(`[MiniCrawler] discover entry: ${seedUrl}`);
  await log(`[MiniCrawler] discover: ${seedUrl}`);

  if (!(await isAllowed(seedUrl))) {
    logger.info(`[MiniCrawler] robots.txt disallows seed: ${seedUrl}`);
    return [];
  }

  try {
    const res = await axios.get(seedUrl, {
      timeout: TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
    });

    const $ = cheerio.load(res.data);
    const seen = new Set<string>();
    const candidates: string[] = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
      try {
        const absolute = new URL(href, seedUrl).href;
        // Strip tracking params and fragments for stable dedup
        const u = new URL(absolute);
        u.hash = "";
        const clean = u.href;
        if (seen.has(clean)) return;
        if (!sameHost(clean, seedUrl)) return;
        if (!looksLikeJobUrl(clean)) return;
        seen.add(clean);
        candidates.push(clean);
      } catch {
        // malformed href — skip
      }
    });

    const limited = candidates.slice(0, MAX_LINKS_PER_SEED);
    logger.info(`[MiniCrawler] discover: ${limited.length} job URLs from ${seedUrl} (${candidates.length} candidates)`);
    await log(`[MiniCrawler] discover: ${limited.length} urls from ${seedUrl}`);
    return limited;
  } catch (e) {
    logger.warn(`[MiniCrawler] discover failed for ${seedUrl}: ${e instanceof Error ? e.message : e}`);
    await log(`[MiniCrawler] discover ERROR: ${seedUrl} — ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/**
 * Scrape a single page to plain text with robots.txt compliance and
 * per-host politeness. Returns the same { markdown } shape as crawleeScraper
 * so callers can treat both interchangeably.
 */
export async function miniScrape(
  url: string,
  lastRequestAt: Map<string, number>,
): Promise<{ markdown: string } | null> {
  if (isNonJobUrl(url) || isJunkUrl(url)) return null;
  if (!(await isAllowed(url))) {
    logger.info(`[MiniCrawler] robots.txt disallows: ${url}`);
    return null;
  }

  const host = extractHost(url) ?? url;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + PER_HOST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
    });
    lastRequestAt.set(host, Date.now());

    const $ = cheerio.load(res.data);
    $("script, style, nav, footer, header, aside, .sidebar, .menu, iframe, noscript").remove();

    // Job boards usually mark the listing with <article>, <main> or a job div;
    // prefer the tightest container, fall back to <body>.
    const container = $("article").first().length
      ? $("article").first()
      : $("main").first().length
        ? $("main").first()
        : $("body");
    const text = container.text().replace(/\s+/g, " ").trim();

    if (text.length < 100) {
      logger.debug(`[MiniCrawler] scrape thin content: ${url} (${text.length} chars)`);
      return null;
    }

    logger.debug(`[MiniCrawler] scraped: ${url} (${text.length} chars)`);
    return { markdown: text };
  } catch (e) {
    lastRequestAt.set(host, Date.now());
    logger.warn(`[MiniCrawler] scrape failed ${url}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Scrape several pages politely with bounded concurrency.
 * Returns { url, markdown } pairs, matching Crawler.scrapePages' shape.
 */
export async function miniScrapeAll(
  urls: string[],
): Promise<Array<{ url: string; markdown: string }>> {
  const results: Array<{ url: string; markdown: string }> = [];
  const lastRequestAt = new Map<string, number>();

  await mapWithConcurrency(urls, MAX_CONCURRENCY, async (url) => {
    const page = await miniScrape(url, lastRequestAt);
    if (page) {
      results.push({ url, markdown: page.markdown });
    }
  });

  logger.info(`[MiniCrawler] scraped ${results.length}/${urls.length} pages`);
  return results;
}

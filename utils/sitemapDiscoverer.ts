import axios from "axios";
import robotsParser from "robots-parser";
import Sitemapper from "sitemapper";
import { log, logger } from "./logger.js";

const TIMEOUT = 15_000;
const USER_AGENT = "hroute-job-discovery";

async function fetchSitemapsFromRobots(
  websiteUrl: string,
): Promise<string[]> {
  try {
    const robotsUrl = new URL("/robots.txt", websiteUrl).href;
    const res = await axios.get(robotsUrl, {
      timeout: TIMEOUT,
      headers: { "User-Agent": USER_AGENT },
    });

    if (res.status !== 200 || typeof res.data !== "string") return [];

    const robots = robotsParser(robotsUrl, res.data);
    const sitemaps = robots.getSitemaps();
    if (sitemaps.length > 0) {
      logger.info(`[SitemapDiscoverer] Found ${sitemaps.length} sitemaps in robots.txt for ${websiteUrl}`);
      return sitemaps;
    }
  } catch {
    // robots.txt missing or unparseable — fall through to convention
  }

  // Convention: try /sitemap.xml directly
  return [new URL("/sitemap.xml", websiteUrl).href];
}

export async function discoverSitemapUrls(
  websiteUrl: string,
  options?: {
    filterText?: string;
    maxResults?: number;
  },
): Promise<string[]> {
  logger.info(`[SitemapDiscoverer] entry: ${websiteUrl}`);
  await log(`[SitemapDiscoverer] starting: ${websiteUrl}`);

  try {
    const sitemapUrls = await fetchSitemapsFromRobots(websiteUrl);
    if (sitemapUrls.length === 0) {
      logger.warn(`[SitemapDiscoverer] No sitemaps found for ${websiteUrl}`);
      return [];
    }

    const sitemapper = new Sitemapper({
      timeout: TIMEOUT,
      retries: 2,
      concurrency: 10,
    });

    const allSites = new Set<string>();
    for (const sitemapUrl of sitemapUrls) {
      try {
        const result = await sitemapper.fetch(sitemapUrl);
        for (const site of result.sites) {
          allSites.add(site);
        }
        if (result.errors.length > 0) {
          logger.warn(
            `[SitemapDiscoverer] ${result.errors.length} parse errors in ${sitemapUrl}`,
          );
        }
      } catch (e) {
        logger.warn(`[SitemapDiscoverer] Failed to fetch ${sitemapUrl}: ${e}`);
      }
    }

    let urls = Array.from(allSites);

    if (options?.filterText) {
      const filter = options.filterText.toLowerCase();
      urls = urls.filter((u) => u.toLowerCase().includes(filter));
    }

    const max = options?.maxResults ?? 200;
    if (urls.length > max) {
      urls = urls.slice(0, max);
    }

    logger.info(
      `[SitemapDiscoverer] ${urls.length} URLs from ${websiteUrl} (${sitemapUrls.length} sitemaps)`,
    );
    await log(`[SitemapDiscoverer] ${urls.length} URLs from ${websiteUrl}`);

    return urls;
  } catch (e) {
    logger.error(`[SitemapDiscoverer] error ${websiteUrl}:`, e);
    await log(`[SitemapDiscoverer] ERROR: ${websiteUrl} — ${e}`);
    return [];
  }
}

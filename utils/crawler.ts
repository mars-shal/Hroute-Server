import axios from "axios";
import { log, logger } from "./logger.js";
import { RedisModel } from "../model/redis.js";
import { scrapePage, discoverPageLinks, isNonJobUrl } from "./crawleeScraper.js";
import { discoverSitemapUrls } from "./sitemapDiscoverer.js";

type ApiHandlerData = {
  method: string;
  url: string;
  headers: {
    "Content-Type": string;
    Authorization: string;
  };
  data: Record<string, unknown>;
  timeout: number;
};

const SCRAPED_URLS_KEY = "scraped_urls";
/** Max entries in the scraped_urls Redis set — prevents unbounded growth on
 * a 400MB server where Redis shares memory with the app. */
const SCRAPED_URLS_MAX = 5000;

function heapUsedMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

class Crawler {
  private apiKey: string;
  private redis: RedisModel;
  /** Set to true when Firecrawl returns 402 Payment Required — suppresses
   * expensive Crawlee fallbacks for the rest of the cycle. */
  private _firecrawlUnavailable = false;

  get firecrawlUnavailable(): boolean {
    return this._firecrawlUnavailable;
  }

  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY ?? "";
    this.redis = new RedisModel();
  }

  private async fireScraper(body_url: string) {
    logger.info(`[Crawler] fireScraper entry: ${body_url}`);
    await log(`[Crawler] fireScraper calling: ${body_url}`);

    try {
      const url = "https://api.firecrawl.dev/v2/scrape";
      const data: ApiHandlerData = {
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        data: {
          url: body_url,
          onlyMainContent: true,
          formats: ["markdown"],
        },
        timeout: 30000,
      };
      const response = await axios(data);
      const success = Boolean(response.data?.data?.markdown);
      logger.info(`[Crawler] fireScraper success: ${body_url} (has_markdown=${success})`);
      await log(`[Crawler] fireScraper success: ${body_url} (has_markdown=${success})`);
      return response.data;
    } catch (e) {
      logger.error(`[Crawler] fireScraper ${body_url}:`, e);
      if (axios.isAxiosError(e) && e.response?.data) {
        const detail = JSON.stringify(e.response.data);
        logger.error(`[Crawler] fireScraper ${body_url} response:`, detail);
        await log(`[Crawler] fireScraper ${body_url} ERROR: ${detail}`);
        // Detect out-of-credits — suppress all fallbacks for rest of cycle
        if (e.response.status === 402) {
          this._firecrawlUnavailable = true;
          logger.warn(`[Crawler] Firecrawl out of credits — skipping Crawlee fallback for ${body_url} and all remaining URLs`);
          await log(`[Crawler] Firecrawl out of credits — skipping Crawlee fallback`);
          return null;
        }
      } else {
        await log(`[Crawler] fireScraper ${body_url} ERROR: ${e}`);
      }
      // Fallback to Crawlee when Firecrawl fails (unless credits exhausted)
      if (this._firecrawlUnavailable) {
        logger.info(`[Crawler] fireScraper skip fallback (credits exhausted): ${body_url}`);
        return null;
      }
      logger.info(`[Crawler] fireScraper fallback to Crawlee: ${body_url}`);
      await log(`[Crawler] fireScraper fallback Crawlee: ${body_url}`);
      const fallback = await scrapePage(body_url);
      if (fallback) {
        return { data: { markdown: fallback.markdown } };
      }
      return null;
    }
  }

  private async fireMap(body_url: string) {
    logger.info(`[Crawler] fireMap entry: ${body_url}`);
    await log(`[Crawler] fireMap calling: ${body_url}`);

    try {
      const url = "https://api.firecrawl.dev/v2/map";
      const data: ApiHandlerData = {
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        data: {
          "url": body_url,
          "limit": 10,
          "includeSubdomains": false,
        },
        timeout: 30000,
      };

      const response = await axios(data);
      const linkCount = response.data?.links?.length ?? 0;
      logger.info(`[Crawler] fireMap success: ${body_url} — ${linkCount} links`);
      await log(`[Crawler] fireMap success: ${body_url} — ${linkCount} links`);
      return response.data;
    } catch (e) {
      logger.error(`[Crawler] fireMap ${body_url}:`, e);
      if (axios.isAxiosError(e) && e.response?.data) {
        const detail = JSON.stringify(e.response.data);
        logger.error(`[Crawler] fireMap ${body_url} response body:`, detail);
        await log(`[Crawler] fireMap ${body_url} ERROR: ${detail}`);
        if (e.response.status === 402) {
          this._firecrawlUnavailable = true;
          logger.warn(`[Crawler] Firecrawl out of credits — skipping fallback for ${body_url}`);
          await log(`[Crawler] Firecrawl out of credits — map fallback skipped`);
          return null;
        }
      } else {
        await log(`[Crawler] fireMap ${body_url} ERROR: ${e}`);
      }
      if (this._firecrawlUnavailable) {
        logger.info(`[Crawler] fireMap skip fallback (credits exhausted): ${body_url}`);
        return null;
      }
      // Tier 2: Crawlee <a> scraping fallback
      logger.info(`[Crawler] fireMap fallback to Crawlee: ${body_url}`);
      await log(`[Crawler] fireMap fallback Crawlee: ${body_url}`);
      const fallbackLinks = await discoverPageLinks(body_url);
      if (fallbackLinks.length > 0) {
        return { links: fallbackLinks };
      }

      // Tier 3: Apify sitemap discovery (requires APIFY_API_TOKEN)
      logger.info(`[Crawler] fireMap fallback to Apify sitemap: ${body_url}`);
      await log(`[Crawler] fireMap fallback Apify: ${body_url}`);
      const sitemapUrls = await discoverSitemapUrls(body_url);
      if (sitemapUrls.length > 0) {
        return { links: sitemapUrls };
      }
      return null;
    }
  }

  // Discover job page URLs from a job board seed URL.
  async discoverUrls(seedUrl: string): Promise<string[]> {
    logger.info(`[Crawler] discoverUrls entry: ${seedUrl}`);

    const result = await this.fireMap(seedUrl);
    // Firecrawl v2 /v2/map returns links as objects {url, title, description}.
    // Normalize to an array of plain URL strings — backward compatible with any
    // future endpoint that returns plain strings.
    const rawLinks: unknown[] = result?.links ?? [];
    const links: string[] = rawLinks.map((l: unknown) =>
      typeof l === "string" ? l : (l as { url: string }).url,
    );
    logger.info(`[Crawler] discoverUrls: ${links.length} raw links from ${seedUrl}`);

    // Filter out non-job URLs before checking Redis or scraping
    const jobLinks = links.filter((link) => !isNonJobUrl(link));
    const skippedCount = links.length - jobLinks.length;
    if (skippedCount > 0) {
      logger.info(`[Crawler] discoverUrls filtered ${skippedCount} non-job URLs from ${seedUrl}`);
    }

    // Filter out already-scraped URLs
    const fresh: string[] = [];
    for (const [i, link] of jobLinks.entries()) {
      const seen = await this.redis.isMember(SCRAPED_URLS_KEY, link);
      if (!seen) fresh.push(link);

      // Log progress every 50 links to track long Redis-filter loops
      if (i > 0 && i % 50 === 0) {
        logger.info(`[Crawler] discoverUrls Redis filter: ${i}/${links.length} (${fresh.length} fresh so far)`);
      }
    }

    logger.info(`[Crawler] discoverUrls exit: ${fresh.length} fresh / ${links.length} total from ${seedUrl}`);
    await log(`[Crawler] discoverUrls: ${fresh.length} fresh urls from ${seedUrl}`);

    // Prune scraped_urls set when over limit to cap Redis memory
    if (fresh.length > 0) {
      await this.pruneScrapedUrls();
    }

    return fresh;
  }

  // Scrape actual page content (markdown) for a list of URLs.
  // Returns { url, markdown } pairs so callers can reference the source URL.
  async clearScrapedUrls(): Promise<void> {
    await this.redis.delete(SCRAPED_URLS_KEY);
    logger.info(`[Crawler] Cleared ${SCRAPED_URLS_KEY} from Redis (heap=${heapUsedMB()}MB, rss=${rssMB()}MB)`);
  }

  /** Keep scraped_urls set under SCRAPED_URLS_MAX by trimming oldest entries. */
  private async pruneScrapedUrls(): Promise<void> {
    try {
      const count = await this.redis.scard(SCRAPED_URLS_KEY);
      if (count > SCRAPED_URLS_MAX) {
        const excess = count - SCRAPED_URLS_MAX;
        const batch = Math.min(excess, 500);
        await this.redis.spop({ key: SCRAPED_URLS_KEY, count: batch });
        logger.info(`[Crawler] Pruned ${batch} entries from ${SCRAPED_URLS_KEY} (${count} → ~${SCRAPED_URLS_MAX}, heap=${heapUsedMB()}MB)`);
      }
    } catch (e) {
      logger.warn(`[Crawler] pruneScrapedUrls error: ${e}`);
    }
  }

  async scrapePages(
    urls: string[],
  ): Promise<Array<{ url: string; markdown: string }>> {
    const results: Array<{ url: string; markdown: string }> = [];
    logger.info(`[Crawler] scrapePages entry: ${urls.length} URLs`);
    await log(`[Crawler] scrapePages starting: ${urls.length} URLs`);

    for (const [idx, url] of urls.entries()) {
      if (idx > 0) {
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (isNonJobUrl(url)) {
        logger.info(`[Crawler] scrapePages skip (non-job): ${url}`);
        continue;
      }

      const alreadyScraped = await this.redis.isMember(SCRAPED_URLS_KEY, url);
      if (alreadyScraped) {
        logger.info(`[Crawler] scrapePages skip (already scraped): ${url}`);
        continue;
      }

      const res = await this.fireScraper(url);
      const markdown: string | undefined = res?.data?.markdown;
      if (markdown) {
        results.push({ url, markdown });
        await this.redis.sadd({ key: SCRAPED_URLS_KEY, member: url });
        logger.info(`[Crawler] scrapePages scraped: ${url} (${markdown.length} chars)`);
      } else {
        logger.warn(`[Crawler] scrapePages no markdown: ${url}`);
        await log(`[Crawler] scrapePages NO markdown: ${url}`);
      }

      if (idx > 0 && idx % 25 === 0) {
        logger.info(`[Crawler] scrapePages progress: ${idx + 1}/${urls.length} (${results.length} scraped so far) [heap=${heapUsedMB()}MB]`);
      }
    }

    logger.info(`[Crawler] scrapePages exit: ${results.length}/${urls.length} pages scraped [heap=${heapUsedMB()}MB]`);
    await log(`[Crawler] scrapePages done: ${results.length}/${urls.length} pages`);
    return results;
  }
}

export { Crawler };

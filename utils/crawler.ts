import axios from "axios";
import { log, logger } from "./logger.js";
import { RedisModel } from "../model/redis.js";
import { scrapePage, discoverPageLinks, isNonJobUrl } from "./crawleeScraper.js";
import { discoverSitemapUrls } from "./sitemapDiscoverer.js";
import { miniDiscover, miniScrape } from "./miniCrawler.js";
import { mapWithConcurrency, sleep } from "./limiter.js";
import { isJunkUrl } from "./jobPipeline.js";

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

/** Scrape concurrency — Firecrawl tolerates small parallel bursts; the old
 * serial loop (5s sleep between every URL) made a 10-link seed take ~50s. */
const SCRAPE_CONCURRENCY = Math.max(1, Number(process.env.SCRAPE_CONCURRENCY) || 3);
/** Politeness delay between consecutive requests inside one worker. */
const SCRAPE_DELAY_MS = Math.max(0, Number(process.env.SCRAPE_DELAY_MS) || 250);
/** Delay before a single retry after a Firecrawl 429. */
const RATE_LIMIT_RETRY_MS = Math.max(1000, Number(process.env.FIRECRAWL_429_RETRY_MS) || 5000);

function heapUsedMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

/** Crawler tier selection — the stack is free-by-default:
 *  - "mini" (default): self-hosted axios+cheerio crawler, zero credits.
 *  - "auto": Firecrawl when configured and funded, mini crawler as the
 *    free fallback for everything else.
 *  - "firecrawl": Firecrawl only, Crawlee fallbacks (legacy behaviour).
 * Set CRAWLER_MODE=auto|firecrawl to spend Firecrawl credits. */
type CrawlerMode = "auto" | "firecrawl" | "mini";
const CRAWLER_MODE: CrawlerMode =
  process.env.CRAWLER_MODE === "firecrawl" || process.env.CRAWLER_MODE === "auto"
    ? (process.env.CRAWLER_MODE as CrawlerMode)
    : "mini";

class Crawler {
  private apiKey: string;
  private redis: RedisModel;
  /** Set to true when Firecrawl returns 402 Payment Required — suppresses
   * expensive fallbacks for the rest of the cycle. */
  private _firecrawlUnavailable = false;
  /** Firecrawl credit accounting for the current run (map + scrape calls). */
  private _creditsUsed = { map: 0, scrape: 0 };
  /** Count of pages/URLs handled by the free mini crawler this run. */
  private _miniHandled = { map: 0, scrape: 0 };
  /** Shared per-host politeness state for the mini crawler across the run. */
  private miniLastRequest = new Map<string, number>();

  get firecrawlUnavailable(): boolean {
    return this._firecrawlUnavailable;
  }

  /** Firecrawl credits spent by this Crawler instance so far. */
  get creditsUsed(): { map: number; scrape: number; total: number } {
    return {
      map: this._creditsUsed.map,
      scrape: this._creditsUsed.scrape,
      total: this._creditsUsed.map + this._creditsUsed.scrape,
    };
  }

  get miniHandled(): { map: number; scrape: number } {
    return { ...this._miniHandled };
  }

  /** True when this call should be served by the free mini crawler. */
  private get useMiniTier(): boolean {
    if (CRAWLER_MODE === "mini") return true;
    if (CRAWLER_MODE === "firecrawl") return false;
    return !this.apiKey || this._firecrawlUnavailable;
  }

  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY ?? "";
    this.redis = new RedisModel();
  }

  private async fireScraper(body_url: string) {
    logger.debug(`[Crawler] fireScraper entry: ${body_url}`);
    await log(`[Crawler] fireScraper calling: ${body_url}`);

    // Zero-credit tier: self-hosted mini crawler
    if (this.useMiniTier) {
      this._miniHandled.scrape++;
      const mini = await miniScrape(body_url, this.miniLastRequest);
      if (mini) return { data: { markdown: mini.markdown } };
      logger.info(`[Crawler] mini crawler returned nothing for ${body_url}`);
      return null;
    }

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
      this._creditsUsed.scrape++;
      const success = Boolean(response.data?.data?.markdown);
      logger.debug(`[Crawler] fireScraper success: ${body_url} (has_markdown=${success})`);
      return response.data;
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 429) {
        // Rate limited — wait once and retry here instead of burning a
        // Crawlee fallback (which is slower) or dropping the URL entirely.
        const retryAfter = Number(e.response.headers?.["retry-after"]) * 1000 || RATE_LIMIT_RETRY_MS;
        logger.warn(`[Crawler] fireScraper 429 for ${body_url} — retrying in ${retryAfter}ms`);
        await sleep(retryAfter);
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
          this._creditsUsed.scrape++;
          return response.data;
        } catch (retryErr) {
          e = retryErr as typeof e;
        }
      }

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
    logger.debug(`[Crawler] fireMap entry: ${body_url}`);
    await log(`[Crawler] fireMap calling: ${body_url}`);

    // Zero-credit tier: self-hosted link discovery
    if (this.useMiniTier) {
      this._miniHandled.map++;
      const links = await miniDiscover(body_url);
      if (links.length > 0) return { links };
      logger.info(`[Crawler] mini discovery returned no links for ${body_url}`);
      return null;
    }

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
      this._creditsUsed.map++;
      const linkCount = response.data?.links?.length ?? 0;
      logger.debug(`[Crawler] fireMap success: ${body_url} — ${linkCount} links`);
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
    logger.debug(`[Crawler] discoverUrls entry: ${seedUrl}`);

    const result = await this.fireMap(seedUrl);
    // Firecrawl v2 /v2/map returns links as objects {url, title, description}.
    // Normalize to an array of plain URL strings — backward compatible with any
    // future endpoint that returns plain strings.
    const rawLinks: unknown[] = result?.links ?? [];
    const links: string[] = rawLinks.map((l: unknown) =>
      typeof l === "string" ? l : (l as { url: string }).url,
    );
    logger.debug(`[Crawler] discoverUrls: ${links.length} raw links from ${seedUrl}`);

    // Filter out non-job and junk URLs before checking Redis or scraping —
    // every link that survives this check is a Firecrawl credit if scraped.
    const jobLinks = links.filter((link) => !isNonJobUrl(link) && !isJunkUrl(link));
    const skippedCount = links.length - jobLinks.length;
    if (skippedCount > 0) {
      logger.info(`[Crawler] discoverUrls filtered ${skippedCount} non-job URLs from ${seedUrl}`);
    }

    // One smembers round-trip instead of one SISMEMBER per link — Upstash
    // charges per request and the set is capped at SCRAPED_URLS_MAX anyway.
    const scraped = new Set(await this.redis.smembers(SCRAPED_URLS_KEY));
    const fresh = jobLinks.filter((link) => !scraped.has(link));

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

  /** Keep scraped_urls set under SCRAPED_URLS_MAX by trimming random entries. */
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
    logger.info(`[Crawler] scrapePages entry: ${urls.length} URLs (concurrency=${SCRAPE_CONCURRENCY})`);
    await log(`[Crawler] scrapePages starting: ${urls.length} URLs`);

    // Skip already-scraped URLs in one round-trip instead of per-URL checks.
    const scraped = new Set(await this.redis.smembers(SCRAPED_URLS_KEY));
    const candidates = urls.filter((url) => {
      if (isNonJobUrl(url) || isJunkUrl(url)) {
        logger.debug(`[Crawler] scrapePages skip (non-job): ${url}`);
        return false;
      }
      if (scraped.has(url)) {
        logger.debug(`[Crawler] scrapePages skip (already scraped): ${url}`);
        return false;
      }
      return true;
    });

    const scrapedThisRun: string[] = [];
    await mapWithConcurrency(candidates, SCRAPE_CONCURRENCY, async (url) => {
      const res = await this.fireScraper(url);
      const markdown: string | undefined = res?.data?.markdown;
      if (markdown) {
        results.push({ url, markdown });
        scrapedThisRun.push(url);
        logger.debug(`[Crawler] scrapePages scraped: ${url} (${markdown.length} chars)`);
      } else {
        logger.warn(`[Crawler] scrapePages no markdown: ${url}`);
        await log(`[Crawler] scrapePages NO markdown: ${url}`);
      }
      await sleep(SCRAPE_DELAY_MS);
    });

    // Persist what we scraped so future runs skip these URLs.
    for (const url of scrapedThisRun) {
      await this.redis.sadd({ key: SCRAPED_URLS_KEY, member: url });
    }

    logger.info(`[Crawler] scrapePages exit: ${results.length}/${urls.length} pages scraped [heap=${heapUsedMB()}MB]`);
    await log(`[Crawler] scrapePages done: ${results.length}/${urls.length} pages`);
    return results;
  }
}

export { Crawler };

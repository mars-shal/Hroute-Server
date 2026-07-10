import { ApifyClient } from "apify-client";
import { log, logger } from "./logger.js";

const APIFY_ACTOR_ID = "thescrapelab/sitemap-target-url-extractor";

/**
 * Discover URLs from a website's sitemaps using the Apify
 * Sitemap URL Finder Actor.
 *
 * Checks robots.txt → sitemap.xml → follows sitemap indexes.
 * Returns clean, deduplicated URLs as found in the sitemap.
 *
 * Requires APIFY_API_TOKEN env var. Returns empty array if not set
 * or if the Actor fails.
 */
export async function discoverSitemapUrls(
  websiteUrl: string,
  options?: {
    /** Only return URLs containing this text (e.g. "/jobs/", "/careers/") */
    filterText?: string;
    /** Max URLs to return (default: 200) */
    maxResults?: number;
  },
): Promise<string[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    logger.info(`[SitemapDiscoverer] APIFY_API_TOKEN not set, skipping: ${websiteUrl}`);
    return [];
  }

  logger.info(`[SitemapDiscoverer] entry: ${websiteUrl}`);
  await log(`[SitemapDiscoverer] starting: ${websiteUrl}`);

  try {
    const client = new ApifyClient({ token });

    const input = {
      websites: [{ url: websiteUrl }],
      includeUrlText: options?.filterText ?? "",
      maxResults: options?.maxResults ?? 200,
      maxRequestsPerCrawl: 1000,
    };

    const run = await client.actor(APIFY_ACTOR_ID).call(input, {
      waitSecs: 120, // Wait up to 2 min for the Actor to finish
    });

    if (!run) {
      logger.warn(`[SitemapDiscoverer] Actor returned no run: ${websiteUrl}`);
      return [];
    }

    if (run.status !== "SUCCEEDED") {
      logger.warn(`[SitemapDiscoverer] Actor run ${run.id} status: ${run.status}`);
      return [];
    }

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems();

    const urls: string[] = items.map((item: { url?: string }) => item.url).filter(Boolean) as string[];

    logger.info(
      `[SitemapDiscoverer] ${urls.length} URLs from ${websiteUrl} (run ${run.id})`,
    );
    await log(`[SitemapDiscoverer] ${urls.length} URLs from ${websiteUrl}`);

    return urls;
  } catch (e) {
    logger.error(`[SitemapDiscoverer] error ${websiteUrl}:`, e);
    await log(`[SitemapDiscoverer] ERROR: ${websiteUrl} — ${e}`);
    return [];
  }
}

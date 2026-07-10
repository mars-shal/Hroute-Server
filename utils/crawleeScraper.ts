import { CheerioCrawler, RequestQueue } from "@crawlee/cheerio";
import { log, logger } from "./logger.js";

/**
 * Scrape a single page using Crawlee's CheerioCrawler.
 * Returns clean text content (not true markdown, but sufficient for LLM extraction).
 * Designed as a Firecrawl fallback — returns the same shape { markdown }.
 */
export async function scrapePage(
  url: string,
): Promise<{ markdown: string } | null> {
  logger.info(`[Crawlee] scrapePage entry: ${url}`);
  await log(`[Crawlee] scrapePage: ${url}`);

  let result: string | null = null;

  try {
    const requestQueue = await RequestQueue.open();
    await requestQueue.addRequest({ url });

    const crawler = new CheerioCrawler({
      requestQueue,
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
      requestHandler: async ({ $ }) => {
        // Remove non-content elements
        $("script, style, nav, footer, header, aside, .sidebar, .menu, iframe").remove();
        const text = $("body").text().replace(/\s+/g, " ").trim();
        result = text;
      },
      failedRequestHandler: async ({ request }) => {
        logger.error(`[Crawlee] scrapePage failed: ${request.url}`);
      },
    });

    await crawler.run();
    await requestQueue.drop();
  } catch (e) {
    logger.error(`[Crawlee] scrapePage error ${url}:`, e);
    await log(`[Crawlee] scrapePage ERROR: ${url} — ${e}`);
    return null;
  }

  if (result) {
    logger.info(`[Crawlee] scrapePage success: ${url} (${result.length} chars)`);
    await log(`[Crawlee] scrapePage success: ${url} (${result.length} chars)`);
    return { markdown: result };
  }

  logger.warn(`[Crawlee] scrapePage no content: ${url}`);
  await log(`[Crawlee] scrapePage no content: ${url}`);
  return null;
}

/**
 * Discover all links from a seed URL using Crawlee's CheerioCrawler.
 * Extracts all <a href> values from the page, resolving relative URLs.
 * Returns an array of absolute URL strings.
 */
export async function discoverPageLinks(seedUrl: string): Promise<string[]> {
  logger.info(`[Crawlee] discoverPageLinks entry: ${seedUrl}`);
  await log(`[Crawlee] discoverPageLinks: ${seedUrl}`);

  const links = new Set<string>();

  try {
    const requestQueue = await RequestQueue.open();
    await requestQueue.addRequest({ url: seedUrl });

    const crawler = new CheerioCrawler({
      requestQueue,
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
      requestHandler: async ({ $, request }) => {
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
          try {
            const absolute = new URL(href, request.url).href;
            links.add(absolute);
          } catch {
            // Skip malformed URLs
          }
        });
      },
      failedRequestHandler: async ({ request }) => {
        logger.error(`[Crawlee] discoverPageLinks failed: ${request.url}`);
      },
    });

    await crawler.run();
    await requestQueue.drop();
  } catch (e) {
    logger.error(`[Crawlee] discoverPageLinks error ${seedUrl}:`, e);
    await log(`[Crawlee] discoverPageLinks ERROR: ${seedUrl} — ${e}`);
    return [];
  }

  const result = Array.from(links);
  logger.info(`[Crawlee] discoverPageLinks: ${result.length} links from ${seedUrl}`);
  await log(`[Crawlee] discoverPageLinks: ${result.length} links from ${seedUrl}`);
  return result;
}

import { Crawler } from "../utils/crawler";
import { EmbeddingService } from "../utils/embedding";
import { LLM } from "../model/LLM";
import type { Database } from "../model/database";
import { JobMatcher } from "./jobMatcher";
import type { MatchFilters, MatchProgressHandler } from "./jobMatcher";
import { log, logger } from "../utils/logger";
import { SEARCHURLS } from "../utils/search";

/** Strip carriage returns, tabs, zero-width characters from a URL string */
function cleanUrl(raw: string): string {
  return raw
    .trim()
    .replace(/[\r\n\t]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

interface DiscoverResult {
  status: number;
  message: string;
  total_jobs: number;
  errors: string[];
}

class JobApplicationController {
  private crawler: Crawler;
  private llm: LLM;
  private db: Database;
  private matcher: JobMatcher;

  constructor(db: Database) {
    this.crawler = new Crawler();
    this.llm = new LLM();
    this.db = db;
    this.matcher = new JobMatcher(db);
  }

  async Discover(seedUrls?: string[]): Promise<DiscoverResult> {
    const urls = (seedUrls && seedUrls.length > 0 ? seedUrls : SEARCHURLS).map(cleanUrl);
    const errors: string[] = [];
    let totalJobs = 0;

    logger.info(`[Discover] Using ${urls.length} seed URLs`);
    await log(`[Discover] Starting with ${urls.length} seed URLs`);

    for (const [seedIdx, seedUrl] of urls.entries()) {
      // Throttle: avoid Firecrawl rate limits between seed URLs (skip first seed)
      if (seedIdx > 0) {
        const delay = 5000;
        logger.info(`[Discover] Waiting ${delay}ms before next seed...`);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        logger.info(`[Discover] Processing seed [${seedIdx + 1}/${urls.length}]: ${seedUrl}`);
        await log(`[Discover] Seed ${seedIdx + 1}/${urls.length}: ${seedUrl}`);

        const links = await this.crawler.discoverUrls(seedUrl);
        if (links.length === 0) {
          logger.info(`[Discover] No new links from ${seedUrl}`);
          await log(`[Discover] No links from ${seedUrl}`);
          continue;
        }
        logger.info(`[Discover] Found ${links.length} links from ${seedUrl}`);

        const pages = await this.crawler.scrapePages(links);
        if (pages.length === 0) {
          logger.info(`[Discover] No new content from ${seedUrl}`);
          await log(`[Discover] No content from ${seedUrl}`);
          continue;
        }
        logger.info(`[Discover] Scraped ${pages.length} pages from ${seedUrl}`);

        const embeddingService = await EmbeddingService.getInstance();
        let seedJobs = 0;

        for (const { url: pageUrl, markdown } of pages) {
          try {
            const job = await this.llm.extractJob(markdown);

            if (!job.title || !job.company) {
              logger.warn(`[Discover] Skipping ${pageUrl} — LLM returned incomplete job`);
              await log(`[Discover] LLM skip (incomplete): ${pageUrl}`);
              continue;
            }

            const storeRes = await this.db.storeJob({
              title: job.title,
              company: job.company,
              location: job.location ?? null,
              description: job.description ?? markdown.slice(0, 2000),
              skills: job.skills ?? [],
              remote_status: job.remote_status ?? "unknown",
              salary_range: job.salary_range ?? null,
              apply_url: job.apply_url ?? null,
              posted_date: job.posted_date ?? null,
              source_site: job.source_site ?? seedUrl,
              source_url: pageUrl,
              logo_url: job.logo_url ?? null,
              crawled_at: new Date().toISOString(),
            });

            const storedJob = storeRes.data as
              | Array<{ id: string }>
              | { id: string }
              | undefined;
            const jobId =
              storedJob && Array.isArray(storedJob)
                ? storedJob[0]?.id
                : (storedJob as { id: string } | undefined)?.id;

            if (jobId) {
              const description = typeof job.description === "string" ? job.description : "";
              if (description.length > 20) {
                const vector = await embeddingService.embed(description);
                await this.db.storeJobVector(jobId, vector);
                await this.matcher.bumpJobsIndexVersion();
              }
              totalJobs++;
              seedJobs++;
              logger.info(`[Discover] Job stored: "${job.title}" @ ${job.company} (${pageUrl})`);
            } else {
              logger.warn(`[Discover] storeJob returned no jobId for ${pageUrl}`);
            }
          } catch (pageErr) {
            errors.push(`Failed to process ${pageUrl}: ${pageErr}`);
            logger.error(`[Discover] Page error ${pageUrl}:`, pageErr);
          }
        }

        logger.info(`[Discover] Seed ${seedIdx + 1} complete: ${seedJobs} jobs from ${seedUrl}`);
        await log(`[Discover] Seed ${seedIdx + 1} done: ${seedJobs} jobs, ${errors.length} errors total`);
      } catch (seedErr) {
        errors.push(`Failed to process seed ${seedUrl}: ${seedErr}`);
        logger.error(`[Discover] Seed error ${seedUrl}:`, seedErr);
        await log(`[Discover] Seed ${seedUrl} ERROR: ${seedErr}`);
      }
    }

    return {
      status: 200,
      message: `Discovery complete. Found ${totalJobs} jobs.`,
      total_jobs: totalJobs,
      errors,
    };
  }

  async Search(
    token: string,
    filters: MatchFilters = {},
    onProgress?: MatchProgressHandler,
  ): Promise<{
    status: number;
    jobs: Record<string, unknown>[];
    source?: string;
    generated_at?: string;
    cache_key?: string;
    error?: string;
  }> {
    logger.info(`[Search] entry (limit=${filters.limit ?? 20})`);

    try {
      const result = await this.matcher.match(token, filters, onProgress);
      const jobs = result.jobs as Record<string, unknown>[];
      logger.info(`[Search] found ${jobs.length} matching jobs (${result.source ?? 'none'})`);
      await log(`[Search] ${jobs.length} results for token ${token.slice(0, 12)}...`);
      return {
        status: result.status,
        jobs,
        source: result.source,
        generated_at: result.generated_at,
        cache_key: result.cache_key,
        error: result.error,
      };
    } catch (e) {
      logger.error(`[Search] Error: ${e}`);
      await log(`[Search] ERROR: ${e}`);
      return { status: 500, jobs: [], error: String(e) };
    }
  }
}

export { JobApplicationController };

import { Crawler } from "../utils/crawler.js";
import { EmbeddingService } from "../utils/embedding.js";
import { LLM } from "../model/LLM.js";
import type { DatabaseLike } from "../model/database.js";
import { JobMatcher } from "./jobMatcher.js";
import type { JobMatcherService, MatchFilters, MatchProgressHandler } from "./jobMatcher.js";
import { log, logger } from "../utils/logger.js";
import { SEARCHURLS, isFeedSource } from "../utils/search.js";
import { normalizeJobCleanupInput } from "../utils/jobCleanup.js";
import { isJunkPage, isLikelyMarketingPage, processJobPipeline } from "../utils/jobPipeline.js";
import { classifyExperienceLevel, processFeedsInBatches } from "../utils/jobFeeds.js";

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
  private db: DatabaseLike;
  private matcher: JobMatcherService;

  constructor(db: DatabaseLike, matcher?: JobMatcherService) {
    this.crawler = new Crawler();
    this.llm = new LLM();
    this.db = db;
    this.matcher = matcher ?? new JobMatcher(db);
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

        // ── Feed path: free public APIs skip Firecrawl + LLM ──
        if (isFeedSource(seedUrl)) {
          logger.info(`[Discover] Feed source: ${seedUrl} — bypassing Firecrawl`);
          await log(`[Discover] Feed source: ${seedUrl}`);

          const seedHostname = new URL(seedUrl).hostname.replace("www.", "");
          const embeddingService = await EmbeddingService.getInstance();
          let seedJobs = 0;

          const { processed, errors: feedErrors } = await processFeedsInBatches(async (feedJob) => {
            let jobHostname: string;
            try {
              jobHostname = new URL(feedJob.source_url).hostname.replace("www.", "");
            } catch {
              return;
            }
            if (!jobHostname.includes(seedHostname)) return;

            const normalized = normalizeJobCleanupInput({
              description: feedJob.description,
              skills: feedJob.skills.length > 0 ? feedJob.skills : undefined,
              remoteStatus: feedJob.remote_status ?? undefined,
              applyUrl: feedJob.apply_url ?? undefined,
              sourceUrl: feedJob.source_url,
              postedDate: feedJob.posted_date,
            });

            if (normalized.isStale) return;

            const experienceLevel = classifyExperienceLevel(feedJob.title, normalized.description);

            const pipelineResult = processJobPipeline(
              {
                title: feedJob.title,
                company: feedJob.company,
                location: feedJob.location,
                description: normalized.description,
                skills: normalized.skills,
                remote_status: normalized.remoteStatus,
                salary_range: feedJob.salary_range,
                apply_url: normalized.applyUrl,
                posted_date: feedJob.posted_date,
                source_site: feedJob.source_site,
                source_url: feedJob.source_url,
                logo_url: feedJob.logo_url,
              },
              feedJob.source_url,
            );

            const storeRes = await this.db.storeJob({
              title: feedJob.title,
              company: feedJob.company,
              location: feedJob.location,
              description: normalized.description,
              skills: normalized.skills,
              remote_status: pipelineResult.remote_status_normalized,
              salary_range: feedJob.salary_range,
              apply_url: normalized.applyUrl,
              posted_date: pipelineResult.posted_date_parsed ?? feedJob.posted_date,
              source_site: feedJob.source_site,
              source_url: feedJob.source_url,
              logo_url: feedJob.logo_url,
              experience_level: experienceLevel,
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

            if (jobId && normalized.description.length > 20) {
              const vector = await embeddingService.embed(normalized.description);
              await this.db.storeJobVector(jobId, vector);
              await this.matcher.bumpJobsIndexVersion();
            }
            seedJobs++;
          });

          totalJobs += seedJobs;
          errors.push(...feedErrors);
          logger.info(`[Discover] Feed seed done: ${seedJobs} jobs from ${seedUrl}`);
          await log(`[Discover] Feed seed done: ${seedJobs} jobs from ${seedUrl}`);
          continue;
        }

        // ── Firecrawl path: discover + scrape + LLM extract ──
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
            // ── Pipeline: junk filter (saves LLM API calls) ──
            if (isJunkPage(pageUrl, markdown)) {
              logger.info(`[Discover] Skipping ${pageUrl} — junk page detected`);
              await log(`[Discover] Skip (junk): ${pageUrl}`);
              continue;
            }

            const job = await this.llm.extractJob(markdown);

            if (!job.title || !job.company) {
              logger.warn(`[Discover] Skipping ${pageUrl} — LLM returned incomplete job`);
              await log(`[Discover] LLM skip (incomplete): ${pageUrl}`);
              continue;
            }

            const normalized = normalizeJobCleanupInput({
              description:
                typeof job.description === "string" && job.description.trim().length > 0
                  ? job.description
                  : markdown.slice(0, 2000),
              skills: Array.isArray(job.skills)
                ? job.skills.filter((skill): skill is string => typeof skill === "string")
                : undefined,
              remoteStatus: typeof job.remote_status === "string" ? job.remote_status : undefined,
              applyUrl: typeof job.apply_url === "string" ? job.apply_url : undefined,
              sourceUrl: pageUrl,
              postedDate: job.posted_date,
            });

            if (normalized.isStale) {
              const ageDays = normalized.ageDays ?? 0;
              logger.info(`[Discover] Skipping ${pageUrl} — posted ${ageDays.toFixed(0)} days ago (>60)`);
              await log(`[Discover] Skip (old): ${pageUrl} (${ageDays.toFixed(0)}d)`);
              continue;
            }

            // ── Sanity: reject LLM-hallucinated jobs from marketing pages ──
            if (isLikelyMarketingPage(
              (job.company as string) ?? "",
              (job.source_site as string) ?? seedUrl,
              (job.title as string) ?? "",
              (job.apply_url as string) ?? null,
              pageUrl,
              normalized.description,
            )) {
              logger.info(`[Discover] Skipping ${pageUrl} — marketing page (company="${job.company}", source_site="${job.source_site ?? seedUrl}")`);
              await log(`[Discover] Skip (marketing): ${pageUrl}`);
              continue;
            }

            // ── Pipeline: normalize fields for Postgres enum + arrays ──
            const pipelineResult = processJobPipeline(
              {
                title: job.title,
                company: job.company,
                location: job.location ?? null,
                description: normalized.description,
                skills: normalized.skills,
                remote_status: normalized.remoteStatus,
                salary_range: job.salary_range ?? null,
                apply_url: normalized.applyUrl,
                posted_date: job.posted_date ?? null,
                source_site: job.source_site ?? seedUrl,
                source_url: pageUrl,
                logo_url: job.logo_url ?? null,
              },
              pageUrl,
            );

            if ((!Array.isArray(job.skills) || job.skills.length === 0) && normalized.skills.length > 0) {
              logger.info(`[Discover] Inferred ${normalized.skills.length} skills from description for ${pageUrl}`);
            }

            if ((typeof job.remote_status !== "string" || job.remote_status === "unknown") && normalized.remoteStatus !== "unknown") {
              logger.info(`[Discover] Inferred remote_status=${normalized.remoteStatus} for ${pageUrl}`);
            }

            const crawlerExperienceLevel = (job.experience_level as string) ?? classifyExperienceLevel(
              (job.title as string) ?? "",
              normalized.description,
            );

            const storeRes = await this.db.storeJob({
              title: job.title,
              company: job.company,
              location: job.location ?? null,
              description: normalized.description,
              skills: normalized.skills,
              remote_status: pipelineResult.remote_status_normalized,
              salary_range: job.salary_range ?? null,
              apply_url: normalized.applyUrl,
              posted_date: pipelineResult.posted_date_parsed ?? job.posted_date ?? null,
              source_site: job.source_site ?? seedUrl,
              source_url: pageUrl,
              logo_url: job.logo_url ?? null,
              experience_level: crawlerExperienceLevel,
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
              if (normalized.description.length > 20) {
                const vector = await embeddingService.embed(normalized.description);
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

    // Clear scraped_urls set so next discovery re-scrapes all URLs fresh
    await this.crawler.clearScrapedUrls();
    logger.info(`[Discover] Cleared scraped_urls from Redis`);
    await log(`[Discover] Cleared scraped_urls from Redis`);

    // ── Self-check: per-run health metrics ──
    try {
      const selfCheckRows = await this.db.listJobs(1000, 0);
      const jobs = Array.isArray(selfCheckRows) ? selfCheckRows : [];
      if (jobs.length > 0) {
        const total = jobs.length;
        const unspecifiedExp = jobs.filter((j: Record<string, unknown>) => (j.experience_level ?? "unspecified") === "unspecified").length;
        const sourceSites = new Set(jobs.map((j: Record<string, unknown>) => String(j.source_site ?? "")));
        const applyUrls = jobs.map((j: Record<string, unknown>) => String(j.apply_url ?? "")).filter(Boolean);
        const duplicateApplyUrls = applyUrls.length - new Set(applyUrls).size;
        const pctUnspecified = ((unspecifiedExp / total) * 100).toFixed(1);

        logger.info(`[Discover] Self-check: ${total} jobs in DB, ${pctUnspecified}% experience unspecified, ${sourceSites.size} distinct source_sites, ${duplicateApplyUrls} duplicate apply_urls`);
        await log(`[Discover] Self-check: ${total} jobs, ${pctUnspecified}% unspecified exp, ${sourceSites.size} sources, ${duplicateApplyUrls} dup apply_urls`);
      } else {
        logger.info(`[Discover] Self-check: no jobs found in DB`);
      }
    } catch (checkErr) {
      logger.warn(`[Discover] Self-check query failed: ${checkErr}`);
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
export type JobSearchService = Pick<JobApplicationController, "Search">;
export type { JobMatcherService };

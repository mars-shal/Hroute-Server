import { Crawler } from "../utils/crawler.js";
import { EmbeddingService } from "../utils/embedding.js";
import { LLM } from "../model/LLM.js";
import type { DatabaseLike } from "../model/database.js";
import { JobMatcher } from "./jobMatcher.js";
import type { JobMatcherService, MatchFilters, MatchProgressHandler } from "./jobMatcher.js";
import { log, logger } from "../utils/logger.js";
import { SEARCHURLS, isFeedSource, FEED_SOURCES } from "../utils/search.js";
import { normalizeJobCleanupInput } from "../utils/jobCleanup.js";
import { isJunkPage, isLikelyMarketingPage, processJobPipeline } from "../utils/jobPipeline.js";
import { processJobRow } from "../utils/jobEnrichmentPipeline.js";
import { classifyExperienceLevel, discoverFromFeeds } from "../utils/jobFeeds.js";
import { mapWithConcurrency } from "../utils/limiter.js";

/** Strip carriage returns, tabs, zero-width characters from a URL string */
function cleanUrl(raw: string): string {
  return raw
    .trim()
    .replace(/[\r\n\t]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/** Max wall-clock time to spend on a single seed URL (feed or crawler).
 * Prevents a slow/scraping-incompatible site from blocking all 45+ seeds. */
const PER_SEED_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Politeness delay between seed URLs — Firecrawl /map is cheap, but some
 * boards throttle bursts. Configurable so ops can trade speed for safety. */
const SEED_DELAY_MS = Math.max(0, Number(process.env.DISCOVER_SEED_DELAY_MS) || 1500);

/** Page-processing concurrency — each page costs one LLM extraction call, and
 * LLM.complete() already caps provider concurrency via its own semaphore. */
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.DISCOVER_PAGE_CONCURRENCY) || 2);

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
      if (seedIdx > 0 && SEED_DELAY_MS > 0) {
        logger.debug(`[Discover] Waiting ${SEED_DELAY_MS}ms before next seed...`);
        await new Promise((r) => setTimeout(r, SEED_DELAY_MS));
      }

      // Wrap each seed with a timeout so a single slow site doesn't block all 45+
      const seedLabel = `[${seedIdx + 1}/${urls.length}]`;
      try {
        await Promise.race([
          (async () => {
            logger.info(`[Discover] Seed ${seedLabel}: ${seedUrl}`);
            await log(`[Discover] Seed ${seedLabel}: ${seedUrl}`);

            // ── Feed path: free public APIs skip Firecrawl + LLM ──
            if (isFeedSource(seedUrl)) {
              const source = FEED_SOURCES.find((f) => seedUrl.includes(f.domain));
              if (!source) {
                logger.warn(`[Discover] Feed seed matched no source config: ${seedUrl}`);
                return;
              }
              logger.info(`[Discover] Feed source: ${seedUrl} — bypassing Firecrawl`);
              await log(`[Discover] Feed source: ${seedUrl}`);

              const result = await discoverFromFeeds(
                this.db,
                [source],
                { onIngestComplete: async () => { await this.matcher.bumpJobsIndexVersion(); } },
              );
              totalJobs += result.total_jobs;
              errors.push(...result.errors);
              logger.info(`[Discover] Feed seed done: ${result.total_jobs} jobs from ${seedUrl}`);
              await log(`[Discover] Feed seed done: ${result.total_jobs} jobs from ${seedUrl}`);
              return;
            }

            // ── Firecrawl path: discover + scrape + LLM extract ──
            if (this.crawler.firecrawlUnavailable) {
              logger.info(`[Discover] Skipping crawler seed (Firecrawl credits exhausted): ${seedUrl}`);
              await log(`[Discover] Skip (no credits): ${seedUrl}`);
              return;
            }

            const links = await this.crawler.discoverUrls(seedUrl);
            if (links.length === 0) {
              logger.info(`[Discover] No new links from ${seedUrl}`);
              await log(`[Discover] No links from ${seedUrl}`);
              return;
            }
            logger.info(`[Discover] Found ${links.length} links from ${seedUrl}`);

            // Credit gate: skip URLs we already have in the DB BEFORE spending
            // Firecrawl scrape credits and LLM extraction tokens on them. One
            // indexed query replaces re-scraping pages that are already stored.
            const knownUrls = await this.db.listJobSourceUrls(links);
            const freshLinks = knownUrls.size > 0
              ? links.filter((link) => !knownUrls.has(link))
              : links;
            if (freshLinks.length < links.length) {
              logger.info(`[Discover] Skipping ${links.length - freshLinks.length} already-stored URLs from ${seedUrl}`);
            }
            if (freshLinks.length === 0) {
              logger.info(`[Discover] All ${links.length} URLs already stored from ${seedUrl}`);
              return;
            }

            const pages = await this.crawler.scrapePages(freshLinks);
            if (pages.length === 0) {
              logger.info(`[Discover] No new content from ${seedUrl}`);
              await log(`[Discover] No content from ${seedUrl}`);
              return;
            }
            logger.info(`[Discover] Scraped ${pages.length} pages from ${seedUrl}`);

            const embeddingService = await EmbeddingService.getInstance();
            let seedJobs = 0;
            const vectors: Array<{ jobId: string; embedding: number[] }> = [];

            await mapWithConcurrency(pages, PAGE_CONCURRENCY, async ({ url: pageUrl, markdown }) => {
              try {
                if (isJunkPage(pageUrl, markdown)) {
                  logger.info(`[Discover] Skipping ${pageUrl} — junk page detected`);
                  await log(`[Discover] Skip (junk): ${pageUrl}`);
                  return;
                }

                const job = await this.llm.extractJob(markdown);

                if (!job.title || !job.company) {
                  logger.warn(`[Discover] Skipping ${pageUrl} — LLM returned incomplete job`);
                  await log(`[Discover] LLM skip (incomplete): ${pageUrl}`);
                  return;
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
                  return;
                }

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
                  return;
                }

                const rawDesc = typeof job.description === "string" && job.description.trim().length > 0
                  ? job.description
                  : markdown.slice(0, 4000);

                const enrichmentResult = await processJobRow(
                  {
                    title: (job.title as string) ?? "",
                    company: (job.company as string) ?? "",
                    location: (job.location as string) ?? null,
                    description: rawDesc,
                    skills: (job.skills as string[]) ?? [],
                    salary_range: (job.salary_range as string) ?? null,
                    remote_status: normalized.remoteStatus,
                    apply_url: normalized.applyUrl,
                    posted_date: (job.posted_date as string) ?? null,
                    source_site: (job.source_site as string) ?? seedUrl,
                    source_url: pageUrl,
                    logo_url: (job.logo_url as string) ?? null,
                    experience_level: (job.experience_level as string) ?? null,
                  },
                  { runEnrichment: false },
                );

                const cleanedDesc = enrichmentResult.description.data?.clean ?? normalized.description;
                const qualityScore = enrichmentResult.description.data?.qualityScore ?? null;

                if (qualityScore !== null && qualityScore < 50) {
                  logger.info(`[Discover] Low quality (${qualityScore}p): ${job.title}`);
                }

                const pipelineResult = processJobPipeline(
                  {
                    title: (job.title as string) ?? "",
                    company: (job.company as string) ?? "",
                    location: (job.location as string) ?? null,
                    description: cleanedDesc,
                    skills: (enrichmentResult.enriched?.skills as readonly string[] | undefined) ?? normalized.skills,
                    remote_status: normalized.remoteStatus,
                    salary_range: (job.salary_range as string) ?? null,
                    apply_url: normalized.applyUrl,
                    posted_date: (job.posted_date as string) ?? null,
                    source_site: (job.source_site as string) ?? seedUrl,
                    source_url: pageUrl,
                    logo_url: (job.logo_url as string) ?? null,
                  },
                  pageUrl,
                );

                const crawlerExperienceLevel = (job.experience_level as string) ?? classifyExperienceLevel(
                  (job.title as string) ?? "",
                  cleanedDesc,
                );

                const storeRes = await this.db.storeJob({
                  title: (job.title as string) ?? "",
                  company: (job.company as string) ?? "",
                  location: (job.location as string) ?? null,
                  description: cleanedDesc,
                  skills: (enrichmentResult.enriched?.skills as readonly string[] | undefined) ?? normalized.skills,
                  remote_status: pipelineResult.remote_status_normalized,
                  salary_range: (job.salary_range as string) ?? null,
                  apply_url: normalized.applyUrl,
                  posted_date: pipelineResult.posted_date_parsed ?? (job.posted_date as string) ?? null,
                  source_site: (job.source_site as string) ?? seedUrl,
                  source_url: pageUrl,
                  logo_url: (job.logo_url as string) ?? null,
                  experience_level: (enrichmentResult.enriched?.experience_level as string | undefined) ?? crawlerExperienceLevel,
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
                  if (cleanedDesc.length > 20) {
                    vectors.push({ jobId, embedding: await embeddingService.embed(cleanedDesc) });
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
            });

            if (vectors.length > 0) {
              const vectorRes = await this.db.storeJobVectorsBulk(vectors);
              if (vectorRes.status !== 200) {
                errors.push(`bulk vector write for ${seedUrl}: ${String(vectorRes.response ?? vectorRes.error)}`);
              }
            }

            logger.info(`[Discover] Seed ${seedLabel} complete: ${seedJobs} jobs from ${seedUrl}`);
            await log(`[Discover] Seed ${seedLabel} done: ${seedJobs} jobs, ${errors.length} errors total`);
          })(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Seed timeout after ${PER_SEED_TIMEOUT_MS / 1000}s`)),
              PER_SEED_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (seedErr) {
        errors.push(`Seed ${seedUrl}: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`);
        if (seedErr instanceof Error && seedErr.message.includes("timeout")) {
          logger.warn(`[Discover] Seed ${seedLabel} TIMEOUT: ${seedUrl}`);
          await log(`[Discover] Seed ${seedLabel} TIMEOUT: ${seedUrl}`);
        } else {
          logger.error(`[Discover] Seed error ${seedUrl}:`, seedErr);
          await log(`[Discover] Seed ${seedUrl} ERROR: ${seedErr}`);
        }
      }
    }

    // The scraped_urls set is intentionally NOT cleared here: it persists
    // across runs so repeat discoveries skip re-scraping pages we've already
    // paid credits for. Force-refresh by calling clearScrapedUrls() via a
    // dedicated admin path if the content needs re-pulling.

    // ── Self-check: per-run health metrics (lightweight column select) ──
    try {
      const statsResult = await this.db.getJobHealthStats(1000);
      const jobs = Array.isArray(statsResult.data) ? statsResult.data : [];
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

    // Single cache invalidation for the whole run — bumping per job only
    // burns a Redis INCR and churns every user's match cache repeatedly.
    if (totalJobs > 0) {
      await this.matcher.bumpJobsIndexVersion();
    }

    const credits = this.crawler.creditsUsed;
    const mini = this.crawler.miniHandled;
    logger.info(`[Discover] Firecrawl credits used: ${credits.total} (map=${credits.map}, scrape=${credits.scrape})`);
    await log(`[Discover] Firecrawl credits used: ${credits.total} (map=${credits.map}, scrape=${credits.scrape})`);
    if (mini.map + mini.scrape > 0) {
      logger.info(`[Discover] Mini crawler handled: ${mini.map} discoveries, ${mini.scrape} scrapes (0 credits)`);
      await log(`[Discover] Mini crawler handled: ${mini.map} discoveries, ${mini.scrape} scrapes (0 credits)`);
    }
    LLM.reportTokenUsage("Discover");

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

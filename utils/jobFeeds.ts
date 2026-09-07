/**
 * Feed-based job ingestion — single source of truth for all feed config,
 * fetchers, classification, and discovery.
 *
 * These sources expose free, structured public feeds — no Firecrawl call,
 * no LLM extraction needed. Wire discoverFromFeeds() into JobApplicationController
 * alongside the existing crawler-based Discover() path.
 *
 * Requires:
 *   npm install rss-parser axios
 */

import axios from "axios";
import Parser from "rss-parser";
import type { DatabaseLike } from "../model/database.js";
import { EmbeddingService } from "../utils/embedding.js";
import { normalizeJobCleanupInput } from "../utils/jobCleanup.js";
import { processJobPipeline } from "../utils/jobPipeline.js";
import { processJobRow } from "../utils/jobEnrichmentPipeline.js";
import { logger, log } from "../utils/logger.js";
import { mapWithConcurrency, sleep } from "../utils/limiter.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Structured job data from free public feeds — maps directly to storeJob(). */
export type FeedJob = {
  readonly title: string;
  readonly company: string;
  readonly location: string | null;
  readonly description: string;
  readonly skills: readonly string[];
  readonly remote_status: string | null;
  readonly salary_range: string | null;
  readonly apply_url: string | null;
  readonly posted_date: string | null;
  readonly source_site: string;
  readonly source_url: string;
  readonly logo_url: string | null;
};

/** Single source of truth for feed config — search.ts re-exports from here. */
export interface FeedSource {
  /** substring matched against a seed URL, e.g. "remoteok.com" */
  domain: string;
  /** canonical source_site value stored in DB */
  sourceSite: string;
  type: "json" | "rss";
  feedUrl: string;
}

export const FEED_SOURCES: FeedSource[] = [
  { domain: "remoteok.com", sourceSite: "remoteok.com", type: "json", feedUrl: "https://remoteok.com/api" },
  { domain: "remotive.com", sourceSite: "remotive.com", type: "json", feedUrl: "https://remotive.com/api/remote-jobs" },
  { domain: "weworkremotely.com", sourceSite: "weworkremotely.com", type: "rss", feedUrl: "https://weworkremotely.com/remote-jobs.rss" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isFeedSource(seedUrl: string): boolean {
  return FEED_SOURCES.some((f) => seedUrl.includes(f.domain));
}

/** Strip HTML tags, decode basic entities, trim to maxLength chars. */
function stripHtml(html: string, maxLength = 2000): string {
  const stripped = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped;
}

/** Deduplicate FeedJob[] by source_url. */
function deduplicateByUrl(jobs: FeedJob[]): FeedJob[] {
  const seen = new Set<string>();
  const out: FeedJob[] = [];
  for (const job of jobs) {
    if (!seen.has(job.source_url)) {
      seen.add(job.source_url);
      out.push(job);
    }
  }
  return out;
}

// ── Experience Level Classification ──────────────────────────────────────────

export type ExperienceLevel = "entry" | "mid" | "senior" | "unspecified";

// Order matters: check senior/exclusion signals first. A title like
// "Senior Software Engineer (Junior team lead welcome)" should not
// classify as entry just because "junior" appears somewhere in the text.
const SENIOR_PATTERNS = [
  /\bsenior\b/i,
  /\bsr\.?\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\blead\b/i,
  /\bhead of\b/i,
  /\bdirector\b/i,
  /\bvp\b/i,
  /\bmanager\b/i,
  /\b\d{1,2}\+?\s*years?\b/i,
];

const ENTRY_PATTERNS = [
  /\bjunior\b/i,
  /\bjr\.?\b/i,
  /\bentry.level\b/i,
  /\bentry\b/i,
  /\bgraduate\b/i,
  /\bgrad\b/i,
  /\bintern(ship)?\b/i,
  /\btrainee\b/i,
  /\bnysc\b/i,
  /\bassociate\b/i,
  /\bno experience (required|needed)\b/i,
  /\b0[-–]?1 years?\b/i,
];

/**
 * Weighted keyword scoring for seniority, used by the JobMatcher to
 * boost entry-level jobs and penalize senior-heavy ones in reranking.
 * Positive score = entry/junior-friendly; negative = senior-oriented.
 * Aggregated across both title and description.
 */
export function computeSeniorityScore(title: string, description: string): number {
  const text = `${title} ${description}`;
  let score = 0;

  // Strong entry-level signals (+3 each)
  if (/\b(junior|jr\.?)\b/i.test(text)) score += 3;
  if (/\b(graduate|grad|new.grad)\b/i.test(text)) score += 3;
  if (/\bintern(ship)?\b/i.test(text)) score += 3;
  if (/\b(trainee|apprentice)\b/i.test(text)) score += 3;
  if (/\bentry\b/i.test(text)) score += 3;
  if (/\bnysc\b/i.test(text)) score += 3;
  if (/\bno experience\b/i.test(text)) score += 3;
  if (/\b0[-–]?[12] years?\b/i.test(text)) score += 3;

  // Moderate entry-level signals (+2 each)
  if (/\bassociate\b/i.test(text)) score += 2;
  if (/\bearly career\b/i.test(text)) score += 2;

  // Strong seniority penalties (-6 each)
  if (/\b(staff|principal)\b/i.test(text)) score -= 6;
  if (/\b(head of|director|vp|architect)\b/i.test(text)) score -= 6;

  // Moderate seniority penalties (-5 each)
  if (/\b(senior|sr\.?)\b/i.test(text)) score -= 5;
  if (/\blead\b/i.test(text)) score -= 5;

  // Minor seniority penalties (-4 each)
  if (/\bmanager\b/i.test(text)) score -= 4;
  if (/\b\d{1,2}\+?\s*years?\b/i.test(text)) score -= 4;

  // Clamp to [-10, +10] so a single bad/good match doesn't dominate everything
  return Math.max(-10, Math.min(10, score));
}

/**
 * Cheap keyword classifier for sources with no LLM extraction step (feeds).
 * Title checked first in isolation; falls back to title+description.
 * "unspecified" is an honest bucket rather than forcing a guess.
 */
export function classifyExperienceLevel(title: string, description: string): ExperienceLevel {
  const titleText = title || "";
  const fullText = `${title} ${description}`;

  if (SENIOR_PATTERNS.some((p) => p.test(titleText))) return "senior";
  if (ENTRY_PATTERNS.some((p) => p.test(titleText))) return "entry";

  if (SENIOR_PATTERNS.some((p) => p.test(fullText))) return "senior";
  if (ENTRY_PATTERNS.some((p) => p.test(fullText))) return "entry";

  return "unspecified";
}

// ── Per-Source Fetchers ──────────────────────────────────────────────────────

const rssParser = new Parser();

async function fetchRemoteOkFeed(): Promise<FeedJob[]> {
  const url = "https://remoteok.com/api";
  logger.info(`[FeedFetcher] Fetching RemoteOK: ${url}`);

  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: { "User-Agent": "hroute-job-discovery" },
  });

  const items: Record<string, unknown>[] = Array.isArray(data)
    ? data.filter(
        (item: Record<string, unknown>) =>
          typeof item === "object" && item !== null && "id" in item,
      )
    : [];

  const jobs: FeedJob[] = [];

  for (const item of items) {
    const title = typeof item.position === "string" ? item.position.trim() : "";
    const company = typeof item.company === "string" ? item.company.trim() : "";
    if (!title || !company) continue;

    const description = typeof item.description === "string" ? item.description : "";
    if (!description.trim()) continue;

    const slug = typeof item.slug === "string" ? item.slug : String(item.id ?? "");
    const applyUrl = typeof item.url === "string" ? item.url : null;

    const tags = Array.isArray(item.tags)
      ? (item.tags as unknown[])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.toLowerCase().trim())
      : [];

    const salaryMin =
      typeof item.salary_min === "number" && item.salary_min > 0 ? item.salary_min : null;
    const salaryMax =
      typeof item.salary_max === "number" && item.salary_max > 0 ? item.salary_max : null;
    let salaryRange: string | null = null;
    if (salaryMin && salaryMax) {
      salaryRange = `$${Math.round(salaryMin / 1000)}k-$${Math.round(salaryMax / 1000)}k`;
    } else if (salaryMin) {
      salaryRange = `$${Math.round(salaryMin / 1000)}k+`;
    }

    const remoteStatus = item.remote === true || item.remote === 1 ? "remote" : null;
    const dateRaw =
      typeof item.date === "string" || typeof item.date === "number" ? String(item.date) : null;
    const logoUrl = typeof item.company_logo === "string" ? item.company_logo : null;
    const sourceUrl = slug
      ? `https://remoteok.com/remote-jobs/${slug}`
      : applyUrl ?? "";

    if (!sourceUrl) continue;

    jobs.push({
      title,
      company,
      location: null,
      description: stripHtml(description),
      skills: tags,
      remote_status: remoteStatus,
      salary_range: salaryRange,
      apply_url: applyUrl,
      posted_date: dateRaw,
      source_site: "remoteok.com",
      source_url: sourceUrl,
      logo_url: logoUrl,
    });
  }

  return jobs;
}

async function fetchRemotiveFeed(): Promise<FeedJob[]> {
  const url = "https://remotive.com/api/remote-jobs";
  logger.info(`[FeedFetcher] Fetching Remotive: ${url}`);

  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: { "User-Agent": "hroute-job-discovery" },
  });

  const items: Record<string, unknown>[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const jobs: FeedJob[] = [];

  for (const item of items) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const company =
      typeof item.company_name === "string" ? item.company_name.trim() : "";
    if (!title || !company) continue;

    const description = typeof item.description === "string" ? item.description : "";
    if (!description.trim()) continue;

    const tags = Array.isArray(item.tags)
      ? (item.tags as unknown[])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.toLowerCase().trim())
      : [];

    const candidateLocation =
      typeof item.candidate_required_location === "string"
        ? item.candidate_required_location.trim()
        : null;
    const location =
      candidateLocation && candidateLocation !== "Anywhere" ? candidateLocation : null;
    const salary =
      typeof item.salary === "string" && item.salary.trim() ? item.salary.trim() : null;
    const applyUrl = typeof item.url === "string" ? item.url : null;
    const sourceUrl = applyUrl ?? "";
    const pubDate =
      typeof item.publication_date === "string" ? item.publication_date : null;
    const logoUrl =
      typeof item.company_logo === "string" ? item.company_logo : null;

    if (!sourceUrl) continue;

    jobs.push({
      title,
      company,
      location,
      description: stripHtml(description),
      skills: tags,
      remote_status: "remote",
      salary_range: salary,
      apply_url: applyUrl,
      posted_date: pubDate,
      source_site: "remotive.com",
      source_url: sourceUrl,
      logo_url: logoUrl,
    });
  }

  return jobs;
}

async function fetchWwrFeed(): Promise<FeedJob[]> {
  const feedUrl = "https://weworkremotely.com/remote-jobs.rss";
  logger.info(`[FeedFetcher] Fetching WWR: ${feedUrl}`);

  const feed = await rssParser.parseURL(feedUrl);
  const jobs: FeedJob[] = [];

  for (const item of feed.items) {
    const title = (item.title ?? "").trim();
    if (!title) continue;

    const colonIdx = title.indexOf(":");
    const company = colonIdx > 0 ? title.slice(0, colonIdx).trim() : "Unknown";
    const jobTitle = colonIdx > 0 ? title.slice(colonIdx + 1).trim() : title;

    const rawDesc = item["content:encoded"] ?? item.content ?? "";
    if (!rawDesc.trim()) continue;

    const applyUrl = item.link ?? null;
    const sourceUrl = applyUrl ?? "";
    if (!sourceUrl) continue;

    const pubDate = item.pubDate ?? null;

    jobs.push({
      title: jobTitle,
      company,
      location: null,
      description: stripHtml(rawDesc),
      skills: [],
      remote_status: "remote",
      salary_range: null,
      apply_url: applyUrl,
      posted_date: pubDate,
      source_site: "weworkremotely.com",
      source_url: sourceUrl,
      logo_url: null,
    });
  }

  return jobs;
}

/** Dispatch to the correct fetcher by source_site. */
async function fetchFeedBySource(sourceSite: string): Promise<FeedJob[]> {
  if (sourceSite === "remoteok.com") return fetchRemoteOkFeed();
  if (sourceSite === "remotive.com") return fetchRemotiveFeed();
  if (sourceSite === "weworkremotely.com") return fetchWwrFeed();
  throw new Error(`No fetcher configured for ${sourceSite}`);
}

// ── Combined APIs ────────────────────────────────────────────────────────────

/**
 * Fetch all feeds, deduplicate by source_url, return flat array.
 * Use ingestFeedJobs for efficient processing.
 */
export async function fetchAllFeeds(): Promise<FeedJob[]> {
  const [remoteOk, remotive, wwr] = await Promise.allSettled([
    fetchRemoteOkFeed(),
    fetchRemotiveFeed(),
    fetchWwrFeed(),
  ]);

  const allJobs: FeedJob[] = [];

  for (const result of [remoteOk, remotive, wwr]) {
    if (result.status === "fulfilled") {
      allJobs.push(...result.value);
    } else {
      logger.error(`[FeedFetcher] Feed fetch failed:`, result.reason);
    }
  }

  const deduped = deduplicateByUrl(allJobs);
  logger.info(
    `[FeedFetcher] fetchAllFeeds: ${deduped.length} jobs (${allJobs.length} raw)`,
  );
  return deduped;
}

// ── Shared Ingestion Pipeline ────────────────────────────────────────────────

export type FeedIngestStats = {
  stored: number;
  skipped_stale: number;
  low_quality: number;
  errors: string[];
};

export type FeedIngestHooks = {
  /** Called once after all jobs are stored (cache invalidation). */
  onIngestComplete?: () => Promise<void> | void;
};

/** Parallelism for per-job store work — Supabase upserts are idempotent on
 * source_url, so pooled writes are safe and keep per-job latency off the
 * critical path. */
const FEED_INGEST_CONCURRENCY = Math.max(1, Number(process.env.FEED_INGEST_CONCURRENCY) || 5);
/** Embedding batch size — MiniLM handles ~32 short texts per forward pass. */
const FEED_EMBED_BATCH = 32;

/**
 * Normalize, quality-check, store, and embed a batch of feed jobs.
 *
 * Single shared path for both feed entry points (Discover feed seeds and the
 * standalone /jobs/discover/feeds route): pooled stores, one batched embed
 * pass, one bulk vector write, one index-version bump at the end.
 */
export async function ingestFeedJobs(
  jobs: readonly FeedJob[],
  db: DatabaseLike,
  embeddingService: EmbeddingService,
  hooks: FeedIngestHooks = {},
  sourceSiteOverride?: string,
): Promise<FeedIngestStats> {
  const stats: FeedIngestStats = { stored: 0, skipped_stale: 0, low_quality: 0, errors: [] };
  const vectors: Array<{ jobId: string; embedding: number[] }> = [];

  await mapWithConcurrency(jobs, FEED_INGEST_CONCURRENCY, async (raw) => {
    try {
      const normalized = normalizeJobCleanupInput({
        description: raw.description || raw.title,
        skills: raw.skills.length > 0 ? [...raw.skills] : undefined,
        applyUrl: raw.apply_url ?? undefined,
        sourceUrl: raw.source_url,
        postedDate: raw.posted_date ?? undefined,
      });

      if (normalized.isStale) {
        stats.skipped_stale++;
        return;
      }

      const experienceLevel = classifyExperienceLevel(raw.title, normalized.description);

      const enrichmentResult = await processJobRow(
        {
          title: raw.title,
          company: raw.company || "Unknown",
          location: raw.location ?? null,
          description: raw.description || raw.title,
          skills: raw.skills,
          salary_range: raw.salary_range,
          remote_status: normalized.remoteStatus,
          apply_url: normalized.applyUrl,
          posted_date: raw.posted_date,
          source_site: sourceSiteOverride ?? raw.source_site,
          source_url: raw.source_url,
          logo_url: raw.logo_url,
          experience_level: experienceLevel,
        },
        { runEnrichment: false },
      );

      const cleanedDesc = enrichmentResult.description.data?.clean ?? normalized.description;
      const qualityScore = enrichmentResult.description.data?.qualityScore ?? null;
      if (qualityScore !== null && qualityScore < 50) {
        stats.low_quality++;
        logger.info(`[FeedIngest] Low quality (${qualityScore}p): ${raw.title} @ ${raw.company}`);
      }

      const pipelineResult = processJobPipeline(
        {
          title: raw.title,
          company: raw.company || "Unknown",
          location: raw.location ?? null,
          description: cleanedDesc,
          skills: (enrichmentResult.enriched?.skills as readonly string[] | undefined) ?? normalized.skills,
          remote_status: normalized.remoteStatus,
          salary_range: raw.salary_range,
          apply_url: normalized.applyUrl,
          posted_date: raw.posted_date,
          source_site: sourceSiteOverride ?? raw.source_site,
          source_url: raw.source_url,
          logo_url: raw.logo_url,
        },
        raw.source_url,
      );

      const storeRes = await db.storeJob({
        title: raw.title,
        company: raw.company || "Unknown",
        location: raw.location ?? null,
        description: cleanedDesc,
        skills: (enrichmentResult.enriched?.skills as readonly string[] | undefined) ?? normalized.skills,
        remote_status: pipelineResult.remote_status_normalized,
        salary_range: raw.salary_range,
        apply_url: normalized.applyUrl,
        posted_date: pipelineResult.posted_date_parsed ?? raw.posted_date ?? null,
        source_site: sourceSiteOverride ?? raw.source_site,
        source_url: raw.source_url,
        logo_url: raw.logo_url,
        experience_level: enrichmentResult.enriched?.experience_level ?? experienceLevel,
        crawled_at: new Date().toISOString(),
      });

      const storedJob = storeRes.data as Array<{ id: string }> | { id: string } | undefined;
      const jobId = Array.isArray(storedJob) ? storedJob[0]?.id : storedJob?.id;

      if (jobId && cleanedDesc.length > 20) {
        vectors.push({ jobId, embedding: await embeddingService.embed(cleanedDesc) });
      }
      stats.stored++;
    } catch (jobErr) {
      stats.errors.push(`[${sourceSiteOverride ?? raw.source_site}] ${raw.source_url}: ${jobErr}`);
    }
  });

  // One batched embed pass is already done above (local model, ~1ms/text);
  // the network win is writing all vectors in one bulk upsert.
  if (vectors.length > 0) {
    const vectorRes = await db.storeJobVectorsBulk(vectors);
    if (vectorRes.status !== 200) {
      stats.errors.push(`bulk vector write: ${String(vectorRes.response ?? vectorRes.error)}`);
    }
  }

  await hooks.onIngestComplete?.();

  logger.info(`[FeedIngest] ${stats.stored} stored, ${stats.skipped_stale} stale, ${stats.low_quality} low quality, ${stats.errors.length} errors`);
  return stats;
}

// ── Standalone Discovery Pipeline ────────────────────────────────────────────

/**
 * Ingests all configured feed sources directly into storage.
 * No crawler, no Firecrawl credits, no LLM extraction call.
 */
export async function discoverFromFeeds(
  db: DatabaseLike,
  sources: FeedSource[] = FEED_SOURCES,
  hooks: FeedIngestHooks = {},
): Promise<{ total_jobs: number; errors: string[] }> {
  const errors: string[] = [];
  let totalJobs = 0;
  const embeddingService = await EmbeddingService.getInstance();

  for (const source of sources) {
    try {
      logger.info(`[FeedDiscover] Fetching ${source.sourceSite}`);
      const rawJobs = await fetchFeedBySource(source.sourceSite);
      logger.info(`[FeedDiscover] ${rawJobs.length} items from ${source.sourceSite}`);

      const stats = await ingestFeedJobs(rawJobs, db, embeddingService, hooks, source.sourceSite);
      totalJobs += stats.stored;
      errors.push(...stats.errors);

      logger.info(`[FeedDiscover] ${source.sourceSite}: stored ${stats.stored} jobs`);
      await log(`[FeedDiscover] ${source.sourceSite}: ${stats.stored} jobs stored`);
    } catch (sourceErr) {
      errors.push(`[${source.sourceSite}] fetch failed: ${sourceErr}`);
      logger.error(`[FeedDiscover] ${source.sourceSite} error:`, sourceErr);
    }
    await sleep(500); // polite gap between feed APIs
  }

  return { total_jobs: totalJobs, errors };
}

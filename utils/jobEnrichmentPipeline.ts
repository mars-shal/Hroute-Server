/**
 * Job Enrichment Pipeline — orchestrates description cleaning, salary parsing,
 * and LLM-based structured enrichment into a single composable pipeline.
 *
 * Usage:
 *   const result = await processJobRow(rawJob);
 *   if (result.usable) {
 *     await db.storeJob(result.enriched);
 *   }
 *
 * Each stage is independent — you can run them separately if needed.
 * The pipeline never throws; it reports errors per-stage.
 */

import { LLM } from "../model/LLM.js";
import { cleanDescription, type CleanDescription } from "./descriptionCleaner.js";
import { enrichJob, type EnrichedJob, type EnrichmentResult } from "./jobEnricher.js";
import { parseSalary, type ParsedSalary } from "./salaryParser.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────

export type RawJobInput = {
  title: string;
  company: string;
  description: string | null;
  description_raw?: string | null;
  skills?: readonly string[] | null;
  salary_range?: string | null;
  location?: string | null;
  remote_status?: string | null;
  apply_url?: string | null;
  posted_date?: string | null;
  source_site?: string | null;
  source_url?: string;
  experience_level?: string | null;
  logo_url?: string | null;
};

export type PipelineStageResult<T> = {
  success: boolean;
  data: T | null;
  error?: string;
  skipped?: boolean;
};

export type PipelineResult = {
  /** Unique job identifier (from source_url) */
  jobId: string;
  /** Whether the job is usable (passes quality gates) */
  usable: boolean;
  /** Description cleaning result */
  description: PipelineStageResult<CleanDescription>;
  /** Salary parsing result */
  salary: PipelineStageResult<ParsedSalary>;
  /** LLM enrichment result */
  enrichment: PipelineStageResult<EnrichedJob>;
  /** Full enriched job record for storage */
  enriched: Record<string, unknown> | null;
  /** Rejection reason if not usable */
  rejection_reason?: string;
  /** Processing timestamp */
  processed_at: string;
};

// ── Default rejection thresholds ────────────────────────────────

export type PipelineConfig = {
  /** Minimum description quality score (0-100) for the job to be usable */
  minDescriptionScore: number;
  /** Minimum description length in chars */
  minDescriptionLength: number;
  /** Whether to run LLM enrichment (can skip to save cost) */
  runEnrichment: boolean;
};

const DEFAULT_CONFIG: PipelineConfig = {
  minDescriptionScore: 50,
  minDescriptionLength: 100,
  runEnrichment: true,
};

// ── Pipeline ────────────────────────────────────────────────────

/**
 * Run the full enrichment pipeline on a raw job input.
 *
 * Stages:
 *   1. Description cleaning (source-specific extraction + pollution detection)
 *   2. Salary parsing (deterministic)
 *   3. LLM enrichment (summary, responsibilities, requirements, skills)
 *   4. Quality gate
 *   5. Build enriched record
 */
export async function processJobRow(
  raw: RawJobInput,
  config: Partial<PipelineConfig> = {},
  llm?: LLM,
): Promise<PipelineResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date().toISOString();
  const jobId = raw.source_url ?? `${raw.company}-${raw.title}`.replace(/[^a-z0-9]/gi, "-").toLowerCase();

  // ── Stage 1: Description cleaning ──
  const descriptionResult = cleanDescription(
    raw.description ?? raw.description_raw ?? null,
    raw.source_site,
  );

  const descriptionStage: PipelineStageResult<CleanDescription> = {
    success: descriptionResult.usable,
    data: descriptionResult,
    error: descriptionResult.usable ? undefined : `Quality score ${descriptionResult.qualityScore}: ${descriptionResult.quality}`,
  };

  // ── Stage 2: Salary parsing ──
  const parsedSalary = parseSalary(raw.salary_range ?? null);

  const salaryStage: PipelineStageResult<ParsedSalary> = {
    success: parsedSalary.confidence !== "low",
    data: parsedSalary,
  };

  // ── Stage 3: LLM enrichment ──
  let enrichmentStage: PipelineStageResult<EnrichedJob> = { success: false, data: null, skipped: true };

  if (cfg.runEnrichment && descriptionResult.usable && descriptionResult.clean.length >= cfg.minDescriptionLength) {
    const enrichmentResult = await enrichJob(descriptionResult.clean, raw.title, llm);
    enrichmentStage = {
      success: enrichmentResult.success,
      data: enrichmentResult.data,
      error: enrichmentResult.error,
      skipped: false,
    };
  }

  // ── Stage 4: Quality gate ──
  const qualityChecks: string[] = [];

  if (descriptionResult.qualityScore < cfg.minDescriptionScore) {
    qualityChecks.push(`description_quality: ${descriptionResult.qualityScore} < ${cfg.minDescriptionScore}`);
  }
  if (descriptionResult.clean.length < cfg.minDescriptionLength) {
    qualityChecks.push(`description_length: ${descriptionResult.clean.length} < ${cfg.minDescriptionLength}`);
  }
  if (!raw.title || raw.title.trim().length < 2) {
    qualityChecks.push("missing_title");
  }
  if (!raw.company || raw.company.trim().length < 2) {
    qualityChecks.push("missing_company");
  }

  const usable = qualityChecks.length === 0;
  const rejectionReason = usable ? undefined : qualityChecks.join("; ");

  // ── Stage 5: Build enriched record ──
  let enriched: Record<string, unknown> | null = null;

  if (usable) {
    enriched = {
      title: raw.title.trim(),
      company: raw.company.trim(),
      location: raw.location?.trim() ?? null,
      description: descriptionResult.clean,
      description_raw: raw.description ?? null,
      description_quality: descriptionResult.quality,
      description_quality_score: descriptionResult.qualityScore,
      skills: enrichmentStage.data?.skills
        ? [...enrichmentStage.data.skills.technical, ...enrichmentStage.data.skills.domain, ...enrichmentStage.data.skills.tools]
        : raw.skills ?? [],
      skills_technical: enrichmentStage.data?.skills?.technical ?? null,
      skills_domain: enrichmentStage.data?.skills?.domain ?? null,
      skills_tools: enrichmentStage.data?.skills?.tools ?? null,
      remote_status: raw.remote_status?.toLowerCase().trim() ?? "unknown",
      salary_min: parsedSalary.min,
      salary_max: parsedSalary.max,
      salary_currency: parsedSalary.currency,
      salary_period: parsedSalary.period,
      salary_type: parsedSalary.type,
      salary_range: raw.salary_range ?? null,
      apply_url: raw.apply_url?.trim() ?? null,
      posted_date: raw.posted_date ?? null,
      source_site: raw.source_site?.trim() ?? null,
      source_url: raw.source_url?.trim() ?? "",
      experience_level: raw.experience_level
        ?? enrichmentStage.data?.experience?.level
        ?? "unspecified",
      experience_min_years: enrichmentStage.data?.experience?.min_years ?? null,
      experience_max_years: enrichmentStage.data?.experience?.max_years ?? null,
      employment_type: enrichmentStage.data?.employment_type ?? "unknown",
      remote_scope: enrichmentStage.data?.remote_scope ?? "unknown",
      summary: enrichmentStage.data?.summary ?? null,
      responsibilities: enrichmentStage.data?.responsibilities ?? null,
      requirements_required: enrichmentStage.data?.requirements?.required ?? null,
      requirements_preferred: enrichmentStage.data?.requirements?.preferred ?? null,
      education_required: enrichmentStage.data?.education ?? null,
      enriched_at: now,
      logo_url: raw.logo_url?.trim() ?? null,
    };
  }

  return {
    jobId,
    usable,
    description: descriptionStage,
    salary: salaryStage,
    enrichment: enrichmentStage,
    enriched,
    rejection_reason: rejectionReason,
    processed_at: now,
  };
}

/**
 * Process multiple job rows, optionally batching enrichment calls
 * to avoid overwhelming the LLM rate limiter.
 */
export async function processJobBatch(
  rows: RawJobInput[],
  config: Partial<PipelineConfig> = {},
  batchSize = 5,
  llm?: LLM,
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(row => processJobRow(row, config, llm)),
    );
    results.push(...batchResults);

    if (i + batchSize < rows.length) {
      logger.info(`[JobPipeline] Processed ${Math.min(i + batchSize, rows.length)}/${rows.length} rows`);
    }
  }

  return results;
}

/**
 * Generate a summary report from pipeline results.
 */
export function summarizePipelineResults(results: PipelineResult[]): {
  total: number;
  usable: number;
  rejected: number;
  enriched: number;
  rejectionBreakdown: Record<string, number>;
} {
  const rejectionBreakdown: Record<string, number> = {};
  let usable = 0;
  let enriched = 0;

  for (const r of results) {
    if (r.usable) {
      usable++;
      if (r.enrichment.success) enriched++;
    } else if (r.rejection_reason) {
      for (const reason of r.rejection_reason.split("; ")) {
        rejectionBreakdown[reason] = (rejectionBreakdown[reason] ?? 0) + 1;
      }
    }
  }

  return {
    total: results.length,
    usable,
    rejected: results.length - usable,
    enriched,
    rejectionBreakdown,
  };
}

import { EmbeddingService } from "../utils/embedding.js";
import { log, logger } from "../utils/logger.js";
import type { DatabaseLike } from "../model/database.js";
import { JobMatcher } from "./jobMatcher.js";
import type { JobMatcherService } from "./jobMatcher.js";
import { normalizeJobCleanupInput } from "../utils/jobCleanup.js";

type CleanupJobRow = {
  readonly id: string;
  readonly description: string | null;
  readonly skills: readonly string[] | null;
  readonly remote_status: string | null;
  readonly apply_url: string | null;
  readonly source_url: string;
  readonly posted_date: string | null;
};

type CleanupJobsOptions = {
  readonly limit?: number;
  readonly dry_run?: boolean;
  readonly prune_old?: boolean;
  readonly recompute_embeddings?: boolean;
  /** Re-derive skills from description using the current word-boundary regex,
   * replacing stored skills. Use this once after fixing inferSkillsFromText
   * to purge false positives from old substring matching. */
  readonly force_reinfer_skills?: boolean;
};

type CleanupJobsResult = {
  readonly status: number;
  readonly scanned: number;
  readonly updated: number;
  readonly pruned: number;
  readonly stale_found: number;
  readonly dry_run: boolean;
  readonly errors: readonly string[];
  readonly message: string;
};

class JobMaintenanceController {
  private db: DatabaseLike;
  private matcher: JobMatcherService;

  constructor(db: DatabaseLike, matcher?: JobMatcherService) {
    this.db = db;
    this.matcher = matcher ?? new JobMatcher(db);
  }

  async CleanupJobs(options: CleanupJobsOptions = {}): Promise<CleanupJobsResult> {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
    const dryRun = options.dry_run ?? false;
    const pruneOld = options.prune_old ?? false;
    const recomputeEmbeddings = options.recompute_embeddings ?? true;
    const reinferSkills = options.force_reinfer_skills ?? false;
    const errors: string[] = [];

    const listResult = await this.db.listJobsForCleanup(limit);
    if (listResult.status !== 200 || !Array.isArray(listResult.data)) {
      return {
        status: listResult.status ?? 500,
        scanned: 0,
        updated: 0,
        pruned: 0,
        stale_found: 0,
        dry_run: dryRun,
        errors: [String(listResult.response ?? listResult.error ?? "Failed to list jobs")],
        message: "Job cleanup failed before scanning rows.",
      };
    }

    const rows = listResult.data.filter((row): row is CleanupJobRow => {
      if (!row || typeof row !== "object") {
        return false;
      }

      const record = row as Record<string, unknown>;
      return typeof record.id === "string" && typeof record.source_url === "string";
    });

    const embeddingService = recomputeEmbeddings && !dryRun ? await EmbeddingService.getInstance() : null;
    let updated = 0;
    let pruned = 0;
    let staleFound = 0;

    for (const row of rows) {
      const normalized = normalizeJobCleanupInput({
        description: row.description ?? "",
        skills: reinferSkills ? null : row.skills,
        remoteStatus: row.remote_status,
        applyUrl: row.apply_url,
        sourceUrl: row.source_url,
        postedDate: row.posted_date,
      });

      if (normalized.isStale) {
        staleFound += 1;
        if (pruneOld) {
          if (!dryRun) {
            const vectorDeleteResult = await this.db.deleteJobVector(row.id);
            if (vectorDeleteResult.status && vectorDeleteResult.status >= 400) {
              errors.push(`deleteJobVector ${row.id}: ${String(vectorDeleteResult.response ?? vectorDeleteResult.error)}`);
              continue;
            }
            const deleteResult = await this.db.deleteJobById(row.id);
            if (deleteResult.status !== 200) {
              errors.push(`deleteJobById ${row.id}: ${String(deleteResult.response ?? deleteResult.error)}`);
              continue;
            }
          }
          pruned += 1;
          continue;
        }
      }

      const currentSkills = Array.isArray(row.skills) ? row.skills : [];
      const nextSkills = [...normalized.skills];
      const currentApplyUrl = row.apply_url?.trim() ?? "";
      const shouldUpdateDescription = normalized.description !== (row.description ?? "");
      const shouldUpdateRemoteStatus = normalized.remoteStatus !== (row.remote_status ?? "unknown");
      const shouldUpdateApplyUrl = normalized.applyUrl !== currentApplyUrl;
      const shouldUpdateSkills =
        currentSkills.length !== nextSkills.length || currentSkills.some((skill, index) => skill !== nextSkills[index]);

      if (!shouldUpdateDescription && !shouldUpdateRemoteStatus && !shouldUpdateApplyUrl && !shouldUpdateSkills) {
        continue;
      }

      if (!dryRun) {
        const patch: Record<string, unknown> = {};
        if (shouldUpdateDescription) {
          patch.description = normalized.description;
        }
        if (shouldUpdateRemoteStatus) {
          patch.remote_status = normalized.remoteStatus;
        }
        if (shouldUpdateApplyUrl) {
          patch.apply_url = normalized.applyUrl;
        }
        if (shouldUpdateSkills) {
          patch.skills = nextSkills;
        }

        const updateResult = await this.db.updateJobById(row.id, patch);
        if (updateResult.status !== 200) {
          errors.push(`updateJobById ${row.id}: ${String(updateResult.response ?? updateResult.error)}`);
          continue;
        }

        updated += 1;

        if (embeddingService && shouldUpdateDescription && normalized.description.length > 20) {
          const vector = await embeddingService.embed(normalized.description);
          const vectorResult = await this.db.storeJobVector(row.id, vector);
          if (vectorResult.status !== 200) {
            errors.push(`storeJobVector ${row.id}: ${String(vectorResult.response ?? vectorResult.error)}`);
          }
        }
      } else {
        updated += 1;
      }
    }

    if (!dryRun && (updated > 0 || pruned > 0)) {
      await this.matcher.bumpJobsIndexVersion();
    }

    const reinferLabel = reinferSkills ? " (skills re-inferred)" : "";
    const message = pruneOld
      ? `Cleanup scanned ${rows.length} jobs, updated ${updated}, pruned ${pruned}, found ${staleFound} stale.${reinferLabel}`
      : `Cleanup scanned ${rows.length} jobs, updated ${updated}, found ${staleFound} stale.${reinferLabel}`;

    logger.info(`[JobMaintenance] ${message}`);
    await log(`[JobMaintenance] ${message}`);

    return {
      status: 200,
      scanned: rows.length,
      updated,
      pruned,
      stale_found: staleFound,
      dry_run: dryRun,
      errors,
      message,
    };
  }
}

export { JobMaintenanceController };
export type { CleanupJobsOptions, CleanupJobsResult };

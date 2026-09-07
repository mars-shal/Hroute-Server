import { EmbeddingService } from "../utils/embedding.js";
import { log, logger } from "../utils/logger.js";
import type { DatabaseLike } from "../model/database.js";
import { JobMatcher } from "./jobMatcher.js";
import type { JobMatcherService } from "./jobMatcher.js";
import { normalizeJobCleanupInput } from "../utils/jobCleanup.js";
import { isLikelyMarketingPage, normalizeRemoteStatusToEnum, normalizeLocationToArray, normalizeSourceSite, extractDomain } from "../utils/jobPipeline.js";
import { classifyExperienceLevel } from "../utils/jobFeeds.js";

type CleanupJobRow = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly skills: readonly string[] | null;
  readonly remote_status: string | null;
  readonly apply_url: string | null;
  readonly source_url: string;
  readonly posted_date: string | null;
  readonly location: string | null;
  readonly company: string | null;
  readonly source_site: string | null;
  readonly experience_level: string | null;
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
  /** Backfill experience_level for jobs where it's 'unspecified' or null.
   * Classifies title + description as entry/mid/senior/unspecified. */
  readonly backfill_experience_level?: boolean;
};

type CleanupJobsResult = {
  readonly status: number;
  readonly scanned: number;
  readonly updated: number;
  readonly pruned: number;
  readonly stale_found: number;
  readonly experience_backfilled: number;
  readonly source_sites_normalized: number;
  readonly junk_killed: number;
  readonly duplicates_removed: number;
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
    const backfillExperience = options.backfill_experience_level ?? false;
    const errors: string[] = [];

    const listResult = await this.db.listJobsForCleanup(limit);
    if (listResult.status !== 200 || !Array.isArray(listResult.data)) {
      return {
        status: listResult.status ?? 500,
        scanned: 0,
        updated: 0,
        pruned: 0,
        stale_found: 0,
        experience_backfilled: 0,
        source_sites_normalized: 0,
        junk_killed: 0,
        duplicates_removed: 0,
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
    let experienceBackfilled = 0;
    let sourceSitesNormalized = 0;
    let junkKilled = 0;
    let duplicatesRemoved = 0;
    const deletedIds = new Set<string>();

    // ── Pre-pass: kill marketing-page junk rows ──
    for (const row of rows) {
      if (deletedIds.has(row.id)) continue;
      if (
        row.company &&
        isLikelyMarketingPage(
          row.company,
          row.source_site,
          row.title,
          row.apply_url,
          row.source_url,
          row.description ?? "",
        )
      ) {
        if (!dryRun) {
          const vecRes = await this.db.deleteJobVector(row.id);
          if (vecRes.status && vecRes.status >= 400) {
            errors.push(`deleteJobVector ${row.id}: ${String(vecRes.response ?? vecRes.error)}`);
            continue;
          }
          const delRes = await this.db.deleteJobById(row.id);
          if (delRes.status !== 200) {
            errors.push(`deleteJobById ${row.id}: ${String(delRes.response ?? delRes.error)}`);
            continue;
          }
        }
        deletedIds.add(row.id);
        junkKilled++;
      }
    }

    // ── Pre-pass: dedup by apply_url, keep most recent ──
    const applyUrlGroups = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      if (deletedIds.has(row.id)) continue;
      const url = row.apply_url?.trim();
      if (!url) continue;
      const group = applyUrlGroups.get(url);
      if (group) {
        group.push(row);
      } else {
        applyUrlGroups.set(url, [row]);
      }
    }
    for (const [, group] of applyUrlGroups) {
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        const aDate = a.posted_date ? new Date(a.posted_date).getTime() : 0;
        const bDate = b.posted_date ? new Date(b.posted_date).getTime() : 0;
        return bDate - aDate; // newest first
      });
      // Keep the first (most recent), delete the rest
      for (let i = 1; i < group.length; i++) {
        const duplicate = group[i];
        if (!duplicate || deletedIds.has(duplicate.id)) continue;
        if (!dryRun) {
          const vecRes = await this.db.deleteJobVector(duplicate.id);
          if (vecRes.status && vecRes.status >= 400) {
            errors.push(`deleteJobVector ${duplicate.id}: ${String(vecRes.response ?? vecRes.error)}`);
            continue;
          }
          const delRes = await this.db.deleteJobById(duplicate.id);
          if (delRes.status !== 200) {
            errors.push(`deleteJobById ${duplicate.id}: ${String(delRes.response ?? delRes.error)}`);
            continue;
          }
        }
        deletedIds.add(duplicate.id);
        duplicatesRemoved++;
      }
    }

    // Filter out deleted rows before the main pass
    const remainingRows = rows.filter((r) => !deletedIds.has(r.id));

    for (const row of remainingRows) {
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
      const normalizedRemote = normalizeRemoteStatusToEnum(row.remote_status ?? "unknown");
      const shouldUpdateDescription = normalized.description !== (row.description ?? "");
      const shouldUpdateRemoteStatus = normalized.remoteStatus !== normalizedRemote;
      const shouldUpdateApplyUrl = normalized.applyUrl !== currentApplyUrl;
      const shouldUpdateSkills =
        currentSkills.length !== nextSkills.length || currentSkills.some((skill, index) => skill !== nextSkills[index]);

      const currentSourceSite = row.source_site?.trim() ?? null;
      const normalizedSourceSite = normalizeSourceSite(currentSourceSite);
      const shouldUpdateSourceSite = currentSourceSite !== normalizedSourceSite;

      let nextExperienceLevel = row.experience_level ?? "unspecified";
      let shouldUpdateExperience = false;
      if (backfillExperience && (nextExperienceLevel === "unspecified" || nextExperienceLevel === null)) {
        const classified = classifyExperienceLevel(row.title, normalized.description);
        if (classified !== "unspecified") {
          nextExperienceLevel = classified;
          shouldUpdateExperience = true;
        }
      }

      if (!shouldUpdateDescription && !shouldUpdateRemoteStatus && !shouldUpdateApplyUrl && !shouldUpdateSkills && !shouldUpdateSourceSite && !shouldUpdateExperience) {
        continue;
      }

      if (!dryRun) {
        const patch: Record<string, unknown> = {};
        if (shouldUpdateDescription) {
          patch.description = normalized.description;
        }
        if (shouldUpdateRemoteStatus) {
          patch.remote_status = normalizeRemoteStatusToEnum(normalized.remoteStatus);
        }
        if (shouldUpdateApplyUrl) {
          patch.apply_url = normalized.applyUrl;
        }
        if (shouldUpdateSkills) {
          patch.skills = nextSkills;
        }
        if (shouldUpdateExperience) {
          patch.experience_level = nextExperienceLevel;
        }
        if (shouldUpdateSourceSite) {
          patch.source_site = normalizedSourceSite;
        }

        const updateResult = await this.db.updateJobById(row.id, patch);
        if (updateResult.status !== 200) {
          errors.push(`updateJobById ${row.id}: ${String(updateResult.response ?? updateResult.error)}`);
          continue;
        }

        updated += 1;
        if (shouldUpdateExperience) experienceBackfilled += 1;
        if (shouldUpdateSourceSite) sourceSitesNormalized += 1;

        if (embeddingService && shouldUpdateDescription && normalized.description.length > 20) {
          const vector = await embeddingService.embed(normalized.description);
          const vectorResult = await this.db.storeJobVector(row.id, vector);
          if (vectorResult.status !== 200) {
            errors.push(`storeJobVector ${row.id}: ${String(vectorResult.response ?? vectorResult.error)}`);
          }
        }
      } else {
        updated += 1;
        if (shouldUpdateExperience) experienceBackfilled += 1;
      }
    }

    if (!dryRun && (updated > 0 || pruned > 0 || junkKilled > 0 || duplicatesRemoved > 0)) {
      await this.matcher.bumpJobsIndexVersion();
    }

    const reinferLabel = reinferSkills ? " (skills re-inferred)" : "";
    const backfillLabel = backfillExperience ? ` (${experienceBackfilled} experience classified)` : "";
    const sourceSiteLabel = sourceSitesNormalized > 0 ? ` (${sourceSitesNormalized} source_sites normalized)` : "";
    const dedupLabel = junkKilled > 0 || duplicatesRemoved > 0 ? ` (${junkKilled} junk killed, ${duplicatesRemoved} duplicates removed)` : "";
    const message = pruneOld
      ? `Cleanup scanned ${rows.length} jobs, updated ${updated}, pruned ${pruned}, found ${staleFound} stale.${reinferLabel}${backfillLabel}${sourceSiteLabel}${dedupLabel}`
      : `Cleanup scanned ${rows.length} jobs, updated ${updated}, found ${staleFound} stale.${reinferLabel}${backfillLabel}${sourceSiteLabel}${dedupLabel}`;

    logger.info(`[JobMaintenance] ${message}`);
    await log(`[JobMaintenance] ${message}`);

    return {
      status: 200,
      scanned: rows.length,
      updated,
      pruned,
      stale_found: staleFound,
      experience_backfilled: experienceBackfilled,
      source_sites_normalized: sourceSitesNormalized,
      junk_killed: junkKilled,
      duplicates_removed: duplicatesRemoved,
      dry_run: dryRun,
      errors,
      message,
    };
  }
}

export { JobMaintenanceController };
export type { CleanupJobsOptions, CleanupJobsResult };

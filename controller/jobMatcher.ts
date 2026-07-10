import { createHash } from "crypto";
import type { DatabaseLike } from "../model/database.js";
import { RedisModel } from "../model/redis.js";
import type { RedisLike } from "../model/redis.js";
import { logger } from "../utils/logger.js";

const MATCH_CACHE_TTL_SECONDS = 600;
const DEFAULT_LIMIT = 20;
const MIN_CANDIDATES = 50;
const MAX_CANDIDATES = 100;
const JOBS_VERSION_KEY = "jobs:index_version";

type MatchFilters = {
  location?: string;
  remote?: boolean;
  role?: string;
  salary_target?: string;
  limit?: number;
};

type MatchProgressStage = "cache" | "vector_search" | "rerank" | "cache_write";

type MatchProgress = {
  stage: MatchProgressStage;
  message: string;
};

type MatchProgressHandler = (progress: MatchProgress) => void | Promise<void>;

type RankedJob = Record<string, unknown> & {
  job_id: string;
  score: number;
  similarity: number;
  matched_skills: string[];
  missing_skills: string[];
  rank_reasons: string[];
};

type MatchResponse = {
  status: number;
  jobs: RankedJob[];
  source?: "cache" | "computed";
  generated_at?: string;
  cache_key?: string;
  error?: string;
};

type CachedMatchPayload = {
  generated_at: string;
  ttl_seconds: number;
  resume_version: string;
  jobs_version: string;
  filters_hash: string;
  results: RankedJob[];
};

class JobMatcher {
  private db: DatabaseLike;
  private redis: RedisLike;

  constructor(db: DatabaseLike, redis: RedisLike = new RedisModel()) {
    this.db = db;
    this.redis = redis;
  }

  async bumpJobsIndexVersion(): Promise<string> {
    const version = await this.redis.increment(JOBS_VERSION_KEY);
    return String(version ?? Date.now());
  }

  async match(token: string, filters: MatchFilters = {}, onProgress?: MatchProgressHandler): Promise<MatchResponse> {
    const auth = await this.db.authenticateToken(token);
    if (auth.status !== 200 || !auth.userId) {
      return { status: 401, jobs: [], error: "Invalid token" };
    }

    const embedding = await this.db.getResumeEmbedding(token);
    if (!embedding || embedding.length === 0) {
      return {
        status: 400,
        jobs: [],
        error: "No resume embedding found. Upload your resume and try again.",
      };
    }

    const profile = await this.db.getUser(token);
    if (profile.status !== 200) {
      return { status: 401, jobs: [], error: String(profile.response ?? "Invalid token") };
    }

    const normalizedFilters = this.normalizeFilters(filters);
    const limit = normalizedFilters.limit ?? DEFAULT_LIMIT;
    const resumeVersion = String(profile.resume_version ?? "unversioned");
    const jobsVersion = await this.getJobsIndexVersion();
    const filtersHash = this.hashFilters(normalizedFilters);
    const cacheKey = this.cacheKey(auth.userId, resumeVersion, jobsVersion, filtersHash);

    await onProgress?.({ stage: "cache", message: "Checking cached matches" });
    const cached = await this.readCache(cacheKey);
    if (cached) {
      return {
        status: 200,
        jobs: cached.results.slice(0, limit),
        source: "cache",
        generated_at: cached.generated_at,
        cache_key: cacheKey,
      };
    }

    await onProgress?.({ stage: "vector_search", message: "Searching jobs" });
    const candidateCount = Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, limit * 5));
    const vectorResult = await this.db.searchJobsByEmbedding(embedding, 0.5, candidateCount);
    if (vectorResult.status !== 200) {
      return { status: 500, jobs: [], error: String(vectorResult.response ?? "Job search failed") };
    }

    await onProgress?.({ stage: "rerank", message: "Ranking matches" });
    const candidates = (vectorResult.data as Record<string, unknown>[] | undefined) ?? [];
    const ranked = candidates
      .map((job) => this.rerank(job, profile, normalizedFilters))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const generatedAt = new Date().toISOString();
    const payload: CachedMatchPayload = {
      generated_at: generatedAt,
      ttl_seconds: MATCH_CACHE_TTL_SECONDS,
      resume_version: resumeVersion,
      jobs_version: jobsVersion,
      filters_hash: filtersHash,
      results: ranked,
    };

    await onProgress?.({ stage: "cache_write", message: "Saving ranked matches" });
    await this.redis.setWithExpiry({
      key: cacheKey,
      value: JSON.stringify(payload),
      expiry: MATCH_CACHE_TTL_SECONDS,
    });

    return {
      status: 200,
      jobs: ranked,
      source: "computed",
      generated_at: generatedAt,
      cache_key: cacheKey,
    };
  }

  private async getJobsIndexVersion(): Promise<string> {
    const version = await this.redis.get({ key: JOBS_VERSION_KEY });
    return version ?? "0";
  }

  private async readCache(key: string): Promise<CachedMatchPayload | null> {
    const raw = await this.redis.get({ key });
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as CachedMatchPayload;
      return Array.isArray(parsed.results) ? parsed : null;
    } catch (e) {
      logger.warn(`[JobMatcher] cache parse failed for ${key}: ${e}`);
      return null;
    }
  }

  private cacheKey(userId: string, resumeVersion: string, jobsVersion: string, filtersHash: string): string {
    return `match:v1:user:${userId}:resume:${resumeVersion}:jobs:${jobsVersion}:filters:${filtersHash}`;
  }

  private hashFilters(filters: MatchFilters): string {
    return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 12);
  }

  private normalizeFilters(filters: MatchFilters): MatchFilters {
    const limit = Number.isFinite(filters.limit) ? Math.min(Math.max(Number(filters.limit), 1), 50) : DEFAULT_LIMIT;
    return {
      location: this.cleanString(filters.location),
      remote: typeof filters.remote === "boolean" ? filters.remote : undefined,
      role: this.cleanString(filters.role),
      salary_target: this.cleanString(filters.salary_target),
      limit,
    };
  }

  private rerank(job: Record<string, unknown>, profile: Record<string, unknown>, filters: MatchFilters): RankedJob {
    const similarity = this.numberValue(job.similarity);
    const userSkills = this.stringList(profile.skills);
    const jobSkills = this.stringList(job.skills);
    const matchedSkills = jobSkills.filter((skill) => userSkills.includes(skill.toLowerCase()));
    const missingSkills = userSkills.filter((skill) => !jobSkills.includes(skill));
    const skillScore = userSkills.length > 0 ? matchedSkills.length / userSkills.length : 0;
    const locationScore = this.locationScore(job, profile, filters);
    const workStyleScore = this.workStyleScore(job, profile, filters);
    const recencyScore = this.recencyScore(job.crawled_at ?? job.posted_date);
    const salaryScore = this.salaryScore(job.salary_range, filters.salary_target ?? profile.salary_target);
    const missingRequiredPenalty = Math.min(0.4, missingSkills.length * 0.05);
    const rawScore =
      similarity * 0.6 +
      skillScore * 0.2 +
      locationScore * 0.08 +
      workStyleScore * 0.06 +
      recencyScore * 0.04 +
      salaryScore * 0.02 -
      missingRequiredPenalty;

    return {
      ...job,
      job_id: String(job.id ?? job.job_id ?? ""),
      score: this.clamp(rawScore),
      similarity,
      matched_skills: matchedSkills,
      missing_skills: missingSkills,
      rank_reasons: this.rankReasons(matchedSkills, locationScore, workStyleScore, recencyScore, salaryScore),
    };
  }

  private locationScore(job: Record<string, unknown>, profile: Record<string, unknown>, filters: MatchFilters): number {
    const target = this.cleanString(filters.location) ?? this.cleanString(String(profile.location ?? ""));
    const jobLocation = this.cleanString(String(job.location ?? ""));
    const remoteStatus = this.cleanString(String(job.remote_status ?? ""));
    if (!target || !jobLocation) return remoteStatus === "remote" ? 0.5 : 0.3;
    if (jobLocation === target) return 1;
    if (jobLocation.includes(target) || target.includes(jobLocation)) return 0.7;
    return remoteStatus === "remote" ? 0.5 : 0;
  }

  private workStyleScore(job: Record<string, unknown>, profile: Record<string, unknown>, filters: MatchFilters): number {
    const remoteStatus = this.cleanString(String(job.remote_status ?? "unknown"));
    const userStyle = this.cleanString(String(profile.work_style ?? ""));
    if (filters.remote === true) return remoteStatus === "remote" ? 1 : remoteStatus === "hybrid" ? 0.5 : 0;
    if (!userStyle) return remoteStatus === "unknown" ? 0.6 : 0.7;
    if (remoteStatus && userStyle.includes(remoteStatus)) return 1;
    if (remoteStatus === "unknown") return 0.6;
    return 0;
  }

  private recencyScore(value: unknown): number {
    const date = new Date(String(value ?? ""));
    if (Number.isNaN(date.getTime())) return 0.5;
    const daysOld = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
    return this.clamp(1 - daysOld / 30);
  }

  private salaryScore(jobSalary: unknown, targetSalary: unknown): number {
    if (!jobSalary || !targetSalary) return 0.5;
    const jobText = String(jobSalary).toLowerCase();
    const targetText = String(targetSalary).toLowerCase();
    return jobText && targetText && jobText.includes(targetText) ? 1 : 0.5;
  }

  private rankReasons(skills: string[], location: number, workStyle: number, recency: number, salary: number): string[] {
    const reasons: string[] = [];
    if (skills.length > 0) reasons.push("skill match");
    if (location >= 0.7) reasons.push("location match");
    if (workStyle >= 0.8) reasons.push("work style match");
    if (recency >= 0.7) reasons.push("recent posting");
    if (salary >= 1) reasons.push("salary match");
    return reasons;
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => String(item).toLowerCase().trim()).filter(Boolean)
      : [];
  }

  private numberValue(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? this.clamp(number) : 0;
  }

  private cleanString(value: string | undefined): string | undefined {
    const cleaned = value?.toLowerCase().trim();
    return cleaned || undefined;
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}

export type JobMatcherService = Pick<JobMatcher, "match" | "bumpJobsIndexVersion">;

export { JobMatcher };
export type { MatchFilters, MatchProgress, MatchProgressHandler, MatchResponse, RankedJob };

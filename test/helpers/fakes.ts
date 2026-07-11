import type { DatabaseLike } from "../../model/database.js";
import type { RedisLike } from "../../model/redis.js";
import type { JobMatcherService } from "../../controller/jobMatcher.js";
import type { JobSearchService } from "../../controller/jobApplication.js";
import type { MatchFilters, MatchResponse, RankedJob } from "../../controller/jobMatcher.js";

type FakeDatabaseOptions = {
  userId?: string;
  email?: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  resumeVersion?: string;
  profile?: Record<string, unknown>;
  jobs?: Record<string, unknown>[];
};

export function createFakeDatabase(options: FakeDatabaseOptions = {}) {
  const state = {
    userId: options.userId ?? "user-1",
    email: options.email ?? "ietorobong@gmail.comiilowi",
    password: options.password ?? "password",
    accessToken: options.accessToken ?? "access-token",
    refreshToken: options.refreshToken ?? "refresh-token",
    resumeVersion: options.resumeVersion ?? "resume-v1",
    profile: {
      id: options.userId ?? "user-1",
      email: options.email ?? "ietorobong@gmail.comiilowi",
      display_name: "Ietorobong",
      location: "Lagos",
      work_style: "remote",
      skills: ["typescript", "react", "node"],
      resume_version: options.resumeVersion ?? "resume-v1",
      ...options.profile,
    } as Record<string, unknown>,
    jobs: [...(options.jobs ?? [])],
    createdUsers: [] as Array<{ email: string; password: string }>,
    updatedProfiles: [] as Record<string, unknown>[],
  };

  const db: DatabaseLike & {
    state: typeof state;
  } = {
    state,
    async authenticateToken(token: string) {
      return token === state.accessToken
        ? { status: 200, userId: state.userId }
        : { status: 401, response: "Invalid token" };
    },
    async getFile() {
      return { status: 200 };
    },
    async listFiles() {
      return { status: 200, data: [] };
    },
    async uploadFile() {
      return { status: 200 };
    },
    async deleteFile() {
      return { status: 200 };
    },
    async uploadResumeFile() {
      return { status: 200 };
    },
    async getResumeSignedUrl() {
      return { status: 200, url: "https://example.com/resume.pdf" };
    },
    async getData() {
      return { status: 200, data: null };
    },
    async insertData() {
      return { status: 200 };
    },
    async createUser(data) {
      state.createdUsers.push({ email: data.email, password: data.password });
      if (data.email === state.email && data.password === state.password) {
        return { access_token: state.accessToken, refresh_token: state.refreshToken };
      }
      return { status: 400, response: "Unexpected credentials" };
    },
    async loginUser(data) {
      if (data.email === state.email && data.password === state.password) {
        return { access_token: state.accessToken, refresh_token: state.refreshToken };
      }
      return { status: 401, response: "Invalid credentials" };
    },
    async refreshToken(refresh_token: string) {
      if (refresh_token === state.refreshToken) {
        return { access_token: `${state.accessToken}-refreshed`, expires_in: 86400 };
      }
      return { status: 401, error: "Invalid or expired refresh token" };
    },
    async logout() {
      return { status: 200, message: "Logged out successfully" };
    },
    async getUser(token: string) {
      return (await db.authenticateToken(token)).status === 200
        ? { status: 200, ...state.profile }
        : { status: 401, response: "Invalid token" };
    },
    async updateUser(token: string, payload: Record<string, unknown>) {
      const auth = await db.authenticateToken(token);
      if (auth.status !== 200) {
        return { status: 401, response: "Invalid token" };
      }
      state.profile = { ...state.profile, ...payload };
      state.updatedProfiles.push(payload);
      return { status: 200 };
    },
    async updateUserPassword() {
      return { status: 200, message: "Password updated successfully" };
    },
    async deleteUser() {
      return { status: 200, message: "Account deleted successfully" };
    },
    async storeJob(job: Record<string, unknown>) {
      state.jobs.push(job);
      return { status: 200, data: [{ id: `job-${state.jobs.length}` }] };
    },
    async storeJobVector() {
      return { status: 200 };
    },
    async getJobsRecent(limit = 50) {
      return { status: 200, data: state.jobs.slice(0, limit) };
    },
    async getJobBySourceUrl(sourceUrl: string) {
      const job = state.jobs.find((item) => item.source_url === sourceUrl);
      return job ? { status: 200, data: job } : { status: 404, response: "Job not found" };
    },
    async listJobsForCleanup(limit = 1000) {
      return { status: 200, data: state.jobs.slice(0, limit) };
    },
    async updateJobById(jobId: string, patch: Record<string, unknown>) {
      const index = state.jobs.findIndex((item) => item.id === jobId);
      if (index === -1) {
        return { status: 404, response: "Job not found" };
      }
      state.jobs[index] = { ...state.jobs[index], ...patch };
      return { status: 200, data: { id: jobId } };
    },
    async deleteJobVector() {
      return { status: 200 };
    },
    async deleteJobById(jobId: string) {
      const nextJobs = state.jobs.filter((item) => item.id !== jobId);
      if (nextJobs.length === state.jobs.length) {
        return { status: 404, response: "Job not found" };
      }
      state.jobs = nextJobs;
      return { status: 200 };
    },
    async getRandomActiveJobs(limit = 50) {
      return { status: 200, data: state.jobs.slice(0, limit) };
    },
    async searchJobsByQuery() {
      return { status: 200, data: state.jobs };
    },
    async searchJobsByEmbedding() {
      return { status: 200, data: state.jobs };
    },
    async saveApplication() {
      return { status: 200 };
    },
    async updateApplicationStatus() {
      return { status: 200 };
    },
    async getApplications() {
      return { status: 200, data: [] };
    },
    async deleteApplication() {
      return { status: 200, message: "Application deleted" };
    },
    async saveResumeEmbedding() {
      return { status: 200 };
    },
    async getResumeEmbedding() {
      return [0.98, 0.01, 0.01];
    },
  };

  return db;
}

export function createFakeRedis(): RedisLike & {
  state: Map<string, string>;
} {
  const state = new Map<string, string>();
  return {
    state,
    async get({ key }) {
      return state.get(key) ?? null;
    },
    async setWithExpiry({ key, value }) {
      state.set(key, value);
      return true;
    },
    async delete(key) {
      return state.delete(key);
    },
    async increment(key) {
      const next = Number(state.get(key) ?? "0") + 1;
      state.set(key, String(next));
      return next;
    },
  };
}

export function createFakeMatcher(result: MatchResponse): JobMatcherService {
  return {
    async match(_token: string, _filters: MatchFilters, onProgress) {
      await onProgress?.({ stage: "cache", message: "Checking cached matches" });
      return result;
    },
    async bumpJobsIndexVersion() {
      return "1";
    },
  };
}

export function createFakeSearchService(result: MatchResponse): JobSearchService {
  return {
    async Search(_token: string, _filters?: MatchFilters, onProgress?) {
      await onProgress?.({ stage: "cache", message: "Checking cached matches" });
      await onProgress?.({ stage: "vector_search", message: "Searching jobs" });
      await onProgress?.({ stage: "rerank", message: "Ranking matches" });
      return {
        status: result.status,
        jobs: result.jobs,
        source: result.source,
        generated_at: result.generated_at,
        cache_key: result.cache_key,
        error: result.error,
      };
    },
  };
}

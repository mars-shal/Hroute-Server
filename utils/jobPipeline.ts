import { normalizeJobCleanupInput } from "./jobCleanup.js";

const JUNK_URL_PARTS = [
  "/blog",
  "/about",
  "/contact",
  "/faq",
  "/categories",
  "/companies",
  "/pricing",
] as const;

const HOMEPAGE_MARKERS = [
  "welcome to",
  "sign up",
  "log in",
  "browse jobs",
  "featured companies",
  "latest articles",
  "newsletter",
] as const;

const NON_JOB_MARKERS = [
  "privacy policy",
  "terms of service",
  "about us",
  "contact us",
  "all categories",
  "company directory",
  "pricing plans",
  "read more",
  "blog post",
] as const;

const JOB_MARKERS = [
  "apply",
  "responsibilities",
  "requirements",
  "qualifications",
  "salary",
  "job description",
  "benefits",
] as const;

type PipelineJob = {
  readonly title: string;
  readonly company: string;
  readonly location: string | null;
  readonly description: string;
  readonly skills: readonly string[];
  readonly remote_status: string;
  readonly salary_range: string | null;
  readonly apply_url: string | null;
  readonly posted_date: string | null;
  readonly source_site: string | null;
  readonly source_url: string;
  readonly logo_url: string | null;
};

type RemoteStatusNormalized = "remote" | "hybrid" | "onsite" | "unknown";

type NormalizedPipelineJob = PipelineJob & {
  readonly location_normalized: readonly string[] | null;
  readonly remote_status_normalized: RemoteStatusNormalized;
  readonly posted_date_parsed: string | null;
  readonly is_junk: boolean;
};

/** Detects crawled pages that are unlikely to contain a single job posting. */
function isJunkPage(url: string, markdown: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (JUNK_URL_PARTS.some((part) => lowerUrl.includes(part))) {
    return true;
  }

  const normalizedMarkdown = markdown.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalizedMarkdown.length < 100) {
    return true;
  }

  const hasJobMarker = JOB_MARKERS.some((marker) => normalizedMarkdown.includes(marker));
  const homepageMarkerCount = HOMEPAGE_MARKERS.filter((marker) => normalizedMarkdown.includes(marker)).length;
  if (homepageMarkerCount >= 3 && !hasJobMarker) {
    return true;
  }

  const nonJobMarkerCount = NON_JOB_MARKERS.filter((marker) => normalizedMarkdown.includes(marker)).length;
  return nonJobMarkerCount >= 2 && !hasJobMarker;
}

function toIsoDate(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function dateDaysAgo(days: number): string | null {
  const date = new Date(Date.now() - days * 86_400_000);
  return toIsoDate(date);
}

function parseRelativeDate(posted: string): string | null {
  const text = posted.toLowerCase().trim();
  if (["today", "just posted", "posted today", "new"].includes(text)) {
    return dateDaysAgo(0);
  }

  if (["yesterday", "posted yesterday"].includes(text)) {
    return dateDaysAgo(1);
  }

  const relativeMatch = text.match(/(?:posted|reposted)?\s*(\d+)\s*(hour|hours|day|days|week|weeks|month|months|year|years)\s*ago/);
  const countText = relativeMatch?.at(1);
  const unit = relativeMatch?.at(2);
  if (!countText || !unit) {
    return null;
  }

  const count = Number.parseInt(countText, 10);
  if (Number.isNaN(count)) {
    return null;
  }

  if (unit.startsWith("hour")) return dateDaysAgo(0);
  if (unit.startsWith("day")) return dateDaysAgo(count);
  if (unit.startsWith("week")) return dateDaysAgo(count * 7);
  if (unit.startsWith("month")) return dateDaysAgo(count * 30);
  return dateDaysAgo(count * 365);
}

function parseAbsoluteDate(posted: string): string | null {
  const trimmed = posted.trim();
  const unixSeconds = trimmed.match(/^\d{10}$/);
  if (unixSeconds) {
    return toIsoDate(new Date(Number.parseInt(trimmed, 10) * 1000));
  }

  const unixMilliseconds = trimmed.match(/^\d{13}$/);
  if (unixMilliseconds) {
    return toIsoDate(new Date(Number.parseInt(trimmed, 10)));
  }

  return toIsoDate(new Date(trimmed));
}

function parseLinkedInDate(posted: string): string | null {
  return parseRelativeDate(posted.replace(/^\s*(posted|reposted)\s+/i, "")) ?? parseAbsoluteDate(posted);
}

function parseIndeedDate(posted: string): string | null {
  const withoutEmployerPrefix = posted.replace(/^\s*employer\s+active\s+/i, "");
  return parseRelativeDate(withoutEmployerPrefix) ?? parseAbsoluteDate(withoutEmployerPrefix);
}

function parseRemoteOkDate(posted: string): string | null {
  return parseAbsoluteDate(posted) ?? parseRelativeDate(posted);
}

function parseWeWorkRemotelyDate(posted: string): string | null {
  const withoutPrefix = posted.replace(/^\s*(posted|new)\s+/i, "");
  return parseRelativeDate(withoutPrefix) ?? parseAbsoluteDate(withoutPrefix);
}

function parseRemotiveDate(posted: string): string | null {
  return parseAbsoluteDate(posted) ?? parseRelativeDate(posted);
}

function parseWithExistingCleanupFallback(posted: string, sourceUrl: string): string | null {
  const cleaned = normalizeJobCleanupInput({
    description: "",
    sourceUrl,
    postedDate: posted,
  });

  return cleaned.ageDays === null ? null : dateDaysAgo(cleaned.ageDays);
}

/** Parses source-specific posted-date text into an ISO timestamp. */
function parsePostedDateForSource(posted: string | null, sourceUrl: string): string | null {
  const cleaned = posted?.trim();
  if (!cleaned) {
    return null;
  }

  const lowerUrl = sourceUrl.toLowerCase();
  if (lowerUrl.includes("linkedin.com")) {
    return parseLinkedInDate(cleaned) ?? parseWithExistingCleanupFallback(cleaned, sourceUrl);
  }
  if (lowerUrl.includes("indeed.com")) {
    return parseIndeedDate(cleaned) ?? parseWithExistingCleanupFallback(cleaned, sourceUrl);
  }
  if (lowerUrl.includes("remoteok.com")) {
    return parseRemoteOkDate(cleaned) ?? parseWithExistingCleanupFallback(cleaned, sourceUrl);
  }
  if (lowerUrl.includes("weworkremotely.com")) {
    return parseWeWorkRemotelyDate(cleaned) ?? parseWithExistingCleanupFallback(cleaned, sourceUrl);
  }
  if (lowerUrl.includes("remotive.com")) {
    return parseRemotiveDate(cleaned) ?? parseWithExistingCleanupFallback(cleaned, sourceUrl);
  }

  return parseWithExistingCleanupFallback(cleaned, sourceUrl);
}

/** Normalizes a location string into lowercase location tokens. */
function normalizeLocationToArray(location: string | null): readonly string[] | null {
  const parts = location
    ?.split(/[,·|]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  return parts && parts.length > 0 ? parts : null;
}

/** Converts scraped remote status strings to the Postgres-compatible enum. */
function normalizeRemoteStatusToEnum(remoteStatus: string): RemoteStatusNormalized {
  const normalized = remoteStatus.toLowerCase().trim();
  if (normalized === "true" || normalized === "remote") {
    return "remote";
  }
  if (normalized === "hybrid") {
    return "hybrid";
  }
  if (normalized === "false" || normalized === "onsite") {
    return "onsite";
  }
  return "unknown";
}

/** Applies the deterministic job-processing normalization pipeline. */
function processJobPipeline(job: PipelineJob, sourceUrl: string): NormalizedPipelineJob {
  return {
    ...job,
    location_normalized: normalizeLocationToArray(job.location),
    remote_status_normalized: normalizeRemoteStatusToEnum(job.remote_status),
    posted_date_parsed: parsePostedDateForSource(job.posted_date, sourceUrl),
    is_junk: isJunkPage(sourceUrl, job.description),
  };
}

export {
  isJunkPage,
  normalizeLocationToArray,
  normalizeRemoteStatusToEnum,
  parsePostedDateForSource,
  processJobPipeline,
};
export type { NormalizedPipelineJob, PipelineJob, RemoteStatusNormalized };

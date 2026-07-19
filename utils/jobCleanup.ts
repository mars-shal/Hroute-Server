const TECH_SKILL_KEYWORDS = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "golang",
  "rust",
  "c++",
  "c#",
  "react",
  "angular",
  "vue",
  "node",
  "nodejs",
  "next.js",
  "express",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "k8s",
  "terraform",
  "sql",
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "graphql",
  "git",
  "ci/cd",
  "linux",
  "api",
  "rest",
  "html",
  "css",
  "machine learning",
  "ai",
  "data science",
  "devops",
  "sre",
  "agile",
  "scrum",
  "jira",
  "figma",
  "tailwind",
] as const;

type CleanupRemoteStatus = "true" | "hybrid" | "false" | "unknown";

type CleanupInput = {
  readonly description: string;
  readonly skills?: readonly string[] | null;
  readonly remoteStatus?: string | null;
  readonly applyUrl?: string | null;
  readonly sourceUrl: string;
  readonly postedDate?: unknown;
};

type CleanupResult = {
  readonly description: string;
  readonly skills: readonly string[];
  readonly remoteStatus: CleanupRemoteStatus;
  readonly applyUrl: string;
  readonly ageDays: number | null;
  readonly isStale: boolean;
};

function parseRelativeAge(posted: string): number | null {
  const relativeMatch = posted.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
  if (relativeMatch) {
    const countText = relativeMatch.at(1);
    const unit = relativeMatch.at(2);
    if (!countText || !unit) return null;
    const count = Number.parseInt(countText, 10);
    if (Number.isNaN(count)) return null;
    if (unit.startsWith("day")) return count;
    if (unit.startsWith("week")) return count * 7;
    if (unit.startsWith("month")) return count * 30;
    return count * 365;
  }

  const singleUnitMatch = posted.match(/^a\s+(day|week|month|year)\s+ago$/);
  const singleUnit = singleUnitMatch?.at(1);
  if (!singleUnit) return null;
  if (singleUnit === "day") return 1;
  if (singleUnit === "week") return 7;
  if (singleUnit === "month") return 30;
  return 365;
}

function parseAbsoluteAge(posted: string): number | null {
  const parsed = new Date(posted);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return (Date.now() - parsed.getTime()) / 86_400_000;
}

function formatDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 4000);
}

function inferSkillsFromText(description: string): readonly string[] {
  return TECH_SKILL_KEYWORDS.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(description);
  });
}

function inferRemoteFromText(description: string): CleanupRemoteStatus {
  const lower = description.toLowerCase();
  if (
    lower.includes("remote") ||
    lower.includes("work from home") ||
    lower.includes("wfh") ||
    lower.includes("anywhere")
  ) {
    return "true";
  }

  if (lower.includes("hybrid")) {
    return "hybrid";
  }

  if (lower.includes("onsite") || lower.includes("in-office")) {
    return "false";
  }

  return "unknown";
}

function normalizeRemoteStatus(remoteStatus: string | null | undefined, description: string): CleanupRemoteStatus {
  const normalized = remoteStatus?.toLowerCase().trim();
  if (normalized === "true" || normalized === "remote") {
    return "true";
  }
  if (normalized === "false" || normalized === "onsite") {
    return "false";
  }
  if (normalized === "hybrid") {
    return "hybrid";
  }
  return inferRemoteFromText(description);
}

function normalizeSkills(skills: readonly string[] | null | undefined, description: string): readonly string[] {
  if (skills && skills.length > 0) {
    return skills;
  }
  return inferSkillsFromText(description);
}

function normalizeApplyUrl(applyUrl: string | null | undefined, sourceUrl: string): string {
  const cleaned = applyUrl?.trim();
  if (cleaned) {
    return cleaned;
  }
  return sourceUrl;
}

function parsePostedAge(posted: unknown): number | null {
  if (!posted) {
    return null;
  }

  const text = String(posted).toLowerCase().trim();
  return parseRelativeAge(text) ?? parseAbsoluteAge(text);
}

function normalizeJobCleanupInput(input: CleanupInput): CleanupResult {
  const description = formatDescription(input.description);
  const ageDays = parsePostedAge(input.postedDate);
  return {
    description,
    skills: normalizeSkills(input.skills, description),
    remoteStatus: normalizeRemoteStatus(input.remoteStatus, description),
    applyUrl: normalizeApplyUrl(input.applyUrl, input.sourceUrl),
    ageDays,
    isStale: ageDays !== null && ageDays > 60,
  };
}

export { normalizeJobCleanupInput };
export type { CleanupInput, CleanupRemoteStatus, CleanupResult };

/**
 * Description Cleaner — source-specific extraction, pollution detection,
 * and quality scoring for job descriptions.
 *
 * Three layers:
 *   1. Source-specific extraction — isolate the actual job body per source
 *   2. Pollution detection — score how much non-job content is present
 *   3. Quality scoring — determine if the clean description is usable
 */

import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────

export type DescriptionQuality = "excellent" | "good" | "acceptable" | "poor" | "reject";

export type CleanDescription = {
  /** The cleaned description text — actual job body only */
  clean: string;
  /** Original raw text before any cleaning */
  raw: string;
  /** Quality grade */
  quality: DescriptionQuality;
  /** Numeric quality score 0-100 */
  qualityScore: number;
  /** Pollution signals that were detected */
  pollutionSignals: string[];
  /** Whether this description is usable for matching */
  usable: boolean;
  /** Which source-specific extractor was used (if any) */
  extractor: string | null;
};

// ── Source-specific extraction strategies ──────────────────────

type ExtractionStrategy = (text: string) => string | null;

/**
 * Himalayas — isolates the actual job description from page chrome.
 * Himalayas wraps descriptions in divs with class containing "description".
 * Strip nav, sidebar, "Jobs 110,610", related listings, footer.
 */
const himalayasExtractor: ExtractionStrategy = (text: string): string | null => {
  // Try to find the job description section
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const startMarkers = [
    "job description",
    "about the job",
    "about this role",
    "the role",
    "what you'll do",
    "what you will do",
    "responsibilities",
    "role description",
    "the opportunity",
  ];

  const endMarkers = [
    "apply now",
    "how to apply",
    "about the company",
    "about us",
    "company overview",
    "similar jobs",
    "related jobs",
    "other jobs",
    "jobs you might like",
    "recommended jobs",
    "more jobs",
    "company profile",
  ];

  let startIdx = -1;
  let endIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (startMarkers.some(m => lower.startsWith(m) || lower.includes(m))) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (endMarkers.some(m => lower.startsWith(m) || lower.includes(m))) {
      endIdx = i;
      break;
    }
  }

  const extracted = lines.slice(startIdx, endIdx).join("\n").trim();
  return extracted.length > 50 ? extracted : null;
};

/**
 * Generic page-chrome cleaner — works for any source.
 * Strips navigation, headers, footers, cookie notices, signup prompts.
 */
function cleanGenericPageChrome(text: string): string {
  const CHROME_PATTERNS = [
    /skip to main content/i,
    /skip to content/i,
    /toggle navigation/i,
    /menu/i,
    /search\s*(jobs|positions|openings)?/i,
    /sign\s*(up|in|out)/i,
    /log\s*(in|out)/i,
    /create\s*(an\s*)?account/i,
    /newsletter/i,
    /subscribe/i,
    /follow us/i,
    /cookie\s*(policy|notice|consent|settings)/i,
    /privacy\s*(policy|notice)/i,
    /terms\s*(of\s*)?(service|use|conditions)/i,
    /all\s+(rights\s+)?reserved/i,
    /powered\s+by/i,
    /browse\s+(all\s+)?(jobs|positions|openings)/i,
    /featured\s+companies/i,
    /latest\s+articles/i,
    /read more/i,
    /blog\s*post/i,
  ];

  let cleaned = text.replace(/\r\n/g, "\n");
  const lines = cleaned.split("\n");
  const filteredLines = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true; // keep empty lines for structure
    return !CHROME_PATTERNS.some(pattern => pattern.test(trimmed));
  });

  return filteredLines.join("\n").trim();
}

// ── Pollution detection ────────────────────────────────────────

const POLLUTION_SIGNALS: { pattern: RegExp; signal: string }[] = [
  { pattern: /jobs?\s[\d,.,]+\s*(results|found|matches)?/i, signal: "job_count_listing" },
  { pattern: /skip to (main )?content/i, signal: "navigation_skip" },
  { pattern: /sign\s*up\s+(for\s+)?(free\s+)?(updates|newsletter|our\s+newsletter)/i, signal: "signup_cta" },
  { pattern: /create\s+(an\s+)?account/i, signal: "account_cta" },
  { pattern: /subscribe\s+(to\s+)?(our\s+)?(newsletter|updates)/i, signal: "subscribe_cta" },
  { pattern: /cookie\s+(policy|notice|consent|settings)/i, signal: "cookie_notice" },
  { pattern: /privacy\s+policy/i, signal: "privacy_policy" },
  { pattern: /terms\s+of\s+(service|use|conditions)/i, signal: "terms_of_service" },
  { pattern: /all\s+(rights\s+)?reserved/i, signal: "copyright_footer" },
  { pattern: /powered\s+by/i, signal: "powered_by" },
  { pattern: /company\s+(directory|listings?)/i, signal: "company_directory" },
  { pattern: /latest\s+(articles|blog|posts|news)/i, signal: "blog_listing" },
  { pattern: /read more/i, signal: "read_more" },
  { pattern: /browse\s+(all\s+)?(jobs|positions|openings)/i, signal: "browse_jobs" },
  { pattern: /featured\s+(companies|jobs)/i, signal: "featured_content" },
  { pattern: /view\s+(all\s+)?(jobs|positions|openings)/i, signal: "view_all_jobs" },
];

function detectPollution(text: string): string[] {
  const signals: string[] = [];
  for (const { pattern, signal } of POLLUTION_SIGNALS) {
    if (pattern.test(text)) {
      signals.push(signal);
    }
  }
  return signals;
}

// ── Quality scoring ────────────────────────────────────────────

function computeQualityScore(clean: string, raw: string, pollutionSignals: string[]): {
  quality: DescriptionQuality;
  score: number;
  usable: boolean;
} {
  let score = 50; // base score
  const len = clean.length;

  // Length scoring (+/-)
  if (len > 1500) score += 20;
  else if (len > 800) score += 15;
  else if (len > 400) score += 10;
  else if (len > 200) score += 5;
  else if (len < 100) score -= 20;
  else if (len < 150) score -= 10;

  // Content quality signals
  const lower = clean.toLowerCase();
  if (/\b(responsibilities|duties|what you('ll| will) do)\b/i.test(lower)) score += 10;
  if (/\b(requirements|qualifications|what you need|you have)\b/i.test(lower)) score += 10;
  if (/\b(skills|experience|expertise)\b/i.test(lower)) score += 5;
  if (/\b(benefits|perks|we offer|what we offer)\b/i.test(lower)) score += 5;
  if (/\b(apply|how to apply|to apply)\b/i.test(lower)) score += 3;

  // Strong signal: contains structured requirements
  if (/\b\d+\+?\s*years? (of )?experience\b/i.test(lower)) score += 8;
  if (/\b(degree|bachelor|master|phd|bs|ba|ms)\b/i.test(lower)) score += 5;

  // Penalties
  if (len < 50) score -= 30;
  if (/^(job description|description)\s*$/i.test(clean.trim())) score -= 30;

  // Pollution penalty
  const pollutionPenalty = Math.min(pollutionSignals.length * 8, 30);
  score -= pollutionPenalty;

  // Clamp
  score = Math.max(0, Math.min(100, score));

  // Grade
  let quality: DescriptionQuality;
  if (score >= 85) quality = "excellent";
  else if (score >= 70) quality = "good";
  else if (score >= 55) quality = "acceptable";
  else if (score >= 35) quality = "poor";
  else quality = "reject";

  return {
    quality,
    score,
    usable: score >= 55,
  };
}

/**
 * Detect if a text describes a single job vs being a board/list page.
 */
function isJobSpecific(text: string): boolean {
  const lower = text.toLowerCase();
  const jobMarkers = [
    "job description",
    "responsibilities",
    "requirements",
    "qualifications",
    "about the role",
    "what you'll do",
    "apply for this job",
    "apply now",
    "we are looking for",
  ];
  const boardMarkers = [
    "browse jobs",
    "job search",
    "search jobs",
    "jobs board",
    "job board",
    "find a job",
    "jobs near",
  ];

  const jobScore = jobMarkers.filter(m => lower.includes(m)).length;
  const boardScore = boardMarkers.filter(m => lower.includes(m)).length;

  return jobScore > boardScore;
}

/**
 * Main cleaning pipeline — extract, clean, score.
 *
 * @param text — raw description text from scraper/page
 * @param source — source identifier (e.g. "himalayas", "jobberman", null for unknown)
 * @returns CleanDescription with quality assessment
 */
export function cleanDescription(text: string | null | undefined, source?: string | null): CleanDescription {
  const raw = (text ?? "").trim();

  if (!raw) {
    return {
      clean: "",
      raw: "",
      quality: "reject",
      qualityScore: 0,
      pollutionSignals: [],
      usable: false,
      extractor: null,
    };
  }

  // Step 1: Detect pollution before cleaning (for the record)
  const prePollution = detectPollution(raw);

  // Step 2: Apply source-specific extraction
  let extractor: string | null = null;
  let extracted: string | null = null;

  const sourceLower = (source ?? "").toLowerCase();
  if (sourceLower.includes("himalayas")) {
    extracted = himalayasExtractor(raw);
    extractor = extracted ? "himalayas" : null;
  }

  // Step 3: Generic chrome removal (always applied)
  const afterChrome = extracted ?? cleanGenericPageChrome(raw);

  // Step 4: Final cleanup — normalize whitespace
  const clean = afterChrome
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  // Step 5: Post-cleaning pollution check
  const pollutionSignals = detectPollution(clean);

  // Step 6: Is this actually a job description?
  if (!isJobSpecific(clean) && clean.length < 300) {
    return {
      clean,
      raw,
      quality: "reject",
      qualityScore: Math.max(0, 30 - pollutionSignals.length * 5),
      pollutionSignals: [...pollutionSignals, "not_a_job_description"],
      usable: false,
      extractor,
    };
  }

  // Step 7: Quality score
  const { quality, score, usable } = computeQualityScore(clean, raw, pollutionSignals);

  return {
    clean,
    raw,
    quality,
    qualityScore: score,
    pollutionSignals,
    usable,
    extractor,
  };
}

/**
 * Salary Parser — deterministic extraction from raw salary strings.
 *
 * Handles the ~57 distinct formats found in real-world job data:
 *   $129k-$161k/yr    €50k–€70k          $100k+
 *   $80,000/yr        50k - 70k          NGN 6M - 8M
 *   Ranges, fixed, hourly/daily/monthly/yearly, multiple currencies.
 *
 * Always returns a structured result. Never throws. Never calls an LLM.
 */

export type SalaryPeriod = "hour" | "day" | "week" | "month" | "year" | "unknown";
export type SalaryType = "range" | "fixed" | "starting" | "commission" | "unspecified";
export type SalaryConfidence = "high" | "medium" | "low";

export type ParsedSalary = {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod;
  type: SalaryType;
  confidence: SalaryConfidence;
  raw: string | null;
};

const CURRENCY_MAP: Record<string, string> = {
  $: "USD", "usd": "USD", "us$": "USD",
  "€": "EUR", eur: "EUR",
  "£": "GBP", gbp: "GBP", "£gbp": "GBP",
  "₦": "NGN", ngn: "NGN", "ngn₦": "NGN",
  "¥": "JPY", jpy: "JPY",
  "₵": "GHS", ghs: "GHS",
  "r": "ZAR", zar: "ZAR",
  ksh: "KES", "kes": "KES",
  "a$": "AUD", aud: "AUD",
  "c$": "CAD", cad: "CAD",
};

const PERIOD_MAP: Record<string, SalaryPeriod> = {
  hr: "hour", "hr.": "hour", "hrs": "hour", "hour": "hour", "hourly": "hour", "/hr": "hour", "/hr.": "hour", "per hour": "hour", "an hour": "hour",
  day: "day", "daily": "day", "/day": "day", "per day": "day",
  wk: "week", "week": "week", "weekly": "week", "/wk": "week", "per week": "week", "a week": "week",
  mo: "month", "month": "month", "monthly": "month", "/mo": "month", "/month": "month", "per month": "month", "a month": "month", "p/m": "month",
  yr: "year", "year": "year", "yearly": "year", "annual": "year", "annually": "year", "/yr": "year", "/year": "year", "per year": "year", "a year": "year", "p.a": "year", "p/a": "year",
};

const PERIOD_ORDER: [string, SalaryPeriod][] = Object.entries(PERIOD_MAP).sort((a, b) => b[0].length - a[0].length);

function extractCurrency(raw: string): { currency: string | null; remaining: string } {
  const cleaned = raw.trim();

  // Try known currency symbols/prefixes
  for (const [sym, code] of Object.entries(CURRENCY_MAP)) {
    if (cleaned.toLowerCase().startsWith(sym)) {
      return { currency: code, remaining: cleaned.slice(sym.length).trim() };
    }
  }

  // Try trailing currency code like "6M - 8M NGN"
  const trailingMatch = cleaned.match(/\b([A-Za-z]{3})\s*$/);
  const trailingCode = trailingMatch?.[1]?.toLowerCase();
  if (trailingCode && CURRENCY_MAP[trailingCode]) {
    return {
      currency: CURRENCY_MAP[trailingCode],
      remaining: cleaned.slice(0, trailingMatch?.index ?? 0).trim(),
    };
  }

  return { currency: null, remaining: cleaned };
}

function extractPeriod(raw: string): { period: SalaryPeriod; remaining: string } {
  for (const [key, period] of PERIOD_ORDER) {
    const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (regex.test(raw)) {
      return { period, remaining: raw.replace(regex, "").trim() };
    }
  }
  return { period: "year", remaining: raw };
}

/** Strip currency symbols and whitespace from a number string. */
function stripCurrency(s: string): string {
  return s.replace(/[$,€£¥₦₵R\s]/gi, "").trim();
}

function parseNumber(s: string): number | null {
  const cleaned = stripCurrency(s);
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/i);
  if (!match) return null;

  const num = parseFloat(match[1]!);
  const suffix = (match[2] ?? "").toLowerCase();

  if (suffix === "k") return Math.round(num * 1000);
  if (suffix === "m") return Math.round(num * 1_000_000);
  if (suffix === "b") return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

function extractNumbers(raw: string): { min: number | null; max: number | null; confidence: SalaryConfidence; type: SalaryType } {
  const cleaned = raw
    .replace(/\/\s*(hr|hrs|hour|day|wk|week|mo|month|yr|year|annual)/gi, "")
    .replace(/per\s+(hour|day|week|month|year|annum)/gi, "")
    .replace(/p\.?\s*[aA]/g, "")
    .replace(/,/g, "")
    .trim();

  const rangeMatch = cleaned.match(
    /(?:[$\u20ac\u00a3\u20a6\u00a5]\s*)?(\d{1,3}(?:[kKmMBb])?)\s*(?:[-–to]|to)\s*(?:[$\u20ac\u00a3\u20a6\u00a5]\s*)?(\d{1,3}(?:[kKmMBb])?)/,
  );
  if (rangeMatch) {
    const min = parseNumber(rangeMatch[1]!);
    const max = parseNumber(rangeMatch[2]!);
    if (min !== null && max !== null && max >= min) {
      return { min, max, confidence: max - min < 200_000 ? "high" : "medium", type: "range" };
    }
  }

  const stripped = stripCurrency(cleaned);
  // Try matching full number (4+ digits or with k/m/b suffix)
  const singleMatch = stripped.match(/(\d{4,}|\d{1,3}[kKmMbB])/);
  if (singleMatch) {
    const num = parseNumber(singleMatch[1]!);
    if (num !== null) {
      return { min: num, max: num, confidence: "high", type: "fixed" };
    }
  }
  // Fallback: try any number
  const anyMatch = stripped.match(/(\d+(?:\.\d+)?[kKmMbB]?)/);
  if (anyMatch) {
    const num = parseNumber(anyMatch[1]!);
    if (num !== null) {
      return { min: num, max: num, confidence: "medium", type: "fixed" };
    }
  }

  return { min: null, max: null, confidence: "low", type: "unspecified" };
}

function detectType(raw: string): SalaryType {
  const lower = raw.toLowerCase();
  if (lower.includes("commission") || lower.includes("+ commission")) return "commission";
  if (lower.includes("starting") || lower.includes("from")) return "starting";
  if (lower.includes("-") || lower.includes("–") || lower.includes("to")) return "range";
  return "unspecified";
}

/**
 * Parse a raw salary string into structured fields.
 *
 * Examples:
 *   "$129k-$161k/yr"  → { min: 129000, max: 161000, currency: "USD", period: "year", ... }
 *   "€50k-€70k"       → { min: 50000, max: 70000, currency: "EUR", period: "year", ... }
 *   "NGN 6M - 8M"     → { min: 6000000, max: 8000000, currency: "NGN", period: "year", ... }
 *   null / ""         → { min: null, max: null, ... confidence: "low" }
 *   "Apply Now"       → { min: null, max: null, ... confidence: "low" }
 */
export function parseSalary(raw: string | null | undefined): ParsedSalary {
  if (!raw || raw.trim().length === 0) {
    return { min: null, max: null, currency: null, period: "unknown", type: "unspecified", confidence: "low", raw: raw ?? null };
  }

  const trimmed = raw.trim();

  // Step 1: Extract currency
  const { currency, remaining: afterCurrency } = extractCurrency(trimmed);

  // Step 2: Extract period
  const { period, remaining: afterPeriod } = extractPeriod(afterCurrency);

  // Step 3: Detect type
  const type = detectType(trimmed);

  // Step 4: Extract numbers
  const { min, max, confidence } = extractNumbers(afterPeriod);

  // If we couldn't extract meaningful numbers, return low-confidence
  if (min === null && max === null) {
    return { min: null, max: null, currency, period, type: "unspecified", confidence: "low", raw: trimmed };
  }

  return { min, max, currency: currency ?? "USD", period, type, confidence, raw: trimmed };
}

/**
 * Format a parsed salary for display.
 *
 * Semantically meaningful string like "$129k-$161k/yr" or "€50k–€70k".
 * Falls back to raw string when confidence is low.
 */
export function formatSalary(salary: ParsedSalary): string {
  if (salary.confidence === "low" || (salary.min === null && salary.max === null)) {
    return salary.raw ?? "Not specified";
  }

  const curr = salary.currency ?? "USD";
  const sym = Object.entries(CURRENCY_MAP).find(([, c]) => c === curr)?.[0] ?? curr;

  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  const periodStr = salary.period !== "year" ? `/${salary.period}` : "";

  if (salary.type === "range" && salary.min !== null && salary.max !== null) {
    return `${sym}${fmt(salary.min)}-${fmt(salary.max)}${periodStr}`;
  }

  if (salary.min !== null && salary.max !== null && salary.min === salary.max) {
    return `${sym}${fmt(salary.min)}${periodStr}`;
  }

  return salary.raw ?? "Not specified";
}

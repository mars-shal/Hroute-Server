const REQUIRED_SECTIONS = ["Experience", "Education", "Skills"] as const;
const PAGE_CHARACTER_LIMIT = 3000;

interface ReformatResult {
  resume_text: string;
  fixes_applied: string[];
  issues_remaining: string[];
}

type TableState = {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
};

function toTitleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function isSectionHeader(line: string): boolean {
  return /^##\s+\S/.test(line);
}

function normalizeHeader(line: string): string {
  return `## ${toTitleCase(line.replace(/^##\s+/, "").trim())}`;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableCells(line: string): readonly string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function formatTableRow(headers: readonly string[], row: readonly string[]): string {
  const labeledCells = row.map((cell, index) => {
    const header = headers.at(index);
    return header ? `${header}: ${cell}` : cell;
  });

  return `- ${labeledCells.join("; ")}`;
}

function flushTable(table: TableState | null): readonly string[] {
  if (!table) {
    return [];
  }

  return table.rows.map((row) => formatTableRow(table.headers, row));
}

function appendLineWithoutTrailingWhitespace(lines: string[], line: string): void {
  lines.push(line.replace(/\s+$/g, ""));
}

function normalizeRequiredSections(lines: readonly string[], fixes: Set<string>): readonly string[] {
  const existingSections = new Set(
    lines
      .filter(isSectionHeader)
      .map((line) => line.replace(/^##\s+/, "").trim().toLowerCase()),
  );
  const missingSections = REQUIRED_SECTIONS.filter((section) => !existingSections.has(section.toLowerCase()));

  if (missingSections.length === 0) {
    return lines;
  }

  fixes.add(`Added missing section headers: ${missingSections.join(", ")}`);
  return [...lines, "", ...missingSections.map((section) => `## ${section}`)];
}

function collapseBlankLines(lines: readonly string[], fixes: Set<string>): readonly string[] {
  let blankCount = 0;
  let removedBlankLine = false;
  const collapsed = lines.filter((line) => {
    if (line.trim() !== "") {
      blankCount = 0;
      return true;
    }

    blankCount += 1;
    const keep = blankCount <= 2;
    removedBlankLine = removedBlankLine || !keep;
    return keep;
  });

  if (removedBlankLine) {
    fixes.add("Removed excessive blank lines");
  }

  return collapsed;
}

function trimAtSectionBoundary(text: string, fixes: Set<string>, issues: Set<string>): string {
  if (text.length <= PAGE_CHARACTER_LIMIT) {
    return text;
  }

  const sectionMatches = Array.from(text.matchAll(/^##\s+.+$/gm));
  const boundary = sectionMatches
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined && index > 0 && index <= PAGE_CHARACTER_LIMIT)
    .at(-1);

  fixes.add("Trimmed content to approximately one page");

  if (boundary) {
    return text.slice(0, boundary).trimEnd();
  }

  issues.add("No section boundary found before one-page limit; truncated at character limit");
  return text.slice(0, PAGE_CHARACTER_LIMIT).trimEnd();
}

function collectRemainingIssues(text: string, issues: Set<string>): void {
  const existingSections = new Set(
    text
      .split("\n")
      .filter(isSectionHeader)
      .map((line) => line.replace(/^##\s+/, "").trim().toLowerCase()),
  );

  REQUIRED_SECTIONS.filter((section) => !existingSections.has(section.toLowerCase())).forEach((section) => {
    issues.add(`Required section missing after trimming: ${section}`);
  });

  if (text.length > PAGE_CHARACTER_LIMIT + 200) {
    issues.add("Resume remains longer than the approximate one-page target after preserving sections");
  }
}

function processMarkdownLines(raw: string, fixes: Set<string>): readonly string[] {
  const output: string[] = [];
  let table: TableState | null = null;

  raw.split(/\r?\n/).forEach((line) => {
    const trimmedRight = line.replace(/\s+$/g, "");

    if (trimmedRight !== line) {
      fixes.add("Trimmed trailing whitespace");
    }

    if (isTableRow(trimmedRight)) {
      fixes.add("Converted markdown tables to bullet lists");

      if (isTableSeparator(trimmedRight)) {
        return;
      }

      const cells = parseTableCells(trimmedRight);
      if (!table) {
        table = { headers: cells, rows: [] };
        return;
      }

      table = { headers: table.headers, rows: [...table.rows, cells] };
      return;
    }

    flushTable(table).forEach((tableLine) => appendLineWithoutTrailingWhitespace(output, tableLine));
    table = null;

    if (isSectionHeader(trimmedRight)) {
      const normalizedHeader = normalizeHeader(trimmedRight);
      if (normalizedHeader !== trimmedRight) {
        fixes.add("Normalized section header capitalization");
      }
      appendLineWithoutTrailingWhitespace(output, normalizedHeader);
      return;
    }

    appendLineWithoutTrailingWhitespace(output, trimmedRight);
  });

  flushTable(table).forEach((tableLine) => appendLineWithoutTrailingWhitespace(output, tableLine));
  return output;
}

function reformatResumeMarkdown(raw: string): ReformatResult {
  const fixes = new Set<string>();
  const issues = new Set<string>();
  const processedLines = processMarkdownLines(raw, fixes);
  const withRequiredSections = normalizeRequiredSections(processedLines, fixes);
  const cleanedLines = collapseBlankLines(withRequiredSections, fixes);
  const cleanedText = cleanedLines.join("\n").trim();
  const resumeText = trimAtSectionBoundary(cleanedText, fixes, issues);

  collectRemainingIssues(resumeText, issues);

  return {
    resume_text: resumeText,
    fixes_applied: Array.from(fixes),
    issues_remaining: Array.from(issues),
  };
}

export { reformatResumeMarkdown };
export type { ReformatResult };

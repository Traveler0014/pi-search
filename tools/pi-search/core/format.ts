/**
 * Model-facing rendering of search and extract results.
 *
 * There is exactly one renderer for every provider, so the output budget
 * (truncation limits) and the shape the model sees stay stable no matter which
 * backend served the request.
 */

import {
  DEFAULT_MAX_EXTRACT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_PER_RESULT_CHARS,
  DEFAULT_PER_URL_CHARS,
  type Detail,
  type ExtractResponse,
  type SearchResponse,
  type SearchResultItem,
} from "./types.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n… [truncated]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Keep only the calendar date part of a timestamp.
 *
 * Providers are not consistent: Tavily returns RFC 1123 (`Thu, 18 Dec 2025
 * 14:52:58 GMT`), DeepSeek returns RFC 3339 (`2026-06-01T00:00:00+00:00`).
 * ISO input keeps its own calendar date; other formats are parsed and rendered
 * in UTC so the date cannot drift by a day.
 */
function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (iso) return iso[1];

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Snippets and summaries are small by construction; page text needs a cap. */
function resultBudget(kind: Detail): number {
  return kind === "content" ? DEFAULT_PER_RESULT_CHARS : 1_500;
}

/**
 * Whether a publisher name adds information beyond the URL.
 *
 * "GitHub" next to `github.com` is noise; "证券时报" next to `stcn.com` is the
 * only way a non-Latin publisher is identifiable at all.
 */
export function siteNameAddsInfo(siteName: string, url: string): boolean {
  const name = siteName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  if (!name) return false;

  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  const labels = host.split(".").filter((label) => label.length > 2);
  return !labels.some((label) => name.includes(label));
}

/**
 * One compact line of judgement aids: score with its level, publication date,
 * publisher name, and notable flags. Segments are omitted when the provider has
 * nothing useful to say.
 */
export function formatScoreLine(result: SearchResultItem): string | null {
  const parts: string[] = [];

  if (result.score !== undefined) {
    const level = result.quality ? ` (${result.quality})` : "";
    parts.push(`score ${result.score.toFixed(2)}${level}`);
  }

  const date = dateOnly(result.publishedAt);
  if (date) parts.push(date);

  if (result.siteName && siteNameAddsInfo(result.siteName, result.url)) {
    parts.push(result.siteName.trim());
  }

  if (result.flags?.length) parts.push(result.flags.join(", "));

  return parts.length > 0 ? parts.join(" | ") : null;
}

/** Non-fatal adjustments reported by the adapter or the registry. */
function formatWarnings(warnings: string[] | undefined): string[] {
  return (warnings ?? []).map((warning) => `note: ${warning}`);
}

/** Render search results as compact plain text for the model. */
export function formatSearchResponse(
  response: SearchResponse,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const warnings = formatWarnings(response.warnings);

  if (response.results.length === 0) {
    const query = response.query || "(query)";
    return [
      `No results for "${query}". Try broader keywords, a shorter recency window, ` +
        `a different detail level, or remove include_domains/exclude_domains filters.`,
      ...warnings,
    ].join("\n");
  }

  const lines: string[] = [];
  if (response.answer) {
    lines.push(`Answer: ${oneLine(response.answer)}`, "");
  }

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
    lines.push(`   URL: ${result.url}`);
    const meta = formatScoreLine(result);
    if (meta) lines.push(`   ${meta}`);
    if (result.text) {
      lines.push(`   ${truncate(oneLine(result.text), resultBudget(result.kind))}`);
    }
    lines.push("");
  });

  if (warnings.length > 0) lines.push(...warnings);

  return truncate(lines.join("\n").trimEnd(), maxChars);
}

/** Render extracted page content as plain text for the model. */
export function formatExtractResponse(
  response: ExtractResponse,
  options: { maxChars?: number; perUrlChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_EXTRACT_CHARS;
  const perUrlChars = options.perUrlChars ?? DEFAULT_PER_URL_CHARS;
  const warnings = formatWarnings(response.warnings);

  if (response.results.length === 0 && response.failedResults.length === 0) {
    return [
      "The provider returned no extracted content. The pages may be empty or blocked.",
      ...warnings,
    ].join("\n");
  }

  const lines: string[] = [];

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || result.url}`);
    lines.push(`   URL: ${result.url}`);
    lines.push("");
    if (result.text) {
      lines.push(truncate(result.text, perUrlChars));
    } else {
      lines.push("(no text content extracted)");
    }
    lines.push("");
  });

  if (response.failedResults.length > 0) {
    lines.push(`Failed (${response.failedResults.length}):`);
    for (const failure of response.failedResults) {
      lines.push(`- ${failure.url}: ${oneLine(failure.error)}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) lines.push(...warnings);

  return truncate(lines.join("\n").trimEnd(), maxChars);
}

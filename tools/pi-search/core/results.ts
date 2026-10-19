/**
 * Result post-processing shared by every adapter.
 *
 * Backends return the same page more than once far more often than expected —
 * Tavily, for example, has returned one article twice with different URL
 * fragments (`#wp--skip-link--target`). Duplicates are the most expensive kind
 * of noise in a search result: identical text, paid for twice in context.
 */

import type { SearchResultItem } from "./types.js";

/**
 * Canonical form used only for duplicate detection.
 *
 * Drops the fragment and a trailing slash, keeps the query string (different
 * queries can mean different pages), and lowercases the scheme/host.
 */
export function normalizeResultUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

/** Drop repeated pages, keeping the first (best-ranked) occurrence. */
export function dedupeResults(results: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const kept: SearchResultItem[] = [];

  for (const result of results) {
    const key = normalizeResultUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(result);
  }

  return kept;
}

/** How many duplicates `dedupeResults` would remove. */
export function countDuplicates(results: SearchResultItem[]): number {
  return results.length - dedupeResults(results).length;
}

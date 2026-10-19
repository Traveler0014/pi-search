/**
 * Score normalization.
 *
 * Two layers, deliberately kept apart:
 *
 *   - the *number* (`score`, 0..1) is a monotonic mapping of the provider's own
 *     value, so it is only meaningful **within** one result set;
 *   - the *level* (`quality`, high/medium/low) is derived from per-provider
 *     cutoffs and is the layer that is comparable **across** providers.
 *
 * Adapters normalize their raw value (they know its scale); the registry stamps
 * the level with the provider's cutoffs. Nothing here invents a new metric: a
 * composite score would need freshness/authority from every backend, so it
 * would silently redefine what "good" means.
 */

import type {
  Quality,
  ScoreCutoffs,
  SearchResponse,
  SearchResultItem,
} from "./types.js";

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** For providers whose native score is already 0..1 (relevance-style). */
export function normalizeUnitScore(raw: number): number {
  return clampUnit(raw);
}

/** For providers with an explicit upper bound, e.g. `rerank_score` 0..3. */
export function normalizeScaledScore(raw: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return clampUnit(raw / max);
}

/** Map a normalized score to a level. Missing scores stay unclassified. */
export function classifyScore(
  score: number | undefined,
  cutoffs: ScoreCutoffs,
): Quality | undefined {
  if (score === undefined) return undefined;
  if (score >= cutoffs.high) return "high";
  if (score >= cutoffs.medium) return "medium";
  return "low";
}

/** Stamp `quality` on every result that has a score. */
export function finalizeSearchResults(
  results: SearchResultItem[],
  cutoffs: ScoreCutoffs,
): SearchResultItem[] {
  return results.map((result) =>
    result.score === undefined
      ? result
      : { ...result, quality: classifyScore(result.score, cutoffs) },
  );
}

export function finalizeSearchResponse(
  response: SearchResponse,
  cutoffs: ScoreCutoffs,
): SearchResponse {
  return { ...response, results: finalizeSearchResults(response.results, cutoffs) };
}

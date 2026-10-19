/**
 * Shared, provider-agnostic types and limits.
 *
 * This module has NO dependency on the pi extension API and no dependency on
 * any specific search provider, so it can be unit-tested in isolation and
 * reused by every adapter under `providers/`.
 *
 * The tool schema is defined by *capabilities*, not by providers: adding a
 * backend adds an enum value, never a parameter. Anything a single backend
 * supports natively travels in `provider_options`.
 */

// =============================================================================
// Limits
// =============================================================================

export const DEFAULT_MAX_RESULTS = 5;
export const MAX_MAX_RESULTS = 20;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
export const DEFAULT_MAX_EXTRACT_CHARS = 16_000;
export const DEFAULT_PER_URL_CHARS = 4_000;
/**
 * Per-result cap for `detail: "content"`; other tiers are small by design.
 *
 * 2K keeps a default 5-result search (5 x 2K) inside the 12K output budget, so
 * the model sees every result instead of losing the last one to truncation.
 */
export const DEFAULT_PER_RESULT_CHARS = 2_000;

/** Per-provider hard limits. */
export interface ProviderLimits {
  /** Maximum query length in characters (before operator injection). */
  maxQueryChars: number;
  /** Maximum results the backend returns in one call. */
  maxResults: number;
}

// =============================================================================
// Neutral request shape
// =============================================================================

export const RECENCY_RANGES = ["day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCY_RANGES)[number];

export const DETAIL_LEVELS = ["snippet", "summary", "content"] as const;
export type Detail = (typeof DETAIL_LEVELS)[number];
export const DEFAULT_DETAIL: Detail = "summary";

export interface SearchOptions {
  query: string;
  maxResults: number;
  detail: Detail;
  recency?: Recency;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** ISO 639-1 code or name; adapters normalize as needed. */
  language?: string;
  /** Backend-native knobs, validated against the adapter's whitelist. */
  options?: Record<string, unknown>;
}

export interface ExtractOptions {
  urls: string[];
  /** Backend-native knobs, validated against the adapter's whitelist. */
  options?: Record<string, unknown>;
}

/** Transport-level options shared by every adapter call. */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// =============================================================================
// Scores
// =============================================================================

export const QUALITY_LEVELS = ["high", "medium", "low"] as const;
export type Quality = (typeof QUALITY_LEVELS)[number];

/** High-signal traits a provider may report about a result. */
export const SEARCH_FLAGS = ["low-authority", "authoritative"] as const;
export type SearchFlag = (typeof SEARCH_FLAGS)[number];

/**
 * Boundaries in normalized (0..1) units. Declared per provider because the
 * underlying scales mean different things; `high`/`medium`/`low` is the layer
 * that is comparable across backends.
 */
export interface ScoreCutoffs {
  high: number;
  medium: number;
}

/** Used when a provider has no opinion (or is not calibrated yet). */
export const DEFAULT_SCORE_CUTOFFS: ScoreCutoffs = { high: 0.65, medium: 0.4 };

// =============================================================================
// Responses
// =============================================================================

export interface SearchResultItem {
  title: string;
  url: string;
  /** Result text at the requested `detail` tier. */
  text: string;
  /** Which tier `text` came from (what the backend could actually deliver). */
  kind: Detail;
  /** Normalized 0..1 score. Absent when the provider returned none. */
  score?: number;
  /** Provider-native score, for `details` and debugging only. */
  rawScore?: number;
  /** Derived from the provider's `ScoreCutoffs` by the registry. */
  quality?: Quality;
  /** Notable traits; nothing is rendered when empty. */
  flags?: SearchFlag[];
  /** Publication date as reported by the provider (ISO-ish string). */
  publishedAt?: string | null;
  /** Publisher name when the provider reports one (often clearer than a domain). */
  siteName?: string | null;
}

export interface SearchResponse {
  query: string;
  answer?: string | null;
  results: SearchResultItem[];
  responseTime: number;
  requestId?: string;
  /** Non-fatal adjustments, rendered as `note:` lines. */
  warnings?: string[];
}

export interface ExtractResultItem {
  url: string;
  title?: string;
  /** Page content as readable text/markdown. */
  text: string;
  images?: string[];
}

export interface ExtractFailure {
  url: string;
  error: string;
}

export interface ExtractResponse {
  results: ExtractResultItem[];
  failedResults: ExtractFailure[];
  responseTime: number;
  warnings?: string[];
}

// =============================================================================
// Errors
// =============================================================================

/**
 * `auth`, `billing`, and `rate_limit` are actionable by the user;
 * `timeout`/`network` are retryable; `aborted` must never be retried; `api`
 * covers everything else.
 */
export type ProviderErrorKind =
  | "auth"
  | "billing"
  | "rate_limit"
  | "timeout"
  | "network"
  | "api"
  | "aborted";

/** A typed failure raised by an adapter, so the extension can react by kind. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

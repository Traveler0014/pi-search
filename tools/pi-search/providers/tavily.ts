/**
 * Tavily adapter.
 *
 * Everything Tavily-specific lives here: endpoints, request bodies, response
 * parsing, key shape, limits, native options, and the prose used to explain its
 * failure modes. The neutral request (query/max_results/recency/detail/language/
 * domains) is translated to Tavily's own vocabulary below.
 */

import type { HttpProfile } from "../core/http.js";
import { postJson } from "../core/http.js";
import {
  normalizeUnitScore,
} from "../core/score.js";
import {
  validateProviderOptions,
  type NativeOptionsSpec,
} from "../core/provider-options.js";
import {
  ProviderError,
  type Detail,
  type ExtractOptions,
  type ExtractResponse,
  type ExtractResultItem,
  type ProviderLimits,
  type RequestOptions,
  type SearchOptions,
  type SearchResponse,
  type SearchResultItem,
} from "../core/types.js";
import {
  dedupeValues,
  normalizeDomain,
  normalizeLanguage,
  validateExtractOptions,
  validateSearchOptions,
  validateUrl,
} from "../core/validate.js";
import type { SearchProvider } from "./types.js";

// =============================================================================
// Endpoints, key shape, limits
// =============================================================================

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

export const TAVILY_LIMITS: ProviderLimits = {
  maxQueryChars: 400,
  maxResults: 20,
};

const TAVILY_KEY_PATTERN = /^tvly-[A-Za-z0-9_-]{8,}$/;

/** Best-effort shape check: keys currently start with `tvly-`. */
export function isValidTavilyKey(key: string): boolean {
  return TAVILY_KEY_PATTERN.test(key.trim());
}

// =============================================================================
// Native options (never sent to the model; used for validation + errors)
// =============================================================================

export const TAVILY_SEARCH_OPTIONS: NativeOptionsSpec = {
  search_depth: {
    type: "enum",
    values: ["basic", "advanced", "fast", "ultra-fast"],
    note: "default basic; advanced costs 2 credits",
  },
  topic: {
    type: "enum",
    values: ["general", "news", "finance"],
    note: "default general",
  },
  include_answer: {
    type: "boolean",
    note: "adds a generated answer; extra credits",
  },
  chunks_per_source: {
    type: "number",
    min: 1,
    max: 3,
    note: "overrides the chunk count implied by `detail`",
  },
  country: { type: "string", note: "requires topic=general" },
  start_date: { type: "string", note: "YYYY-MM-DD; replaces `recency`" },
  end_date: { type: "string", note: "YYYY-MM-DD; replaces `recency`" },
};

export const TAVILY_EXTRACT_OPTIONS: NativeOptionsSpec = {
  extract_depth: {
    type: "enum",
    values: ["basic", "advanced"],
    note: "advanced handles JS-heavy pages and costs more credits",
  },
  include_images: { type: "boolean" },
};

// =============================================================================
// HTTP profile
// =============================================================================

export const TAVILY_HTTP_PROFILE: HttpProfile = {
  label: "Tavily",

  classify(status) {
    if (status === 401 || status === 403) return "auth";
    if (status === 429 || status === 432 || status === 433) return "rate_limit";
    return "api";
  },

  describe(status, detail) {
    const suffix = detail ? ` ${detail}` : "";

    if (status === 401 || status === 403) {
      return (
        `Tavily rejected the API key (HTTP ${status}).${suffix} ` +
        "Check TAVILY_API_KEY or run /search-key <key> to update the stored key."
      );
    }
    if (status === 429) {
      return (
        `Tavily rate limit reached (HTTP 429).${suffix} ` +
        "Do not retry immediately; wait or check your Tavily plan/usage."
      );
    }
    if (status === 432 || status === 433) {
      return (
        `Tavily plan limit exceeded (HTTP ${status}).${suffix} ` +
        "Check your Tavily account usage/billing."
      );
    }
    return `Tavily API error (HTTP ${status}).${suffix}`.trim();
  },
};

// =============================================================================
// Neutral → Tavily translation
// =============================================================================

/** `detail` → how many snippets Tavily should return per source. */
export function chunksForDetail(detail: Detail): number {
  if (detail === "snippet") return 1;
  if (detail === "content") return 3;
  return 2;
}

export function buildSearchBody(options: SearchOptions): Record<string, unknown> {
  const native = validateProviderOptions(
    "Tavily",
    TAVILY_SEARCH_OPTIONS,
    options.options,
  );
  const detail = options.detail;

  const body: Record<string, unknown> = {
    query: options.query.trim(),
    max_results: options.maxResults,
    search_depth: native.search_depth ?? "basic",
    topic: native.topic ?? "general",
    chunks_per_source: native.chunks_per_source ?? chunksForDetail(detail),
    include_answer: native.include_answer ?? false,
    // `detail: content` is the neutral way to ask for page text; it maps onto
    // Tavily's raw-content field so callers never need provider knowledge.
    include_raw_content: detail === "content" ? "markdown" : false,
    // Adds `published_date` per result; pages without a detectable date keep
    // `null`, so this only enables freshness signal, never filters results.
    include_published_date: true,
  };

  const hasNativeDates = native.start_date !== undefined || native.end_date !== undefined;
  if (options.recency && !hasNativeDates) body.time_range = options.recency;
  if (native.start_date !== undefined) body.start_date = native.start_date;
  if (native.end_date !== undefined) body.end_date = native.end_date;

  if (options.language) body.language = normalizeLanguage(options.language);

  const include = dedupeValues((options.includeDomains ?? []).map(normalizeDomain));
  const exclude = dedupeValues((options.excludeDomains ?? []).map(normalizeDomain));
  if (include.length > 0) body.include_domains = include;
  if (exclude.length > 0) body.exclude_domains = exclude;

  if (native.country !== undefined) body.country = native.country;

  return body;
}

/** Explain every neutral option the native ones overrode. */
export function searchWarnings(options: SearchOptions): string[] {
  const native = (options.options ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  if (
    options.recency &&
    (native.start_date !== undefined || native.end_date !== undefined)
  ) {
    warnings.push("recency ignored: start_date/end_date take precedence at the provider");
  }
  return warnings;
}

export function buildExtractBody(options: ExtractOptions): Record<string, unknown> {
  const native = validateProviderOptions(
    "Tavily",
    TAVILY_EXTRACT_OPTIONS,
    options.options,
  );

  return {
    urls: dedupeValues(options.urls.map(validateUrl)),
    extract_depth: native.extract_depth ?? "basic",
    include_images: native.include_images ?? false,
  };
}

// =============================================================================
// Response parsing
// =============================================================================

export function parseSearchResponse(
  payload: unknown,
  detail: Detail = "summary",
): SearchResponse {
  if (!payload || typeof payload !== "object") {
    throw new ProviderError("Tavily search response is not an object.", "api");
  }

  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.results)) {
    throw new ProviderError(
      "Tavily search response is missing a 'results' array.",
      "api",
    );
  }

  const results: SearchResultItem[] = [];
  for (const item of raw.results) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;

    const content = typeof r.content === "string" ? r.content : "";
    const pageText = typeof r.raw_content === "string" ? r.raw_content : "";
    const rawScore = typeof r.score === "number" ? r.score : undefined;

    // Report what was actually delivered, not what was asked for.
    const fromPage = detail === "content" && pageText.length > 0;
    const kind: Detail = fromPage ? "content" : detail === "snippet" ? "snippet" : "summary";

    results.push({
      title: typeof r.title === "string" ? r.title : "",
      url: r.url,
      text: fromPage ? pageText : content,
      kind,
      // Tavily's relevance score is already 0..1; normalization is a clamp so
      // every adapter goes through the same funnel.
      score: rawScore === undefined ? undefined : normalizeUnitScore(rawScore),
      rawScore,
      publishedAt: typeof r.published_date === "string" ? r.published_date : null,
    });
  }

  return {
    query: typeof raw.query === "string" ? raw.query : "",
    answer: typeof raw.answer === "string" ? raw.answer : null,
    results,
    responseTime: typeof raw.response_time === "number" ? raw.response_time : 0,
    requestId: typeof raw.request_id === "string" ? raw.request_id : undefined,
  };
}

export function parseExtractResponse(payload: unknown): ExtractResponse {
  if (!payload || typeof payload !== "object") {
    throw new ProviderError("Tavily extract response is not an object.", "api");
  }

  const raw = payload as Record<string, unknown>;
  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const rawFailed = Array.isArray(raw.failed_results) ? raw.failed_results : [];

  const results: ExtractResultItem[] = [];
  for (const item of rawResults) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;
    results.push({
      url: r.url,
      title: typeof r.title === "string" ? r.title : undefined,
      text: typeof r.raw_content === "string" ? r.raw_content : "",
      images: Array.isArray(r.images)
        ? r.images.filter((v): v is string => typeof v === "string")
        : undefined,
    });
  }

  const failedResults = [];
  for (const item of rawFailed) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    failedResults.push({
      url: typeof f.url === "string" ? f.url : "(unknown)",
      error: typeof f.error === "string" ? f.error : "extraction failed",
    });
  }

  return {
    results,
    failedResults,
    responseTime: typeof raw.response_time === "number" ? raw.response_time : 0,
  };
}

// =============================================================================
// High-level calls
// =============================================================================

export async function tavilyRequest<T>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  return postJson<T>(endpoint, apiKey, body, TAVILY_HTTP_PROFILE, options);
}

export async function tavilySearch(
  apiKey: string,
  options: SearchOptions,
  requestOptions: RequestOptions = {},
): Promise<SearchResponse> {
  validateSearchOptions(options, TAVILY_LIMITS);
  const payload = await tavilyRequest<unknown>(
    TAVILY_SEARCH_URL,
    apiKey,
    buildSearchBody(options),
    requestOptions,
  );
  return {
    ...parseSearchResponse(payload, options.detail),
    warnings: searchWarnings(options),
  };
}

export async function tavilyExtract(
  apiKey: string,
  options: ExtractOptions,
  requestOptions: RequestOptions = {},
): Promise<ExtractResponse> {
  validateExtractOptions(options);
  const payload = await tavilyRequest<unknown>(
    TAVILY_EXTRACT_URL,
    apiKey,
    buildExtractBody(options),
    requestOptions,
  );
  return parseExtractResponse(payload);
}

// =============================================================================
// Provider descriptor
// =============================================================================

export const tavilyProvider: SearchProvider = {
  id: "tavily",
  label: "Tavily",
  apiKeyEnv: ["TAVILY_API_KEY"],
  // Calibrated against real responses (Tavily documents no thresholds):
  //   focused query  "pi coding agent"     -> 0.88-0.92 (all on-topic)
  //   vague query    "ai news"             -> 0.84, 0.81, 0.81, 0.71, 0.71,
  //                                           0.69, 0.67, 0.49, 0.41
  //   filtered       domain + year window  -> 0.83, 0.77, 0.77
  // 0.75 separates clearly on-topic pages from weaker matches; below 0.50 the
  // results were consistently generic index pages with no article content.
  // NOTE: the level measures topical relevance only — a homepage titled
  // "AI News" scores high without being a useful source. `publishedAt` and the
  // result text are what tell an article from a listing.
  // Re-check after Tavily changes its ranking model.
  scores: { high: 0.75, medium: 0.5 },
  limits: TAVILY_LIMITS,
  details: ["snippet", "summary", "content"],
  searchOptions: TAVILY_SEARCH_OPTIONS,
  extractOptions: TAVILY_EXTRACT_OPTIONS,
  looksLikeKey: isValidTavilyKey,
  search: tavilySearch,
  extract: tavilyExtract,
};

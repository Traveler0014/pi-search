/**
 * DeepSeek adapter (Search / Fetch).
 *
 * Two notable differences from Tavily shape this adapter:
 *
 *   1. Filters are expressed **inside the query** (`site:`, `-site:`, `lang:`,
 *      `after:`), and the query has a hard 128-character limit. Every neutral
 *      option is injected here and the length is re-checked afterwards.
 *   2. Fetch accepts **one URL per request**, so a batch is a sequential loop.
 *      Per-URL rejections (403 policy, 404 no content) become soft failures so
 *      one bad page cannot sink the batch.
 *
 * Billing is per successful request (not per result), so `count` and
 * `need_content` cost nothing extra.
 */

import type { HttpProfile } from "../core/http.js";
import { postJson } from "../core/http.js";
import {
  validateProviderOptions,
  type NativeOptionsSpec,
} from "../core/provider-options.js";
import { normalizeScaledScore } from "../core/score.js";
import {
  ProviderError,
  type Detail,
  type ExtractFailure,
  type ExtractOptions,
  type ExtractResponse,
  type ExtractResultItem,
  type ProviderLimits,
  type Recency,
  type RequestOptions,
  type SearchFlag,
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

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
export const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

export const DEEPSEEK_LIMITS: ProviderLimits = {
  maxQueryChars: 128,
  maxResults: 50,
};

/** DeepSeek documents `rerank_score` as 0..3 where >= 1.5 is high quality. */
export const DEEPSEEK_SCORE_MAX = 3;
/**
 * `authority` is 0..4 with `-1` for unknown. Live payloads put most results at
 * 3-4, so flagging the *top* tier marked 4 of 5 results and told the model
 * nothing. Flagging the bottom instead is rare and decision-relevant: "this
 * source has little standing, prefer another".
 */
export const DEEPSEEK_LOW_AUTHORITY_MAX = 1;

const DEEPSEEK_KEY_PATTERN = /^sk-[A-Za-z0-9]{16,}$/;

/** Best-effort shape check: DeepSeek keys start with `sk-`. */
export function isValidDeepSeekKey(key: string): boolean {
  return DEEPSEEK_KEY_PATTERN.test(key.trim());
}

// =============================================================================
// Native options
// =============================================================================

export const DEEPSEEK_SEARCH_OPTIONS: NativeOptionsSpec = {
  ori_question: {
    type: "string",
    note: "the user's original question (<=128 chars); improves intent matching",
  },
  localization: {
    type: "string",
    note: "IP address used to prefer locally relevant results",
  },
};

/** Fetch takes only a URL; there is nothing to expose. */
export const DEEPSEEK_EXTRACT_OPTIONS: NativeOptionsSpec = {};

// =============================================================================
// HTTP profile
// =============================================================================

const STATUS_PROSE: Record<number, string> = {
  400: "DeepSeek rejected the request body (HTTP 400). Check the query and filters.",
  401: "DeepSeek rejected the API key (HTTP 401). Check DEEPSEEK_API_KEY or update the stored key in /search-config.",
  402: "DeepSeek account balance is insufficient (HTTP 402). Top up, then retry.",
  403: "DeepSeek blocked the fetch by security policy (HTTP 403).",
  404: "DeepSeek found no extractable page content (HTTP 404).",
  408: "DeepSeek timed out reading the request (HTTP 408). Retry later.",
  413: "DeepSeek rejected the request body as too large (HTTP 413).",
  429: "DeepSeek rate limit reached (HTTP 429, 5 QPS per account). Do not retry immediately.",
  500: "DeepSeek internal error (HTTP 500). Retry later.",
  504: "DeepSeek downstream timeout (HTTP 504). Retry later.",
};

export const DEEPSEEK_HTTP_PROFILE: HttpProfile = {
  label: "DeepSeek",

  classify(status) {
    if (status === 401) return "auth";
    if (status === 402) return "billing";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limit";
    return "api";
  },

  describe(status, detail) {
    const suffix = detail ? ` ${detail}` : "";
    return `${STATUS_PROSE[status] ?? `DeepSeek API error (HTTP ${status}).`}${suffix}`.trim();
  },
};

// =============================================================================
// Neutral → DeepSeek translation
// =============================================================================

const RECENCY_DAYS: Record<Recency, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function isoDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** The `after:` date for a recency window, relative to now. */
export function afterDateFor(recency: Recency, now: number = Date.now()): string {
  return isoDate(now - RECENCY_DAYS[recency] * 86_400_000);
}

/**
 * Build the effective query by appending DeepSeek search operators.
 *
 * Operators already present in the user's query are left untouched; this only
 * appends what the neutral options ask for.
 */
export function buildDeepSeekQuery(
  options: SearchOptions,
  now: number = Date.now(),
): string {
  const parts = [options.query.trim()];

  const include = dedupeValues((options.includeDomains ?? []).map(normalizeDomain));
  if (include.length > 0) parts.push(include.map((d) => `site:${d}`).join(" OR "));

  for (const domain of dedupeValues(
    (options.excludeDomains ?? []).map(normalizeDomain),
  )) {
    parts.push(`-site:${domain}`);
  }

  if (options.language) {
    const primary = normalizeLanguage(options.language).split("-")[0].toLowerCase();
    parts.push(`lang:${primary}`);
  }

  if (options.recency) parts.push(`after:${afterDateFor(options.recency, now)}`);

  return parts.join(" ");
}

export function buildSearchBody(
  options: SearchOptions,
  now: number = Date.now(),
): Record<string, unknown> {
  const native = validateProviderOptions(
    "DeepSeek",
    DEEPSEEK_SEARCH_OPTIONS,
    options.options,
  );

  const query = buildDeepSeekQuery(options, now);
  if (query.length > DEEPSEEK_LIMITS.maxQueryChars) {
    throw new Error(
      `Invalid 'query': with the requested filters it becomes ${query.length} characters, ` +
        `above DeepSeek's ${DEEPSEEK_LIMITS.maxQueryChars}-character limit. ` +
        `Shorten the query, drop include_domains/exclude_domains/language/recency, ` +
        `or use provider="tavily".`,
    );
  }

  const body: Record<string, unknown> = {
    query,
    count: options.maxResults,
    need_content: options.detail === "content",
  };

  if (typeof native.ori_question === "string") {
    if ((native.ori_question as string).length > 128) {
      throw new Error(
        "Invalid 'provider_options.ori_question': must be 128 characters or fewer.",
      );
    }
    body.ori_question = native.ori_question;
  }
  if (typeof native.localization === "string") {
    body.localization = native.localization;
  }

  return body;
}

// =============================================================================
// Response parsing
// =============================================================================

/** Pick the richest text the response actually carries for the requested tier. */
export function selectText(
  detail: Detail,
  fields: { snippet: string; summary: string; content: string },
): { text: string; kind: Detail } {
  if (detail === "content" && fields.content) {
    return { text: fields.content, kind: "content" };
  }
  if (detail !== "snippet" && fields.summary) {
    return { text: fields.summary, kind: "summary" };
  }
  if (fields.snippet) return { text: fields.snippet, kind: "snippet" };
  if (fields.summary) return { text: fields.summary, kind: "summary" };
  if (fields.content) return { text: fields.content, kind: "content" };
  return { text: "", kind: detail };
}

function flagsFor(authority: unknown): SearchFlag[] {
  return typeof authority === "number" &&
    authority >= 0 &&
    authority <= DEEPSEEK_LOW_AUTHORITY_MAX
    ? ["low-authority"]
    : [];
}

export function parseSearchResponse(
  payload: unknown,
  detail: Detail = "summary",
): SearchResponse {
  if (!payload || typeof payload !== "object") {
    throw new ProviderError("DeepSeek search response is not an object.", "api");
  }

  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.results)) {
    throw new ProviderError(
      "DeepSeek search response is missing a 'results' array.",
      "api",
    );
  }

  const results: SearchResultItem[] = [];
  for (const item of raw.results) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;

    const rawScore = typeof r.rerank_score === "number" ? r.rerank_score : undefined;
    const { text, kind } = selectText(detail, {
      snippet: typeof r.snippet === "string" ? r.snippet : "",
      summary: typeof r.summary === "string" ? r.summary : "",
      content: typeof r.content === "string" ? r.content : "",
    });

    results.push({
      title: typeof r.title === "string" ? r.title : "",
      url: r.url,
      text,
      kind,
      score:
        rawScore === undefined
          ? undefined
          : normalizeScaledScore(rawScore, DEEPSEEK_SCORE_MAX),
      rawScore,
      publishedAt: typeof r.date === "string" ? r.date : null,
      siteName: typeof r.site_name === "string" ? r.site_name : null,
      flags: flagsFor(r.authority),
    });
  }

  return {
    query: typeof raw.query === "string" ? raw.query : "",
    // DeepSeek returns no generated answer.
    answer: null,
    results,
    responseTime: 0,
  };
}

/**
 * DeepSeek's Fetch endpoint escapes markdown punctuation in `content`
 * (`https\:\/\/api\.deepseek\.com`, `\# heading`). Verified live: search
 * snippets/summaries are clean, only fetched pages carry the escaping, so it is
 * undone here — otherwise URLs handed to the model are subtly broken.
 *
 * A left-to-right pass also restores `\\` correctly, so a page that genuinely
 * documents `\/` (regex) survives.
 */
const ESCAPABLE = new Set("\\/\"'#-*_.,:;!?()[]{}|<>+=~&^$@%`".split(""));

export function unescapeFetchedMarkdown(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      out += text[i + 1];
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

export function parseFetchResponse(payload: unknown, url: string): ExtractResultItem {
  if (!payload || typeof payload !== "object") {
    throw new ProviderError("DeepSeek fetch response is not an object.", "api");
  }
  const raw = payload as Record<string, unknown>;
  return {
    url,
    title: typeof raw.title === "string" ? raw.title : undefined,
    text:
      typeof raw.content === "string"
        ? unescapeFetchedMarkdown(raw.content)
        : "",
  };
}

// =============================================================================
// High-level calls
// =============================================================================

export async function deepseekRequest<T>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  return postJson<T>(endpoint, apiKey, body, DEEPSEEK_HTTP_PROFILE, options);
}

export async function deepseekSearch(
  apiKey: string,
  options: SearchOptions,
  requestOptions: RequestOptions = {},
): Promise<SearchResponse> {
  validateSearchOptions(options, DEEPSEEK_LIMITS);
  const started = Date.now();
  const payload = await deepseekRequest<unknown>(
    DEEPSEEK_SEARCH_URL,
    apiKey,
    buildSearchBody(options),
    requestOptions,
  );
  const warnings: string[] = [];
  if ((options.includeDomains?.length ?? 0) > 0 || (options.excludeDomains?.length ?? 0) > 0) {
    // Verified live: `site:` matches URL text, so pkg.go.dev/github.com/... came
    // back for `site:github.com`. Say so instead of implying a hard filter.
    warnings.push(
      "domain filters are applied as DeepSeek query operators, so results outside those domains may still appear",
    );
  }

  return {
    ...parseSearchResponse(payload, options.detail),
    responseTime: (Date.now() - started) / 1000,
    warnings,
  };
}

/**
 * DeepSeek fetch handles one URL per request, so a batch is sequential.
 *
 * 403 (security policy) and 404 (no extractable content) are per-URL failures;
 * auth, billing, rate-limit, and transport errors abort the whole batch because
 * retrying the remaining URLs would only repeat the same failure.
 */
export async function deepseekExtract(
  apiKey: string,
  options: ExtractOptions,
  requestOptions: RequestOptions = {},
): Promise<ExtractResponse> {
  validateExtractOptions(options);
  // DeepSeek fetch has no native options; reject anything else so callers get
  // a teaching error instead of a silently ignored key.
  validateProviderOptions("DeepSeek", DEEPSEEK_EXTRACT_OPTIONS, options.options);
  const urls = dedupeValues(options.urls.map(validateUrl));
  const started = Date.now();

  const results: ExtractResultItem[] = [];
  const failedResults: ExtractFailure[] = [];

  for (const url of urls) {
    if (requestOptions.signal?.aborted) break;
    try {
      const payload = await deepseekRequest<unknown>(
        DEEPSEEK_FETCH_URL,
        apiKey,
        { url },
        requestOptions,
      );
      const page = parseFetchResponse(payload, url);
      if (page.text) results.push(page);
      else failedResults.push({ url, error: "no extractable content" });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        (error.status === 403 || error.status === 404)
      ) {
        failedResults.push({ url, error: error.message });
        continue;
      }
      throw error;
    }
  }

  const warnings =
    urls.length > 1
      ? [
          `${urls.length} sequential DeepSeek fetch requests (one URL per call, 5 QPS)`,
        ]
      : [];

  return {
    results,
    failedResults,
    responseTime: (Date.now() - started) / 1000,
    warnings,
  };
}

// =============================================================================
// Provider descriptor
// =============================================================================

export const deepseekProvider: SearchProvider = {
  id: "deepseek",
  label: "DeepSeek",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  // rerank_score >= 1.5 of 3 is documented as high quality; 1.0 of 3 is the
  // practical floor for usable results.
  scores: { high: 1.5 / DEEPSEEK_SCORE_MAX, medium: 1 / DEEPSEEK_SCORE_MAX },
  limits: DEEPSEEK_LIMITS,
  details: ["snippet", "summary", "content"],
  searchOptions: DEEPSEEK_SEARCH_OPTIONS,
  extractOptions: DEEPSEEK_EXTRACT_OPTIONS,
  looksLikeKey: isValidDeepSeekKey,
  search: deepseekSearch,
  extract: deepseekExtract,
};

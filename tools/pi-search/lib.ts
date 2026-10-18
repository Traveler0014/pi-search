/**
 * pi-search — pure logic for the Tavily search / extract API.
 *
 * This file has NO dependency on the pi extension API so it can be
 * unit-tested in isolation. index.ts only handles registration + TUI.
 *
 * Design notes:
 *   - API key resolution: TAVILY_API_KEY env var > ~/.pi/agent/pi-search.json
 *   - All network calls take an AbortSignal + timeout
 *   - HTTP failures become typed TavilyError values so the extension can
 *     decide between hard errors and recoverable hints
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Constants & types
// =============================================================================

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Config file lives next to pi's own agent state. */
export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-search.json");

export const DEFAULT_MAX_RESULTS = 5;
export const MAX_MAX_RESULTS = 20;
export const MAX_QUERY_CHARS = 400;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
export const DEFAULT_MAX_EXTRACT_CHARS = 16_000;
export const DEFAULT_PER_URL_CHARS = 4_000;

export const SEARCH_DEPTHS = ["basic", "advanced"] as const;
export const SEARCH_TOPICS = ["general", "news", "finance"] as const;
export const EXTRACT_DEPTHS = ["basic", "advanced"] as const;

export type SearchDepth = (typeof SEARCH_DEPTHS)[number];
export type SearchTopic = (typeof SEARCH_TOPICS)[number];
export type ExtractDepth = (typeof EXTRACT_DEPTHS)[number];

export interface SearchConfig {
  apiKey: string;
}

export interface ResolvedApiKey {
  apiKey: string;
  source: "env" | "config";
}

export interface SearchOptions {
  query: string;
  searchDepth?: SearchDepth;
  topic?: SearchTopic;
  maxResults?: number;
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  days?: number;
  country?: string;
}

export interface ExtractOptions {
  urls: string[];
  extractDepth?: ExtractDepth;
  includeImages?: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string | null;
}

export interface SearchResponse {
  query: string;
  answer: string | null;
  results: SearchResultItem[];
  responseTime: number;
  requestId?: string;
}

export interface ExtractResultItem {
  url: string;
  title?: string;
  rawContent: string;
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
}

export type TavilyErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "api"
  | "aborted";

export class TavilyError extends Error {
  constructor(
    message: string,
    readonly kind: TavilyErrorKind,
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// =============================================================================
// Config persistence
// =============================================================================

/** Load the key stored in the config file. Missing/corrupt files yield "". */
export function loadConfig(file: string = CONFIG_FILE): SearchConfig {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SearchConfig>;
      if (typeof parsed?.apiKey === "string") return { apiKey: parsed.apiKey.trim() };
    }
  } catch {
    // Corrupt config — treat as unconfigured.
  }
  return { apiKey: "" };
}

/** Persist the key with owner-only permissions (best effort on Windows). */
export function saveConfig(config: SearchConfig, file: string = CONFIG_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ apiKey: config.apiKey.trim() }, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on some platforms.
  }
}

/**
 * Resolve the API key. The environment wins so ephemeral/CI setups can
 * override a stored developer key without editing the config file.
 */
export function resolveApiKey(
  env: NodeJS.ProcessEnv = process.env,
  file: string = CONFIG_FILE,
): ResolvedApiKey | null {
  const fromEnv = env.TAVILY_API_KEY?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };

  const fromFile = loadConfig(file).apiKey;
  if (fromFile) return { apiKey: fromFile, source: "config" };

  return null;
}

export function isValidApiKey(key: string): boolean {
  return /^tvly-[A-Za-z0-9_-]{8,}$/.test(key.trim());
}

/** Show enough to identify a key without leaking it into logs/transcripts. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "****";
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

// =============================================================================
// Validation
// =============================================================================

/** Normalize a domain filter: strip scheme, path, www, port, lowercase. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");
}

function domainProblem(value: string): string | null {
  const normalized = normalizeDomain(value);
  if (!normalized) return "is empty";
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(normalized)) {
    return `"${value}" is not a valid domain (expected e.g. "example.com")`;
  }
  return null;
}

export function validateSearchOptions(options: SearchOptions): void {
  const query = options.query?.trim() ?? "";
  if (!query) throw new Error("Invalid 'query': must be a non-empty string.");
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(
      `Invalid 'query': ${query.length} characters exceeds Tavily's ${MAX_QUERY_CHARS}-character limit.`,
    );
  }

  if (
    options.maxResults !== undefined &&
    (!Number.isInteger(options.maxResults) ||
      options.maxResults < 1 ||
      options.maxResults > MAX_MAX_RESULTS)
  ) {
    throw new Error(
      `Invalid 'max_results': expected an integer between 1 and ${MAX_MAX_RESULTS} (received ${options.maxResults}).`,
    );
  }

  if (
    options.days !== undefined &&
    (!Number.isInteger(options.days) || options.days < 1)
  ) {
    throw new Error(
      `Invalid 'days': expected a positive integer (received ${options.days}).`,
    );
  }

  if (options.searchDepth !== undefined && !SEARCH_DEPTHS.includes(options.searchDepth)) {
    throw new Error(
      `Invalid 'search_depth': expected one of ${SEARCH_DEPTHS.join(", ")}.`,
    );
  }

  if (options.topic !== undefined && !SEARCH_TOPICS.includes(options.topic)) {
    throw new Error(`Invalid 'topic': expected one of ${SEARCH_TOPICS.join(", ")}.`);
  }

  if (options.country !== undefined && !options.country.trim()) {
    throw new Error("Invalid 'country': must be a non-empty string when provided.");
  }

  for (const [label, domains] of [
    ["include_domains", options.includeDomains],
    ["exclude_domains", options.excludeDomains],
  ] as const) {
    for (const domain of domains ?? []) {
      const problem = domainProblem(domain);
      if (problem) throw new Error(`Invalid '${label}': ${problem}.`);
    }
  }
}

/** Validate and normalize a URL for the extract endpoint. */
export function validateUrl(input: string): string {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL "${input}": expected an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid URL "${input}": only http:// and https:// URLs can be extracted.`,
    );
  }
  return url.toString();
}

export function validateExtractOptions(options: ExtractOptions): void {
  if (!Array.isArray(options.urls) || options.urls.length === 0) {
    throw new Error("Invalid 'urls': provide at least one URL to extract.");
  }
  if (options.urls.length > MAX_MAX_RESULTS) {
    throw new Error(
      `Invalid 'urls': at most ${MAX_MAX_RESULTS} URLs per request (received ${options.urls.length}).`,
    );
  }
  for (const url of options.urls) validateUrl(url);

  if (
    options.extractDepth !== undefined &&
    !EXTRACT_DEPTHS.includes(options.extractDepth)
  ) {
    throw new Error(
      `Invalid 'extract_depth': expected one of ${EXTRACT_DEPTHS.join(", ")}.`,
    );
  }
}

// =============================================================================
// Request bodies
// =============================================================================

export function buildSearchBody(options: SearchOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: options.query.trim(),
    search_depth: options.searchDepth ?? "basic",
    topic: options.topic ?? "general",
    max_results: options.maxResults ?? DEFAULT_MAX_RESULTS,
    include_answer: options.includeAnswer ?? false,
    include_raw_content: options.includeRawContent ?? false,
  };

  const include = dedupe((options.includeDomains ?? []).map(normalizeDomain));
  const exclude = dedupe((options.excludeDomains ?? []).map(normalizeDomain));
  if (include.length > 0) body.include_domains = include;
  if (exclude.length > 0) body.exclude_domains = exclude;

  if (options.days !== undefined) body.days = options.days;
  if (options.country?.trim()) body.country = options.country.trim();

  return body;
}

export function buildExtractBody(options: ExtractOptions): Record<string, unknown> {
  return {
    urls: dedupe(options.urls.map(validateUrl)),
    extract_depth: options.extractDepth ?? "basic",
    include_images: options.includeImages ?? false,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

// =============================================================================
// HTTP client
// =============================================================================

export async function tavilyRequest<T>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const failure = (error: unknown): TavilyError => {
    if (options.signal?.aborted) {
      return new TavilyError("Search cancelled.", "aborted");
    }
    if (timedOut) {
      const label =
        timeoutMs >= 1_000
          ? `${Math.round(timeoutMs / 1_000)}s`
          : `${timeoutMs}ms`;
      return new TavilyError(`Tavily API timed out after ${label}.`, "timeout");
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new TavilyError(
      `Could not reach Tavily (${detail}). Check network connectivity and retry.`,
      "network",
    );
  };

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw failure(error);
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      throw failure(error);
    }

    let payload: unknown = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = rawBody;
      }
    }

    if (!response.ok) {
      throw new TavilyError(
        formatHttpError(response.status, payload),
        mapStatus(response.status),
        response.status,
        payload,
      );
    }

    if (payload === null || typeof payload !== "object") {
      throw new TavilyError(
        "Tavily returned an unreadable response (expected JSON).",
        "api",
        response.status,
        payload,
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function mapStatus(status: number): TavilyErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 432 || status === 433) return "rate_limit";
  return "api";
}

function formatHttpError(status: number, payload: unknown): string {
  const detail = extractErrorMessage(payload);
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
}

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  const detail = obj.detail;

  if (typeof detail === "string") return detail.trim() || null;
  if (detail && typeof detail === "object") {
    const inner = detail as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof inner[key] === "string" && inner[key]) return inner[key] as string;
    }
    try {
      return JSON.stringify(detail);
    } catch {
      return null;
    }
  }

  for (const key of ["error", "message"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
  }
  return null;
}

// =============================================================================
// Response parsing
// =============================================================================

export function parseSearchResponse(payload: unknown): SearchResponse {
  if (!payload || typeof payload !== "object") {
    throw new TavilyError("Tavily search response is not an object.", "api");
  }

  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.results)) {
    throw new TavilyError(
      "Tavily search response is missing a 'results' array.",
      "api",
    );
  }

  const results: SearchResultItem[] = [];
  for (const item of raw.results) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;
    results.push({
      title: typeof r.title === "string" ? r.title : "",
      url: r.url,
      content: typeof r.content === "string" ? r.content : "",
      score: typeof r.score === "number" ? r.score : 0,
      rawContent:
        typeof r.raw_content === "string" || r.raw_content === null
          ? (r.raw_content as string | null)
          : undefined,
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
    throw new TavilyError("Tavily extract response is not an object.", "api");
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
      rawContent: typeof r.raw_content === "string" ? r.raw_content : "",
      images: Array.isArray(r.images)
        ? r.images.filter((v): v is string => typeof v === "string")
        : undefined,
    });
  }

  const failedResults: ExtractFailure[] = [];
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
// High-level API calls
// =============================================================================

export async function tavilySearch(
  apiKey: string,
  options: SearchOptions,
  requestOptions: RequestOptions = {},
): Promise<SearchResponse> {
  validateSearchOptions(options);
  const payload = await tavilyRequest<unknown>(
    TAVILY_SEARCH_URL,
    apiKey,
    buildSearchBody(options),
    requestOptions,
  );
  return parseSearchResponse(payload);
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
// Formatting (model-facing text)
// =============================================================================

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n… [truncated]`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render search results as compact plain text for the model. */
export function formatSearchResponse(
  response: SearchResponse,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  if (response.results.length === 0) {
    const query = response.query || "(query)";
    return (
      `No results for "${query}". Try broader keywords, a different topic ` +
      `(general/news/finance), or remove include_domains/exclude_domains filters.`
    );
  }

  const lines: string[] = [];
  if (response.answer) {
    lines.push(`Answer: ${oneLine(response.answer)}`, "");
  }

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
    lines.push(`   URL: ${result.url}`);
    if (result.score) lines.push(`   Score: ${result.score.toFixed(3)}`);
    if (result.content) lines.push(`   ${oneLine(result.content)}`);
    if (result.rawContent) {
      lines.push(`   Raw content: ${truncate(oneLine(result.rawContent), 1_500)}`);
    }
    lines.push("");
  });

  return truncate(lines.join("\n").trimEnd(), maxChars);
}

/** Render extracted page content as plain text for the model. */
export function formatExtractResponse(
  response: ExtractResponse,
  options: { maxChars?: number; perUrlChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_EXTRACT_CHARS;
  const perUrlChars = options.perUrlChars ?? DEFAULT_PER_URL_CHARS;

  if (response.results.length === 0 && response.failedResults.length === 0) {
    return "Tavily returned no extracted content. The pages may be empty or blocked.";
  }

  const lines: string[] = [];

  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || result.url}`);
    lines.push(`   URL: ${result.url}`);
    lines.push("");
    if (result.rawContent) {
      lines.push(truncate(result.rawContent, perUrlChars));
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

  return truncate(lines.join("\n").trimEnd(), maxChars);
}

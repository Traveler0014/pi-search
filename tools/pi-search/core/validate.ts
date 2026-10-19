/**
 * Input validation shared by the extension entry point and adapters.
 *
 * Tool inputs are validated strictly at the boundary: invalid input throws so
 * the model gets a corrective message instead of a silently wrong request.
 * Limits come from the provider, because they differ per backend (query length,
 * result count).
 */

import {
  DETAIL_LEVELS,
  MAX_MAX_RESULTS,
  RECENCY_RANGES,
  type Detail,
  type ExtractOptions,
  type ProviderLimits,
  type SearchOptions,
} from "./types.js";

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

export function normalizeLanguage(input: string): string {
  return input.trim().replace(/_/g, "-");
}

export function validateSearchOptions(
  options: SearchOptions,
  limits: ProviderLimits,
): void {
  const query = options.query?.trim() ?? "";
  if (!query) throw new Error("Invalid 'query': must be a non-empty string.");
  if (query.length > limits.maxQueryChars) {
    throw new Error(
      `Invalid 'query': ${query.length} characters exceeds the ${limits.maxQueryChars}-character limit of this provider.`,
    );
  }

  if (
    !Number.isInteger(options.maxResults) ||
    options.maxResults < 1 ||
    options.maxResults > MAX_MAX_RESULTS
  ) {
    throw new Error(
      `Invalid 'max_results': expected an integer between 1 and ${MAX_MAX_RESULTS} (received ${options.maxResults}).`,
    );
  }

  if (!DETAIL_LEVELS.includes(options.detail)) {
    throw new Error(
      `Invalid 'detail': expected one of ${DETAIL_LEVELS.join(", ")}.`,
    );
  }

  if (options.recency !== undefined && !RECENCY_RANGES.includes(options.recency)) {
    throw new Error(
      `Invalid 'recency': expected one of ${RECENCY_RANGES.join(", ")}.`,
    );
  }

  if (options.language !== undefined) {
    if (!options.language.trim()) {
      throw new Error("Invalid 'language': must be a non-empty string when provided.");
    }
    if (!/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(normalizeLanguage(options.language))) {
      throw new Error(
        `Invalid 'language': expected an ISO 639-1 code such as "en" or "zh" (received "${options.language}").`,
      );
    }
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
}

/**
 * Apply a provider's hard limits to an already-validated request.
 *
 * Returns the adjusted options plus a warning per adjustment, so the model sees
 * that its request was trimmed instead of silently getting fewer results.
 */
export function clampToLimits(
  options: SearchOptions,
  limits: ProviderLimits,
  label: string,
): { options: SearchOptions; warnings: string[] } {
  const warnings: string[] = [];
  if (options.maxResults > limits.maxResults) {
    warnings.push(
      `max_results clamped to ${limits.maxResults} by ${label} (requested ${options.maxResults})`,
    );
    return { options: { ...options, maxResults: limits.maxResults }, warnings };
  }
  return { options, warnings };
}

/** Coerce a provider-reported tier to the closest one it could deliver. */
export function resolveDetail(requested: Detail, supported: readonly Detail[]): Detail {
  if (supported.includes(requested)) return requested;
  return requested === "content" && supported.includes("summary") ? "summary" : supported[0];
}

/** Drop empty values and duplicates while preserving order. */
export function dedupeValues(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

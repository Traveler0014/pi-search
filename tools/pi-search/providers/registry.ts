/**
 * Provider registry — the single source of truth for which backends exist.
 *
 * `PROVIDER_IDS` is derived from `PROVIDERS` so the tool's `provider` enum can
 * never drift from the adapter list. Adding a provider is one import + one
 * array entry (plus widening `ProviderId`, which the compiler enforces).
 *
 * `runSearch`/`runExtract` are the only way the extension reaches a backend, so
 * cross-provider policy (limit clamping, detail degradation, score levels)
 * lives in exactly one place.
 */

import { resolveApiKey, type SearchConfig } from "../core/config.js";
import { finalizeSearchResponse } from "../core/score.js";
import { countDuplicates, dedupeResults } from "../core/results.js";
import type {
  ExtractOptions,
  ExtractResponse,
  RequestOptions,
  SearchOptions,
  SearchResponse,
} from "../core/types.js";
import { clampToLimits, resolveDetail } from "../core/validate.js";
import type { SearchProvider } from "./types.js";
import { deepseekProvider } from "./deepseek.js";
import { tavilyProvider } from "./tavily.js";

/** Every registered backend, in display order. */
export const PROVIDERS: readonly SearchProvider[] = [tavilyProvider, deepseekProvider];

/**
 * Ids for `StringEnum`. Derived, not duplicated: a new adapter shows up in the
 * schema automatically.
 */
export const PROVIDER_IDS: readonly SearchProvider["id"][] = PROVIDERS.map(
  (p) => p.id,
);

/** Look up a provider by id; unknown ids are a caller error. */
export function getProvider(id: string): SearchProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ResolvedProvider {
  provider: SearchProvider;
  /** True when the caller named it explicitly rather than inheriting the default. */
  explicit: boolean;
}

/**
 * Resolve the provider for a call.
 *
 * NOTE (migration in progress): until the multi-provider config lands, the
 * default is the first registered provider. Afterwards it comes from
 * `config.defaultProvider`.
 */
export function resolveProvider(id?: string): ResolvedProvider {
  if (id === undefined || id === "") {
    return { provider: PROVIDERS[0], explicit: false };
  }
  const provider = getProvider(id);
  if (!provider) {
    throw new Error(
      `Unknown provider "${id}". Available providers: ${PROVIDER_IDS.join(", ")}.`,
    );
  }
  return { provider, explicit: true };
}

export interface ProviderSelection {
  provider: SearchProvider;
  /** True when the caller named it explicitly rather than inheriting the default. */
  explicit: boolean;
  /**
   * Set when the call is *not* using the configured default, with the reason.
   * Surfaced as a warning so a misconfigured default is discoverable instead of
   * silently changing which backend answers every call.
   */
  note?: string;
}

/**
 * Choose the backend for a call.
 *
 * An explicit `provider` always wins: when its key is missing the caller gets
 * the actionable "not configured" error instead of a silent switch to another
 * backend. Otherwise the configured default is honored **only when it has a
 * key** — a stale default (renamed backend, never-set or removed key) would
 * otherwise fail every call. When no backend has a key at all the default is
 * kept, so the error names the backend the user meant to configure.
 */
export function selectProvider(
  id: string | undefined,
  config: SearchConfig,
): ProviderSelection {
  const wanted = id ?? config.defaultProvider;
  // Unknown ids fall back instead of throwing: a config naming a removed
  // backend must not break every call.
  const preferred = wanted ? getProvider(wanted) : undefined;

  if (id && preferred) return { provider: preferred, explicit: true };
  if (preferred && resolveApiKey(preferred, config)) {
    return { provider: preferred, explicit: false };
  }

  const configured = PROVIDERS.find((p) => resolveApiKey(p, config) !== null);
  if (configured) {
    const note =
      wanted && wanted !== configured.id
        ? preferred
          ? `default provider ${preferred.label} has no API key; using ${configured.label} — run /search-provider ${configured.id} to make it the default`
          : `default provider "${wanted}" is not a known backend; using ${configured.label} — run /search-provider ${configured.id} to make it the default`
        : undefined;
    return { provider: configured, explicit: false, ...(note ? { note } : {}) };
  }

  return { provider: preferred ?? PROVIDERS[0], explicit: false };
}

/**
 * Run a search, applying provider limits, detail degradation, and quality
 * levels.
 */
export async function runSearch(
  provider: SearchProvider,
  apiKey: string,
  input: SearchOptions,
  request?: RequestOptions,
): Promise<SearchResponse> {
  const warnings: string[] = [];
  const { options, warnings: limitWarnings } = clampToLimits(
    input,
    provider.limits,
    provider.label,
  );
  warnings.push(...limitWarnings);

  let detail = options.detail;
  if (!provider.details.includes(detail)) {
    detail = resolveDetail(detail, provider.details);
    warnings.push(
      `detail "${options.detail}" is not supported by ${provider.label}; using "${detail}"`,
    );
  }

  const response = await provider.search(
    apiKey,
    { ...options, detail },
    request,
  );

  // Backends repeat pages; drop duplicates before they reach the renderer so
  // the model never pays for the same text twice, and say so when it happens.
  const duplicates = countDuplicates(response.results);
  if (duplicates > 0) {
    warnings.push(
      `${duplicates} duplicate result${duplicates === 1 ? "" : "s"} removed`,
    );
  }
  const deduped = { ...response, results: dedupeResults(response.results) };

  const finalized = finalizeSearchResponse(deduped, provider.scores);
  return {
    ...finalized,
    warnings: [...warnings, ...(response.warnings ?? [])],
  };
}

/** Run an extraction; adapters already report per-URL failures. */
export async function runExtract(
  provider: SearchProvider,
  apiKey: string,
  options: ExtractOptions,
  request?: RequestOptions,
): Promise<ExtractResponse> {
  return provider.extract(apiKey, options, request);
}

/**
 * The contract every search backend implements.
 *
 * Adapters own everything provider-specific: endpoints, request bodies,
 * response parsing, key shape, limits, native options, and error prose. They
 * must not touch the pi extension API — registration and TUI live in `index.ts`.
 */

import type { NativeOptionsSpec } from "../core/provider-options.js";
import type {
  Detail,
  ExtractOptions,
  ExtractResponse,
  ProviderLimits,
  RequestOptions,
  ScoreCutoffs,
  SearchOptions,
  SearchResponse,
} from "../core/types.js";

/**
 * Provider identifiers. Adding a provider means: add its adapter module, add
 * it to `PROVIDERS` in `registry.ts`, and widen this union (the compiler
 * catches a missing union member).
 */
export type ProviderId = "tavily" | "deepseek";

export interface SearchProvider {
  /** Stable id used in the `provider` tool parameter and in config. */
  readonly id: ProviderId;
  /** Human-readable name used in messages and TUI. */
  readonly label: string;
  /** Environment variables checked for the API key, in priority order. */
  readonly apiKeyEnv: readonly string[];
  /** Boundaries that turn the normalized score into a quality level. */
  readonly scores: ScoreCutoffs;
  /** Hard limits applied before a request is built. */
  readonly limits: ProviderLimits;
  /** Detail tiers this backend can actually deliver. */
  readonly details: readonly Detail[];
  /** Whitelist for `provider_options` on search calls. */
  readonly searchOptions: NativeOptionsSpec;
  /** Whitelist for `provider_options` on extract calls. */
  readonly extractOptions: NativeOptionsSpec;
  /** Best-effort key shape check; never a hard gate. */
  looksLikeKey(key: string): boolean;

  search(
    apiKey: string,
    options: SearchOptions,
    request?: RequestOptions,
  ): Promise<SearchResponse>;

  extract(
    apiKey: string,
    options: ExtractOptions,
    request?: RequestOptions,
  ): Promise<ExtractResponse>;
}

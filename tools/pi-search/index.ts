/**
 * pi-search — web search and page extraction for the pi coding agent.
 *
 * Tools (agent-facing, snake_case):
 *   - search_web      Search the web, returning ranked results + text
 *   - search_extract  Extract the full readable content of one or more URLs
 *
 * Commands (user-facing, kebab-case):
 *   - /search <query>            Quick raw search, results in a notification
 *   - /search-config             Settings menu: provider keys, default backend
 *   - /search-test [live]        Self-check per backend (live = one real call)
 *
 * The tool schema is defined by capabilities, not providers: `provider` is an
 * enum derived from the registry, and backend-native knobs travel in
 * `provider_options`, so adding a backend never grows the model-facing surface.
 *
 * Key resolution per provider: <PROVIDER>_API_KEY env var > stored key.
 * Config: ~/.pi/agent/pi-search.json (v2, multi-provider)
 *
 * Layout:
 *   core/       provider-agnostic types, transport, config, scoring, formatting
 *   providers/  one adapter per backend + the registry
 *   ui/         the interactive settings menu
 *   index.ts     registration glue only (tools, commands, TUI)
 *
 * Testing:
 *   pi -ne -e ./tools/pi-search/index.ts -p 'list tools'
 *   pi -e ./tools/pi-search/index.ts
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CONFIG_FILE,
  loadConfig,
  maskApiKey,
  resolveApiKey,
  type ResolvedApiKey,
  type SearchConfig,
} from "./core/config.js";
import { formatExtractResponse, formatSearchResponse } from "./core/format.js";
import { describeNativeOptions } from "./core/provider-options.js";
import {
  removeProviderKey,
  saveDefaultProvider,
  saveProviderKey,
} from "./core/settings.js";
import {
  DEFAULT_DETAIL,
  DEFAULT_MAX_RESULTS,
  DETAIL_LEVELS,
  MAX_MAX_RESULTS,
  ProviderError,
  RECENCY_RANGES,
  type ExtractOptions,
  type SearchOptions,
} from "./core/types.js";
import {
  PROVIDER_IDS,
  PROVIDERS,
  runExtract,
  runSearch,
  selectProvider,
} from "./providers/registry.js";
import type { SearchProvider } from "./providers/types.js";
import {
  buildSettingsMenu,
  runMenu,
  settingsSummary,
} from "./ui/config-menu.js";

// =============================================================================
// Helpers
// =============================================================================

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

/** The provider a call resolves to: explicit id, else the configured default. */
function providerFor(id: string | undefined, config: SearchConfig) {
  return selectProvider(id, config);
}

/** The provider an unqualified call actually uses (see `selectProvider`). */
function defaultProviderId(config: SearchConfig): string {
  return providerFor(undefined, config).provider.id;
}

/**
 * First non-empty line of a tool result.
 *
 * Error results carry only `content` (their `details` are `{}`), so the TUI has
 * to show the message itself instead of inventing a summary from the details.
 */
function firstLine(content: readonly { type: string; text?: string }[]): string {
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const line = block.text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find(Boolean);
    if (line) return line.length > 140 ? `${line.slice(0, 137)}…` : line;
  }
  return "";
}

/** Merge the "not the configured default" explanation into a response. */
function withNote<T extends { warnings?: string[] }>(response: T, note?: string): T {
  if (!note) return response;
  return { ...response, warnings: [...(response.warnings ?? []), note] };
}

function keyFor(
  provider: SearchProvider,
  config: SearchConfig,
): ResolvedApiKey | null {
  return resolveApiKey(provider, config);
}

function requireApiKey(provider: SearchProvider, config: SearchConfig): string {
  const resolved = keyFor(provider, config);
  if (!resolved) {
    throw new Error(
      `${provider.label} API key not configured. Open /search-config, or set ${provider.apiKeyEnv[0]}.`,
    );
  }
  return resolved.apiKey;
}

function keySourceLabel(provider: SearchProvider, resolved: ResolvedApiKey): string {
  return resolved.source === "env" ? provider.apiKeyEnv[0] : CONFIG_FILE;
}

function errorMessage(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
const PROVIDER_PARAM_DESCRIPTION =
  "Search backend to use. Omit to use the configured default provider";

const PROVIDER_OPTIONS_PARAM_DESCRIPTION =
  "Backend-native options as a flat object (e.g. Tavily's search_depth or topic). " +
  "Unknown keys are rejected with the list of accepted keys for the selected backend.";

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── Tool: search_web ────────────────────────────────────────────────────
  pi.registerTool({
    name: "search_web",
    label: "Web Search",

    description:
      `Search the web through a search backend and return ranked results with titles, URLs, and text. Use for current events, facts that may have changed, or when the user explicitly asks to search/look something up online. Supports recency windows, domain filters, language preference, and three levels of per-result text.`,

    promptSnippet:
      "Search the web for current information via search_web(query, provider?, recency?, detail?, max_results?)",

    promptGuidelines: [
      "Use search_web when the user asks about current events, recent releases, prices, or any fact that may have changed after the model's training cutoff.",
      "Use search_extract when a search_web result is insufficient and the full page content is needed.",
    ],

    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query (natural language; the per-backend character limit is enforced, Tavily allows 400 and DeepSeek 128)",
      }),
      provider: Type.Optional(
        StringEnum(PROVIDER_IDS, { description: PROVIDER_PARAM_DESCRIPTION }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: MAX_MAX_RESULTS,
          default: DEFAULT_MAX_RESULTS,
          description: `Number of results to return, 1-${MAX_MAX_RESULTS} (default ${DEFAULT_MAX_RESULTS})`,
        }),
      ),
      recency: Type.Optional(
        StringEnum(RECENCY_RANGES, {
          description:
            "Only return results published within this window (omit for no time filter)",
        }),
      ),
      include_domains: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Only return results from these domains, e.g. ['arxiv.org', 'github.com']",
        }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Exclude results from these domains, e.g. ['pinterest.com']",
        }),
      ),
      detail: Type.Optional(
        StringEnum(DETAIL_LEVELS, {
          default: DEFAULT_DETAIL,
          description:
            "How much text per result: 'summary' (default, ~600-800 chars), 'snippet' (short, cheapest), 'content' (full page text, larger output)",
        }),
      ),
      language: Type.Optional(
        Type.String({
          description: "Prefer results in this language (ISO 639-1, e.g. 'en', 'zh')",
        }),
      ),
      provider_options: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: PROVIDER_OPTIONS_PARAM_DESCRIPTION,
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const config = loadConfig();
      const { provider, note } = providerFor(params.provider, config);
      const apiKey = requireApiKey(provider, config);

      const options: SearchOptions = {
        query: params.query,
        maxResults: params.max_results ?? DEFAULT_MAX_RESULTS,
        detail: params.detail ?? DEFAULT_DETAIL,
        recency: params.recency,
        includeDomains: params.include_domains,
        excludeDomains: params.exclude_domains,
        language: params.language,
        // `additionalProperties: true` widens to `object` in TypeBox; the
        // adapter validates every key against its own whitelist anyway.
        options: params.provider_options as Record<string, unknown> | undefined,
      };

      const response = withNote(
        await runSearch(provider, apiKey, options, { signal }),
        note,
      );

      return textResult(formatSearchResponse(response), {
        provider: provider.id,
        query: response.query,
        count: response.results.length,
        answer: response.answer,
        responseTime: response.responseTime,
        requestId: response.requestId,
        warnings: response.warnings ?? [],
        results: response.results.map((r) => ({
          title: r.title,
          url: r.url,
          kind: r.kind,
          score: r.score,
          rawScore: r.rawScore,
          quality: r.quality,
          publishedAt: r.publishedAt,
          flags: r.flags,
          chars: r.text.length,
        })),
      });
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("search_web")) +
        " " +
        theme.fg("accent", `"${args.query ?? ""}"`);
      const meta = [
        args.provider ?? null,
        args.detail && args.detail !== DEFAULT_DETAIL ? args.detail : null,
        args.recency ?? null,
        // `max N` is the requested cap, not the number of results — a bare
        // "N results" made an empty answer look like a ten-hit answer.
        `max ${args.max_results ?? DEFAULT_MAX_RESULTS}`,
      ].filter(Boolean);
      text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, context) {
      const details = result.details as
        | {
            provider?: string;
            count?: number;
            responseTime?: number;
            warnings?: string[];
          }
        | undefined;

      // A thrown failure (missing key, HTTP error) has empty `details`, which
      // used to fall through to "No results" — the search never ran, so show
      // what actually went wrong.
      if (context.isError) {
        return new Text(
          theme.fg("error", firstLine(result.content) || "Search failed"),
          0,
          0,
        );
      }

      const count = details?.count ?? 0;
      const warnings = details?.warnings?.length ?? 0;

      if (count === 0) {
        return new Text(theme.fg("warning", "No results"), 0, 0);
      }

      const via = details?.provider ? theme.fg("dim", ` · ${details.provider}`) : "";
      const time =
        typeof details?.responseTime === "number" && details.responseTime > 0
          ? theme.fg("dim", ` · ${details.responseTime.toFixed(2)}s`)
          : "";
      const note = warnings > 0 ? theme.fg("dim", ` · ${warnings} note(s)`) : "";
      const noun = count === 1 ? "result" : "results";
      return new Text(
        theme.fg("success", `${count} ${noun}`) + via + time + note,
        0,
        0,
      );
    },
  });

  // ── Tool: search_extract ────────────────────────────────────────────────
  pi.registerTool({
    name: "search_extract",
    label: "Extract Page Content",

    description:
      `Extract the full readable content of one or more web pages through a search backend. Use after search_web when the result text is insufficient, or when the user provides URLs and asks to read/summarize them.`,

    promptSnippet: "Extract full page text from URLs via search_extract(urls, provider?)",

    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MAX_MAX_RESULTS,
        description: `Absolute http(s) URLs to extract (1-${MAX_MAX_RESULTS})`,
      }),
      provider: Type.Optional(
        StringEnum(PROVIDER_IDS, { description: PROVIDER_PARAM_DESCRIPTION }),
      ),
      provider_options: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: PROVIDER_OPTIONS_PARAM_DESCRIPTION,
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const config = loadConfig();
      const { provider, note } = providerFor(params.provider, config);
      const apiKey = requireApiKey(provider, config);

      const options: ExtractOptions = {
        urls: params.urls,
        options: params.provider_options as Record<string, unknown> | undefined,
      };

      const response = withNote(
        await runExtract(provider, apiKey, options, { signal }),
        note,
      );

      return textResult(formatExtractResponse(response), {
        provider: provider.id,
        count: response.results.length,
        failedCount: response.failedResults.length,
        responseTime: response.responseTime,
        warnings: response.warnings ?? [],
        results: response.results.map((r) => ({
          url: r.url,
          title: r.title,
          chars: r.text.length,
        })),
        failed: response.failedResults,
      });
    },

    renderCall(args, theme) {
      const urls = Array.isArray(args.urls) ? args.urls : [];
      const first = urls[0] ?? "";
      const more = urls.length > 1 ? ` +${urls.length - 1}` : "";
      let text =
        theme.fg("toolTitle", theme.bold("search_extract")) +
        " " +
        theme.fg("accent", first) +
        (more ? theme.fg("dim", more) : "");
      if (args.provider) text += " " + theme.fg("dim", `(${args.provider})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, context) {
      const details = result.details as
        | { count?: number; failedCount?: number; provider?: string }
        | undefined;

      // Same trap as search_web: an error result carries no `details`, so
      // without this branch a failed call rendered as a success-coloured
      // "0 pages".
      if (context.isError) {
        return new Text(
          theme.fg("error", firstLine(result.content) || "Extraction failed"),
          0,
          0,
        );
      }

      const count = details?.count ?? 0;
      const failed = details?.failedCount ?? 0;

      if (count === 0 && failed > 0) {
        return new Text(
          theme.fg("error", `All ${failed} extraction(s) failed`),
          0,
          0,
        );
      }

      let text = theme.fg("success", `${count} page${count === 1 ? "" : "s"}`);
      if (failed > 0) text += theme.fg("warning", ` · ${failed} failed`);
      if (details?.provider) text += theme.fg("dim", ` · ${details.provider}`);
      return new Text(text, 0, 0);
    },
  });

  // ── Command: /search ────────────────────────────────────────────────────
  pi.registerCommand("search", {
    description: "Quick web search — /search <query>",
    async handler(args, ctx) {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /search <query>", "warning");
        return;
      }

      const config = loadConfig();
      const { provider } = providerFor(undefined, config);
      const resolved = keyFor(provider, config);
      if (!resolved) {
        ctx.ui.notify(
          `No ${provider.label} API key configured. Open /search-config, or set ${provider.apiKeyEnv[0]}.`,
          "error",
        );
        return;
      }

      try {
        const response = await runSearch(provider, resolved.apiKey, {
          query,
          maxResults: 5,
          detail: "snippet",
        });

        if (response.results.length === 0) {
          ctx.ui.notify(`No results for "${query}". Try broader keywords.`, "warning");
          return;
        }

        const lines = response.results.map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}`,
        );
        ctx.ui.notify(
          `${lines.join("\n")}\n\n(Ask the agent to "search for ..." for a synthesized answer.)`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  // ── Command: /search-config ─────────────────────────────────────────────
  //
  // The one place settings are managed. It replaced `/search-key` and
  // `/search-provider`: two commands with overlapping argument grammars for the
  // same two values, one of which (`/search-key <key>` guessing the backend from
  // the key shape) nobody could remember. It grows by adding an entry in
  // `ui/config-menu.ts`, not by adding another command.
  pi.registerCommand("search-config", {
    description: "Open the settings menu (provider keys, default backend)",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        // No dialogs available (RPC/CI): print the same state the menu shows.
        ctx.ui.notify(
          settingsSummary(loadConfig(), PROVIDERS, CONFIG_FILE),
          "info",
        );
        return;
      }

      await runMenu(
        buildSettingsMenu({
          providers: PROVIDERS,
          config: loadConfig,
          configPath: CONFIG_FILE,
          saveKey: async (provider, key) => {
            await saveProviderKey(provider.id, key);
          },
          clearKey: async (provider) => {
            await removeProviderKey(provider.id);
          },
          setDefault: async (provider) => {
            await saveDefaultProvider(provider?.id);
          },
        }),
        ctx.ui,
      );
    },
  });

  // ── Command: /search-test ───────────────────────────────────────────────
  pi.registerCommand("search-test", {
    description: "Self-check every backend, optionally with one live call each",
    async handler(args, ctx) {
      const live = /\blive\b/i.test(args);
      const config = loadConfig();
      const current = defaultProviderId(config);
      let failed = 0;
      let configured = 0;

      for (const provider of PROVIDERS) {
        const resolved = keyFor(provider, config);
        const isDefault = provider.id === current ? " (default)" : "";

        if (!resolved) {
          ctx.ui.notify(
            `• ${provider.id}${isDefault}: not configured (optional) — /search-config, or ${provider.apiKeyEnv[0]}`,
            "info",
          );
          continue;
        }

        configured++;
        ctx.ui.notify(
          `✓ ${provider.id}${isDefault}: ${maskApiKey(resolved.apiKey)} via ${keySourceLabel(provider, resolved)}`,
          "info",
        );
        if (!provider.looksLikeKey(resolved.apiKey)) {
          ctx.ui.notify(
            `⚠ ${provider.id}: key format does not look like a ${provider.label} key (continuing anyway)`,
            "warning",
          );
        }
        ctx.ui.notify(
          `• ${provider.id} limits: query ≤${provider.limits.maxQueryChars} chars, ≤${provider.limits.maxResults} results\n` +
            `• ${provider.id} provider_options: ${describeNativeOptions(provider.searchOptions) || "(none)"}`,
          "info",
        );
      }

      if (configured === 0) {
        failed++;
        ctx.ui.notify(
          "✗ No provider is configured — nothing to test.",
          "error",
        );
      }

      if (live && configured > 0) {
        for (const provider of PROVIDERS) {
          const resolved = keyFor(provider, config);
          if (!resolved) continue;
          try {
            const started = Date.now();
            const response = await runSearch(provider, resolved.apiKey, {
              query: "API connectivity check",
              maxResults: 1,
              detail: "snippet",
            });
            ctx.ui.notify(
              `✓ ${provider.id} live: ${response.results.length} result in ${(
                (Date.now() - started) / 1000
              ).toFixed(2)}s`,
              "info",
            );
          } catch (error) {
            failed++;
            ctx.ui.notify(`✗ ${provider.id} live: ${errorMessage(error)}`, "error");
          }
        }
      } else if (configured > 0) {
        ctx.ui.notify(
          "• Live search: skipped (run /search-test live to spend one request per configured backend)",
          "info",
        );
      }

      ctx.ui.notify(
        failed === 0
          ? `pi-search: all checks passed (${configured} provider${configured === 1 ? "" : "s"} configured)`
          : `pi-search: ${failed} check(s) failed`,
        failed === 0 ? "info" : "warning",
      );
    },
  });
}

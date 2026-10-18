/**
 * pi-search — Tavily-backed web search for the pi coding agent.
 *
 * Tools (agent-facing, snake_case):
 *   - search_web      Search the web, returning ranked snippets + URLs
 *   - search_extract  Extract the full readable content of one or more URLs
 *
 * Commands (user-facing, kebab-case):
 *   - /search <query>     Quick raw search, results shown in a notification
 *   - /search-key [key]   Set / show / clear the Tavily API key
 *   - /search-test [live] Runtime self-check (add "live" for one real request)
 *
 * API key resolution: TAVILY_API_KEY env var > ~/.pi/agent/pi-search.json
 *
 * Testing:
 *   pi -ne -e ./tools/pi-search/index.ts -p 'list tools'
 *   pi -e ./tools/pi-search/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CONFIG_FILE,
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  TavilyError,
  formatExtractResponse,
  formatSearchResponse,
  isValidApiKey,
  maskApiKey,
  resolveApiKey,
  saveConfig,
  tavilyExtract,
  tavilySearch,
  type ExtractOptions,
  type SearchOptions,
} from "./lib.js";

// =============================================================================
// Helpers
// =============================================================================

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

function requireApiKey(): string {
  const resolved = resolveApiKey();
  if (!resolved) {
    throw new Error(
      "Tavily API key not configured. Run /search-key <key> or set TAVILY_API_KEY.",
    );
  }
  return resolved.apiKey;
}

function errorMessage(error: unknown): string {
  if (error instanceof TavilyError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── Tool: search_web ────────────────────────────────────────────────────
  pi.registerTool({
    name: "search_web",
    label: "Web Search",

    description:
      `Search the web through Tavily and return ranked results with titles, URLs, and content snippets. Use for current events, facts that may have changed, or when the user explicitly asks to search/look something up online. Supports general, news, and finance topics plus domain filters.`,

    promptSnippet:
      "Search the web for current information via search_web(query, topic?, max_results?)",

    promptGuidelines: [
      "Use search_web when the user asks about current events, recent releases, prices, or any fact that may have changed after the model's training cutoff.",
      "Use search_extract when a search_web snippet is insufficient and the full page content is needed.",
    ],

    parameters: Type.Object({
      query: Type.String({
        description: "Search query (natural language, max 400 characters)",
      }),
      search_depth: Type.Optional(
        StringEnum(["basic", "advanced"] as const, {
          description:
            "Search effort: 'basic' is fast and cheap (default), 'advanced' retrieves more and costs more credits",
        }),
      ),
      topic: Type.Optional(
        StringEnum(["general", "news", "finance"] as const, {
          description:
            "Result category (default: general). Use 'news' for recent reporting and 'finance' for market data",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: MAX_MAX_RESULTS,
          default: DEFAULT_MAX_RESULTS,
          description: `Number of results to return, 1-${MAX_MAX_RESULTS} (default ${DEFAULT_MAX_RESULTS})`,
        }),
      ),
      include_answer: Type.Optional(
        Type.Boolean({
          description:
            "Include Tavily's short generated answer summary (default: false; costs extra credits)",
        }),
      ),
      include_raw_content: Type.Optional(
        Type.Boolean({
          description:
            "Include cleaned page text for each result (default: false; larger output)",
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
      days: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "For topic='news': only return results from the last N days",
        }),
      ),
      country: Type.Optional(
        Type.String({
          description:
            "Boost results from a country, for topic='general' (e.g. 'united states', 'germany')",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = requireApiKey();

      const options: SearchOptions = {
        query: params.query,
        searchDepth: params.search_depth,
        topic: params.topic,
        maxResults: params.max_results,
        includeAnswer: params.include_answer,
        includeRawContent: params.include_raw_content,
        includeDomains: params.include_domains,
        excludeDomains: params.exclude_domains,
        days: params.days,
        country: params.country,
      };

      const response = await tavilySearch(apiKey, options, { signal });

      return textResult(formatSearchResponse(response), {
        query: response.query,
        count: response.results.length,
        answer: response.answer,
        responseTime: response.responseTime,
        requestId: response.requestId,
        results: response.results.map((r) => ({
          title: r.title,
          url: r.url,
          score: r.score,
        })),
      });
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("search_web")) +
        " " +
        theme.fg("accent", `"${args.query ?? ""}"`);
      const meta = [
        args.topic && args.topic !== "general" ? args.topic : null,
        args.search_depth ?? "basic",
        `${args.max_results ?? DEFAULT_MAX_RESULTS} results`,
      ].filter(Boolean);
      text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | { count?: number; responseTime?: number }
        | undefined;
      const count = details?.count ?? 0;

      if (count === 0) {
        return new Text(theme.fg("warning", "No results"), 0, 0);
      }

      const time =
        typeof details?.responseTime === "number"
          ? theme.fg("dim", ` · ${details.responseTime.toFixed(2)}s`)
          : "";
      const noun = count === 1 ? "result" : "results";
      return new Text(
        theme.fg("success", `${count} ${noun}`) + time,
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
      `Extract the full readable content of one or more web pages through Tavily. Use after search_web when snippets are insufficient, or when the user provides URLs and asks to read/summarize them.`,

    promptSnippet:
      "Extract full page text from URLs via search_extract(urls, extract_depth?)",

    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MAX_MAX_RESULTS,
        description: `Absolute http(s) URLs to extract (1-${MAX_MAX_RESULTS})`,
      }),
      extract_depth: Type.Optional(
        StringEnum(["basic", "advanced"] as const, {
          description:
            "Extraction effort: 'basic' is fast (default), 'advanced' handles JS-heavy pages and costs more credits",
        }),
      ),
      include_images: Type.Optional(
        Type.Boolean({
          description: "Include image URLs found on the page (default: false)",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = requireApiKey();

      const options: ExtractOptions = {
        urls: params.urls,
        extractDepth: params.extract_depth,
        includeImages: params.include_images,
      };

      const response = await tavilyExtract(apiKey, options, { signal });

      return textResult(formatExtractResponse(response), {
        count: response.results.length,
        failedCount: response.failedResults.length,
        responseTime: response.responseTime,
        results: response.results.map((r) => ({
          url: r.url,
          title: r.title,
          chars: r.rawContent.length,
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
      text += " " + theme.fg("dim", `(${args.extract_depth ?? "basic"})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | { count?: number; failedCount?: number }
        | undefined;
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
      return new Text(text, 0, 0);
    },
  });

  // ── Command: /search ────────────────────────────────────────────────────
  pi.registerCommand("search", {
    description: "Quick web search via Tavily — /search <query>",
    async handler(args, ctx) {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /search <query>", "warning");
        return;
      }

      const resolved = resolveApiKey();
      if (!resolved) {
        ctx.ui.notify(
          "No Tavily API key configured. Run /search-key <key> or set TAVILY_API_KEY.",
          "error",
        );
        return;
      }

      try {
        const response = await tavilySearch(resolved.apiKey, {
          query,
          maxResults: 5,
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

  // ── Command: /search-key ────────────────────────────────────────────────
  pi.registerCommand("search-key", {
    description: "Set, show, or clear the Tavily API key",
    async handler(args, ctx) {
      const input = args.trim();

      if (input === "clear" || input === "remove") {
        saveConfig({ apiKey: "" });
        ctx.ui.notify(`Removed the stored Tavily API key (${CONFIG_FILE}).`, "info");
        return;
      }

      if (input) {
        if (!isValidApiKey(input)) {
          ctx.ui.notify(
            'Invalid key format: expected a Tavily key starting with "tvly-".',
            "error",
          );
          return;
        }
        saveConfig({ apiKey: input });
        const envOverride = process.env.TAVILY_API_KEY?.trim();
        const suffix = envOverride
          ? " Note: TAVILY_API_KEY is set and takes precedence over the stored key."
          : "";
        ctx.ui.notify(`Saved Tavily API key to ${CONFIG_FILE}.${suffix}`, "info");
        return;
      }

      const resolved = resolveApiKey();
      if (resolved) {
        const source =
          resolved.source === "env" ? "TAVILY_API_KEY" : CONFIG_FILE;
        ctx.ui.notify(
          `Tavily key: ${maskApiKey(resolved.apiKey)} (source: ${source}).\n` +
            "Use /search-key <key> to replace it or /search-key clear to remove it.",
          "info",
        );
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "No Tavily API key configured. Set TAVILY_API_KEY or run /search-key <key> interactively.",
          "warning",
        );
        return;
      }

      const key = await ctx.ui.input("Tavily API key", "tvly-...");
      if (key === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      const trimmed = key.trim();
      if (!isValidApiKey(trimmed)) {
        ctx.ui.notify(
          'Invalid key format: expected a Tavily key starting with "tvly-".',
          "error",
        );
        return;
      }
      saveConfig({ apiKey: trimmed });
      ctx.ui.notify(`Saved Tavily API key to ${CONFIG_FILE}.`, "info");
    },
  });

  // ── Command: /search-test ───────────────────────────────────────────────
  pi.registerCommand("search-test", {
    description: "Self-check: key/config plus an optional live API call",
    async handler(args, ctx) {
      const live = /\blive\b/i.test(args);
      let failed = 0;

      const resolved = resolveApiKey();
      if (resolved) {
        const source =
          resolved.source === "env" ? "TAVILY_API_KEY" : CONFIG_FILE;
        ctx.ui.notify(
          `✓ API key: ${maskApiKey(resolved.apiKey)} (source: ${source})`,
          "info",
        );
        ctx.ui.notify(
          isValidApiKey(resolved.apiKey)
            ? "✓ Key format: tvly-…"
            : "⚠ Key format: does not look like a Tavily key (continuing anyway)",
          "info",
        );
      } else {
        failed++;
        ctx.ui.notify(
          "✗ API key: not configured — run /search-key <key> or set TAVILY_API_KEY",
          "error",
        );
      }

      if (resolved && live) {
        try {
          const response = await tavilySearch(resolved.apiKey, {
            query: "Tavily API connectivity check",
            maxResults: 1,
            searchDepth: "basic",
          });
          ctx.ui.notify(
            `✓ Live search: ${response.results.length} result in ${response.responseTime.toFixed(2)}s`,
            "info",
          );
        } catch (error) {
          failed++;
          ctx.ui.notify(`✗ Live search: ${errorMessage(error)}`, "error");
        }
      } else if (resolved) {
        ctx.ui.notify(
          "• Live search: skipped (run /search-test live to spend 1 API credit)",
          "info",
        );
      }

      ctx.ui.notify(
        failed === 0
          ? "pi-search: all checks passed"
          : `pi-search: ${failed} check(s) failed`,
        failed === 0 ? "info" : "warning",
      );
    },
  });
}

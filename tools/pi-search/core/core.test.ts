/**
 * Unit tests for the provider-agnostic core: config, validation, transport,
 * provider options, and formatting.
 *
 * Run: npm test
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  configuredProviderIds,
  loadConfig,
  maskApiKey,
  resolveApiKey,
  saveConfig,
  withApiKey,
  withDefaultProvider,
} from "../core/config.js";
import {
  formatExtractResponse,
  formatSearchResponse,
  siteNameAddsInfo,
} from "../core/format.js";
import {
  defaultClassify,
  extractErrorMessage,
  postJson,
  type HttpProfile,
} from "../core/http.js";
import {
  describeNativeOptions,
  validateProviderOptions,
  type NativeOptionsSpec,
} from "../core/provider-options.js";
import {
  DETAIL_LEVELS,
  ProviderError,
  RECENCY_RANGES,
  type ProviderLimits,
  type SearchOptions,
} from "../core/types.js";
import {
  clampToLimits,
  normalizeDomain,
  normalizeLanguage,
  resolveDetail,
  validateExtractOptions,
  validateSearchOptions,
  validateUrl,
} from "../core/validate.js";
import {
  cleanupTmpDirs,
  hangingFetch,
  jsonResponse,
  mockFetch,
  tmpConfigFile,
} from "../support/test-helpers.js";

afterEach(cleanupTmpDirs);

/** A neutral profile so transport tests do not depend on provider prose. */
const testProfile: HttpProfile = {
  label: "TestAPI",
  classify: defaultClassify,
  describe: (status, detail) =>
    `TestAPI error (HTTP ${status}).${detail ? ` ${detail}` : ""}`,
};

const ENDPOINT = "https://api.example.com/search";
const LIMITS: ProviderLimits = { maxQueryChars: 400, maxResults: 20 };

// =============================================================================
// Config
// =============================================================================

describe("config", () => {
  it("points at pi's agent state directory", () => {
    expect(CONFIG_FILE.endsWith("pi-search.json")).toBe(true);
  });

  it("returns an empty v2 config when the file is missing", () => {
    expect(loadConfig(tmpConfigFile())).toEqual({ version: 2, providers: {} });
  });

  it("round-trips a stored key", () => {
    const file = tmpConfigFile();
    saveConfig(withApiKey(loadConfig(file), "tavily", "  tvly-test-key-123456  "), file);
    expect(loadConfig(file)).toEqual({
      version: 2,
      providers: { tavily: { apiKey: "tvly-test-key-123456" } },
    });
  });

  it("preserves the default provider and drops empty keys", () => {
    const file = tmpConfigFile();
    let config = withApiKey(loadConfig(file), "tavily", "tvly-a-1234567890");
    config = withApiKey(config, "deepseek", "sk-b-1234567890123456");
    config = withDefaultProvider(config, "deepseek");
    saveConfig(config, file);

    expect(loadConfig(file)).toEqual({
      version: 2,
      defaultProvider: "deepseek",
      providers: {
        tavily: { apiKey: "tvly-a-1234567890" },
        deepseek: { apiKey: "sk-b-1234567890123456" },
      },
    });

    saveConfig(withApiKey(loadConfig(file), "tavily", ""), file);
    expect(loadConfig(file).providers).toEqual({
      deepseek: { apiKey: "sk-b-1234567890123456" },
    });
  });

  it("migrates a v1 single-key file to providers.tavily", () => {
    const file = tmpConfigFile();
    fs.writeFileSync(file, JSON.stringify({ apiKey: "tvly-legacy-123456" }));
    expect(loadConfig(file)).toEqual({
      version: 2,
      providers: { tavily: { apiKey: "tvly-legacy-123456" } },
    });
  });

  it("treats a corrupt config as unconfigured", () => {
    const file = tmpConfigFile();
    fs.writeFileSync(file, "{not json");
    expect(loadConfig(file)).toEqual({ version: 2, providers: {} });
  });

  it("lists configured provider ids", () => {
    const config = withApiKey(
      withApiKey(loadConfig(tmpConfigFile()), "tavily", "tvly-a-1234567890"),
      "deepseek",
      "sk-b-1234567890123456",
    );
    expect(configuredProviderIds(config).sort()).toEqual(["deepseek", "tavily"]);
  });
});

describe("resolveApiKey", () => {
  const tavily = { id: "tavily", apiKeyEnv: ["TAVILY_API_KEY"] };
  const deepseek = { id: "deepseek", apiKeyEnv: ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"] };

  it("prefers the environment over the stored key", () => {
    const config = withApiKey(loadConfig(tmpConfigFile()), "tavily", "tvly-file-1234567");

    expect(resolveApiKey(tavily, config, { TAVILY_API_KEY: " tvly-env-1234567 " })).toEqual({
      apiKey: "tvly-env-1234567",
      source: "env",
    });
    expect(resolveApiKey(tavily, config, {})).toEqual({
      apiKey: "tvly-file-1234567",
      source: "config",
    });
  });

  it("checks env vars in priority order", () => {
    const config = loadConfig(tmpConfigFile());
    expect(
      resolveApiKey(deepseek, config, { DEEPSEEK_KEY: "sk-second-1234567" }),
    ).toEqual({ apiKey: "sk-second-1234567", source: "env" });
    expect(
      resolveApiKey(deepseek, config, {
        DEEPSEEK_API_KEY: "sk-first-1234567",
        DEEPSEEK_KEY: "sk-second-1234567",
      })?.apiKey,
    ).toBe("sk-first-1234567");
  });

  it("returns null when neither source has a key", () => {
    const config = loadConfig(tmpConfigFile());
    expect(resolveApiKey(tavily, config, {})).toBeNull();
    expect(resolveApiKey(tavily, config, { TAVILY_API_KEY: "   " })).toBeNull();
    // A key stored for another provider does not leak across providers.
    const other = withApiKey(config, "deepseek", "sk-other-1234567890");
    expect(resolveApiKey(tavily, other, {})).toBeNull();
  });

  it("masks keys without leaking the middle", () => {
    expect(maskApiKey("tvly-1234567890abcdef")).toBe("tvly-123…cdef");
    expect(maskApiKey("short")).toBe("****");
  });
});

// =============================================================================
// Validation
// =============================================================================

describe("validateSearchOptions", () => {
  const base = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
    query: "hello world",
    maxResults: 5,
    detail: "summary",
    ...overrides,
  });

  it("accepts a minimal query", () => {
    expect(() => validateSearchOptions(base(), LIMITS)).not.toThrow();
  });

  it("rejects empty or whitespace queries", () => {
    expect(() => validateSearchOptions(base({ query: "" }), LIMITS)).toThrow(
      /non-empty/,
    );
    expect(() => validateSearchOptions(base({ query: "   " }), LIMITS)).toThrow(
      /non-empty/,
    );
  });

  it("enforces the provider's query limit, not a global one", () => {
    expect(() =>
      validateSearchOptions(base({ query: "x".repeat(401) }), LIMITS),
    ).toThrow(/400/);
    expect(() =>
      validateSearchOptions(base({ query: "x".repeat(400) }), LIMITS),
    ).not.toThrow();

    const tight: ProviderLimits = { maxQueryChars: 128, maxResults: 50 };
    expect(() =>
      validateSearchOptions(base({ query: "x".repeat(129) }), tight),
    ).toThrow(/128/);
    expect(() =>
      validateSearchOptions(base({ query: "x".repeat(128) }), tight),
    ).not.toThrow();
  });

  it("enforces max_results bounds", () => {
    for (const bad of [0, 21, 1.5, -1]) {
      expect(() =>
        validateSearchOptions(base({ maxResults: bad }), LIMITS),
      ).toThrow(/max_results/);
    }
    expect(() => validateSearchOptions(base({ maxResults: 1 }), LIMITS)).not.toThrow();
    expect(() => validateSearchOptions(base({ maxResults: 20 }), LIMITS)).not.toThrow();
  });

  it("rejects invalid detail and recency at runtime", () => {
    expect(() =>
      validateSearchOptions(
        base({ detail: "full" as unknown as SearchOptions["detail"] }),
        LIMITS,
      ),
    ).toThrow(/detail/);
    expect(() =>
      validateSearchOptions(
        base({ recency: "decade" as unknown as SearchOptions["recency"] }),
        LIMITS,
      ),
    ).toThrow(/recency/);
  });

  it("accepts ISO 639-1 languages and rejects the rest", () => {
    for (const ok of ["en", "zh", "zh-CN", "pt-BR"]) {
      expect(() =>
        validateSearchOptions(base({ language: ok }), LIMITS),
      ).not.toThrow();
    }
    for (const bad of ["english please", "e", "zh_CN!"]) {
      expect(() =>
        validateSearchOptions(base({ language: bad }), LIMITS),
      ).toThrow(/language/);
    }
  });

  it("rejects invalid domain filters", () => {
    expect(() =>
      validateSearchOptions(base({ includeDomains: ["not a domain"] }), LIMITS),
    ).toThrow(/include_domains/);
    expect(() =>
      validateSearchOptions(
        base({ excludeDomains: ["https://example.com/path"] }),
        LIMITS,
      ),
    ).not.toThrow();
    expect(() =>
      validateSearchOptions(base({ excludeDomains: ["ftp://example.com"] }), LIMITS),
    ).toThrow(/exclude_domains/);
  });

  it("exports the neutral enum values", () => {
    expect(DETAIL_LEVELS).toEqual(["snippet", "summary", "content"]);
    expect(RECENCY_RANGES).toEqual(["day", "week", "month", "year"]);
  });
});

describe("normalizeDomain", () => {
  it("strips scheme, path, www, port, and case", () => {
    expect(normalizeDomain("HTTPS://WWW.Example.com:443/path/to?q=1")).toBe(
      "example.com",
    );
    expect(normalizeDomain("  github.com  ")).toBe("github.com");
    expect(normalizeDomain("http://sub.example.org")).toBe("sub.example.org");
  });
});

describe("normalizeLanguage", () => {
  it("normalizes separators to hyphens", () => {
    expect(normalizeLanguage(" zh_CN ")).toBe("zh-CN");
    expect(normalizeLanguage("en")).toBe("en");
  });
});

describe("validateUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(validateUrl("https://example.com")).toBe("https://example.com/");
    expect(validateUrl(" http://example.com/a?b=c ")).toBe(
      "http://example.com/a?b=c",
    );
  });

  it("rejects relative and non-http URLs", () => {
    expect(() => validateUrl("/relative")).toThrow(/absolute/);
    expect(() => validateUrl("ftp://example.com/file")).toThrow(/http/);
    expect(() => validateUrl("javascript:alert(1)")).toThrow(/http/);
  });
});

describe("validateExtractOptions", () => {
  it("rejects empty and oversized lists", () => {
    expect(() => validateExtractOptions({ urls: [] })).toThrow(/at least one/);
    expect(() =>
      validateExtractOptions({
        urls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`),
      }),
    ).toThrow(/at most 20/);
  });

  it("rejects invalid URLs", () => {
    expect(() => validateExtractOptions({ urls: ["not-a-url"] })).toThrow(
      /Invalid URL/,
    );
  });
});

describe("clampToLimits", () => {
  const options: SearchOptions = { query: "q", maxResults: 50, detail: "summary" };

  it("clamps and explains", () => {
    const { options: clamped, warnings } = clampToLimits(
      options,
      { maxQueryChars: 400, maxResults: 20 },
      "Tavily",
    );
    expect(clamped.maxResults).toBe(20);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/clamped to 20 by Tavily/);
  });

  it("leaves an in-range request untouched", () => {
    const input: SearchOptions = { query: "q", maxResults: 5, detail: "summary" };
    const result = clampToLimits(input, { maxQueryChars: 400, maxResults: 20 }, "Tavily");
    expect(result.options).toBe(input);
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveDetail", () => {
  it("keeps a supported tier", () => {
    expect(resolveDetail("content", ["snippet", "content"])).toBe("content");
  });

  it("degrades content to summary when page text is unavailable", () => {
    expect(resolveDetail("content", ["snippet", "summary"])).toBe("summary");
  });

  it("falls back to the first supported tier", () => {
    expect(resolveDetail("content", ["snippet"])).toBe("snippet");
    expect(resolveDetail("snippet", ["summary"])).toBe("summary");
  });
});

// =============================================================================
// provider_options
// =============================================================================

describe("validateProviderOptions", () => {
  const specs: NativeOptionsSpec = {
    search_depth: { type: "enum", values: ["basic", "advanced"] },
    include_answer: { type: "boolean" },
    chunks_per_source: { type: "number", min: 1, max: 3 },
    country: { type: "string" },
  };

  it("treats a missing object as empty", () => {
    expect(validateProviderOptions("Tavily", specs, undefined)).toEqual({});
  });

  it("passes valid values through", () => {
    expect(
      validateProviderOptions("Tavily", specs, {
        search_depth: "advanced",
        include_answer: true,
        chunks_per_source: 3,
      }),
    ).toEqual({
      search_depth: "advanced",
      include_answer: true,
      chunks_per_source: 3,
    });
  });

  it("rejects a non-object", () => {
    expect(() => validateProviderOptions("Tavily", specs, "x")).toThrow(
      /expected an object/,
    );
    expect(() => validateProviderOptions("Tavily", specs, [])).toThrow(
      /expected an object/,
    );
  });

  it("names the accepted keys for an unknown key", () => {
    expect(() =>
      validateProviderOptions("Tavily", specs, { search_dept: "advanced" }),
    ).toThrow(/search_dept/);
    expect(() =>
      validateProviderOptions("Tavily", specs, { search_dept: "advanced" }),
    ).toThrow(/search_depth \(basic\|advanced\)/);
  });

  it("explains bad enum, boolean, and number values", () => {
    expect(() =>
      validateProviderOptions("Tavily", specs, { search_depth: "deep" }),
    ).toThrow(/basic, advanced/);
    expect(() =>
      validateProviderOptions("Tavily", specs, { include_answer: "yes" }),
    ).toThrow(/true or false/);
    expect(() =>
      validateProviderOptions("Tavily", specs, { chunks_per_source: 9 }),
    ).toThrow(/<= 3/);
    expect(() =>
      validateProviderOptions("Tavily", specs, { chunks_per_source: 0 }),
    ).toThrow(/>= 1/);
  });

  it("rejects an empty string", () => {
    expect(() =>
      validateProviderOptions("Tavily", specs, { country: "  " }),
    ).toThrow(/non-empty string/);
  });

  it("describes the whitelist for humans", () => {
    expect(describeNativeOptions(specs)).toBe(
      "search_depth (basic|advanced), include_answer boolean, chunks_per_source number 1-3, country string",
    );
  });
});

// =============================================================================
// Transport
// =============================================================================

describe("postJson", () => {
  it("sends bearer auth and the JSON body", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ results: [] }));

    const payload = await postJson<{ results: unknown[] }>(
      ENDPOINT,
      "test-key-1234",
      { query: "hello" },
      testProfile,
      { fetchImpl },
    );

    expect(payload).toEqual({ results: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key-1234");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "hello" });
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [400, "api"],
    [500, "api"],
  ])("classifies HTTP %i as %s", async (status, kind) => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ detail: { error: "upstream detail" } }, status),
    );

    const promise = postJson(ENDPOINT, "key", {}, testProfile, { fetchImpl });
    await expect(promise).rejects.toMatchObject({ kind, status });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toThrow(/upstream detail/);
  });

  it("wraps network failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await expect(
      postJson(ENDPOINT, "key", {}, testProfile, { fetchImpl }),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      postJson(ENDPOINT, "key", {}, testProfile, { fetchImpl }),
    ).rejects.toThrow(/Check network connectivity/);
  });

  it("times out", async () => {
    await expect(
      postJson(ENDPOINT, "key", {}, testProfile, {
        fetchImpl: hangingFetch(),
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports external cancellation as aborted", async () => {
    const controller = new AbortController();
    const promise = postJson(ENDPOINT, "key", {}, testProfile, {
      fetchImpl: hangingFetch(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rejects a non-JSON success body", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response("plain text", { status: 200 }),
    );

    await expect(
      postJson(ENDPOINT, "key", {}, testProfile, { fetchImpl }),
    ).rejects.toThrow(/unreadable response/);
  });
});

describe("extractErrorMessage", () => {
  it("handles plain string payloads", () => {
    expect(extractErrorMessage(" boom ")).toBe("boom");
    expect(extractErrorMessage("   ")).toBeNull();
    expect(extractErrorMessage(null)).toBeNull();
  });

  it("handles detail strings and nested detail objects", () => {
    expect(extractErrorMessage({ detail: "bad request" })).toBe("bad request");
    expect(extractErrorMessage({ detail: { error: "inner" } })).toBe("inner");
    expect(extractErrorMessage({ detail: { message: "inner msg" } })).toBe(
      "inner msg",
    );
  });

  it("handles OpenAI-compatible error objects", () => {
    expect(
      extractErrorMessage({
        error: {
          message: "'count' must be between 1 and 50",
          type: "invalid_request_error",
          param: null,
          code: "invalid_request_error",
        },
      }),
    ).toBe("'count' must be between 1 and 50");
  });

  it("falls back to a JSON dump of structured details", () => {
    expect(extractErrorMessage({ detail: { nested: true } })).toBe(
      '{"nested":true}',
    );
  });
});

// =============================================================================
// Formatting
// =============================================================================

describe("formatSearchResponse", () => {
  it("renders the answer, title, URL, and score line", () => {
    const text = formatSearchResponse({
      query: "typescript release",
      answer: "TypeScript 6.0 was released.",
      responseTime: 0.42,
      results: [
        {
          title: "TypeScript 6.0",
          url: "https://devblogs.microsoft.com/typescript/",
          text: "Announcing TypeScript 6.0 with faster builds.",
          kind: "summary",
          score: 0.91,
          quality: "high",
          publishedAt: "2024-11-26T10:00:00Z",
        },
      ],
    });

    expect(text).toContain("Answer: TypeScript 6.0 was released.");
    expect(text).toContain("1. TypeScript 6.0");
    expect(text).toContain("URL: https://devblogs.microsoft.com/typescript/");
    expect(text).toContain("score 0.91 (high) | 2024-11-26");
    expect(text).toContain("Announcing TypeScript 6.0");
  });

  it("shows a publisher name only when the domain does not already say it", () => {
    expect(siteNameAddsInfo("GitHub", "https://github.com/a/b")).toBe(false);
    // Two-letter TLD labels are ignored, so this one is kept: mild redundancy is
    // preferable to hiding a publisher name.
    expect(siteNameAddsInfo("Go Packages", "https://pkg.go.dev/x")).toBe(true);
    expect(siteNameAddsInfo("证券时报", "https://stcn.com/a.html")).toBe(true);
    expect(siteNameAddsInfo("  ", "https://stcn.com/a.html")).toBe(false);
    expect(siteNameAddsInfo("Example", "not-a-url")).toBe(true);
  });

  it("renders a useful publisher name in the score line", () => {
    const text = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        {
          title: "t",
          url: "https://stcn.com/a.html",
          text: "body",
          kind: "summary",
          siteName: "证券时报",
        },
        {
          title: "t2",
          url: "https://github.com/a/b",
          text: "body",
          kind: "summary",
          siteName: "GitHub",
        },
      ],
    });
    expect(text).toContain("证券时报");
    expect(text).not.toContain("GitHub");
  });

  it("omits the score line when the provider gives no judgement data", () => {
    const text = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        { title: "t", url: "https://example.com/", text: "body", kind: "summary" },
      ],
    });
    expect(text).not.toContain("score ");
    expect(text).toContain("body");
  });

  it("includes the quality level and flags when present", () => {
    const text = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        {
          title: "t",
          url: "https://example.com/",
          text: "body",
          kind: "content",
          score: 0.8,
          quality: "high",
          publishedAt: "2026-06-01T00:00:00+00:00",
          flags: ["authoritative"],
        },
      ],
    });
    expect(text).toContain("score 0.80 (high) | 2026-06-01 | authoritative");
  });

  it("gives recovery hints when there are no results", () => {
    const text = formatSearchResponse({
      query: "nothing",
      responseTime: 0.1,
      results: [],
    });
    expect(text).toContain('No results for "nothing"');
    expect(text).toContain("include_domains");
  });

  it("renders warnings as note lines", () => {
    const text = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        { title: "t", url: "https://example.com/", text: "body", kind: "summary" },
      ],
      warnings: ["max_results clamped to 20 by Tavily (requested 50)"],
    });
    expect(text).toContain("note: max_results clamped to 20 by Tavily");
  });

  it("caps page text per result but not summaries", () => {
    const long = "x".repeat(5_000);
    const content = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        { title: "t", url: "https://example.com/", text: long, kind: "content" },
      ],
    });
    expect(content).toContain("[truncated]");
    expect(content.length).toBeLessThan(3_200);

    const summary = formatSearchResponse({
      query: "q",
      responseTime: 0.1,
      results: [
        { title: "t", url: "https://example.com/", text: "s".repeat(1_000), kind: "summary" },
      ],
    });
    expect(summary).not.toContain("[truncated]");
  });

  it("truncates to maxChars", () => {
    const text = formatSearchResponse(
      {
        query: "q",
        responseTime: 0.1,
        results: [
          {
            title: "A long result",
            url: "https://example.com/",
            text: "x".repeat(200),
            kind: "summary",
          },
        ],
      },
      { maxChars: 60 },
    );
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text).toContain("[truncated]");
  });
});

describe("formatExtractResponse", () => {
  it("renders pages and failures", () => {
    const text = formatExtractResponse({
      results: [{ url: "https://a.example", text: "Page A body" }],
      failedResults: [{ url: "https://b.example", error: "blocked" }],
      responseTime: 0.1,
    });
    expect(text).toContain("Page A body");
    expect(text).toContain("Failed (1):");
    expect(text).toContain("https://b.example: blocked");
  });

  it("truncates each page", () => {
    const text = formatExtractResponse(
      {
        results: [{ url: "https://a.example", text: "x".repeat(100) }],
        failedResults: [],
        responseTime: 0.1,
      },
      { perUrlChars: 10, maxChars: 1_000 },
    );
    expect(text).toContain("xxxxxxxxxx\n… [truncated]");
  });

  it("reports when nothing was extracted", () => {
    const text = formatExtractResponse({
      results: [],
      failedResults: [],
      responseTime: 0.1,
    });
    expect(text).toContain("no extracted content");
  });

  it("renders warnings", () => {
    const text = formatExtractResponse({
      results: [{ url: "https://a.example", text: "body" }],
      failedResults: [],
      responseTime: 0.1,
      warnings: ["one URL was skipped"],
    });
    expect(text).toContain("note: one URL was skipped");
  });
});

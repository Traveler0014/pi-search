/**
 * Unit tests for the Tavily adapter, its neutral→Tavily translation, and the
 * provider registry.
 *
 * Run: npm test
 */

import { describe, expect, it } from "vitest";
import { ProviderError, type SearchOptions } from "../core/types.js";
import {
  PROVIDER_IDS,
  PROVIDERS,
  getProvider,
  resolveProvider,
  runSearch,
} from "./registry.js";
import {
  TAVILY_EXTRACT_OPTIONS,
  TAVILY_EXTRACT_URL,
  TAVILY_HTTP_PROFILE,
  TAVILY_LIMITS,
  TAVILY_SEARCH_OPTIONS,
  TAVILY_SEARCH_URL,
  buildExtractBody,
  buildSearchBody,
  chunksForDetail,
  isValidTavilyKey,
  parseExtractResponse,
  parseSearchResponse,
  tavilyExtract,
  tavilyProvider,
  tavilyRequest,
  tavilySearch,
} from "./tavily.js";
import {
  jsonResponse,
  mockFetch,
  sampleSearchPayload,
} from "../support/test-helpers.js";

const baseOptions = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
  query: "hello",
  maxResults: 5,
  detail: "summary",
  ...overrides,
});

// =============================================================================
// Provider descriptor
// =============================================================================

describe("tavilyProvider", () => {
  it("declares its id, label, env vars, and limits", () => {
    const provider = getProvider("tavily");
    expect(provider?.id).toBe("tavily");
    expect(provider?.label).toBe("Tavily");
    expect(provider?.apiKeyEnv).toEqual(["TAVILY_API_KEY"]);
    expect(provider?.limits).toEqual({ maxQueryChars: 400, maxResults: 20 });
  });

  it("declares the detail tiers it can deliver", () => {
    expect(tavilyProvider.details).toEqual(["snippet", "summary", "content"]);
  });

  it("documents native options for both operations", () => {
    expect(Object.keys(TAVILY_SEARCH_OPTIONS)).toContain("search_depth");
    expect(Object.keys(TAVILY_EXTRACT_OPTIONS)).toContain("extract_depth");
    expect(TAVILY_LIMITS.maxQueryChars).toBe(400);
  });

  it("validates key format", () => {
    expect(isValidTavilyKey("tvly-dev-example-key-1234567890")).toBe(true);
    expect(isValidTavilyKey("tvly-short")).toBe(false);
    expect(isValidTavilyKey("sk-not-tavily-123456")).toBe(false);
    expect(isValidTavilyKey("")).toBe(false);
  });

  it("uses https endpoints", () => {
    expect(TAVILY_SEARCH_URL).toBe("https://api.tavily.com/search");
    expect(TAVILY_EXTRACT_URL).toBe("https://api.tavily.com/extract");
  });
});

// =============================================================================
// Neutral → Tavily translation
// =============================================================================

describe("chunksForDetail", () => {
  it("maps detail tiers onto chunk counts", () => {
    expect(chunksForDetail("snippet")).toBe(1);
    expect(chunksForDetail("summary")).toBe(2);
    expect(chunksForDetail("content")).toBe(3);
  });
});

describe("buildSearchBody", () => {
  it("builds defaults", () => {
    expect(buildSearchBody(baseOptions())).toEqual({
      query: "hello",
      max_results: 5,
      search_depth: "basic",
      topic: "general",
      chunks_per_source: 2,
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
    });
  });

  it("requests page text only for detail=content", () => {
    for (const [detail, raw, chunks] of [
      ["snippet", false, 1],
      ["summary", false, 2],
      ["content", "markdown", 3],
    ] as const) {
      const body = buildSearchBody(baseOptions({ detail }));
      expect(body.include_raw_content).toBe(raw);
      expect(body.chunks_per_source).toBe(chunks);
    }
  });

  it("maps recency to time_range", () => {
    for (const recency of ["day", "week", "month", "year"] as const) {
      expect(buildSearchBody(baseOptions({ recency })).time_range).toBe(recency);
    }
    expect(buildSearchBody(baseOptions()).time_range).toBeUndefined();
  });

  it("normalizes language", () => {
    expect(buildSearchBody(baseOptions({ language: "zh_CN" })).language).toBe(
      "zh-CN",
    );
  });

  it("dedupes and normalizes domains", () => {
    expect(
      buildSearchBody(
        baseOptions({
          includeDomains: ["https://www.Example.com/a", "example.com"],
          excludeDomains: ["pinterest.com", "www.pinterest.com"],
        }),
      ),
    ).toMatchObject({
      include_domains: ["example.com"],
      exclude_domains: ["pinterest.com"],
    });
  });

  it("passes native options through", () => {
    expect(
      buildSearchBody(
        baseOptions({
          options: {
            search_depth: "advanced",
            topic: "news",
            include_answer: true,
            chunks_per_source: 1,
            country: "germany",
          },
        }),
      ),
    ).toMatchObject({
      search_depth: "advanced",
      topic: "news",
      include_answer: true,
      chunks_per_source: 1,
      country: "germany",
    });
  });

  it("lets native dates replace recency", () => {
    const body = buildSearchBody(
      baseOptions({
        recency: "week",
        options: { start_date: "2025-01-01", end_date: "2025-02-01" },
      }),
    );
    expect(body.time_range).toBeUndefined();
    expect(body.start_date).toBe("2025-01-01");
    expect(body.end_date).toBe("2025-02-01");
  });

  it("rejects unknown provider_options and lists accepted keys", () => {
    expect(() =>
      buildSearchBody(baseOptions({ options: { search_dept: "advanced" } })),
    ).toThrow(/search_dept/);
    expect(() =>
      buildSearchBody(baseOptions({ options: { search_dept: "advanced" } })),
    ).toThrow(/search_depth \(basic\|advanced\|fast\|ultra-fast\)/);
  });

  it("rejects native options that belong to extract", () => {
    expect(() =>
      buildSearchBody(baseOptions({ options: { extract_depth: "advanced" } })),
    ).toThrow(/does not accept that key/);
  });
});

describe("buildExtractBody", () => {
  it("builds defaults and dedupes URLs", () => {
    expect(
      buildExtractBody({ urls: ["https://example.com", "https://example.com/"] }),
    ).toEqual({
      urls: ["https://example.com/"],
      extract_depth: "basic",
      include_images: false,
    });
  });

  it("passes native options through", () => {
    expect(
      buildExtractBody({
        urls: ["https://example.com"],
        options: { extract_depth: "advanced", include_images: true },
      }),
    ).toMatchObject({ extract_depth: "advanced", include_images: true });
  });
});

// =============================================================================
// HTTP error prose
// =============================================================================

describe("TAVILY_HTTP_PROFILE", () => {
  it("classifies statuses the way Tavily documents them", () => {
    expect(TAVILY_HTTP_PROFILE.classify(401)).toBe("auth");
    expect(TAVILY_HTTP_PROFILE.classify(403)).toBe("auth");
    expect(TAVILY_HTTP_PROFILE.classify(429)).toBe("rate_limit");
    expect(TAVILY_HTTP_PROFILE.classify(432)).toBe("rate_limit");
    expect(TAVILY_HTTP_PROFILE.classify(433)).toBe("rate_limit");
    expect(TAVILY_HTTP_PROFILE.classify(400)).toBe("api");
  });

  it.each([
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [429, /rate limit/],
    [432, /plan limit/],
    [433, /plan limit/],
    [400, /HTTP 400/],
    [500, /HTTP 500/],
  ])("explains HTTP %i", async (status, pattern) => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ detail: { error: "upstream detail" } }, status),
    );

    const promise = tavilyRequest(TAVILY_SEARCH_URL, "key", {}, { fetchImpl });
    await expect(promise).rejects.toMatchObject({ status });
    await expect(promise).rejects.toThrow(pattern);
    await expect(promise).rejects.toThrow(/upstream detail/);
  });

  it("names the fix for auth failures", () => {
    expect(TAVILY_HTTP_PROFILE.describe(401, null)).toContain("/search-config");
    expect(TAVILY_HTTP_PROFILE.describe(401, null)).toContain("TAVILY_API_KEY");
  });
});

// =============================================================================
// Search API
// =============================================================================

describe("tavilySearch", () => {
  it("calls the search endpoint and parses the response", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(sampleSearchPayload),
    );

    const response = await tavilySearch(
      "tvly-test-key-1234",
      baseOptions({ query: "typescript release", maxResults: 2 }),
      { fetchImpl },
    );

    expect(calls[0].url).toBe(TAVILY_SEARCH_URL);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      query: "typescript release",
      max_results: 2,
    });

    expect(response.query).toBe("typescript release");
    expect(response.answer).toBe("TypeScript 6.0 was released.");
    expect(response.results).toHaveLength(2); // item without URL is dropped
    expect(response.results[0]).toMatchObject({
      title: "TypeScript 6.0",
      kind: "summary",
      text: "Announcing TypeScript 6.0 with faster builds.",
      score: 0.91,
      rawScore: 0.91,
      publishedAt: "2024-11-26T10:00:00Z",
    });
    expect(response.responseTime).toBe(0.42);
    expect(response.requestId).toBe("req-1");
  });

  it("warns when native dates override recency", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(sampleSearchPayload));
    const response = await tavilySearch(
      "key",
      baseOptions({ recency: "week", options: { start_date: "2025-01-01" } }),
      { fetchImpl },
    );
    expect(response.warnings?.[0]).toMatch(/recency ignored/);
  });

  it("validates before making a request", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ results: [] }));
    await expect(
      tavilySearch("key", baseOptions({ query: "" }), { fetchImpl }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      tavilySearch("key", baseOptions({ query: "x".repeat(401) }), { fetchImpl }),
    ).rejects.toThrow(/400/);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed responses", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ nope: true }));
    await expect(
      tavilySearch("key", baseOptions(), { fetchImpl }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("parseSearchResponse", () => {
  it("throws when results is missing", () => {
    expect(() => parseSearchResponse({})).toThrow(/results/);
  });

  it("defaults missing fields safely", () => {
    const parsed = parseSearchResponse({ results: [{}] });
    expect(parsed.results).toEqual([]);
    expect(parsed.answer).toBeNull();
    expect(parsed.query).toBe("");
    expect(parsed.responseTime).toBe(0);
  });

  it("uses raw content for detail=content", () => {
    const [hit] = parseSearchResponse(
      {
        results: [
          {
            title: "t",
            url: "https://example.com/",
            content: "snippet text",
            raw_content: "# Full page\n\nBody",
          },
        ],
      },
      "content",
    ).results;
    expect(hit.kind).toBe("content");
    expect(hit.text).toContain("Full page");
  });

  it("falls back to the summary tier when page text is missing", () => {
    const [hit] = parseSearchResponse(
      {
        results: [
          { title: "t", url: "https://example.com/", content: "snippet text" },
        ],
      },
      "content",
    ).results;
    expect(hit.kind).toBe("summary");
    expect(hit.text).toBe("snippet text");
  });

  it("reports snippet detail", () => {
    const [hit] = parseSearchResponse(
      {
        results: [
          { title: "t", url: "https://example.com/", content: "chunk one" },
        ],
      },
      "snippet",
    ).results;
    expect(hit.kind).toBe("snippet");
  });

  it("leaves a missing score undefined instead of zero", () => {
    const [hit] = parseSearchResponse({
      results: [{ url: "https://example.com/", title: "t" }],
    }).results;
    expect(hit.score).toBeUndefined();
    expect(hit.rawScore).toBeUndefined();
    expect(hit.publishedAt).toBeNull();
  });

  it("clamps an out-of-range score", () => {
    const [hit] = parseSearchResponse({
      results: [{ url: "https://example.com/", score: 1.4 }],
    }).results;
    expect(hit.score).toBe(1);
    expect(hit.rawScore).toBe(1.4);
  });
});

// =============================================================================
// Extract API
// =============================================================================

describe("tavilyExtract", () => {
  it("calls the extract endpoint and parses results + failures", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        results: [
          {
            url: "https://example.com/",
            title: "Example",
            raw_content: "Hello world",
            images: ["https://example.com/a.png", 42],
          },
        ],
        failed_results: [{ url: "https://broken.example", error: "timeout" }],
        response_time: 0.2,
      }),
    );

    const response = await tavilyExtract(
      "key",
      { urls: ["https://example.com", "https://example.com/"] },
      { fetchImpl },
    );

    expect(calls[0].url).toBe(TAVILY_EXTRACT_URL);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      urls: ["https://example.com/"],
      extract_depth: "basic",
      include_images: false,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      url: "https://example.com/",
      title: "Example",
      text: "Hello world",
      images: ["https://example.com/a.png"],
    });
    expect(response.failedResults).toEqual([
      { url: "https://broken.example", error: "timeout" },
    ]);
  });

  it("rejects invalid URLs before making a request", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({}));
    await expect(
      tavilyExtract("key", { urls: ["nope"] }, { fetchImpl }),
    ).rejects.toThrow(/Invalid URL/);
    expect(calls).toHaveLength(0);
  });
});

describe("parseExtractResponse", () => {
  it("defaults missing arrays", () => {
    expect(parseExtractResponse({})).toEqual({
      results: [],
      failedResults: [],
      responseTime: 0,
    });
  });
});

// =============================================================================
// Registry invariants
// =============================================================================

describe("provider registry", () => {
  it("derives the tool enum from the adapter list", () => {
    expect([...PROVIDER_IDS]).toEqual(PROVIDERS.map((p) => p.id));
  });

  it("keeps ids unique", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every provider the full contract", () => {
    for (const provider of PROVIDERS) {
      expect(provider.apiKeyEnv.length).toBeGreaterThan(0);
      expect(typeof provider.looksLikeKey).toBe("function");
      expect(typeof provider.search).toBe("function");
      expect(typeof provider.extract).toBe("function");
      expect(provider.limits.maxQueryChars).toBeGreaterThan(0);
      expect(provider.limits.maxResults).toBeGreaterThan(0);
      expect(provider.details.length).toBeGreaterThan(0);
      expect(typeof provider.searchOptions).toBe("object");
      expect(typeof provider.extractOptions).toBe("object");

      const { high, medium } = provider.scores;
      expect(high).toBeGreaterThan(medium);
      expect(high).toBeLessThanOrEqual(1);
      expect(medium).toBeGreaterThanOrEqual(0);
    }
  });

  it("resolves the default provider when none is named", () => {
    const resolved = resolveProvider();
    expect(resolved.provider.id).toBe(PROVIDER_IDS[0]);
    expect(resolved.explicit).toBe(false);
    expect(resolveProvider("").explicit).toBe(false);
  });

  it("resolves a named provider", () => {
    const resolved = resolveProvider("tavily");
    expect(resolved.provider.id).toBe("tavily");
    expect(resolved.explicit).toBe(true);
  });

  it("explains unknown providers", () => {
    expect(() => resolveProvider("nope")).toThrow(/Unknown provider "nope"/);
    expect(() => resolveProvider("nope")).toThrow(/tavily/);
  });

  it("stamps quality levels and passes adapter warnings through", async () => {
    const response = await runSearch(
      {
        ...tavilyProvider,
        scores: { high: 0.5, medium: 0.25 },
        search: async () => ({
          query: "q",
          answer: null,
          responseTime: 0,
          warnings: ["adapter note"],
          results: [
            { title: "a", url: "https://a/", text: "", kind: "summary", score: 0.7 },
            { title: "b", url: "https://b/", text: "", kind: "summary", score: 0.3 },
            { title: "c", url: "https://c/", text: "", kind: "summary" },
          ],
        }),
      },
      "key",
      baseOptions(),
    );

    expect(response.results.map((r) => r.quality)).toEqual([
      "high",
      "medium",
      undefined,
    ]);
    expect(response.warnings).toEqual(["adapter note"]);
  });

  it("clamps to the provider limit and warns", async () => {
    const response = await runSearch(
      {
        ...tavilyProvider,
        limits: { maxQueryChars: 400, maxResults: 3 },
        search: async (_key, options) => ({
          query: "q",
          responseTime: 0,
          results: Array.from({ length: options.maxResults }, (_, i) => ({
            title: `r${i}`,
            url: `https://r${i}/`,
            text: "",
            kind: "summary" as const,
          })),
        }),
      },
      "key",
      baseOptions({ maxResults: 10 }),
    );

    expect(response.results).toHaveLength(3);
    expect(response.warnings?.[0]).toMatch(/max_results clamped to 3/);
  });

  it("downgrades an unsupported detail tier and warns", async () => {
    let requestedKind = "";
    const response = await runSearch(
      {
        ...tavilyProvider,
        details: ["snippet", "summary"],
        search: async (_key, options) => {
          requestedKind = options.detail;
          return {
            query: "q",
            responseTime: 0,
            results: [
              { title: "a", url: "https://a/", text: "", kind: "summary" },
            ],
          };
        },
      },
      "key",
      baseOptions({ detail: "content" }),
    );

    expect(requestedKind).toBe("summary");
    expect(response.warnings?.[0]).toMatch(/detail "content" is not supported/);
  });
});

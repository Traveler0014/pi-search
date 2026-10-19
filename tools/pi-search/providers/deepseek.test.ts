/**
 * Unit tests for the DeepSeek adapter: query-operator injection, the 128-char
 * guard, response parsing, batch fetch semantics, and error mapping.
 *
 * Run: npm test
 */

import { describe, expect, it } from "vitest";
import type { SearchOptions } from "../core/types.js";
import {
  DEEPSEEK_LOW_AUTHORITY_MAX,
  DEEPSEEK_FETCH_URL,
  DEEPSEEK_HTTP_PROFILE,
  DEEPSEEK_SCORE_MAX,
  DEEPSEEK_SEARCH_OPTIONS,
  DEEPSEEK_SEARCH_URL,
  afterDateFor,
  buildDeepSeekQuery,
  buildSearchBody,
  deepseekExtract,
  deepseekProvider,
  deepseekRequest,
  deepseekSearch,
  isValidDeepSeekKey,
  parseFetchResponse,
  parseSearchResponse,
  selectText,
  unescapeFetchedMarkdown,
} from "./deepseek.js";
import { jsonResponse, mockFetch } from "../support/test-helpers.js";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15

const baseOptions = (overrides: Partial<SearchOptions> = {}): SearchOptions => ({
  query: "deepseek v4",
  maxResults: 5,
  detail: "summary",
  ...overrides,
});

const searchPayload = {
  results: [
    {
      rerank_score: 2.4,
      title: "DeepSeek V4 发布",
      url: "https://example.com/deepseek-v4",
      snippet: "DeepSeek V4 已上线。",
      summary: "DeepSeek 发布了 V4 模型，改进了工具调用与长上下文。",
      content: "# DeepSeek V4\n\n正文内容。",
      site_name: "Example News",
      site_icon: "https://example.com/favicon.ico",
      date: "2026-06-01T00:00:00+00:00",
      authority: 3,
    },
    {
      rerank_score: 0.6,
      title: "Low quality",
      url: "https://example.com/low",
      snippet: "short",
      summary: "",
      content: "",
      date: null,
      authority: -1,
    },
    { title: "no url" },
  ],
};

// =============================================================================
// Descriptor
// =============================================================================

describe("deepseekProvider", () => {
  it("declares its identity and limits", () => {
    expect(deepseekProvider.id).toBe("deepseek");
    expect(deepseekProvider.label).toBe("DeepSeek");
    expect(deepseekProvider.apiKeyEnv).toEqual(["DEEPSEEK_API_KEY"]);
    expect(deepseekProvider.limits).toEqual({ maxQueryChars: 128, maxResults: 50 });
  });

  it("derives quality cutoffs from the documented 1.5/3 threshold", () => {
    expect(deepseekProvider.scores.high).toBeCloseTo(1.5 / DEEPSEEK_SCORE_MAX);
    expect(deepseekProvider.scores.medium).toBeCloseTo(1 / DEEPSEEK_SCORE_MAX);
  });

  it("supports every detail tier and exposes only two native options", () => {
    expect(deepseekProvider.details).toEqual(["snippet", "summary", "content"]);
    expect(Object.keys(DEEPSEEK_SEARCH_OPTIONS).sort()).toEqual([
      "localization",
      "ori_question",
    ]);
    expect(Object.keys(deepseekProvider.extractOptions)).toEqual([]);
  });

  it("validates key shape", () => {
    expect(isValidDeepSeekKey("sk-1234567890abcdef1234")).toBe(true);
    expect(isValidDeepSeekKey("sk-short")).toBe(false);
    expect(isValidDeepSeekKey("tvly-1234567890abcdef")).toBe(false);
  });
});

// =============================================================================
// Query operator injection
// =============================================================================

describe("afterDateFor", () => {
  it("maps recency windows onto UTC dates", () => {
    expect(afterDateFor("day", NOW)).toBe("2026-06-14");
    expect(afterDateFor("week", NOW)).toBe("2026-06-08");
    expect(afterDateFor("month", NOW)).toBe("2026-05-16");
    expect(afterDateFor("year", NOW)).toBe("2025-06-15");
  });
});

describe("buildDeepSeekQuery", () => {
  it("leaves a plain query alone", () => {
    expect(buildDeepSeekQuery(baseOptions(), NOW)).toBe("deepseek v4");
  });

  it("injects domain filters as site: operators", () => {
    expect(
      buildDeepSeekQuery(
        baseOptions({
          includeDomains: ["https://github.com/a", "huggingface.co"],
          excludeDomains: ["pinterest.com"],
        }),
        NOW,
      ),
    ).toBe("deepseek v4 site:github.com OR site:huggingface.co -site:pinterest.com");
  });

  it("injects language and recency", () => {
    expect(
      buildDeepSeekQuery(baseOptions({ language: "zh-CN", recency: "week" }), NOW),
    ).toBe("deepseek v4 lang:zh after:2026-06-08");
  });

  it("passes operators the user wrote through untouched", () => {
    expect(
      buildDeepSeekQuery(baseOptions({ query: "v4 site:github.com" }), NOW),
    ).toBe("v4 site:github.com");
  });
});

// =============================================================================
// Request body
// =============================================================================

describe("buildSearchBody", () => {
  it("builds defaults", () => {
    expect(buildSearchBody(baseOptions(), NOW)).toEqual({
      query: "deepseek v4",
      count: 5,
      need_content: false,
    });
  });

  it("asks for page text only for detail=content", () => {
    expect(buildSearchBody(baseOptions({ detail: "content" }), NOW).need_content).toBe(
      true,
    );
    expect(buildSearchBody(baseOptions({ detail: "snippet" }), NOW).need_content).toBe(
      false,
    );
  });

  it("passes native options through", () => {
    expect(
      buildSearchBody(
        baseOptions({
          options: { ori_question: "what is deepseek v4?", localization: "1.2.3.4" },
        }),
        NOW,
      ),
    ).toMatchObject({
      ori_question: "what is deepseek v4?",
      localization: "1.2.3.4",
    });
  });

  it("rejects unknown native options", () => {
    expect(() =>
      buildSearchBody(baseOptions({ options: { need_content: true } }), NOW),
    ).toThrow(/does not accept that key/);
    expect(() =>
      buildSearchBody(baseOptions({ options: { need_content: true } }), NOW),
    ).toThrow(/ori_question/);
  });

  it("rejects an ori_question over 128 characters", () => {
    expect(() =>
      buildSearchBody(baseOptions({ options: { ori_question: "x".repeat(129) } }), NOW),
    ).toThrow(/ori_question/);
  });

  it("ramps the length guard with injected operators", () => {
    const query = "x".repeat(110);
    expect(() =>
      buildSearchBody(
        baseOptions({ query, includeDomains: ["example.com"], recency: "week" }),
        NOW,
      ),
    ).toThrow(/above DeepSeek's 128-character limit/);
    // The message must tell the model how to recover.
    expect(() =>
      buildSearchBody(
        baseOptions({ query, includeDomains: ["example.com"], recency: "week" }),
        NOW,
      ),
    ).toThrow(/provider="tavily"/);
  });
});

// =============================================================================
// Response parsing
// =============================================================================

describe("selectText", () => {
  const fields = { snippet: "s", summary: "m", content: "c" };

  it("returns the requested tier when present", () => {
    expect(selectText("snippet", fields)).toEqual({ text: "s", kind: "snippet" });
    expect(selectText("summary", fields)).toEqual({ text: "m", kind: "summary" });
    expect(selectText("content", fields)).toEqual({ text: "c", kind: "content" });
  });

  it("falls back to the richest available tier", () => {
    expect(selectText("content", { snippet: "s", summary: "m", content: "" })).toEqual({
      text: "m",
      kind: "summary",
    });
    expect(selectText("summary", { snippet: "s", summary: "", content: "c" })).toEqual({
      text: "s",
      kind: "snippet",
    });
  });
});

describe("parseSearchResponse", () => {
  it("normalizes rerank_score, authority, and date", () => {
    const response = parseSearchResponse(searchPayload, "summary");
    expect(response.results).toHaveLength(2); // item without URL is dropped
    const [first, second] = response.results;

    expect(first).toMatchObject({
      title: "DeepSeek V4 发布",
      url: "https://example.com/deepseek-v4",
      kind: "summary",
      score: 2.4 / DEEPSEEK_SCORE_MAX,
      rawScore: 2.4,
      publishedAt: "2026-06-01T00:00:00+00:00",
      siteName: "Example News",
      flags: [],
    });

    expect(second.score).toBeCloseTo(0.6 / DEEPSEEK_SCORE_MAX);
    expect(second.publishedAt).toBeNull();
    expect(second.flags).toEqual([]);
  });

  it("flags only the low end of the authority scale", () => {
    const hitAt = (authority: number) =>
      parseSearchResponse({ results: [{ url: "https://a/", title: "t", authority }] }).results[0];

    expect(hitAt(DEEPSEEK_LOW_AUTHORITY_MAX).flags).toEqual(["low-authority"]);
    expect(hitAt(0).flags).toEqual(["low-authority"]);
    expect(hitAt(2).flags).toEqual([]);
    expect(hitAt(4).flags).toEqual([]);
    // -1 means "unknown" and must not be reported as low authority.
    expect(hitAt(-1).flags).toEqual([]);
  });

  it("warns that domain filters are only query operators", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(searchPayload));
    const response = await deepseekSearch(
      "sk-key",
      baseOptions({ includeDomains: ["github.com"] }),
      { fetchImpl },
    );
    expect(response.warnings?.[0]).toMatch(/domain filters are applied as DeepSeek query operators/);
  });

  it("leaves a missing rerank_score undefined", () => {
    const [hit] = parseSearchResponse(
      { results: [{ url: "https://a/", title: "t", summary: "m" }] },
      "summary",
    ).results;
    expect(hit.score).toBeUndefined();
    expect(hit.rawScore).toBeUndefined();
  });

  it("uses content when detail=content", () => {
    const [hit] = parseSearchResponse(searchPayload, "content").results;
    expect(hit.kind).toBe("content");
    expect(hit.text).toContain("正文内容");
  });

  it("returns no answer", () => {
    expect(parseSearchResponse(searchPayload).answer).toBeNull();
  });

  it("rejects a payload without results", () => {
    expect(() => parseSearchResponse({})).toThrow(/results/);
  });
});

describe("unescapeFetchedMarkdown", () => {
  it("restores URLs and headings", () => {
    expect(unescapeFetchedMarkdown("https\\:\\/\\/api\\.deepseek\\.com")).toBe(
      "https://api.deepseek.com",
    );
    expect(unescapeFetchedMarkdown("\\# Heading")).toBe("# Heading");
    expect(unescapeFetchedMarkdown("a \\- b \\| c")).toBe("a - b | c");
  });

  it("keeps genuine backslashes", () => {
    // A page that really contains `\/` must survive the round trip.
    expect(unescapeFetchedMarkdown("regex: \\\\/")).toBe("regex: \\/");
    expect(unescapeFetchedMarkdown("C:\\\\path")).toBe("C:\\path");
  });

  it("leaves a backslash before a non-punctuation character alone", () => {
    expect(unescapeFetchedMarkdown("a\\bc")).toBe("a\\bc");
  });
});

describe("parseFetchResponse", () => {
  it("maps title and markdown content, unescaping it", () => {
    expect(
      parseFetchResponse({ title: "T", content: "\\# Body https\\:\\/\\/x\\.dev" }, "https://a/"),
    ).toEqual({
      url: "https://a/",
      title: "T",
      text: "# Body https://x.dev",
    });
  });
});

// =============================================================================
// HTTP error mapping
// =============================================================================

describe("DEEPSEEK_HTTP_PROFILE", () => {
  it("classifies documented statuses", () => {
    expect(DEEPSEEK_HTTP_PROFILE.classify(401)).toBe("auth");
    expect(DEEPSEEK_HTTP_PROFILE.classify(402)).toBe("billing");
    expect(DEEPSEEK_HTTP_PROFILE.classify(408)).toBe("timeout");
    expect(DEEPSEEK_HTTP_PROFILE.classify(504)).toBe("timeout");
    expect(DEEPSEEK_HTTP_PROFILE.classify(429)).toBe("rate_limit");
    expect(DEEPSEEK_HTTP_PROFILE.classify(403)).toBe("api");
    expect(DEEPSEEK_HTTP_PROFILE.classify(404)).toBe("api");
    expect(DEEPSEEK_HTTP_PROFILE.classify(500)).toBe("api");
  });

  it("explains the actionable ones", () => {
    expect(DEEPSEEK_HTTP_PROFILE.describe(402, null)).toMatch(/Top up/);
    expect(DEEPSEEK_HTTP_PROFILE.describe(401, null)).toMatch(/DEEPSEEK_API_KEY/);
    expect(DEEPSEEK_HTTP_PROFILE.describe(429, null)).toMatch(/Do not retry/);
    expect(DEEPSEEK_HTTP_PROFILE.describe(418, "teapot")).toMatch(/teapot/);
  });

  it("surfaces the OpenAI-compatible error message", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(
        {
          error: {
            message: "'count' must be between 1 and 50",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request_error",
          },
        },
        400,
      ),
    );

    const promise = deepseekRequest(DEEPSEEK_SEARCH_URL, "sk-x", {}, { fetchImpl });
    await expect(promise).rejects.toMatchObject({ kind: "api", status: 400 });
    await expect(promise).rejects.toThrow(/'count' must be between 1 and 50/);
  });
});

// =============================================================================
// Search call
// =============================================================================

describe("deepseekSearch", () => {
  it("posts to the search endpoint and reports elapsed time", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(searchPayload));

    const response = await deepseekSearch("sk-test-key-1234567890", baseOptions(), {
      fetchImpl,
    });

    expect(calls[0].url).toBe(DEEPSEEK_SEARCH_URL);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      query: "deepseek v4",
      count: 5,
      need_content: false,
    });
    expect(response.results).toHaveLength(2);
    expect(response.responseTime).toBeGreaterThanOrEqual(0);
  });

  it("validates before making a request", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ results: [] }));
    await expect(
      deepseekSearch("key", baseOptions({ query: "" }), { fetchImpl }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      deepseekSearch("key", baseOptions({ query: "x".repeat(129) }), { fetchImpl }),
    ).rejects.toThrow(/128/);
    expect(calls).toHaveLength(0);
  });
});

// =============================================================================
// Fetch (batch) call
// =============================================================================

describe("deepseekExtract", () => {
  it("fetches one URL per request and keeps going after a blocked page", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { url: string };
      seen.push(body.url);
      if (body.url === "https://blocked.example/") {
        return jsonResponse({ error: { message: "policy" } }, 403);
      }
      return jsonResponse({ title: "T", content: `# ${body.url}` });
    }) as typeof fetch;

    const response = await deepseekExtract(
      "sk-key",
      { urls: ["https://a.example", "https://blocked.example", "https://c.example"] },
      { fetchImpl },
    );

    expect(seen).toEqual([
      "https://a.example/",
      "https://blocked.example/",
      "https://c.example/",
    ]);
    expect(response.results.map((r) => r.url)).toEqual([
      "https://a.example/",
      "https://c.example/",
    ]);
    expect(response.failedResults).toHaveLength(1);
    expect(response.failedResults[0].url).toBe("https://blocked.example/");
    expect(response.warnings?.[0]).toMatch(/sequential DeepSeek fetch requests/);
  });

  it("treats 404 as a per-URL failure", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: "no content" } }, 404)) as typeof fetch;
    const response = await deepseekExtract(
      "key",
      { urls: ["https://empty.example"] },
      { fetchImpl },
    );
    expect(response.results).toEqual([]);
    expect(response.failedResults[0].error).toMatch(/no extractable page content/);
  });

  it("aborts the batch on an account-level failure", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: "insufficient balance" } }, 402)) as typeof fetch;
    await expect(
      deepseekExtract("key", { urls: ["https://a.example", "https://b.example"] }, {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: "billing" });
  });

  it("skips the sequential-request note for a single URL", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ title: "T", content: "body" })) as typeof fetch;
    const response = await deepseekExtract(
      "key",
      { urls: ["https://a.example"] },
      { fetchImpl },
    );
    expect(response.warnings).toEqual([]);
  });

  it("rejects unknown provider_options", async () => {
    await expect(
      deepseekExtract("key", {
        urls: ["https://a.example"],
        options: { extract_depth: "advanced" },
      }),
    ).rejects.toThrow(/accepts no provider_options/);
  });

  it("uses the fetch endpoint", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ title: "T", content: "body" }),
    );
    await deepseekExtract("key", { urls: ["https://a.example"] }, { fetchImpl });
    expect(calls[0].url).toBe(DEEPSEEK_FETCH_URL);
    expect(DEEPSEEK_FETCH_URL).toBe("https://api.deepseek.com/v1/tools/fetch");
  });

  it("propagates an abort to stop the loop early", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      return jsonResponse({ title: "T", content: "body" });
    }) as typeof fetch;

    const response = await deepseekExtract(
      "key",
      { urls: ["https://a.example", "https://b.example"] },
      { fetchImpl, signal: controller.signal },
    );
    expect(response.results).toHaveLength(1);
  });
});

// =============================================================================
// Registry integration
// =============================================================================

describe("deepseek in the registry", () => {
  it("is reachable by id", async () => {
    const { getProvider, runSearch } = await import("./registry.js");
    expect(getProvider("deepseek")?.label).toBe("DeepSeek");

    const { fetchImpl } = mockFetch(() => jsonResponse(searchPayload));
    const response = await runSearch(deepseekProvider, "sk-key", baseOptions(), {
      fetchImpl,
    });
    // 2.4/3 = 0.8 >= 0.5 -> high; 0.6/3 = 0.2 < 1/3 -> low
    expect(response.results.map((r) => r.quality)).toEqual(["high", "low"]);
  });
});

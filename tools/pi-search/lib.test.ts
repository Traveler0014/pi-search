/**
 * Unit tests for pi-search pure logic.
 *
 * Run: npm test
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESULTS,
  EXTRACT_DEPTHS,
  SEARCH_DEPTHS,
  SEARCH_TOPICS,
  TAVILY_EXTRACT_URL,
  TAVILY_SEARCH_URL,
  TavilyError,
  buildExtractBody,
  buildSearchBody,
  formatExtractResponse,
  formatSearchResponse,
  isValidApiKey,
  loadConfig,
  maskApiKey,
  normalizeDomain,
  parseExtractResponse,
  parseSearchResponse,
  resolveApiKey,
  saveConfig,
  tavilyExtract,
  tavilyRequest,
  tavilySearch,
  validateExtractOptions,
  validateSearchOptions,
  validateUrl,
  type SearchOptions,
} from "./lib.js";

// =============================================================================
// Helpers
// =============================================================================

const tmpDirs: string[] = [];

function tmpConfigFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "pi-search.json");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function mockFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const sampleSearchPayload = {
  query: "typescript release",
  answer: "TypeScript 6.0 was released.",
  results: [
    {
      title: "TypeScript 6.0",
      url: "https://devblogs.microsoft.com/typescript/",
      content: "Announcing TypeScript 6.0 with faster builds.",
      score: 0.91,
      raw_content: null,
      id: "abc",
    },
    {
      title: "Release notes",
      url: "https://github.com/microsoft/TypeScript/releases",
      content: "Release notes for TypeScript.",
      score: 0.77,
      raw_content: "# Release notes",
      id: "def",
    },
    { title: "no url", score: 0.1 },
  ],
  response_time: 0.42,
  request_id: "req-1",
};

// =============================================================================
// Config
// =============================================================================

describe("config", () => {
  it("returns an empty config when the file is missing", () => {
    expect(loadConfig(tmpConfigFile())).toEqual({ apiKey: "" });
  });

  it("round-trips the API key", () => {
    const file = tmpConfigFile();
    saveConfig({ apiKey: "  tvly-test-key-123456  " }, file);
    expect(loadConfig(file)).toEqual({ apiKey: "tvly-test-key-123456" });
  });

  it("treats corrupt config as unconfigured", () => {
    const file = tmpConfigFile();
    fs.writeFileSync(file, "{not json");
    expect(loadConfig(file)).toEqual({ apiKey: "" });
  });

  it("prefers the environment over the config file", () => {
    const file = tmpConfigFile();
    saveConfig({ apiKey: "tvly-from-file-1234" }, file);

    expect(resolveApiKey({ TAVILY_API_KEY: " tvly-from-env-1234 " }, file)).toEqual({
      apiKey: "tvly-from-env-1234",
      source: "env",
    });
    expect(resolveApiKey({}, file)).toEqual({
      apiKey: "tvly-from-file-1234",
      source: "config",
    });
  });

  it("returns null when no key is configured", () => {
    expect(resolveApiKey({}, tmpConfigFile())).toBeNull();
    expect(resolveApiKey({ TAVILY_API_KEY: "   " }, tmpConfigFile())).toBeNull();
  });

  it("validates key format", () => {
    expect(isValidApiKey("tvly-dev-example-key-1234567890")).toBe(true);
    expect(isValidApiKey("tvly-short")).toBe(false);
    expect(isValidApiKey("sk-not-tavily-123456")).toBe(false);
    expect(isValidApiKey("")).toBe(false);
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
    ...overrides,
  });

  it("accepts a minimal query", () => {
    expect(() => validateSearchOptions(base())).not.toThrow();
  });

  it("rejects empty or whitespace queries", () => {
    expect(() => validateSearchOptions(base({ query: "" }))).toThrow(/non-empty/);
    expect(() => validateSearchOptions(base({ query: "   " }))).toThrow(/non-empty/);
  });

  it("rejects queries over 400 chars", () => {
    expect(() => validateSearchOptions(base({ query: "x".repeat(401) }))).toThrow(
      /400/,
    );
    expect(() =>
      validateSearchOptions(base({ query: "x".repeat(400) })),
    ).not.toThrow();
  });

  it("enforces max_results bounds", () => {
    for (const bad of [0, 21, 1.5, -1]) {
      expect(() => validateSearchOptions(base({ maxResults: bad }))).toThrow(
        /max_results/,
      );
    }
    expect(() => validateSearchOptions(base({ maxResults: 1 }))).not.toThrow();
    expect(() => validateSearchOptions(base({ maxResults: 20 }))).not.toThrow();
  });

  it("enforces days bounds", () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() => validateSearchOptions(base({ days: bad }))).toThrow(/days/);
    }
    expect(() => validateSearchOptions(base({ days: 1 }))).not.toThrow();
  });

  it("rejects invalid enums at runtime", () => {
    expect(() =>
      validateSearchOptions(
        base({ searchDepth: "deep" as unknown as SearchOptions["searchDepth"] }),
      ),
    ).toThrow(/search_depth/);
    expect(() =>
      validateSearchOptions(
        base({ topic: "sports" as unknown as SearchOptions["topic"] }),
      ),
    ).toThrow(/topic/);
  });

  it("rejects invalid domain filters", () => {
    expect(() =>
      validateSearchOptions(base({ includeDomains: ["not a domain"] })),
    ).toThrow(/include_domains/);
    expect(() =>
      validateSearchOptions(base({ excludeDomains: ["https://example.com/path"] })),
    ).not.toThrow();
    expect(() =>
      validateSearchOptions(base({ excludeDomains: ["ftp://example.com"] })),
    ).toThrow(/exclude_domains/);
  });

  it("rejects an empty country", () => {
    expect(() => validateSearchOptions(base({ country: "  " }))).toThrow(/country/);
  });

  it("exports the supported enum values", () => {
    expect(SEARCH_DEPTHS).toEqual(["basic", "advanced"]);
    expect(SEARCH_TOPICS).toEqual(["general", "news", "finance"]);
    expect(EXTRACT_DEPTHS).toEqual(["basic", "advanced"]);
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

  it("rejects an invalid depth at runtime", () => {
    expect(() =>
      validateExtractOptions({
        urls: ["https://example.com"],
        extractDepth: "deep" as unknown as "basic",
      }),
    ).toThrow(/extract_depth/);
  });
});

// =============================================================================
// Request bodies
// =============================================================================

describe("buildSearchBody", () => {
  it("builds defaults", () => {
    expect(buildSearchBody({ query: "  hello  " })).toEqual({
      query: "hello",
      search_depth: "basic",
      topic: "general",
      max_results: DEFAULT_MAX_RESULTS,
      include_answer: false,
      include_raw_content: false,
    });
  });

  it("maps every option and dedupes normalized domains", () => {
    expect(
      buildSearchBody({
        query: "news",
        searchDepth: "advanced",
        topic: "news",
        maxResults: 3,
        includeAnswer: true,
        includeRawContent: true,
        includeDomains: ["https://www.Example.com/a", "example.com"],
        excludeDomains: ["pinterest.com", "www.pinterest.com"],
        days: 7,
        country: " germany ",
      }),
    ).toEqual({
      query: "news",
      search_depth: "advanced",
      topic: "news",
      max_results: 3,
      include_answer: true,
      include_raw_content: true,
      include_domains: ["example.com"],
      exclude_domains: ["pinterest.com"],
      days: 7,
      country: "germany",
    });
  });
});

describe("buildExtractBody", () => {
  it("builds defaults and dedupes URLs", () => {
    expect(
      buildExtractBody({
        urls: ["https://example.com", "https://example.com/"],
      }),
    ).toEqual({
      urls: ["https://example.com/"],
      extract_depth: "basic",
      include_images: false,
    });
  });
});

// =============================================================================
// HTTP client
// =============================================================================

describe("tavilyRequest", () => {
  it("sends bearer auth and the JSON body", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ results: [] }),
    );

    const payload = await tavilyRequest<{ results: unknown[] }>(
      TAVILY_SEARCH_URL,
      "tvly-test-key-1234",
      { query: "hello" },
      { fetchImpl },
    );

    expect(payload).toEqual({ results: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAVILY_SEARCH_URL);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tvly-test-key-1234");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "hello" });
  });

  it.each([
    [401, "auth", /rejected the API key/],
    [403, "auth", /rejected the API key/],
    [429, "rate_limit", /rate limit/],
    [432, "rate_limit", /plan limit/],
    [433, "rate_limit", /plan limit/],
    [400, "api", /HTTP 400/],
    [500, "api", /HTTP 500/],
  ])("maps HTTP %i to a %s error", async (status, kind, pattern) => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ detail: { error: "upstream detail" } }, status),
    );

    await expect(
      tavilyRequest(TAVILY_SEARCH_URL, "key", {}, { fetchImpl }),
    ).rejects.toMatchObject({ kind, status });
    await expect(
      tavilyRequest(TAVILY_SEARCH_URL, "key", {}, { fetchImpl }),
    ).rejects.toThrow(pattern);
  });

  it("wraps network failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await expect(
      tavilyRequest(TAVILY_SEARCH_URL, "key", {}, { fetchImpl }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("times out", async () => {
    const fetchImpl = ((_input: FetchInput, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;

    await expect(
      tavilyRequest(TAVILY_SEARCH_URL, "key", {}, { fetchImpl, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports external cancellation as aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_input: FetchInput, init?: FetchInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as typeof fetch;

    const promise = tavilyRequest(TAVILY_SEARCH_URL, "key", {}, {
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
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
      { query: "typescript release", maxResults: 2, includeAnswer: true },
      { fetchImpl },
    );

    expect(calls[0].url).toBe(TAVILY_SEARCH_URL);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      query: "typescript release",
      max_results: 2,
      include_answer: true,
    });

    expect(response.query).toBe("typescript release");
    expect(response.answer).toBe("TypeScript 6.0 was released.");
    expect(response.results).toHaveLength(2); // item without URL is dropped
    expect(response.results[0]).toMatchObject({
      title: "TypeScript 6.0",
      score: 0.91,
    });
    expect(response.responseTime).toBe(0.42);
    expect(response.requestId).toBe("req-1");
  });

  it("validates before making a request", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ results: [] }));
    await expect(
      tavilySearch("key", { query: "" }, { fetchImpl }),
    ).rejects.toThrow(/non-empty/);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed responses", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ nope: true }));
    await expect(
      tavilySearch("key", { query: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TavilyError);
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
});

describe("formatSearchResponse", () => {
  it("renders the answer, titles, URLs, and scores", () => {
    const text = formatSearchResponse(
      parseSearchResponse(sampleSearchPayload),
    );
    expect(text).toContain("Answer: TypeScript 6.0 was released.");
    expect(text).toContain("1. TypeScript 6.0");
    expect(text).toContain("URL: https://devblogs.microsoft.com/typescript/");
    expect(text).toContain("Score: 0.910");
  });

  it("gives recovery hints when there are no results", () => {
    const text = formatSearchResponse({
      query: "nothing",
      answer: null,
      results: [],
      responseTime: 0.1,
    });
    expect(text).toContain('No results for "nothing"');
    expect(text).toContain("include_domains");
  });

  it("truncates to maxChars", () => {
    const text = formatSearchResponse(
      parseSearchResponse(sampleSearchPayload),
      { maxChars: 60 },
    );
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text).toContain("[truncated]");
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
      rawContent: "Hello world",
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

describe("formatExtractResponse", () => {
  it("renders pages and failures", () => {
    const text = formatExtractResponse(
      parseExtractResponse({
        results: [
          { url: "https://a.example", raw_content: "Page A body" },
        ],
        failed_results: [{ url: "https://b.example", error: "blocked" }],
      }),
    );
    expect(text).toContain("Page A body");
    expect(text).toContain("Failed (1):");
    expect(text).toContain("https://b.example: blocked");
  });

  it("truncates each page", () => {
    const text = formatExtractResponse(
      {
        results: [
          { url: "https://a.example", rawContent: "x".repeat(100) },
        ],
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
});

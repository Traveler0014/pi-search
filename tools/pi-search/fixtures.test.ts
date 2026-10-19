/**
 * Regression tests against payloads captured from the live Tavily API
 * (2026-11, post-parse adapter output).
 *
 * These exist because live testing found three things unit fixtures missed:
 *   - `published_date` is RFC 1123, not ISO, so dates silently disappeared;
 *   - the same article can come back twice with a URL fragment;
 *   - the score distribution sits far higher than a guessed cutoff assumed.
 *
 * Run: npm test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { formatExtractResponse, formatSearchResponse } from "./core/format.js";
import { countDuplicates, dedupeResults } from "./core/results.js";
import { finalizeSearchResponse } from "./core/score.js";
import type { ExtractResponse, SearchResponse } from "./core/types.js";
import { parseFetchResponse, parseSearchResponse } from "./providers/deepseek.js";
import { runSearch } from "./providers/registry.js";
import { tavilyProvider } from "./providers/tavily.js";

const FIXTURES = path.resolve("tools/pi-search/providers/fixtures");

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8")) as T;
}

const vague = fixture<SearchResponse>("tavily-search-vague-2026-11.json");
const content = fixture<SearchResponse>("tavily-search-content-duplicate-2026-11.json");
const extract = fixture<ExtractResponse>("tavily-extract-404-2026-11.json");

describe("live fixture: vague query score distribution", () => {
  it("keeps the distribution that justifies the cutoffs", () => {
    expect(vague.results.map((r) => Number(r.score?.toFixed(3)))).toEqual([
      0.838, 0.809, 0.806, 0.708, 0.706, 0.691, 0.67, 0.494, 0.41,
    ]);
  });

  it("splits into a usable high/medium/low mix", () => {
    const scored = finalizeSearchResponse(vague, tavilyProvider.scores);
    const counts = { high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const result of scored.results) counts[result.quality!]++;
    expect(counts).toEqual({ high: 3, medium: 4, low: 2 });
  });

  it("renders the level next to the normalized score", () => {
    const text = formatSearchResponse(
      finalizeSearchResponse(vague, tavilyProvider.scores),
    );
    expect(text).toContain("score 0.84 (high)");
    expect(text).toContain("score 0.41 (low)");
  });
});

describe("live fixture: RFC 1123 publication dates", () => {
  it("keeps the provider's raw date strings", () => {
    expect(content.results[0].publishedAt).toBe("Thu, 18 Dec 2025 14:52:58 GMT");
  });

  it("renders them as calendar dates instead of dropping them", () => {
    const text = formatSearchResponse({
      ...content,
      results: dedupeResults(content.results),
    });
    expect(text).toContain("2025-12-18");
    expect(text).toContain("2026-06-25");
  });
});

describe("live fixture: duplicate pages", () => {
  it("detects the duplicated article that differs only by fragment", () => {
    expect(content.results).toHaveLength(3);
    expect(countDuplicates(content.results)).toBe(1);

    const deduped = dedupeResults(content.results);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].url).not.toContain("#");
  });

  it("is removed by runSearch, with a note", async () => {
    const response = await runSearch(
      {
        ...tavilyProvider,
        search: async () => content,
      },
      "key",
      { query: "ai model release", maxResults: 3, detail: "content" },
    );

    expect(response.results).toHaveLength(2);
    expect(response.warnings).toContain("1 duplicate result removed");
  });
});

describe("live fixture: DeepSeek search (raw API payload)", () => {
  const raw = fixture<unknown>("deepseek-search-2026-11.json");

  it("parses rerank_score, ISO dates, and site names", () => {
    const response = parseSearchResponse(raw, "summary");
    expect(response.results).toHaveLength(5);

    const first = response.results[0];
    expect(first.rawScore).toBeCloseTo(2.289, 3);
    expect(first.score).toBeCloseTo(2.289 / 3, 3);
    expect(first.publishedAt).toBe("2026-04-26T16:00:00+00:00");
    expect(first.siteName).toBe("央广网");
    expect(first.kind).toBe("summary");
    expect(first.text.length).toBeGreaterThan(200);
  });

  it("keeps every observed authority in the unremarkable range", () => {
    const response = parseSearchResponse(raw, "summary");
    expect(response.results.map((r) => r.flags)).toEqual([[], [], [], [], []]);
  });

  it("renders the publisher name when it beats the domain", () => {
    const text = formatSearchResponse(
      finalizeSearchResponse(parseSearchResponse(raw, "summary"), tavilyProvider.scores),
    );
    expect(text).toContain("| 央广网");
    expect(text).toContain("| 证券时报");
    expect(text).toContain("(high)");
  });
});

describe("live fixture: DeepSeek fetch (raw API payload)", () => {
  const raw = fixture<{ title: string; content: string }>("deepseek-fetch-2026-11.json");

  it("has the escaping that broke URLs, now undone", () => {
    expect(raw.content).toContain("https\\:\\/\\/api\\.deepseek\\.com");
    const page = parseFetchResponse(raw, "https://api-docs.deepseek.com/zh-cn/guides/search");
    expect(page.text).toContain("https://api.deepseek.com");
    expect(page.text).not.toContain("\\/");
    expect(page.title).toBe("网页搜索与抓取");
  });
});

describe("live fixture: extract with a failing URL", () => {
  it("keeps the success and reports the 404", () => {
    expect(extract.results).toHaveLength(1);
    expect(extract.failedResults[0].error).toContain("404");

    const text = formatExtractResponse(extract);
    expect(text).toContain("Failed (1):");
    expect(text).toContain("404 page not found");
  });

  it("carries a realistic amount of page text", () => {
    expect(extract.results[0].text.length).toBeGreaterThan(1_500);
  });
});

/**
 * Unit tests for score normalization and quality classification.
 *
 * Run: npm test
 */

import { describe, expect, it } from "vitest";
import {
  clampUnit,
  classifyScore,
  finalizeSearchResponse,
  finalizeSearchResults,
  normalizeScaledScore,
  normalizeUnitScore,
} from "../core/score.js";
import { DEFAULT_SCORE_CUTOFFS, type SearchResultItem } from "../core/types.js";

const cutoffs = { high: 0.5, medium: 0.3 };

describe("clampUnit", () => {
  it("clamps into 0..1", () => {
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(0.42)).toBe(0.42);
    expect(clampUnit(1.7)).toBe(1);
  });

  it("treats non-finite values as 0", () => {
    expect(clampUnit(Number.NaN)).toBe(0);
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("normalizeUnitScore", () => {
  it("passes 0..1 through and clamps the rest", () => {
    expect(normalizeUnitScore(0.91)).toBe(0.91);
    expect(normalizeUnitScore(1.2)).toBe(1);
    expect(normalizeUnitScore(-0.2)).toBe(0);
  });
});

describe("normalizeScaledScore", () => {
  it("divides by the provider's documented maximum", () => {
    // DeepSeek rerank_score is 0..3 and >= 1.5 is documented as high quality.
    expect(normalizeScaledScore(3, 3)).toBe(1);
    expect(normalizeScaledScore(1.5, 3)).toBe(0.5);
    expect(normalizeScaledScore(0, 3)).toBe(0);
  });

  it("clamps values beyond the maximum", () => {
    expect(normalizeScaledScore(4.2, 3)).toBe(1);
  });

  it("guards against a bogus maximum", () => {
    expect(normalizeScaledScore(1, 0)).toBe(0);
    expect(normalizeScaledScore(1, Number.NaN)).toBe(0);
  });
});

describe("classifyScore", () => {
  it("returns the level at the boundary, not above it", () => {
    expect(classifyScore(0.5, cutoffs)).toBe("high");
    expect(classifyScore(0.4999, cutoffs)).toBe("medium");
    expect(classifyScore(0.3, cutoffs)).toBe("medium");
    expect(classifyScore(0.2999, cutoffs)).toBe("low");
    expect(classifyScore(0, cutoffs)).toBe("low");
  });

  it("leaves a missing score unclassified", () => {
    expect(classifyScore(undefined, cutoffs)).toBeUndefined();
  });

  it("ships defaults for uncalibrated providers", () => {
    expect(classifyScore(DEFAULT_SCORE_CUTOFFS.high, DEFAULT_SCORE_CUTOFFS)).toBe(
      "high",
    );
    expect(classifyScore(0, DEFAULT_SCORE_CUTOFFS)).toBe("low");
  });
});

describe("finalizeSearchResults", () => {
  const base = (overrides: Partial<SearchResultItem> = {}): SearchResultItem => ({
    title: "t",
    url: "https://example.com/",
    text: "c",
    kind: "summary",
    ...overrides,
  });

  it("stamps quality without touching other fields", () => {
    const [result] = finalizeSearchResults(
      [base({ score: 0.8, rawScore: 2.4, publishedAt: "2024-01-01" })],
      cutoffs,
    );
    expect(result).toMatchObject({
      score: 0.8,
      rawScore: 2.4,
      publishedAt: "2024-01-01",
      quality: "high",
    });
  });

  it("keeps results that have no score untouched", () => {
    const input = base();
    const [result] = finalizeSearchResults([input], cutoffs);
    expect(result).toBe(input);
    expect(result.quality).toBeUndefined();
  });

  it("preserves provider flags", () => {
    const [result] = finalizeSearchResults(
      [base({ score: 0.9, flags: ["authoritative"] })],
      cutoffs,
    );
    expect(result.flags).toEqual(["authoritative"]);
  });
});

describe("finalizeSearchResponse", () => {
  it("classifies every scored result", () => {
    const response = finalizeSearchResponse(
      {
        query: "q",
        answer: null,
        responseTime: 1,
        results: [
          { title: "a", url: "https://a/", text: "", kind: "summary", score: 0.9 },
          { title: "b", url: "https://b/", text: "", kind: "summary", score: 0.2 },
        ],
      },
      cutoffs,
    );
    expect(response.results.map((r) => r.quality)).toEqual(["high", "low"]);
  });
});

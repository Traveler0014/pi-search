/**
 * Provider selection.
 *
 * The failure this guards against: with only a DeepSeek key stored and no
 * `defaultProvider`, every unqualified `search_web` call picked the first
 * registered backend (Tavily) and died with "Tavily API key not configured"
 * even though a usable backend was configured.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, withApiKey, withDefaultProvider } from "../core/config.js";
import { PROVIDERS, selectProvider } from "./registry.js";

const tavilyKey = (config = EMPTY_CONFIG) =>
  withApiKey(config, "tavily", "tvly-abcdefghijklmnop");
const deepseekKey = (config = EMPTY_CONFIG) =>
  withApiKey(config, "deepseek", "sk-abcdefghijklmnopqrst");

describe("selectProvider", () => {
  it("uses the configured default when it has a key", () => {
    const config = deepseekKey(withDefaultProvider(tavilyKey(), "deepseek"));
    const selection = selectProvider(undefined, config);

    expect(selection.provider.id).toBe("deepseek");
    expect(selection.explicit).toBe(false);
    expect(selection.note).toBeUndefined();
  });

  it("skips a keyless default for the backend that has a key", () => {
    const selection = selectProvider(
      undefined,
      withDefaultProvider(deepseekKey(), "tavily"),
    );

    expect(selection.provider.id).toBe("deepseek");
    expect(selection.explicit).toBe(false);
    expect(selection.note).toContain("Tavily has no API key");
    expect(selection.note).toContain("/search-provider deepseek");
  });

  it("skips the first registered backend when only a later one has a key", () => {
    // No defaultProvider at all — the shape of a fresh multi-provider config.
    const selection = selectProvider(undefined, deepseekKey());

    expect(selection.provider.id).toBe("deepseek");
    expect(selection.explicit).toBe(false);
    expect(selection.note).toBeUndefined();
  });

  it("honours an explicit backend even without a key", () => {
    // The explicit path must surface its own "not configured" error instead of
    // silently answering from a different backend.
    const config = deepseekKey(withDefaultProvider(deepseekKey(), "deepseek"));
    const selection = selectProvider("tavily", config);

    expect(selection.provider.id).toBe("tavily");
    expect(selection.explicit).toBe(true);
    expect(selection.note).toBeUndefined();
  });

  it("falls back when the configured default names an unknown backend", () => {
    const config = withDefaultProvider(deepseekKey(), "removed-backend");
    const selection = selectProvider(undefined, config);

    expect(selection.provider.id).toBe("deepseek");
    expect(selection.note).toContain("is not a known backend");
  });

  it("keeps the keyless default when no backend has a key", () => {
    // Nothing else to fall back to: the error should name what the user meant.
    const selection = selectProvider(
      undefined,
      withDefaultProvider(EMPTY_CONFIG, PROVIDERS[1].id),
    );

    expect(selection.provider.id).toBe(PROVIDERS[1].id);
    expect(selection.note).toBeUndefined();
  });

  it("falls back to the first registered backend with an empty config", () => {
    expect(selectProvider(undefined, EMPTY_CONFIG).provider.id).toBe(
      PROVIDERS[0].id,
    );
  });
});

/**
 * Config mutations and the key copy shared with the TUI.
 *
 * Every write goes through `mutateConfig`; these tests pin the file shape so the
 * settings menu and `/search-key` cannot diverge.
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type SearchConfig } from "./config.js";
import {
  envOverrideNote,
  keyFormatError,
  removeProviderKey,
  saveDefaultProvider,
  saveProviderKey,
  type KeyTarget,
} from "./settings.js";
import { cleanupTmpDirs, tmpConfigFile } from "../support/test-helpers.js";

afterEach(cleanupTmpDirs);

const target: KeyTarget = {
  id: "tavily",
  label: "Tavily",
  apiKeyEnv: ["TAVILY_API_KEY"],
  looksLikeKey: (key) => key.startsWith("tvly-"),
};

describe("config mutations", () => {
  it("stores a key without disturbing other state", async () => {
    const file = tmpConfigFile();
    saveConfig(seededConfig(), file);

    await saveProviderKey("deepseek", "sk-abcdefghijklmnop", file);

    const config = loadConfig(file);
    expect(config.defaultProvider).toBe("tavily");
    expect(config.providers.deepseek?.apiKey).toBe("sk-abcdefghijklmnop");
  });

  it("trims the key it stores", async () => {
    const file = tmpConfigFile();

    await saveProviderKey("tavily", "  tvly-abcdefghijklmnop  ", file);

    expect(loadConfig(file).providers.tavily?.apiKey).toBe(
      "tvly-abcdefghijklmnop",
    );
  });

  it("removes a stored key but keeps the provider's other state", async () => {
    const file = tmpConfigFile();
    saveConfig(seededConfig(), file);
    await saveProviderKey("tavily", "tvly-abcdefghijklmnop", file);

    await removeProviderKey("tavily", file);

    const config = loadConfig(file);
    expect(config.providers.tavily).toBeUndefined();
    expect(config.defaultProvider).toBe("tavily");
  });

  it("sets and clears the default provider", async () => {
    const file = tmpConfigFile();

    await saveDefaultProvider("deepseek", file);
    expect(loadConfig(file).defaultProvider).toBe("deepseek");

    await saveDefaultProvider(undefined, file);
    expect(loadConfig(file).defaultProvider).toBeUndefined();
  });

  it("writes owner-only permissions", async () => {
    const file = tmpConfigFile();

    await saveProviderKey("tavily", "tvly-abcdefghijklmnop", file);

    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("creates the file when it does not exist yet", async () => {
    const file = tmpConfigFile();

    await saveProviderKey("tavily", "tvly-abcdefghijklmnop", file);

    expect(fs.existsSync(file)).toBe(true);
  });

  it("serializes concurrent writes instead of dropping one", async () => {
    const file = tmpConfigFile();

    await Promise.all([
      saveProviderKey("tavily", "tvly-abcdefghijklmnop", file),
      saveProviderKey("deepseek", "sk-abcdefghijklmnop", file),
      saveDefaultProvider("deepseek", file),
    ]);

    const config = loadConfig(file);
    expect(config.providers.tavily?.apiKey).toBe("tvly-abcdefghijklmnop");
    expect(config.providers.deepseek?.apiKey).toBe("sk-abcdefghijklmnop");
    expect(config.defaultProvider).toBe("deepseek");
  });
});

describe("keyFormatError", () => {
  it("rejects an empty value", () => {
    expect(keyFormatError(target, "   ")).toBe("No key entered.");
  });

  it("rejects a key of the wrong shape, naming the backend", () => {
    expect(keyFormatError(target, "sk-nope")).toBe(
      "Invalid key format: expected a Tavily API key.",
    );
  });

  it("accepts a plausible key", () => {
    expect(keyFormatError(target, "tvly-abcdefghijklmnop")).toBeNull();
  });
});

describe("envOverrideNote", () => {
  it("is empty when no env var is set", () => {
    expect(envOverrideNote(target, {})).toBe("");
  });

  it("names the env var that shadows the stored key", () => {
    expect(envOverrideNote(target, { TAVILY_API_KEY: "tvly-env" })).toBe(
      " Note: TAVILY_API_KEY is set and takes precedence over the stored key.",
    );
  });

  it("ignores blank env vars", () => {
    expect(envOverrideNote(target, { TAVILY_API_KEY: "   " })).toBe("");
  });
});

/** A v2 config with a non-default `defaultProvider`, used to spot clobbering. */
function seededConfig(): SearchConfig {
  return {
    version: 2,
    defaultProvider: "tavily",
    providers: { tavily: { apiKey: "tvly-oldkey1234567890" } },
  };
}

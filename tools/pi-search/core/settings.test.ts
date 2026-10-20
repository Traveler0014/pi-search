/**
 * Config mutations.
 *
 * Every write goes through `mutateConfig`; these tests pin the file shape the
 * settings menu depends on.
 */

import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type SearchConfig } from "./config.js";
import {
  removeProviderKey,
  saveDefaultProvider,
  saveProviderKey,
} from "./settings.js";
import { cleanupTmpDirs, tmpConfigFile } from "../support/test-helpers.js";

afterEach(cleanupTmpDirs);

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

/** A v2 config with a pinned default, used to spot clobbering. */
function seededConfig(): SearchConfig {
  return {
    version: 2,
    defaultProvider: "tavily",
    providers: { tavily: { apiKey: "tvly-oldkey1234567890" } },
  };
}

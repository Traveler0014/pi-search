/**
 * The `/search-config` menu, driven headlessly.
 *
 * Navigation is scripted by row index (0, 1, …) rather than by label text, so
 * the tests assert flow and persistence without freezing the copy. Row text is
 * asserted where it is the point: it must show live state, because a settings
 * menu that lies about the current value is worse than no menu.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type SearchConfig } from "../core/config.js";
import {
  removeProviderKey,
  saveDefaultProvider,
  saveProviderKey,
} from "../core/settings.js";
import { PROVIDERS } from "../providers/registry.js";
import {
  buildSettingsMenu,
  describeKey,
  runMenu,
  settingsSummary,
  type Menu,
  type MenuIO,
  type SettingsDeps,
} from "./config-menu.js";
import { cleanupTmpDirs, tmpConfigFile } from "../support/test-helpers.js";

afterEach(cleanupTmpDirs);

// =============================================================================
// Harness
// =============================================================================

type Pick = number | string | undefined;

interface Plan {
  /** One entry per `select` call: row index, label substring, or `undefined` to cancel. */
  select?: Pick[];
  input?: (string | undefined)[];
  confirm?: boolean[];
}

interface Harness {
  io: MenuIO;
  /** Options rendered by each `select` call, in order. */
  rendered: string[][];
  notifications: { message: string; type?: string }[];
}

function scriptedIO(plan: Plan): Harness {
  const rendered: string[][] = [];
  const notifications: { message: string; type?: string }[] = [];
  let selects = 0;
  let inputs = 0;
  let confirms = 0;

  const io: MenuIO = {
    select: async (_title, options) => {
      rendered.push(options);
      const pick = plan.select?.[selects++];
      if (pick === undefined) return undefined;
      if (typeof pick === "number") return options[pick];
      return options.find((option) => option.includes(pick));
    },
    input: async () => plan.input?.[inputs++],
    confirm: async () => plan.confirm?.[confirms++] ?? false,
    notify: (message, type) => {
      notifications.push({ message, type });
    },
  };

  return { io, rendered, notifications };
}

function setup(file: string, seed?: SearchConfig) {
  if (seed) saveConfig(seed, file);

  const deps: SettingsDeps = {
    providers: PROVIDERS,
    config: () => loadConfig(file),
    configPath: file,
    saveKey: (provider, key) => saveProviderKey(provider.id, key, file),
    clearKey: (provider) => removeProviderKey(provider.id, file),
    setDefault: (provider) => saveDefaultProvider(provider?.id, file),
  };

  return { file, deps, menu: buildSettingsMenu(deps) };
}

const TAVILY = 0;
const DEEPSEEK = 1;
/** Root rows after the provider rows: default submenu, then the summary. */
const DEFAULT_ROW = PROVIDERS.length;

const tavilyKey = "tvly-abcdefghijklmnop";
const deepseekKey = "sk-abcdefghijklmnop";

// =============================================================================
// Provider keys
// =============================================================================

describe("provider key rows", () => {
  it("stores a key typed in the provider submenu", async () => {
    const { file, menu } = setup(tmpConfigFile());
    const io = scriptedIO({
      select: [TAVILY, 0],
      input: [tavilyKey],
    });

    await runMenu(menu, io.io);

    expect(loadConfig(file).providers.tavily?.apiKey).toBe(tavilyKey);
    expect(io.notifications.at(-1)?.message).toContain("Saved Tavily API key");
  });

  it("rejects a malformed key and leaves the file untouched", async () => {
    const { file, menu } = setup(tmpConfigFile());
    const io = scriptedIO({
      select: [TAVILY, 0],
      input: ["not-a-key"],
    });

    await runMenu(menu, io.io);

    expect(loadConfig(file).providers.tavily).toBeUndefined();
    expect(io.notifications.at(-1)?.type).toBe("error");
    expect(io.notifications.at(-1)?.message).toContain("Invalid key format");
  });

  it("treats a cancelled input as no change", async () => {
    const { file, menu } = setup(tmpConfigFile());
    const io = scriptedIO({ select: [TAVILY, 0], input: [undefined] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).providers.tavily).toBeUndefined();
    expect(io.notifications.at(-1)?.message).toBe("Cancelled.");
  });

  it("offers no clear row when no key is stored", async () => {
    const { menu } = setup(tmpConfigFile());
    const io = scriptedIO({ select: [TAVILY] });

    await runMenu(menu, io.io);

    const childRows = io.rendered[1]!;
    expect(childRows.some((row) => row.includes("Clear stored API key"))).toBe(
      false,
    );
  });

  it("clears a stored key after confirmation", async () => {
    const { file, menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { tavily: { apiKey: tavilyKey } },
    });
    const io = scriptedIO({ select: [TAVILY, 1], confirm: [true] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).providers.tavily).toBeUndefined();
    expect(io.notifications.at(-1)?.message).toContain("Removed the stored");
  });

  it("keeps the key when the confirmation is dismissed", async () => {
    const { file, menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { tavily: { apiKey: tavilyKey } },
    });
    const io = scriptedIO({ select: [TAVILY, 1], confirm: [false] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).providers.tavily?.apiKey).toBe(tavilyKey);
  });

  it("shows the stored key masked, never in full", async () => {
    const { menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { tavily: { apiKey: tavilyKey } },
    });
    const io = scriptedIO({ select: [] });

    await runMenu(menu, io.io);

    const row = io.rendered[0]![TAVILY]!;
    expect(row).toContain("key tvly-abc…mnop");
    expect(row).not.toContain(tavilyKey);
  });

  it("redraws rows with the new state after an action", async () => {
    const { menu } = setup(tmpConfigFile());
    const io = scriptedIO({
      // provider → set key → back → (root redraw) → close
      select: [TAVILY, 0, 2, 3],
      input: [tavilyKey],
    });

    await runMenu(menu, io.io);

    // rendered[2] is the redrawn submenu (2 actions + Back), rendered[3] the root.
    expect(io.rendered[3]![TAVILY]).toContain("key tvly-abc…mnop");
  });
});

// =============================================================================
// Default backend
// =============================================================================

describe("default backend rows", () => {
  it("offers to pin a backend when the default is automatic", async () => {
    const { file, menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    const io = scriptedIO({ select: [DEFAULT_ROW] });

    await runMenu(menu, io.io);

    const rows = io.rendered[1]!;
    expect(rows[0]).toContain("Automatic");
    expect(rows[0]).toContain("(current)");
    expect(rows[1]).toContain("Use Tavily");
    expect(rows[2]).toContain("Use DeepSeek");
    expect(loadConfig(file).defaultProvider).toBeUndefined();
  });

  it("pins the chosen backend", async () => {
    const { file, menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    // Default submenu row 2 = "Use DeepSeek" (row 0 is Automatic, 1 is Tavily).
    const io = scriptedIO({ select: [DEFAULT_ROW, 2] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).defaultProvider).toBe("deepseek");
    expect(io.notifications.at(-1)?.message).toContain(
      "Default search backend: DeepSeek.",
    );
  });

  it("warns when pinning a backend that has no key", async () => {
    const { file, menu } = setup(tmpConfigFile());
    const io = scriptedIO({ select: [DEFAULT_ROW, 1] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).defaultProvider).toBe("tavily");
    expect(io.notifications.at(-1)?.type).toBe("warning");
    expect(io.notifications.at(-1)?.message).toContain("no stored key");
  });

  it("restores automatic selection", async () => {
    const { file, menu } = setup(tmpConfigFile(), {
      version: 2,
      defaultProvider: "tavily",
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    const io = scriptedIO({ select: [DEFAULT_ROW, 0] });

    await runMenu(menu, io.io);

    expect(loadConfig(file).defaultProvider).toBeUndefined();
    expect(io.notifications.at(-1)?.message).toContain("automatic");
  });

  it("labels the root row with the configured default", async () => {
    const { menu } = setup(tmpConfigFile(), {
      version: 2,
      defaultProvider: "deepseek",
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    const io = scriptedIO({ select: [] });

    await runMenu(menu, io.io);

    expect(io.rendered[0]![DEFAULT_ROW]).toBe(
      "Default search backend — DeepSeek",
    );
  });

  it("labels the root row as automatic when nothing is pinned", async () => {
    const { menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    const io = scriptedIO({ select: [] });

    await runMenu(menu, io.io);

    expect(io.rendered[0]![DEFAULT_ROW]).toBe(
      "Default search backend — automatic (DeepSeek)",
    );
  });

  it("redraws the submenu with fresh state after an action", async () => {
    const { menu } = setup(tmpConfigFile(), {
      version: 2,
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    // Open Default, pin Tavily, then look at the redrawn submenu.
    const io = scriptedIO({ select: [DEFAULT_ROW, 1, "← Back"] });

    await runMenu(menu, io.io);

    const redrawn = io.rendered[2]!;
    expect(redrawn[0]).toBe("Automatic — first backend with a key");
    expect(redrawn[1]).toBe("Use Tavily (current)");
  });

  it("marks the effective backend in the provider rows", async () => {
    const { menu } = setup(tmpConfigFile(), {
      version: 2,
      defaultProvider: "tavily",
      providers: { tavily: { apiKey: tavilyKey } },
    });
    const io = scriptedIO({ select: [] });

    await runMenu(menu, io.io);

    expect(io.rendered[0]![TAVILY]).toContain("· default");
    expect(io.rendered[0]![DEEPSEEK]).not.toContain("· default");
  });
});

// =============================================================================
// Navigation and state dump
// =============================================================================

describe("navigation", () => {
  it("closes on cancel without changing anything", async () => {
    const file = tmpConfigFile();
    const seed: SearchConfig = { version: 2, providers: {} };
    const { menu } = setup(file, seed);
    const io = scriptedIO({ select: [undefined] });

    await runMenu(menu, io.io);

    expect(loadConfig(file)).toEqual(seed);
    expect(io.notifications).toHaveLength(0);
  });

  it("returns to the root from a submenu", async () => {
    const { menu } = setup(tmpConfigFile());
    const io = scriptedIO({
      // open Tavily, pick Back (= last row), then close the root.
      select: [TAVILY, "← Back", "✕ Close"],
    });

    await runMenu(menu, io.io);

    expect(io.rendered).toHaveLength(3);
    expect(io.rendered[2]![0]).toContain("Tavily");
  });

  it("keeps duplicate row labels selectable", async () => {
    // Rows are selected by label; a collision must not pick the first one.
    const ran: string[] = [];
    const menu: Menu = {
      title: () => "duplicates",
      entries: () => [
        { id: "first", label: () => "Same", run: async () => void ran.push("first") },
        { id: "second", label: () => "Same", run: async () => void ran.push("second") },
      ],
    };
    const io = scriptedIO({ select: ["(second)"] });

    await runMenu(menu, io.io);

    expect(io.rendered[0]).toEqual([
      "Same (first)",
      "Same (second)",
      "✕ Close",
    ]);
    expect(ran).toEqual(["second"]);
  });
});

describe("summary row", () => {
  it("prints the config path and effective backend", async () => {
    const file = tmpConfigFile();
    const { menu } = setup(file, {
      version: 2,
      providers: { deepseek: { apiKey: deepseekKey } },
    });
    const io = scriptedIO({ select: [PROVIDERS.length + 1] });

    await runMenu(menu, io.io);

    const message = io.notifications.at(-1)?.message ?? "";
    expect(message).toContain(file);
    expect(message).toContain("→ deepseek");
    expect(message).not.toContain(deepseekKey);
  });
});

describe("describeKey", () => {
  it("reports no key", () => {
    expect(describeKey(PROVIDERS[0]!, { version: 2, providers: {} })).toBe(
      "no key",
    );
  });

  it("attributes the key to the env var that provided it", () => {
    const config: SearchConfig = {
      version: 2,
      providers: { tavily: { apiKey: tavilyKey } },
    };

    // The env var wins over the stored key, and the row says so.
    expect(
      describeKey(PROVIDERS[0]!, config, {
        TAVILY_API_KEY: "tvly-envabcdefghijkl",
      }),
    ).toBe("key tvly-env…ijkl via env TAVILY_API_KEY");
  });

  it("attributes the key to storage otherwise", () => {
    const config: SearchConfig = {
      version: 2,
      providers: { tavily: { apiKey: tavilyKey } },
    };

    expect(describeKey(PROVIDERS[0]!, config, {})).toBe(
      "key tvly-abc…mnop via stored key",
    );
  });
});

describe("settingsSummary", () => {
  it("marks the effective backend and reports the pinned one", () => {
    const summary = settingsSummary(
      {
        version: 2,
        defaultProvider: "tavily",
        providers: { deepseek: { apiKey: deepseekKey } },
      },
      PROVIDERS,
      "/tmp/pi-search.json",
    );

    expect(summary).toContain("pi-search config — /tmp/pi-search.json");
    // The pinned backend has no key, so the effective one (arrow) differs —
    // exactly the mismatch the summary exists to expose.
    expect(summary).toContain("  tavily (Tavily): no key");
    expect(summary).toContain("→ deepseek (DeepSeek): key sk-abcde…mnop via stored key");
    expect(summary).toContain("default: tavily (configured)");
  });

  it("reports automatic selection when nothing is pinned", () => {
    const summary = settingsSummary(
      { version: 2, providers: { deepseek: { apiKey: deepseekKey } } },
      PROVIDERS,
      "/tmp/pi-search.json",
    );

    expect(summary).toContain("→ deepseek (DeepSeek)");
    expect(summary).toContain("default: automatic (→ deepseek)");
  });
});

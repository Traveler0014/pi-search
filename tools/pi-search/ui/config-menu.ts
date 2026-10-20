/**
 * The `/search-config` menu.
 *
 * The menu is **data, not a switch statement**: the driver walks a node
 * (`entries()` → label + either `children()` or `run()`), redrawing after every
 * action so rows always show live values. Adding a setting later is one entry in
 * `buildSettingsMenu` — no new command, no new navigation code, and the new row
 * automatically picks up "back", cancel, and redraw behaviour.
 *
 * The driver talks to an injected `MenuIO`, not to `ctx.ui`, so the whole flow
 * is testable without a terminal.
 */

import {
  maskApiKey,
  resolveApiKey,
  type SearchConfig,
} from "../core/config.js";
import { getProvider, selectProvider } from "../providers/registry.js";
import type { SearchProvider } from "../providers/types.js";

// =============================================================================
// Menu model
// =============================================================================

/** The four interactions a menu needs from the host. */
export interface MenuIO {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** One row: either a submenu (`children`) or an action (`run`). */
export interface MenuEntry {
  /** Stable id for tests and logs; never rendered. */
  id: string;
  /** Row text, including the current value — re-evaluated on every redraw. */
  label: () => string;
  children?: () => MenuEntry[];
  run?: (io: MenuIO) => Promise<void>;
}

export interface Menu {
  title: () => string;
  entries: () => MenuEntry[];
}

const BACK = "← Back";
const CLOSE = "✕ Close";

/**
 * Walk a menu until the user backs out (nested) or closes/cancels (root).
 *
 * Returns normally on cancel: a settings menu that throws on Escape would print
 * an error for the most common way of dismissing a dialog.
 */
export async function runMenu(
  menu: Menu,
  io: MenuIO,
  nested = false,
): Promise<void> {
  for (;;) {
    const entries = menu.entries();
    const options = optionLabels(entries);
    options.push(nested ? BACK : CLOSE);

    const choice = await io.select(menu.title(), options);
    if (choice === undefined) return;
    if (choice === BACK || choice === CLOSE) return;

    const entry = entries[options.indexOf(choice)];
    if (!entry) return;

    if (entry.children) {
      await runMenu(
        // `entries` re-evaluates on every redraw: rows must reflect the state an
        // action just changed, not the state the submenu was opened with.
        { title: () => stripState(entry.label()), entries: () => entry.children!() },
        io,
        true,
      );
      continue;
    }

    await entry.run?.(io);
  }
}

/**
 * Row labels double as selection keys, so they must be unique.
 *
 * A collision (two future rows with the same wording) would silently navigate
 * to the wrong entry; the id only appears in that case, so normal rows stay
 * clean.
 */
function optionLabels(entries: MenuEntry[]): string[] {
  const labels = entries.map((entry) => entry.label());
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  return entries.map((entry, index) =>
    (counts.get(labels[index]!) ?? 0) > 1
      ? `${labels[index]} (${entry.id})`
      : labels[index]!,
  );
}

/**
 * Submenu title = the row that opened it, minus the value it displayed.
 *
 * "Tavily — key tvly-abc… via stored key" is a fine row label but a poor dialog
 * title, and a stale key in a title is noise once the key changes.
 */
function stripState(label: string): string {
  return label.split(" — ")[0].trim();
}

// =============================================================================
// Key copy
// =============================================================================

/** The slice of a provider that key validation and messaging need. */
export interface KeyTarget {
  id: string;
  label: string;
  apiKeyEnv: readonly string[];
  looksLikeKey: (key: string) => boolean;
}

/** Why a typed key is rejected, or `null` when it is usable. */
export function keyFormatError(
  target: KeyTarget,
  value: string,
): string | null {
  if (!value.trim()) return "No key entered.";
  if (!target.looksLikeKey(value.trim())) {
    return `Invalid key format: expected a ${target.label} API key.`;
  }
  return null;
}

/**
 * Sentence to append when an env var shadows the stored key — the stored key is
 * kept, but the environment wins, so "saved" alone would be a lie.
 */
export function envOverrideNote(
  target: KeyTarget,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = target.apiKeyEnv.find((candidate) => env[candidate]?.trim());
  return name
    ? ` Note: ${name} is set and takes precedence over the stored key.`
    : "";
}

// =============================================================================
// Readable state
// =============================================================================

/** `key tvly-abcd… via stored key`, `key sk-1234… via env DEEPSEEK_API_KEY`, or `no key`. */
export function describeKey(
  provider: SearchProvider,
  config: SearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = resolveApiKey(provider, config, env);
  if (!resolved) return "no key";

  const envName = provider.apiKeyEnv.find((name) => env[name]?.trim());
  const source =
    resolved.source === "env" && envName ? `env ${envName}` : "stored key";
  return `key ${maskApiKey(resolved.apiKey)} via ${source}`;
}

/** The backend an unqualified call would use right now. */
function effectiveDefault(config: SearchConfig): SearchProvider {
  return selectProvider(undefined, config).provider;
}

/** Multi-line state dump, used by the menu row and by headless `/search-config`. */
export function settingsSummary(
  config: SearchConfig,
  providers: readonly SearchProvider[],
  configPath: string,
): string {
  const effective = effectiveDefault(config);
  const rows = providers.map((provider) => {
    const mark = provider.id === effective.id ? "→" : " ";
    return `${mark} ${provider.id} (${provider.label}): ${describeKey(provider, config)}`;
  });

  const configured = config.defaultProvider
    ? `default: ${config.defaultProvider} (configured)`
    : `default: automatic (→ ${effective.id})`;

  return [`pi-search config — ${configPath}`, ...rows, configured].join("\n");
}

// =============================================================================
// Settings tree
// =============================================================================

export interface SettingsDeps {
  providers: readonly SearchProvider[];
  /** Re-read on every redraw: another command/session may have changed the file. */
  config: () => SearchConfig;
  configPath: string;
  saveKey: (provider: SearchProvider, key: string) => Promise<void>;
  clearKey: (provider: SearchProvider) => Promise<void>;
  /** `undefined` = automatic (first backend that has a key). */
  setDefault: (provider: SearchProvider | undefined) => Promise<void>;
}

/** The root menu: provider rows, the default row, and a state dump. */
export function buildSettingsMenu(deps: SettingsDeps): Menu {
  return {
    title: () => "pi-search settings",
    entries: () => [
      ...deps.providers.map((provider) => providerEntry(deps, provider)),
      defaultEntry(deps),
      {
        id: "summary",
        label: () => "Show current configuration",
        run: async (io) => {
          io.notify(
            settingsSummary(deps.config(), deps.providers, deps.configPath),
            "info",
          );
        },
      },
    ],
  };
}

function providerEntry(
  deps: SettingsDeps,
  provider: SearchProvider,
): MenuEntry {
  return {
    id: `provider:${provider.id}`,
    label: () => {
      const config = deps.config();
      const isDefault = effectiveDefault(config).id === provider.id;
      const suffix = isDefault ? " · default" : "";
      return `${provider.label} — ${describeKey(provider, config)}${suffix}`;
    },
    children: () => {
      const config = deps.config();
      const stored = config.providers[provider.id]?.apiKey?.trim();
      const isDefault = effectiveDefault(config).id === provider.id;

      return [
        {
          id: `provider:${provider.id}:set`,
          label: () => "Set or replace API key",
          run: (io) => setKey(deps, provider, io),
        },
        ...(stored
          ? [
              {
                id: `provider:${provider.id}:clear`,
                label: () => "Clear stored API key",
                run: (io: MenuIO) => clearKey(deps, provider, io),
              },
            ]
          : []),
        ...(isDefault
          ? []
          : [
              {
                id: `provider:${provider.id}:default`,
                label: () => `Make ${provider.label} the default`,
                run: (io: MenuIO) => makeDefault(deps, provider, io),
              },
            ]),
      ];
    },
  };
}

function defaultEntry(deps: SettingsDeps): MenuEntry {
  return {
    id: "default",
    label: () => {
      const config = deps.config();
      const effective = effectiveDefault(config);
      const configured = config.defaultProvider
        ? getProvider(config.defaultProvider)
        : undefined;
      return configured
        ? `Default search backend — ${configured.label}`
        : `Default search backend — automatic (${effective.label})`;
    },
    children: () => {
      const config = deps.config();
      return [
        {
          id: "default:auto",
          label: () =>
            `Automatic — first backend with a key${
              config.defaultProvider ? "" : " (current)"
            }`,
          run: async (io) => {
            await deps.setDefault(undefined);
            io.notify(
              `Default search backend: automatic (→ ${effectiveDefault(deps.config()).label}).`,
              "info",
            );
          },
        },
        ...deps.providers.map((provider) => ({
          id: `default:${provider.id}`,
          label: () =>
            `Use ${provider.label}${
              config.defaultProvider === provider.id ? " (current)" : ""
            }`,
          run: (io: MenuIO) => makeDefault(deps, provider, io),
        })),
      ];
    },
  };
}

// =============================================================================
// Actions
// =============================================================================

async function setKey(
  deps: SettingsDeps,
  provider: SearchProvider,
  io: MenuIO,
): Promise<void> {
  const value = await io.input(
    `${provider.label} API key`,
    provider.apiKeyEnv[0],
  );
  if (value === undefined) {
    io.notify("Cancelled.", "info");
    return;
  }

  const error = keyFormatError(provider, value);
  if (error) {
    io.notify(error, "error");
    return;
  }

  await deps.saveKey(provider, value.trim());
  io.notify(
    `Saved ${provider.label} API key to ${deps.configPath}.${envOverrideNote(provider)}`,
    "info",
  );
}

async function clearKey(
  deps: SettingsDeps,
  provider: SearchProvider,
  io: MenuIO,
): Promise<void> {
  const shadowed = envOverrideNote(provider);
  const confirmed = await io.confirm(
    `Clear the stored ${provider.label} API key?`,
    `Removes the key from ${deps.configPath}.${shadowed}`,
  );
  if (!confirmed) return;

  await deps.clearKey(provider);
  io.notify(`Removed the stored ${provider.label} API key.`, "info");
}

async function makeDefault(
  deps: SettingsDeps,
  provider: SearchProvider,
  io: MenuIO,
): Promise<void> {
  await deps.setDefault(provider);
  const hasKey = Boolean(deps.config().providers[provider.id]?.apiKey?.trim());
  io.notify(
    hasKey
      ? `Default search backend: ${provider.label}.`
      : `Default search backend: ${provider.label} — no stored key yet; calls will fall back to the first backend that has one.`,
    hasKey ? "info" : "warning",
  );
}

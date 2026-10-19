/**
 * Config persistence for pi-search.
 *
 * Shape (v2, multi-provider):
 *
 *   {
 *     "version": 2,
 *     "defaultProvider": "tavily",
 *     "providers": { "tavily": { "apiKey": "tvly-..." } }
 *   }
 *
 * A v1 file (`{ "apiKey": "..." }`) is migrated on read: v1 only ever held the
 * Tavily key, so it becomes `providers.tavily`. The migration is written back on
 * the next mutation, never silently on read.
 *
 * Key resolution order for a provider: its env vars (in priority order), then
 * the stored key. The environment always wins so CI can override a stored key.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Config file lives next to pi's own agent state. */
export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-search.json");

export const CONFIG_VERSION = 2;

/** v1 stored exactly one key, and it could only have been Tavily's. */
export const LEGACY_PROVIDER_ID = "tavily";

export interface ProviderKeyConfig {
  apiKey?: string;
}

export interface SearchConfig {
  version: number;
  /** Provider id used when a call does not name one. */
  defaultProvider?: string;
  providers: Record<string, ProviderKeyConfig>;
}

export const EMPTY_CONFIG: SearchConfig = { version: CONFIG_VERSION, providers: {} };

export interface ResolvedApiKey {
  apiKey: string;
  source: "env" | "config";
}

/** The structural slice of a provider that key handling needs. */
export interface KeySpec {
  id: string;
  apiKeyEnv: readonly string[];
}

// =============================================================================
// Load / save
// =============================================================================

function normalizeProviders(input: unknown): Record<string, ProviderKeyConfig> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, ProviderKeyConfig> = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    const apiKey =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).apiKey
        : undefined;
    if (typeof apiKey === "string" && apiKey.trim()) {
      out[id] = { apiKey: apiKey.trim() };
    }
  }
  return out;
}

/** Load config, migrating a v1 file in memory. Missing/corrupt files are empty. */
export function loadConfig(file: string = CONFIG_FILE): SearchConfig {
  try {
    if (!fs.existsSync(file)) return { ...EMPTY_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_CONFIG };

    if (parsed.providers !== undefined || typeof parsed.version === "number") {
      const defaultProvider =
        typeof parsed.defaultProvider === "string" && parsed.defaultProvider.trim()
          ? parsed.defaultProvider.trim()
          : undefined;
      return {
        version: CONFIG_VERSION,
        ...(defaultProvider ? { defaultProvider } : {}),
        providers: normalizeProviders(parsed.providers),
      };
    }

    // v1: { apiKey }
    const legacyKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    return {
      version: CONFIG_VERSION,
      ...(legacyKey ? { providers: { [LEGACY_PROVIDER_ID]: { apiKey: legacyKey } } } : { providers: {} }),
    };
  } catch {
    // Corrupt config — treat as unconfigured rather than crashing the session.
    return { ...EMPTY_CONFIG };
  }
}

/** Persist the config with owner-only permissions (best effort on Windows). */
export function saveConfig(config: SearchConfig, file: string = CONFIG_FILE): void {
  const payload: Record<string, unknown> = {
    version: CONFIG_VERSION,
    ...(config.defaultProvider ? { defaultProvider: config.defaultProvider } : {}),
    providers: normalizeProviders(config.providers),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on some platforms.
  }
}

// =============================================================================
// Immutable updates (callers persist with saveConfig)
// =============================================================================

export function withApiKey(
  config: SearchConfig,
  providerId: string,
  apiKey: string,
): SearchConfig {
  const providers = { ...config.providers };
  const trimmed = apiKey.trim();
  if (trimmed) providers[providerId] = { apiKey: trimmed };
  else delete providers[providerId];
  return { ...config, providers };
}

export function withDefaultProvider(
  config: SearchConfig,
  providerId: string | undefined,
): SearchConfig {
  return { ...config, defaultProvider: providerId };
}

/** Provider ids that have a stored key (env vars are resolved separately). */
export function configuredProviderIds(config: SearchConfig): string[] {
  return Object.keys(config.providers);
}

// =============================================================================
// Key resolution
// =============================================================================

/** Resolve a provider's key: env vars first, then the stored key. */
export function resolveApiKey(
  spec: KeySpec,
  config: SearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApiKey | null {
  for (const name of spec.apiKeyEnv) {
    const fromEnv = env[name]?.trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
  }

  const fromConfig = config.providers[spec.id]?.apiKey?.trim();
  if (fromConfig) return { apiKey: fromConfig, source: "config" };

  return null;
}

/** Show enough to identify a key without leaking it into logs/transcripts. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "****";
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

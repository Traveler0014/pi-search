/**
 * Config mutations — the write side of `config.ts`.
 *
 * Every write to pi-search.json goes through `mutateConfig`, so the
 * read-modify-write is serialized per file: a key typed into the settings menu
 * cannot clobber a `/search-provider` change made at the same time (or by
 * another session).
 *
 * The two user-facing helpers at the bottom live here rather than in the TUI
 * because they answer a config question — "is this key usable, and is it the one
 * that will actually be used?" — and `/search-key` and the menu must not drift
 * apart on the answer.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  withApiKey,
  withDefaultProvider,
  type SearchConfig,
} from "./config.js";

/** Read-modify-write under the per-file mutation queue. */
export async function mutateConfig(
  mutate: (config: SearchConfig) => SearchConfig,
  file: string = CONFIG_FILE,
): Promise<void> {
  await withFileMutationQueue(file, async () => {
    saveConfig(mutate(loadConfig(file)), file);
  });
}

/** Store (or replace) a provider's key. An empty value clears it. */
export async function saveProviderKey(
  providerId: string,
  apiKey: string,
  file: string = CONFIG_FILE,
): Promise<void> {
  await mutateConfig((config) => withApiKey(config, providerId, apiKey), file);
}

/** Remove a provider's stored key. Environment variables are untouched. */
export async function removeProviderKey(
  providerId: string,
  file: string = CONFIG_FILE,
): Promise<void> {
  await mutateConfig((config) => withApiKey(config, providerId, ""), file);
}

/** Set the default provider; `undefined` restores automatic selection. */
export async function saveDefaultProvider(
  providerId: string | undefined,
  file: string = CONFIG_FILE,
): Promise<void> {
  await mutateConfig((config) => withDefaultProvider(config, providerId), file);
}

// =============================================================================
// Key copy shared by /search-key and the settings menu
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

/**
 * Config mutations — the write side of `config.ts`.
 *
 * Every write to pi-search.json goes through `mutateConfig`, so the
 * read-modify-write is serialized per file: a key typed into the settings menu
 * cannot clobber a change made at the same time by another session.
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

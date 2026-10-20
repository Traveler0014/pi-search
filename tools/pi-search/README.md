# pi-search

Web search and page extraction for the pi coding agent, powered by pluggable search backends (Tavily and DeepSeek today).

Give the agent live access to the web: it can search for current information and extract the full text of pages when snippets are not enough. Both backends are built for LLM agents, so results come back as clean ranked snippets instead of raw HTML. The agent can pick a backend per call, and more backends drop in as adapters without changing the tool schema.

## Features

- **`search_web`** — ranked search with recency windows, domain filters, a language preference, three text-detail levels, and backend selection via `provider`
- **`search_extract`** — full readable page text from up to 20 URLs per call, including failed-URL reporting
- **Capability-shaped schema** — the model-facing parameters describe *searching*, not any one backend; backend-native knobs travel in `provider_options`
- **Pluggable backends** — Tavily and DeepSeek today; every backend is an adapter behind one registry, and the tool schemas do not change when one is added
- **Per-provider keys and default** — one settings menu (`/search-config`) manages both; `<PROVIDER>_API_KEY` always wins over the stored key
- **Compact plain-text output** tuned for model consumption, with automatic truncation
- **Judgement aids per result** — a normalized `score` with a `high`/`medium`/`low` level, the publication date, and provider flags, compressed onto one line so the model can weigh results instead of trusting rank alone
- **Key management** — `/search-config` stores keys in `~/.pi/agent/pi-search.json` with `0600` permissions and shows them masked with their source; `TAVILY_API_KEY` overrides the stored key
- **Runtime self-check** — `/search-test` validates config; `/search-test live` performs one real request
- **Robust failures** — typed errors for auth, rate limits, timeouts, network failures, and cancellation
- **No background resources** — the extension opens no sockets or timers until a tool actually runs

## Tools (agent-facing, snake_case)

### `search_web`

Search the web and return ranked results with titles, URLs, and result text.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural-language query (per-backend character limit; Tavily allows 400) |
| `provider` | provider id | Backend to use; omit for the configured default |
| `max_results` | number | 1–20 results; default 5 |
| `recency` | `day` \| `week` \| `month` \| `year` | Only results published within this window |
| `include_domains` | string[] | Only return results from these domains |
| `exclude_domains` | string[] | Exclude results from these domains |
| `detail` | `snippet` \| `summary` \| `content` | Text per result; default `summary`. `snippet` is cheapest, `content` adds full page text |
| `language` | string | Prefer results in this language (ISO 639-1, e.g. `en`, `zh`) |
| `provider_options` | object | Backend-native knobs (see below) |

### `search_extract`

Extract the full readable content of one or more pages.

| Parameter | Type | Description |
|-----------|------|-------------|
| `urls` | string[] | 1–20 absolute `http(s)` URLs |
| `provider` | provider id | Backend to use; omit for the configured default |
| `provider_options` | object | Backend-native knobs (see below) |

### Backend-native options (`provider_options`)

Everything a single backend supports natively lives here, so the main schema never grows when a backend is added. Keys are validated per backend; an unknown key is rejected and the error lists what *is* accepted. Nothing here is described in the tool schema, so unused options cost no context.

Tavily accepts, for `search_web`:

| Key | Type | Notes |
|-----|------|-------|
| `search_depth` | `basic` \| `advanced` \| `fast` \| `ultra-fast` | Default `basic`; `advanced` costs 2 credits |
| `topic` | `general` \| `news` \| `finance` | Default `general` |
| `include_answer` | boolean | Adds a generated answer; extra credits |
| `chunks_per_source` | number 1–3 | Overrides the chunk count implied by `detail` |
| `country` | string | Requires `topic: general` |
| `start_date` / `end_date` | `YYYY-MM-DD` | Replace `recency` (and take precedence over it) |

…and for `search_extract`: `extract_depth` (`basic` \| `advanced`) and `include_images` (boolean).

DeepSeek accepts, for `search_web`: `ori_question` (string ≤128 chars — the user's original question, improves intent matching) and `localization` (an IP address used to prefer locally relevant results). `search_extract` accepts none.

### What each backend does with the neutral options

| Neutral option | Tavily | DeepSeek |
|---|---|---|
| `detail` | `chunks_per_source` 1/2/3, plus `include_raw_content: markdown` for `content` | `snippet` / `summary` / `content` fields; `need_content` for `content` |
| `recency` | `time_range` | `after:YYYY-MM-DD` appended to the query |
| `include_domains` / `exclude_domains` | native fields | `site:a OR site:b` / `-site:c` operators |
| `language` | `language` | `lang:zh` operator |

DeepSeek limits the query to **128 characters**, and the filters are part of it — the adapter re-checks the length after injection and tells the caller to shorten the query or switch backends. Domain filters are **best-effort**: live testing showed `site:github.com` also returning `pkg.go.dev/github.com/...`, so every filtered DeepSeek search carries a `note:` saying so. DeepSeek `fetch` also handles **one URL per request**, so `search_extract` with several URLs becomes a sequential batch (the result carries a note saying so), and its `content` is markdown-escaped by DeepSeek (`https\:\/\/api\.deepseek\.com`) — the adapter undoes that escaping so URLs stay usable.

## Commands (user-facing, kebab-case)

### `/search-config`

Opens the settings menu — the interactive way to manage every option:

```
┌ pi-search settings
│   Tavily — no key
│   DeepSeek — key sk-abcde…mnop via stored key · default
│   Default search backend — automatic (DeepSeek)
│   Show current configuration
│   ✕ Close
```

A backend row opens `Set or replace API key`, `Clear stored API key` (confirmation required), and `Make <provider> the default`. The `Default search backend` row pins a backend or restores automatic selection (first backend that has a key). Keys are shown masked, with their source (`via stored key` / `via env DEEPSEEK_API_KEY`).

Rows are redrawn with live state after every action; `← Back` returns to the root and `Esc` closes. Every setting lives in one menu tree, so a new option is a new entry in `tools/pi-search/ui/config-menu.ts` — not a new command. Without a dialog UI (RPC/CI) the same state is printed as text.

### `/search <query>`

Runs a quick 5-result basic search and shows titles and URLs in a notification. This is a raw lookup — ask the agent to "search for ..." when you want a synthesized answer.

### `/search-test [live]`

Reports, per backend: key source, key-shape sanity, limits, and the accepted `provider_options`. Add `live` to run one real 1-result request per configured backend:

```
/search-test
/search-test live
```

## Setup

### Option A — environment variables (recommended for CI)

```bash
export TAVILY_API_KEY="tvly-..."     # Tavily
export DEEPSEEK_API_KEY="sk-..."     # DeepSeek (the same key you use for the models)
```

The environment always takes precedence over the stored key.

### Option B — store keys with pi

```
/search-config
```

Keys are written to `~/.pi/agent/pi-search.json` with owner-only permissions. Without a dialog UI (RPC/CI) use the environment variables above or edit the file — `/search-config` only prints the current state there.

Get a Tavily key at [tavily.com](https://tavily.com) (free tier available); a DeepSeek key is the one from [platform.deepseek.com](https://platform.deepseek.com/).

### Verify

```
/search-test
/search-test live
```

### Config file

`~/.pi/agent/pi-search.json` (v2):

```json
{
  "version": 2,
  "defaultProvider": "deepseek",
  "providers": {
    "tavily": { "apiKey": "tvly-..." },
    "deepseek": { "apiKey": "sk-..." }
  }
}
```

A v1 file (`{ "apiKey": "..." }`) is migrated on read to `providers.tavily` — v1 only ever held a Tavily key.

When `defaultProvider` names a backend without a key, calls fall back to the first backend that has one and add a `note:` warning instead of failing; run `/search-config` to see which backend is actually in use (`→`).

## Usage examples

Ask the agent in natural language:

```
Search the web for the latest TypeScript release and summarize the changes.
```

```
Look up recent news about the EU AI Act from the last 7 days.
```

```
Read https://example.com/article and give me the key points.
```

The model maps these to:

```text
search_web(query="latest TypeScript release", max_results=5)
search_web(query="EU AI Act", recency="week", max_results=5)
search_web(query="vite 6", provider_options={search_depth: "advanced", topic: "news"})
search_extract(urls=["https://example.com/article"])
```

What the model sees per result (Tavily, then DeepSeek with a publisher name):

```text
1. Vite 6.0 is out
   URL: https://vitejs.dev/blog/announcing-vite6
   score 0.86 (high) | 2024-11-26
   Announcing Vite 6.0 with the new Environment API.

1. DeepSeek“无预警”上新，为何引发巨大关注？_央广网
   URL: http://tech.cnr.cn/gstj/20260427/t20260427_527601623.shtml
   score 0.76 (high) | 2026-04-26 | 央广网
   # DeepSeek“无预警”上新，为何引发巨大关注？ …
```

The publisher name is rendered only when it adds information the domain does not already carry ("GitHub" next to `github.com` is dropped; "证券时报" next to `stcn.com` is kept).

## Architecture

```
tools/pi-search/
├── index.ts            registration glue only (tools, commands, TUI)
├── core/               provider-agnostic, pi-free, unit-tested
│   ├── types.ts        limits, request/response shapes, ProviderError
│   ├── http.ts         POST transport: timeout, abort, error classification
│   ├── config.ts       v2 config (multi-provider) + v1 migration + key lookup
│   ├── validate.ts     strict input validation + provider-limit clamping
│   ├── provider-options.ts  the `provider_options` whitelist and its errors
│   ├── score.ts        score normalization + quality levels
│   ├── results.ts      duplicate-page removal (fragment-insensitive)
│   └── format.ts       the single model-facing renderer (truncation lives here)
└── providers/
    ├── types.ts        the SearchProvider contract
    ├── registry.ts     PROVIDERS + PROVIDER_IDS (source of truth)
    ├── tavily.ts       endpoints, bodies, parsing, error prose
    └── deepseek.ts     query-operator injection, batch fetch, error prose
```

### Adding a provider

1. Create `providers/<id>.ts` exporting a `SearchProvider`: `id`, `label`, `apiKeyEnv`, `scores` (quality boundaries in normalized units), `limits` (query length, result count), `details` (which text tiers it can deliver), `searchOptions`/`extractOptions` (its `provider_options` whitelist), `looksLikeKey`, `search`, `extract`, plus a private `HttpProfile` describing how the backend classifies and explains its HTTP errors.
2. Add it to `PROVIDERS` in `providers/registry.ts` and widen the `ProviderId` union — the compiler complains until both are done.
3. Put it in `providers/<id>.test.ts` with fixture-based payload tests; the registry invariant tests then cover the wiring. For score cutoffs, run a focused and a vague query with a real key and calibrate against the observed distribution — `providers/fixtures/` shows what captured output looks like.

Nothing else changes. The tool schemas are untouched: `provider` is an enum derived from `PROVIDER_IDS`, so the context cost of one more backend is one enum value. Result rendering, truncation, retries, timeouts, limit clamping, detail degradation, and score levels stay shared, which keeps output size and behaviour identical across backends.

## Design notes

- **Two tools, one job each** — search and extraction are separate operations with separate schemas, following pi's single-responsibility tool convention.
- **Capabilities, not providers, define the schema** — `query`/`max_results`/`recency`/`domains`/`detail`/`language` are things every backend can do; a backend's own knobs go into `provider_options`, which is never described in the tool schema. This is why adding a provider costs one enum value instead of a few hundred tokens.
- **Thin adapters, shared core** — adapters own endpoints, bodies, parsing, `provider_options` whitelists, and error prose; validation, transport, config, scoring, and rendering live once in `core/` and are covered by unit tests. `index.ts` is only registration and TUI glue.
- **Errors that teach** — invalid input throws with the expected shape; auth failures name `/search-config` and the env var as the fix; rate limits tell the caller not to retry immediately; a bad `provider_options` key lists every accepted key. Empty result sets return recovery hints (broaden the query, widen recency, drop domain filters).
- **Bounded output** — search output truncates to 12K chars, extraction to 16K chars with 4K per page, and `detail: content` caps each result at 2K so a default 5-result search fits the budget without losing the last result. DeepSeek `content` really is 15–20K per page, so the cap is doing real work. The limits live in the shared renderer, not in an adapter.
- **Scores are normalized, not re-invented** — each adapter maps its native score onto `0..1`; the registry turns that into `high`/`medium`/`low` with the provider's own cutoffs, so the level is comparable across backends while the number stays a per-result-set signal. Provider-native values stay in `details`. A composite pi-search score was deliberately rejected: it would need freshness/authority from every backend and would quietly redefine what "good" means. The level measures **topical relevance**, not usefulness: a homepage titled "AI News" scores high — the date and the result text are what distinguish an article from a listing.
- **Thresholds are calibrated on real payloads, not guessed** — Tavily publishes none, so the cutoffs (0.75 / 0.50) come from three live queries whose scores span 0.41–0.92; the captured payloads live in `providers/fixtures/` and are asserted in `fixtures.test.ts`.
- **Flags point at the low end, not the top** — DeepSeek's `authority` puts most results at 3–4, so flagging the top tier marked almost everything and said nothing. `low-authority` (authority ≤ 1, `-1` = unknown ignored) is rare and decision-relevant: prefer another source.
- **Duplicates are removed before rendering** — backends do return the same article twice (Tavily used a `#wp--skip-link--target` variant in testing). The registry drops fragment-equal URLs and adds a `note:` saying how many it removed, so the model never pays twice for the same text.
- **Freshness is opt-in at the request level** — Tavily is asked for `include_published_date` so each result can carry a date; results without one render without a date rather than with a fake one.
- **Backend quirks stay in the backend** — DeepSeek's `site:`/`lang:`/`after:` operators, its 128-character query budget, its one-URL-per-fetch rule, and its `authority` field are all handled inside `providers/deepseek.ts`; callers and the renderer never see them. `authority ≥ 3` surfaces as the `authoritative` flag instead of an extra field Tavily could not fill.
- **Cancellation and timeouts** — every request carries a 30-second timeout and forwards pi's abort signal to `fetch`.
- **Zero-cost startup** — no timers, watchers, or network clients are created in the extension factory; config writes go through pi's file mutation queue so the settings menu cannot race another writer.

## Notes on usage and privacy

- Queries and URLs are sent to whichever backend serves the call (Tavily or DeepSeek). Do not send secrets or private page content.
- **Tavily** is credit-based: basic search = 1 credit, advanced = 2; basic extract = 1 per 5 URLs, advanced = 2 per 5; `include_answer` adds credits. See [Tavily pricing](https://tavily.com/#pricing).
- **DeepSeek** is billed per successful request, not per token or result: ¥5 per 1,000 Search calls and ¥5 per 1,000 Fetch calls; failed, empty, or timed-out requests are free. Because `count` and `need_content` are free, asking for more results or full page text costs the same as one minimal call — but `search_extract` on N URLs is N Fetch calls. Each account is limited to 5 QPS. See [DeepSeek docs](https://api-docs.deepseek.com/zh-cn/guides/search).
- `/search-test` does not spend credits; `/search-test live`, `/search` and any tool call do.

## Development

```bash
npm install
npm test          # unit tests (core + adapters)
npm run typecheck
pi -ne -e ./tools/pi-search/index.ts -p 'list tools'
```

## License

MIT

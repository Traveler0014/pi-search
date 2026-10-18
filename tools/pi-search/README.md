# pi-search

Web search and page extraction for the pi coding agent, powered by the Tavily API.

Give the agent live access to the web: it can search for current information and extract the full text of pages when snippets are not enough. Tavily is built for LLM agents, so results come back as clean ranked snippets instead of raw HTML.

## Features

- **`search_web`** — ranked web/news/finance search with domain include/exclude filters, recency (`days`), configurable depth, and optional AI answer summary
- **`search_extract`** — full readable page text from up to 20 URLs per call, including failed-URL reporting
- **Compact plain-text output** tuned for model consumption, with automatic truncation
- **Key management** — `/search-key` stores the key in `~/.pi/agent/pi-search.json` with `0600` permissions; `TAVILY_API_KEY` overrides it
- **Runtime self-check** — `/search-test` validates config; `/search-test live` performs one real request
- **Robust failures** — typed errors for auth, rate limits, timeouts, network failures, and cancellation
- **No background resources** — the extension opens no sockets or timers until a tool actually runs

## Tools (agent-facing, snake_case)

### `search_web`

Search the web and return ranked results with titles, URLs, and content snippets.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural-language query (max 400 chars) |
| `search_depth` | `basic` \| `advanced` | Search effort; default `basic` |
| `topic` | `general` \| `news` \| `finance` | Result category; default `general` |
| `max_results` | number | 1–20 results; default 5 |
| `include_answer` | boolean | Include Tavily's generated answer (extra credit) |
| `include_raw_content` | boolean | Include cleaned page text per result (larger output) |
| `include_domains` | string[] | Only return results from these domains |
| `exclude_domains` | string[] | Exclude results from these domains |
| `days` | number | For `news`: only results from the last N days |
| `country` | string | Boost results from a country (for `general`) |

### `search_extract`

Extract the full readable content of one or more pages.

| Parameter | Type | Description |
|-----------|------|-------------|
| `urls` | string[] | 1–20 absolute `http(s)` URLs |
| `extract_depth` | `basic` \| `advanced` | Extraction effort; `advanced` handles JS-heavy pages |
| `include_images` | boolean | Also return image URLs found on the page |

## Commands (user-facing, kebab-case)

### `/search <query>`

Runs a quick 5-result basic search and shows titles and URLs in a notification. This is a raw lookup — ask the agent to "search for ..." when you want a synthesized answer.

### `/search-key [key|clear]`

- `/search-key` — show the active key source and a masked key; prompts for one if none is set
- `/search-key tvly-...` — validate and save a key
- `/search-key clear` — remove the stored key

The key is written to `~/.pi/agent/pi-search.json` with owner-only permissions.

### `/search-test [live]`

Checks that a key is configured and its format looks right. Add `live` to also run one real 1-result search (costs one API credit):

```
/search-test
/search-test live
```

## Setup

### Option A — environment variable (recommended for CI)

```bash
export TAVILY_API_KEY="tvly-..."
```

The environment always takes precedence over the stored key.

### Option B — store the key with pi

```
/search-key tvly-...
```

Get a key at [tavily.com](https://tavily.com) (free tier available).

### Verify

```
/search-test live
```

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
search_web(query="EU AI Act", topic="news", days=7, max_results=5)
search_extract(urls=["https://example.com/article"])
```

## Design notes

- **Two tools, one job each** — search and extraction are separate operations with separate schemas, following pi's single-responsibility tool convention.
- **`lib.ts` is pi-free** — all validation, HTTP, parsing, and formatting live in a pure module covered by 50 unit tests. `index.ts` is only registration and TUI glue.
- **Errors that teach** — invalid input throws with the expected shape; Tavily auth failures name `/search-key` as the fix; rate limits tell the caller not to retry immediately. Empty result sets return recovery hints (broaden the query, change topic, drop domain filters).
- **Bounded output** — search output truncates to 12K chars, extraction to 16K chars with 4K per page, so a large page cannot blow up the context window.
- **Cancellation and timeouts** — every request carries a 30-second timeout and forwards pi's abort signal to `fetch`.
- **Zero-cost startup** — no timers, watchers, or network clients are created in the extension factory.

## Notes on usage and privacy

- Queries and URLs are sent to the Tavily API. Do not send secrets or private page content.
- Each search/extract call consumes Tavily credits. Roughly: basic search = 1 credit, advanced = 2; basic extract = 1 per 5 URLs, advanced = 2 per 5; `include_answer` adds credits. Check [Tavily pricing](https://tavily.com/#pricing) for current rates.
- `/search-test` does not spend credits; `/search-test live`, `/search` and any tool call do.

## Development

```bash
npm install
npm test          # 50 unit tests
npm run typecheck
pi -ne -e ./tools/pi-search/index.ts -p 'list tools'
```

## License

MIT

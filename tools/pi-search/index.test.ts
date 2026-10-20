/**
 * TUI rending of the tool rows.
 *
 * Two bugs motivated these tests, both visible in one screenshot:
 *
 *   - the call header printed `max_results` as if it were the result count, so
 *     `(10 results)` sat directly above an empty answer;
 *   - a failed call (missing API key) has `details: {}`, which the result
 *     renderer read as `count === 0` and reported as "No results" — the search
 *     never ran, and the actual error never reached the user.
 */

import { describe, expect, it } from "vitest";
import register from "./index.js";
import { DEFAULT_MAX_RESULTS } from "./core/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const okContext = { isError: false } as any;
const errorContext = { isError: true } as any;
const renderOptions = { expanded: false, isPartial: false };

interface AnyTool {
  name: string;
  renderCall: (args: any, theme: any, context?: any) => { render: (w: number) => string[] };
  renderResult: (
    result: any,
    options: any,
    theme: any,
    context: any,
  ) => { render: (w: number) => string[] };
}

interface AnyCommand {
  description: string;
  handler: (
    args: string,
    ctx: { hasUI: boolean; ui: { notify: (m: string, t?: string) => void } },
  ) => Promise<void>;
}

function capture(): {
  tools: Map<string, AnyTool>;
  commands: Map<string, AnyCommand>;
} {
  const tools = new Map<string, AnyTool>();
  const commands = new Map<string, AnyCommand>();
  register({
    registerTool: (definition: AnyTool) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: AnyCommand) =>
      commands.set(name, definition),
  } as any);
  return { tools, commands };
}

const { tools, commands } = capture();

function line(component: { render: (w: number) => string[] }): string {
  return component.render(200).join("\n").trim();
}

function toolResult(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: content }], details };
}

describe("registration", () => {
  it("registers the tools and the three user-facing commands", () => {
    expect([...commands.keys()].sort()).toEqual([
      "search",
      "search-config",
      "search-test",
    ]);
    expect([...tools.keys()].sort()).toEqual(["search_extract", "search_web"]);
  });

  it("prints the configuration summary when no dialog UI is available", async () => {
    const notes: { message: string; type?: string }[] = [];

    await commands.get("search-config")!.handler("", {
      hasUI: false,
      ui: { notify: (message, type) => notes.push({ message, type }) },
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("pi-search config —");
    expect(notes[0]!.message).toContain("default:");
  });
});

describe("search_web renderers", () => {
  const tool = tools.get("search_web")!;

  it("labels max_results as a cap, not as a result count", () => {
    const header = line(
      tool.renderCall({ query: "switch 2 grip", max_results: 10 }, theme),
    );

    expect(header).toContain("max 10");
    expect(header).not.toContain("10 results");
  });

  it("still labels the default cap when the caller omits max_results", () => {
    const header = line(tool.renderCall({ query: "q" }, theme));

    expect(header).toContain(`max ${DEFAULT_MAX_RESULTS}`);
  });

  it("shows the error message instead of 'No results' on failure", () => {
    const rendered = line(
      tool.renderResult(
        toolResult("Tavily API key not configured. Open /search-config."),
        renderOptions,
        theme,
        errorContext,
      ),
    );

    expect(rendered).toContain("Tavily API key not configured");
    expect(rendered).not.toContain("No results");
  });

  it("falls back to a generic error line when the result has no text", () => {
    const rendered = line(
      tool.renderResult(
        { content: [], details: {} },
        renderOptions,
        theme,
        errorContext,
      ),
    );

    expect(rendered).toBe("Search failed");
  });

  it("keeps 'No results' for a successful call that found nothing", () => {
    const rendered = line(
      tool.renderResult(
        toolResult("No results for \"x\".", { provider: "deepseek", count: 0 }),
        renderOptions,
        theme,
        okContext,
      ),
    );

    expect(rendered).toBe("No results");
  });

  it("reports the real count with provider, timing, and note count", () => {
    const rendered = line(
      tool.renderResult(
        toolResult("1. a", {
          provider: "deepseek",
          count: 2,
          responseTime: 0.42,
          warnings: ["note"],
        }),
        renderOptions,
        theme,
        okContext,
      ),
    );

    expect(rendered).toBe("2 results · deepseek · 0.42s · 1 note(s)");
  });
});

describe("search_extract renderers", () => {
  const tool = tools.get("search_extract")!;

  it("shows the error message instead of a zero-page success line", () => {
    const rendered = line(
      tool.renderResult(
        toolResult("DeepSeek API key not configured."),
        renderOptions,
        theme,
        errorContext,
      ),
    );

    expect(rendered).toContain("DeepSeek API key not configured");
    expect(rendered).not.toContain("0 pages");
  });

  it("reports extracted pages and per-URL failures", () => {
    const rendered = line(
      tool.renderResult(
        toolResult("1. a", {
          provider: "tavily",
          count: 3,
          failedCount: 1,
        }),
        renderOptions,
        theme,
        okContext,
      ),
    );

    expect(rendered).toBe("3 pages · 1 failed · tavily");
  });
});

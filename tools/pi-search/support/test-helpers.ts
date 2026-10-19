/**
 * Shared test helpers (not exported from the extension entry point).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDirs: string[] = [];

/** Create a throwaway config file path inside a per-test temp directory. */
export function tmpConfigFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "pi-search.json");
}

/** Remove every temp directory created by `tmpConfigFile`. */
export function cleanupTmpDirs(): void {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface CapturedCall {
  url: string;
  init: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** A `fetch` stand-in that records calls and delegates to `handler`. */
export function mockFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A `fetch` stand-in that never resolves until its signal aborts. */
export function hangingFetch(onAbort?: () => void): typeof fetch {
  return ((_input: FetchInput, init?: FetchInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        onAbort?.();
        reject(new Error("aborted"));
      });
    })) as typeof fetch;
}

/** A representative search payload (one item lacks a URL and must be dropped). */
export const sampleSearchPayload = {
  query: "typescript release",
  answer: "TypeScript 6.0 was released.",
  results: [
    {
      title: "TypeScript 6.0",
      url: "https://devblogs.microsoft.com/typescript/",
      content: "Announcing TypeScript 6.0 with faster builds.",
      score: 0.91,
      published_date: "2024-11-26T10:00:00Z",
      raw_content: null,
      id: "abc",
    },
    {
      title: "Release notes",
      url: "https://github.com/microsoft/TypeScript/releases",
      content: "Release notes for TypeScript.",
      score: 0.77,
      raw_content: "# Release notes",
      id: "def",
    },
    { title: "no url", score: 0.1 },
  ],
  response_time: 0.42,
  request_id: "req-1",
};

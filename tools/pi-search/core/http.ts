/**
 * Shared JSON-over-POST transport with timeouts and cancellation.
 *
 * Provider-agnostic by construction: status classification and error prose are
 * supplied by the adapter through an `HttpProfile`, so transport behaviour
 * (timeout, abort, unreadable body) stays identical across providers while
 * each one can describe its own failure modes.
 */

import {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  type ProviderErrorKind,
  type RequestOptions,
} from "./types.js";

export interface HttpProfile {
  /** Display name used in transport-level messages, e.g. "Tavily". */
  label: string;
  /** Map a non-2xx status to the error kind the extension reacts to. */
  classify(status: number): ProviderErrorKind;
  /** Provider-specific prose for a non-2xx response. */
  describe(status: number, detail: string | null): string;
}

/** Fallback classification when a provider has no opinion. */
export function defaultClassify(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "api";
}

/**
 * POST a JSON body and parse the JSON reply.
 *
 * Throws `ProviderError` for every failure mode (transport, HTTP, body shape).
 * The caller's `signal` is forwarded and an independent timeout always applies.
 */
export async function postJson<T>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  profile: HttpProfile,
  options: RequestOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const failure = (error: unknown): ProviderError => {
    if (options.signal?.aborted) {
      return new ProviderError("Search cancelled.", "aborted");
    }
    if (timedOut) {
      const label =
        timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
      return new ProviderError(
        `${profile.label} API timed out after ${label}.`,
        "timeout",
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new ProviderError(
      `Could not reach ${profile.label} (${detail}). Check network connectivity and retry.`,
      "network",
    );
  };

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw failure(error);
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      throw failure(error);
    }

    let payload: unknown = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = rawBody;
      }
    }

    if (!response.ok) {
      throw new ProviderError(
        profile.describe(response.status, extractErrorMessage(payload)),
        profile.classify(response.status),
        response.status,
        payload,
      );
    }

    if (payload === null || typeof payload !== "object") {
      throw new ProviderError(
        `${profile.label} returned an unreadable response (expected JSON).`,
        "api",
        response.status,
        payload,
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Pull a human-readable message out of an error body.
 *
 * Handles the shapes seen in the wild: `{"detail": "..."}` and
 * `{"detail": {"error": "..."}}` as well as the OpenAI-compatible
 * `{"error": {"message": "...", "type": "...", "code": "..."}}`.
 */
export function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;

  for (const key of ["detail", "error", "message"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const key of ["detail", "error"]) {
    const value = obj[key];
    if (!value || typeof value !== "object") continue;

    const inner = value as Record<string, unknown>;
    for (const innerKey of ["error", "message", "detail"]) {
      const text = inner[innerKey];
      if (typeof text === "string" && text.trim()) return text.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  return null;
}

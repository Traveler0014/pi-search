/**
 * The `provider_options` contract.
 *
 * A single structured table per adapter drives three things that must never
 * disagree: validation, the error message that teaches the model (or user) the
 * accepted keys, and the documentation of a backend's native knobs.
 *
 * Nothing here is ever sent to the model. The cost of a native option is paid
 * only when someone uses it and gets a corrective message.
 */

export type NativeOptionSpec =
  | { type: "string"; note?: string }
  | { type: "boolean"; note?: string }
  | { type: "number"; min?: number; max?: number; note?: string }
  | { type: "enum"; values: readonly string[]; note?: string };

export type NativeOptionsSpec = Readonly<Record<string, NativeOptionSpec>>;

function typeHint(spec: NativeOptionSpec): string {
  switch (spec.type) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return spec.min !== undefined && spec.max !== undefined
        ? `number ${spec.min}-${spec.max}`
        : "number";
    case "enum":
      return `(${spec.values.join("|")})`;
  }
}

/** "search_depth (basic|advanced), include_answer (boolean), country (string)" */
export function describeNativeOptions(specs: NativeOptionsSpec): string {
  return Object.entries(specs)
    .map(([name, spec]) => `${name} ${typeHint(spec)}`)
    .join(", ");
}

/** Human-readable whitelist, or a sentence for backends without one. */
function acceptedList(label: string, specs: NativeOptionsSpec): string {
  const described = describeNativeOptions(specs);
  return described
    ? `${label} accepts: ${described}.`
    : `${label} accepts no provider_options for this operation.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `provider_options` against an adapter's whitelist.
 *
 * Throws on unknown keys and bad values: the caller passed something the
 * backend does not understand, which the model can fix on the next call. The
 * message always lists what *is* accepted.
 */
export function validateProviderOptions(
  label: string,
  specs: NativeOptionsSpec,
  input: unknown,
): Record<string, unknown> {
  if (input === undefined) return {};
  if (!isPlainObject(input)) {
    throw new Error(
      `Invalid 'provider_options': expected an object with backend-native keys. ` +
        acceptedList(label, specs),
    );
  }

  const accepted = acceptedList(label, specs);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const spec = specs[key];
    if (!spec) {
      throw new Error(
        `Invalid 'provider_options.${key}': ${label} does not accept that key. ${accepted}`,
      );
    }
    if (value === undefined) continue;

    switch (spec.type) {
      case "string": {
        if (typeof value !== "string" || value.trim() === "") {
          throw new Error(
            `Invalid 'provider_options.${key}': expected a non-empty string${spec.note ? ` (${spec.note})` : ""}.`,
          );
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new Error(
            `Invalid 'provider_options.${key}': expected true or false${spec.note ? ` (${spec.note})` : ""}.`,
          );
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `Invalid 'provider_options.${key}': expected a number${spec.note ? ` (${spec.note})` : ""}.`,
          );
        }
        if (spec.min !== undefined && value < spec.min) {
          throw new Error(
            `Invalid 'provider_options.${key}': expected >= ${spec.min} (received ${value}).`,
          );
        }
        if (spec.max !== undefined && value > spec.max) {
          throw new Error(
            `Invalid 'provider_options.${key}': expected <= ${spec.max} (received ${value}).`,
          );
        }
        break;
      }
      case "enum": {
        if (typeof value !== "string" || !spec.values.includes(value)) {
          throw new Error(
            `Invalid 'provider_options.${key}': expected one of ${spec.values.join(", ")}${spec.note ? ` (${spec.note})` : ""}.`,
          );
        }
        break;
      }
    }

    out[key] = value;
  }

  return out;
}

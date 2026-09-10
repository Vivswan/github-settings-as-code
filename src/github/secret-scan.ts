/**
 * Plain-data normalization and secret-field scanning for outgoing request
 * payloads, dependency-free on purpose (no octokit, no @actions/core): the
 * client calls this before every request, and the guarantees here - nothing
 * payload-supplied ever executes, the scanned tree IS the sent tree, secret
 * fields are masked in traces - must hold independent of any transport.
 */

import { nonPlainKind } from "../plain-data.js";

/** The constant written over a secret-bearing request field in the debug trace. */
const SECRET_FIELD_PLACEHOLDER = "***";

/**
 * Octokit's own body rule: only plain objects and arrays are stringified.
 * Arrays must be genuine base-class arrays - a subclass can override map
 * and iteration, which is foreign code the normalizer must never invoke.
 */
function isPlainJsonContainer(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return proto === Array.prototype;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * The typed rejection normalizePlainData raises, carrying WHERE (the key
 * path, field names only - never a value) and WHAT (the value class) so the
 * abort message can name the offending field. redactSecretPayloadSafe
 * rethrows only THIS class's information through its fail-closed catch;
 * anything else a hostile object throws stays swallowed so no foreign
 * message can leak.
 */
class NotPlainDataError extends Error {
  constructor(
    readonly path: readonly string[],
    readonly kind: string,
  ) {
    super("not plain JSON data");
  }
}

/** Render a normalizePlainData key path ("config.starts_at", "contexts[2]"). */
function renderKeyPath(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/**
 * Build the normalized plain-data tree BY HAND, never via JSON.stringify: it
 * honors toJSON, and a toJSON can return a different container that hides a
 * secret under no field name ({secret, toJSON: () => [value]} has no key to match).
 * No payload-supplied code EVER runs: properties are read through their
 * descriptors, an enumerable accessor is rejected UNREAD (a getter is code that
 * could sabotage the pipeline's globals), toJSON is never invoked. Non-enumerable
 * and symbol-keyed properties are never inspected, and only the normalized COPY
 * is sent, so they cannot reach the wire.
 */
function normalizePlainData(value: unknown, path: string[] = []): unknown {
  if (value === null) {
    return null;
  }
  // For plain JSON data the output stringifies byte-identically to the input:
  // undefined object keys are dropped; undefined array items, holes, and
  // non-finite numbers become null - JSON.stringify's own rules.
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object":
      break;
    default:
      throw new NotPlainDataError(path, nonPlainKind(value));
  }
  // Anything that is not JSON plain data - a class instance, a non-plain
  // prototype, a function, a bigint - THROWS into the caller's fail-closed
  // catch, naming the field's key path and value class (cycles exhaust the
  // stack and are caught the same way). YAML reaches this through explicit
  // tags: !!timestamp parses to a Date, !!binary to a Uint8Array.
  if (!isPlainJsonContainer(value)) {
    throw new NotPlainDataError(path, nonPlainKind(value));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    // Base-class array (isPlainJsonContainer checked the prototype); a
    // manual index loop over descriptors never dispatches .map or invokes
    // an index accessor someone defineProperty'd onto the array.
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[index];
      if (descriptor === undefined) {
        items.push(null); // a hole; stringify renders it null
        continue;
      }
      if (!("value" in descriptor)) {
        throw new NotPlainDataError([...path, String(index)], "an accessor property");
      }
      const item: unknown = descriptor.value;
      items.push(item === undefined ? null : normalizePlainData(item, [...path, String(index)]));
    }
    return items;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw new NotPlainDataError([...path, key], "an accessor property");
    }
    const item: unknown = descriptor.value;
    if (item === undefined) {
      continue;
    }
    out[key] = normalizePlainData(item, [...path, key]);
  }
  return out;
}

/**
 * The scan entry point: normalize, then walk. normalizePlainData reads the
 * input once into a pure plain-data tree; redactSecretPayload walks it, the
 * trace prints it (masked), and the request SENDS it - one read, one truth, so
 * no exotic object can make the scan, the trace, and the wire disagree.
 * Primitives pass through untouched (no named fields; a bare-value secret is
 * unsupported by design). Any other non-plain payload (a Buffer, a stream, an
 * exotic prototype anywhere in its graph) fails `ok: false` and is never sent:
 * octokit hands such a body to fetch verbatim, so normalizing it would change the wire.
 */
export function redactSecretPayloadSafe(
  payload: unknown,
):
  | { ok: true; payload: unknown; traced: unknown; carriesSecret: boolean }
  | { ok: false; reason?: string } {
  if (payload === undefined) {
    return { ok: true, payload: undefined, traced: undefined, carriesSecret: false };
  }
  // Everything reflective happens INSIDE the try: even Array.isArray and
  // Object.getPrototypeOf can throw on a hostile proxy (a throwing or
  // revoked trap), and an error thrown before the guard could carry a
  // secret in its message.
  try {
    if (typeof payload !== "object" || payload === null) {
      // Only JSON primitives pass through - a function, bigint or symbol
      // cannot be JSON-encoded and fails closed instead of reaching
      // octokit un-normalized.
      const jsonPrimitive =
        payload === null ||
        typeof payload === "string" ||
        typeof payload === "boolean" ||
        (typeof payload === "number" && Number.isFinite(payload));
      return jsonPrimitive
        ? { ok: true, payload, traced: payload, carriesSecret: false }
        : { ok: false };
    }
    if (!isPlainJsonContainer(payload)) {
      return {
        ok: false,
        reason: describeNotPlain(new NotPlainDataError([], nonPlainKind(payload))),
      };
    }
    const normalized: unknown = normalizePlainData(payload);
    const scanned = redactSecretPayload(normalized);
    return { ok: true, payload: normalized, ...scanned };
  } catch (error) {
    // Only our own typed rejection may contribute prose: it carries key
    // PATHS (field names) and a value-class word, never a value - anything
    // a hostile object threw is discarded wholesale.
    return error instanceof NotPlainDataError
      ? { ok: false, reason: describeNotPlain(error) }
      : { ok: false };
  }
}

/** The abort-message clause for a non-plain payload, naming field and class. */
function describeNotPlain(error: NotPlainDataError): string {
  const where = error.path.length > 0 ? `the value at "${renderKeyPath(error.path)}"` : "the value";
  return `${where} is not plain JSON data (${error.kind})`;
}

/** Request-payload field names whose values are secrets wherever they appear. */
const SECRET_FIELD_NAMES = new Set(["secret", "encrypted_value"]);

/**
 * Structural redaction of secret-bearing request fields before tracing. The
 * scan recurses over objects and arrays and keys on the FIELD NAMES alone, so a
 * consumer nesting one level deeper - or a new consumer entirely - is covered
 * without declaring anything here (an unenforced "declare your shape" contract
 * is how a leak happens). It cannot cover an UNNAMED value: a bare string body
 * has no key, so a secret must never be sent as the whole payload. Copy-on-write:
 * with no secret field the input is returned unchanged; on a hit `traced` is a
 * copy with only the secret fields masked (the request sends the unmasked tree).
 */
function redactSecretPayload(payload: unknown): { traced: unknown; carriesSecret: boolean } {
  if (typeof payload !== "object" || payload === null) {
    return { traced: payload, carriesSecret: false };
  }
  if (Array.isArray(payload)) {
    let hit = false;
    // Index loop, not .map: the walker must not dispatch through mutable
    // prototype methods (the tree it walks is ours, but the habit is the
    // guarantee).
    const traced: unknown[] = [];
    for (let index = 0; index < payload.length; index++) {
      const scanned = redactSecretPayload(payload[index]);
      hit = hit || scanned.carriesSecret;
      traced.push(scanned.traced);
    }
    return hit ? { traced, carriesSecret: true } : { traced: payload, carriesSecret: false };
  }
  const record = payload as Record<string, unknown>;
  let hit = false;
  // Null prototype: JSON.parse creates own `__proto__` DATA properties, and
  // assigning that key through a plain `{}` would hit the prototype setter
  // and silently drop the branch from the trace.
  const traced: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      traced[key] = SECRET_FIELD_PLACEHOLDER;
      hit = true;
    } else {
      const scanned = redactSecretPayload(value);
      hit = hit || scanned.carriesSecret;
      traced[key] = scanned.traced;
    }
  }
  return hit ? { traced, carriesSecret: true } : { traced: payload, carriesSecret: false };
}

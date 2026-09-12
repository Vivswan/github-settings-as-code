/**
 * Plain-data normalization and secret-field scanning for outgoing payloads, dependency-free on purpose: the guarantees
 * (no payload-supplied method or accessor is ever invoked, the scanned tree IS the sent tree, secret fields are masked
 * in traces) must hold independent of any transport.
 */

import { nonPlainKind } from "../plain-data.js";

const SECRET_FIELD_PLACEHOLDER = "***";

/**
 * Octokit's own body rule: only plain objects and arrays are stringified. An array subclass can override map and
 * iteration, which is foreign code the normalizer must never invoke.
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
 * Carries WHERE (the key path: field names only, never a value) and WHAT (the value class). redactSecretPayloadSafe
 * reports only THIS class's information; anything else a hostile object throws is swallowed so no foreign message leaks.
 */
class NotPlainDataError extends Error {
  constructor(
    readonly path: readonly string[],
    readonly kind: string,
  ) {
    super("not plain JSON data");
  }
}

function renderKeyPath(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/**
 * Built BY HAND, never via JSON.stringify: it honors toJSON, and a toJSON can return a container that hides a secret
 * under no field name ({secret, toJSON: () => [value]}). No payload method, accessor, or toJSON is ever invoked.
 *
 * a property         -> read through its descriptor; an enumerable accessor is rejected UNREAD (a getter could sabotage globals)
 * an object's keys   -> only Object.keys are copied, so symbol and non-enumerable keys never reach the copy (array indices do)
 * the wire           -> only the copy is sent
 */
function normalizePlainData(value: unknown, path: string[] = []): unknown {
  if (value === null) {
    return null;
  }
  // For plain JSON data the output stringifies byte-identically to the input: JSON.stringify's own rules for undefined,
  // holes, and non-finite numbers.
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
  // A class instance, a non-plain prototype, a function, a bigint: each THROWS into the caller's fail-closed catch
  // (cycles exhaust the stack and are caught the same way). YAML reaches this through explicit tags: !!timestamp parses to a Date.
  if (!isPlainJsonContainer(value)) {
    throw new NotPlainDataError(path, nonPlainKind(value));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    // A manual index loop over descriptors never dispatches .map or invokes an index accessor someone defineProperty'd onto the array.
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
 * One read, one truth: normalizePlainData reads the input once into a plain-data tree; the scan walks it, the trace
 * prints it masked, and the request SENDS it, so no exotic object can make the scan, the trace, and the wire disagree.
 *
 * undefined (no body), or a JSON primitive  -> passes through: no named fields, and a bare-value secret is unsupported by design
 * plain objects and arrays throughout       -> normalized, scanned, sent
 * a non-plain value, at any depth           -> `ok: false`, never sent: normalizing a non-plain container would change what reaches fetch
 */
export function redactSecretPayloadSafe(
  payload: unknown,
):
  | { ok: true; payload: unknown; traced: unknown; carriesSecret: boolean }
  | { ok: false; reason?: string } {
  if (payload === undefined) {
    return { ok: true, payload: undefined, traced: undefined, carriesSecret: false };
  }
  // Everything reflective happens INSIDE the try: even Array.isArray can throw on a hostile proxy, and an error thrown
  // before the guard could carry a secret in its message.
  try {
    if (typeof payload !== "object" || payload === null) {
      // A function, bigint, or symbol cannot be JSON-encoded and fails closed instead of reaching octokit un-normalized.
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
    // Only our own typed rejection may contribute prose: it carries key PATHS and a value-class word, never a value.
    return error instanceof NotPlainDataError
      ? { ok: false, reason: describeNotPlain(error) }
      : { ok: false };
  }
}

function describeNotPlain(error: NotPlainDataError): string {
  const where = error.path.length > 0 ? `the value at "${renderKeyPath(error.path)}"` : "the value";
  return `${where} is not plain JSON data (${error.kind})`;
}

const SECRET_FIELD_NAMES = new Set(["secret", "encrypted_value"]);

/**
 * Keys on the FIELD NAMES alone, recursing over objects and arrays, so a consumer nesting one level deeper, or a new
 * consumer entirely, is covered without declaring anything (an unenforced "declare your shape" contract is how a leak
 * happens).
 *
 * an UNNAMED value (a bare string body)  -> uncovered: a secret must never be the whole payload
 * a hit                                  -> `traced` is a masked copy; the request still sends the unmasked tree
 */
function redactSecretPayload(payload: unknown): { traced: unknown; carriesSecret: boolean } {
  if (typeof payload !== "object" || payload === null) {
    return { traced: payload, carriesSecret: false };
  }
  if (Array.isArray(payload)) {
    let hit = false;
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
  // Null prototype: JSON.parse creates own `__proto__` DATA properties, and assigning that key through a plain `{}`
  // would hit the prototype setter and silently drop the branch from the trace.
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

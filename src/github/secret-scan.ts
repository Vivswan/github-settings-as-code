/**
 * Plain-data normalization and secret-field scanning for outgoing request
 * payloads, dependency-free on purpose (no octokit, no @actions/core): the
 * client calls this before every request, and the guarantees here - nothing
 * payload-supplied ever executes, the scanned tree IS the sent tree, secret
 * fields are masked in traces - must hold independent of any transport.
 */

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

/** The value class of a non-plain value, without running any of its code. */
function nonPlainKind(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `a ${typeof value}`;
  }
  // Prototype comparison only - the same reflective read
  // isPlainJsonContainer already performs; no payload method is dispatched.
  const proto = Object.getPrototypeOf(value);
  if (proto === Date.prototype) {
    return "a Date, e.g. from a YAML !!timestamp tag";
  }
  if (proto === Uint8Array.prototype) {
    return "binary data, e.g. from a YAML !!binary tag";
  }
  return "a non-plain object";
}

/**
 * Build the normalized plain-data tree BY HAND, never handing the input to
 * JSON.stringify: stringify honors toJSON, and a toJSON can return a
 * different container that hides a secret under no field name at all
 * ({secret, toJSON: () => [value]} traces the value with no key to match).
 * No payload-supplied code EVER runs: properties are read through their
 * descriptors and an enumerable accessor property is rejected UNREAD (a
 * getter is code, not data - and a getter that ran could sabotage the
 * globals the rest of the pipeline uses), toJSON is never invoked, methods
 * are never dispatched. Non-enumerable and symbol-keyed properties are
 * ignored entirely, never inspected - the set stringify would serialize is
 * exactly the set walked, and only the normalized COPY is ever sent, so
 * ignored code can neither execute nor reach the wire. Anything else that
 * is not JSON plain data - a function, a bigint,
 * a symbol, a class instance, a non-plain prototype, an accessor - THROWS
 * into the caller's fail-closed catch. Cycles exhaust the stack and are
 * caught the same way.
 *
 * For plain JSON data the output stringifies byte-identically to the
 * input: undefined-valued object keys are dropped, undefined array items,
 * holes, and non-finite numbers become null - exactly JSON.stringify's own
 * rules.
 * Note YAML can step OUTSIDE plain data through explicit tags
 * (!!timestamp parses to a Date, !!binary to a Uint8Array); those throw
 * here and abort the request with a message naming the offending field's
 * key path and value class, which beats the garbage their old
 * stringification produced.
 */
function normalizePlainData(value: unknown, path: string[] = []): unknown {
  if (value === null) {
    return null;
  }
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
 * The scan entry point: normalize, then walk. The hand-rolled
 * normalization (see normalizePlainData) reads the input once into a pure
 * plain-data tree; redactSecretPayload walks that tree, the trace prints
 * it (masked), and the request SENDS it - one read, one truth, and no
 * exotic object can make the scan, the trace, and the wire disagree.
 * YAML-derived payloads are plain data apart from the explicit-tag escape
 * hatch normalizePlainData documents; this is the runtime enforcement of
 * that boundary, and nothing payload-supplied is ever executed on the way.
 *
 * Primitives pass through untouched - they carry no named fields for the
 * scan, and a bare-value secret is unsupported by design. Any other
 * non-plain payload (a Buffer, a typed array, a stream, anything carrying
 * a function or exotic prototype anywhere in its graph) fails `ok: false`
 * and is never sent: octokit would pass a non-plain body to fetch
 * verbatim, so normalizing it would silently change the wire, and sending
 * it unscanned would be a blind spot. The caller aborts instead of
 * sending what it could not inspect.
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
 * Structural redaction of secret-bearing request fields before tracing.
 * The scan is recursive over objects and arrays and keys on the FIELD
 * NAMES alone (`secret`, `encrypted_value`), so a consumer nesting one
 * level deeper - or a new consumer entirely - is covered without declaring
 * anything here; an unenforced "declare your shape here" contract is how a
 * leak happens. Field-name keying cannot cover an UNNAMED value: a bare
 * string body has no key to match, so a future consumer must never send a
 * secret as the whole payload.
 * Copy-on-write: when no secret field is present the input is returned
 * unchanged (the trace is byte-identical); on a hit, `traced`
 * is a structural copy with only the secret fields masked - the request
 * sends the unmasked tree - and `carriesSecret` flags the request for
 * fail-closed error handling.
 * Over-matching an innocent field that happens to be named `secret` costs
 * a masked trace line and a withheld error body, never a wrong request.
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

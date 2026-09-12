/**
 * Declared-keys-only comparison: extra live keys are ignored, and renderDelta() is the ONE rendering of a delta as drift
 * prose. GitHub returns null, or omits the field, for empty values, so two tolerances are deliberate:
 *
 * desired null, live absent         -> no delta
 * desired "", live null or absent   -> no delta
 */

type PathStep = string | number | { readonly key: string };

type ListMatch = "key" | "shape" | "value";

/** A phantom is a non-empty declared field the live object has no key for: a typo, or a write-only field. */
export type Delta =
  | {
      readonly kind: "mismatch";
      readonly path: readonly PathStep[];
      readonly desired: unknown;
      readonly live: unknown;
    }
  | { readonly kind: "phantom"; readonly path: readonly PathStep[]; readonly desired: unknown }
  | {
      readonly kind: "missing";
      readonly path: readonly PathStep[];
      readonly desired: unknown;
      readonly match: ListMatch;
    }
  | {
      readonly kind: "undeclared";
      readonly path: readonly PathStep[];
      readonly live: unknown;
      readonly match: ListMatch;
    };

export interface DeltaOptions {
  /**
   * Per nested list (by dotted object path below the root), the item key to pair by; a missing or repeated key is a
   * declaration bug.
   *
   * a list not named here  -> object items pair by shape, others by value
   * matchBy omitted        -> lists fall back to the legacy `type` sniffing subsetDiff callers rely on
   */
  readonly matchBy?: Readonly<Record<string, string>>;
}

function isScalar(value: unknown): boolean {
  return typeof value !== "object" || value === null;
}

/** Marks a live field the object has no own key for, as opposed to one holding undefined. */
const ABSENT: unique symbol = Symbol("no such live key");

export function deltas(desired: unknown, live: unknown, opts: DeltaOptions = {}): Delta[] {
  const out: Delta[] = [];
  walk(desired, live, [], "", opts, out);
  return out;
}

function walk(
  desired: unknown,
  live: unknown | typeof ABSENT,
  path: readonly PathStep[],
  keyPath: string,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const absent = live === ABSENT;
  const liveValue = absent ? undefined : live;
  if (desired === null || desired === undefined) {
    if (liveValue === null || liveValue === undefined || liveValue === "") {
      return;
    }
    out.push({ kind: "mismatch", path, desired, live: liveValue });
    return;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(liveValue)) {
      out.push(
        absent
          ? { kind: "phantom", path, desired }
          : { kind: "mismatch", path, desired, live: liveValue },
      );
      return;
    }
    walkList(desired, liveValue, path, keyPath, opts, out);
    return;
  }
  if (typeof desired === "object") {
    if (typeof liveValue !== "object" || liveValue === null || Array.isArray(liveValue)) {
      out.push(
        absent
          ? { kind: "phantom", path, desired }
          : { kind: "mismatch", path, desired, live: liveValue },
      );
      return;
    }
    const liveRecord = liveValue as Record<string, unknown>;
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      // hasOwn, not indexing: a key named like a prototype member (toString) must read as absent, not as the inherited function.
      const child = Object.hasOwn(liveRecord, key) ? liveRecord[key] : ABSENT;
      walk(value, child, [...path, key], keyPath === "" ? key : `${keyPath}.${key}`, opts, out);
    }
    return;
  }
  if (desired === "" && (liveValue === null || liveValue === undefined)) {
    return;
  }
  if (desired !== liveValue) {
    out.push(
      absent
        ? { kind: "phantom", path, desired }
        : { kind: "mismatch", path, desired, live: liveValue },
    );
  }
}

function typeOf(item: unknown): string | null {
  return typeof item === "object" && item !== null && "type" in (item as object)
    ? String((item as { type: unknown }).type)
    : null;
}

function itemKey(item: unknown, key: string, keyPath: string, side: "desired" | "live"): string {
  if (typeof item !== "object" || item === null || !Object.hasOwn(item, key)) {
    throw new Error(
      `BUG: matchBy pairs the list "${keyPath}" by "${key}", but a ${side} item carries no such key: ${JSON.stringify(item)}`,
    );
  }
  return String((item as Record<string, unknown>)[key]);
}

function walkList(
  desired: unknown[],
  live: unknown[],
  path: readonly PathStep[],
  keyPath: string,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const declaredKey = opts.matchBy?.[keyPath];
  if (declaredKey !== undefined) {
    const liveByKey = new Map<string, unknown>();
    for (const item of live) {
      const key = itemKey(item, declaredKey, keyPath, "live");
      if (liveByKey.has(key)) {
        throw new Error(
          `BUG: matchBy pairs the list "${keyPath}" by "${declaredKey}", but the live list repeats ${JSON.stringify(key)}`,
        );
      }
      liveByKey.set(key, item);
    }
    walkKeyed(desired, liveByKey, declaredKey, path, keyPath, opts, out);
    return;
  }
  if (opts.matchBy === undefined) {
    // Legacy sniffing pairs by `type` only when types are unique on both sides (ruleset rules); environment reviewers
    // repeat types and fall through to shape pairing below.
    const desiredTypes = desired.map(typeOf);
    const liveTypes = live.map(typeOf);
    const typed =
      desired.length > 0 &&
      desiredTypes.every((t) => t !== null) &&
      new Set(desiredTypes).size === desiredTypes.length &&
      liveTypes.every((t) => t !== null) &&
      new Set(liveTypes).size === liveTypes.length;
    if (typed) {
      const liveByType = new Map<string, unknown>();
      for (const item of live) {
        liveByType.set(typeOf(item) as string, item);
      }
      walkKeyed(desired, liveByType, "type", path, keyPath, opts, out);
      return;
    }
  }
  const objectList =
    desired.length > 0 &&
    desired.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
  if (objectList) {
    // Order-insensitive; a live item nothing pairs with is undeclared because a full-payload write would remove it.
    const liveItems = [...live];
    for (const [index, item] of desired.entries()) {
      const matchIndex = liveItems.findIndex(
        (candidate) => deltas(item, candidate, opts).length === 0,
      );
      if (matchIndex === -1) {
        out.push({ kind: "missing", path: [...path, index], desired: item, match: "shape" });
      } else {
        liveItems.splice(matchIndex, 1);
      }
    }
    for (const leftover of liveItems) {
      out.push({ kind: "undeclared", path, live: leftover, match: "shape" });
    }
    return;
  }
  const desiredSet = new Set(desired.map((v) => JSON.stringify(v)));
  const liveSet = new Set(live.map((v) => JSON.stringify(v)));
  for (const [index, value] of desired.entries()) {
    const json = JSON.stringify(value);
    if (!liveSet.has(json) && desired.findIndex((v) => JSON.stringify(v) === json) === index) {
      out.push({ kind: "missing", path, desired: value, match: "value" });
    }
  }
  for (const [index, value] of live.entries()) {
    const json = JSON.stringify(value);
    if (!desiredSet.has(json) && live.findIndex((v) => JSON.stringify(v) === json) === index) {
      out.push({ kind: "undeclared", path, live: value, match: "value" });
    }
  }
}

function walkKeyed(
  desired: unknown[],
  liveByKey: ReadonlyMap<string, unknown>,
  key: string,
  path: readonly PathStep[],
  keyPath: string,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const declared = new Set<string>();
  for (const item of desired) {
    const itemId = itemKey(item, key, keyPath, "desired");
    if (declared.has(itemId)) {
      throw new Error(
        `BUG: matchBy pairs the list "${keyPath}" by "${key}", but the declared list repeats ${JSON.stringify(itemId)}`,
      );
    }
    declared.add(itemId);
    const match = liveByKey.get(itemId);
    const at = [...path, { key: itemId }];
    if (match === undefined) {
      out.push({ kind: "missing", path: at, desired: item, match: "key" });
    } else {
      walk(item, match, at, keyPath, opts, out);
    }
  }
  for (const [itemId, item] of liveByKey) {
    if (!declared.has(itemId)) {
      out.push({ kind: "undeclared", path: [...path, { key: itemId }], live: item, match: "key" });
    }
  }
}

function renderPath(root: string, path: readonly PathStep[]): string {
  const steps = path.map((step) =>
    typeof step === "string"
      ? `.${step}`
      : typeof step === "number"
        ? `[${step}]`
        : `[${step.key}]`,
  );
  return `${root}${steps.join("")}`;
}

function mismatchLine(at: string, desired: unknown, live: unknown): string {
  if (desired === null || desired === undefined) {
    return `${at}: expected empty, live has ${JSON.stringify(live)}`;
  }
  if (Array.isArray(desired)) {
    return `${at}: expected list, live has ${JSON.stringify(live)}`;
  }
  if (!isScalar(desired)) {
    return `${at}: expected object, live has ${JSON.stringify(live)}`;
  }
  if (live === undefined) {
    return `${at}: declared ${JSON.stringify(desired)} but the API response has no such field (new or write-only field?)`;
  }
  return `${at}: ${JSON.stringify(desired)} != ${JSON.stringify(live)}`;
}

export function renderDelta(root: string, delta: Delta): string {
  const at = renderPath(root, delta.path);
  switch (delta.kind) {
    case "mismatch":
      return mismatchLine(at, delta.desired, delta.live);
    case "phantom":
      return mismatchLine(at, delta.desired, undefined);
    case "missing":
      return delta.match === "key"
        ? `${at}: missing live`
        : delta.match === "shape"
          ? `${at}: no matching live entry for ${JSON.stringify(delta.desired)}`
          : `${at}: missing ${JSON.stringify(delta.desired)}`;
    case "undeclared":
      return delta.match === "key"
        ? `${at}: present live but not declared`
        : delta.match === "shape"
          ? `${at}: live entry not declared: ${JSON.stringify(delta.live)}`
          : `${at}: unexpected ${JSON.stringify(delta.live)}`;
  }
}

export function subsetDiff(desired: unknown, live: unknown, path: string): string[] {
  return deltas(desired, live).map((delta) => renderDelta(path, delta));
}

/** Sections whose write is gated by a comparison note these, so the gating keys do not silently rewrite on every run. */
export function phantomKeys(desired: Record<string, unknown>, live: unknown): string[] {
  return deltas(desired, live).flatMap((delta) =>
    delta.kind === "phantom" && delta.path.length === 1 && typeof delta.path[0] === "string"
      ? [delta.path[0]]
      : [],
  );
}

export function phantomNote(prefix: string, keys: string[], noun: string, rewrite: string): string {
  const list = keys.map((k) => `"${k}"`).join(", ");
  return `${prefix}: declared key(s) ${list} do not exist on the live ${noun}, so if GitHub ignores them ${rewrite} on every apply without converging. Fix the key name, or remove it from the settings file`;
}

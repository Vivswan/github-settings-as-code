/**
 * Declared-keys-only comparison: extra live keys are ignored, and renderDelta() is the ONE rendering of a delta as drift
 * prose. GitHub returns null, or omits the field, for empty values, so two tolerances are deliberate:
 *
 * desired null, live absent         -> no delta
 * desired "", live null or absent   -> no delta
 *
 * A replace-style write (a ruleset's PUT) is the exception: `replace` turns every non-empty live value the declaration
 * omits into an `omitted` delta, because that write would remove it.
 */

import { agree } from "../text.js";

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
    }
  | {
      readonly kind: "omitted";
      readonly path: readonly PathStep[];
      readonly live: unknown;
      /** The slice accepts `null` at this path, so `<key>: null` is the clearing spelling (an object has no other). */
      readonly nullable: boolean;
    };

/** One field, or the fields whose values together identify an item (a bypass actor's type and id). */
export type MatchKey = string | readonly string[];

export interface DeltaOptions {
  /**
   * Per nested list (by dotted object path below the root, a list item spelled `[]`: `rules`, `rules[].checks`), the
   * item key to pair by; a missing or repeated key is a declaration bug.
   *
   * a list not named here  -> object items pair by shape, others by value
   * matchBy omitted        -> lists fall back to the legacy `type` sniffing subsetDiff callers rely on
   */
  readonly matchBy?: Readonly<Record<string, MatchKey>>;
  /**
   * The write replaces the live object whole, so a non-empty live value at a path the declaration omits is an
   * `omitted` delta. Callers project the live object onto the write's keys first, or server-assigned fields count.
   */
  readonly replace?: ReplaceSweep;
}

/**
 * Where the write's slice stops knowing the keys. The sweep skips `passthrough` (the dotted paths the slice leaves
 * untyped, `rules[].parameters`, `bypass_actors[]`) because it cannot tell a default GitHub filled from a value the
 * file left out: a live `require_code_owner_review: true` beside a declared pull_request rule reads clean, and the
 * PUT resets it. `nullable` names the paths whose clearing spelling is `null`.
 */
export interface ReplaceSweep {
  readonly passthrough: readonly string[];
  readonly nullable: readonly string[];
}

function isPassthrough(keyPath: string, passthrough: readonly string[]): boolean {
  return passthrough.some((path) => keyPath === path || keyPath.startsWith(`${path}.`));
}

function isScalar(value: unknown): boolean {
  return typeof value !== "object" || value === null;
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Nothing a replacing write would need to preserve: GitHub's zero values, an empty list, or a mapping
 * whose every value is empty by the same rule (an actor holder with empty lists).
 */
function isEmptySetting(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainMapping(value)) {
    return Object.values(value).every(isEmptySetting);
  }
  return false;
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
    if (!isPlainMapping(liveValue)) {
      out.push(
        absent
          ? { kind: "phantom", path, desired }
          : { kind: "mismatch", path, desired, live: liveValue },
      );
      return;
    }
    const declared = desired as Record<string, unknown>;
    for (const [key, value] of Object.entries(declared)) {
      // hasOwn, not indexing: a key named like a prototype member (toString) must read as absent, not as the inherited function.
      const child = Object.hasOwn(liveValue, key) ? liveValue[key] : ABSENT;
      walk(value, child, [...path, key], keyPath === "" ? key : `${keyPath}.${key}`, opts, out);
    }
    if (opts.replace !== undefined && !isPassthrough(keyPath, opts.replace.passthrough)) {
      for (const [key, value] of Object.entries(liveValue)) {
        const childPath = keyPath === "" ? key : `${keyPath}.${key}`;
        if (
          !Object.hasOwn(declared, key) &&
          !isEmptySetting(value) &&
          !isPassthrough(childPath, opts.replace.passthrough)
        ) {
          out.push({
            kind: "omitted",
            path: [...path, key],
            live: value,
            nullable: opts.replace.nullable.includes(childPath),
          });
        }
      }
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

function fieldsOf(key: MatchKey): readonly string[] {
  return typeof key === "string" ? [key] : key;
}

function describeKey(key: MatchKey): string {
  return fieldsOf(key)
    .map((field) => `"${field}"`)
    .join(", ");
}

/**
 * The identity of one item: its key fields' values, space-joined. A null or absent part is left out (a DeployKey
 * actor carries no id), so both spellings of the same actor read as one; an item carrying none of the fields is a
 * declaration bug.
 */
function itemKey(item: unknown, key: MatchKey, keyPath: string, side: "desired" | "live"): string {
  const parts = isPlainMapping(item) ? fieldsOf(key).filter((field) => item[field] != null) : [];
  if (!isPlainMapping(item) || parts.length === 0) {
    throw new Error(
      `BUG: matchBy pairs the list "${keyPath}" by ${describeKey(key)}, but a ${side} item carries no such key: ${JSON.stringify(item)}`,
    );
  }
  return parts.map((field) => String(item[field])).join(" ");
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
          `BUG: matchBy pairs the list "${keyPath}" by ${describeKey(declaredKey)}, but the live list repeats ${JSON.stringify(key)}`,
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
    // Items pair on the declared fields alone, so under `replace` a paired item's extra live fields read as omitted.
    const { replace: _replace, ...subset } = opts;
    const liveItems = [...live];
    for (const [index, item] of desired.entries()) {
      const matchIndex = liveItems.findIndex(
        (candidate) => deltas(item, candidate, subset).length === 0,
      );
      if (matchIndex === -1) {
        out.push({ kind: "missing", path: [...path, index], desired: item, match: "shape" });
      } else {
        if (opts.replace !== undefined) {
          walk(item, liveItems[matchIndex], [...path, index], `${keyPath}[]`, opts, out);
        }
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
  key: MatchKey,
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
        `BUG: matchBy pairs the list "${keyPath}" by ${describeKey(key)}, but the declared list repeats ${JSON.stringify(itemId)}`,
      );
    }
    declared.add(itemId);
    const match = liveByKey.get(itemId);
    const at = [...path, { key: itemId }];
    if (match === undefined) {
      out.push({ kind: "missing", path: at, desired: item, match: "key" });
    } else {
      walk(item, match, at, `${keyPath}[]`, opts, out);
    }
  }
  for (const [itemId, item] of liveByKey) {
    if (!declared.has(itemId)) {
      out.push({ kind: "undeclared", path: [...path, { key: itemId }], live: item, match: "key" });
    }
  }
}

/**
 * `rulesets[main].bypass_actors[Team 1]` under a root, or `rules[deletion].parameters.x` under an empty one:
 * the path as a settings-file reader would spell it.
 */
function renderPath(root: string, path: readonly PathStep[]): string {
  return path.reduce<string>(
    (at, step) =>
      typeof step === "string"
        ? at === ""
          ? step
          : `${at}.${step}`
        : `${at}[${typeof step === "number" ? step : step.key}]`,
    root,
  );
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

/**
 * The declaration that removes a live value on purpose, or null when the kind has no one empty spelling: a slice
 * may refuse `null` for an object, and an empty string is outside every enum.
 */
function emptyFor(live: unknown): string | null {
  if (Array.isArray(live)) {
    return "[]";
  }
  switch (typeof live) {
    case "boolean":
      return "false";
    case "number":
      return "0";
    default:
      return null;
  }
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
    case "omitted": {
      const key = renderPath("", delta.path);
      const empty = delta.nullable ? "null" : emptyFor(delta.live);
      const remove = empty === null ? "" : `, or ${key}: ${empty} to remove it on purpose`;
      return `${at}: live has ${JSON.stringify(delta.live)} but the settings file omits it, so apply would REMOVE it; declare ${key} to keep it${remove}`;
    }
  }
}

export function subsetDiff(
  desired: unknown,
  live: unknown,
  path: string,
  opts: DeltaOptions = {},
): string[] {
  return deltas(desired, live, opts).map((delta) => renderDelta(path, delta));
}

/**
 * What a replacing write would remove: the `omitted` deltas of a comparison against the live object projected onto
 * the write's own keys. The projection and the passthrough paths are the caller's, since only it knows the write's
 * schema; the declared-key comparison itself runs against the unprojected live object, so passthrough keys compare.
 */
export function omittedDeltas(
  desired: unknown,
  projectedLive: unknown,
  opts: { readonly matchBy?: DeltaOptions["matchBy"]; readonly sweep: ReplaceSweep },
): Delta[] {
  return deltas(desired, projectedLive, { matchBy: opts.matchBy, replace: opts.sweep }).filter(
    (delta) => delta.kind === "omitted",
  );
}

/**
 * Apply never issues a replacing write that would remove what the settings file omits: the operation's `before`
 * hook throws the omitted lines instead, so the run fails for that entry with its request never sent, while check
 * keeps reporting the same lines as drift. Undefined when nothing is omitted.
 */
export function refuseOmitted(
  label: string,
  omitted: readonly string[],
): (() => never) | undefined {
  if (omitted.length === 0) {
    return undefined;
  }
  const message = `${label}: not applied - the update would remove ${agree(omitted.length, "a live value", "live values")} the settings file omits. ${omitted.join(" ")}`;
  return () => {
    throw new Error(message);
  };
}

/** The phantom deltas as dotted paths (`security_and_analysis.foo`, `rules[deletion].x`), for the never-converges note. */
export function phantomPaths(found: readonly Delta[]): string[] {
  return found.flatMap((delta) => (delta.kind === "phantom" ? [renderPath("", delta.path)] : []));
}

/** Sections whose write is gated by a comparison note these, so the gating keys do not silently rewrite on every run. */
export function phantomKeys(desired: Record<string, unknown>, live: unknown): string[] {
  return phantomPaths(deltas(desired, live));
}

export function phantomNote(prefix: string, keys: string[], noun: string, rewrite: string): string {
  const list = keys.map((k) => `"${k}"`).join(", ");
  const count = keys.length;
  return (
    `${prefix}: declared ${agree(count, "key", "keys")} ${list} ${agree(count, "does", "do")} not exist on the live ${noun}, ` +
    `so if GitHub ignores ${agree(count, "it", "them")} ${rewrite} on every apply without converging. Fix the key name, or remove it from the settings file`
  );
}

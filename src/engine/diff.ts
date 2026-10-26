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

import { err, type Result } from "neverthrow";
import { isPlainObject, isZeroValue } from "../plain-data.js";
import { type SectionFailure, sectionFailure } from "../sections/contract/errors.js";
import { agree } from "../text.js";

type PathStep = string | number | { readonly key: string };

type ListMatch = "key" | "shape" | "value";

/**
 * A phantom is a non-empty declared field the live object has no key for: a typo, or a write-only field. An omitted
 * delta's `nullable` says the slice accepts `null` at its path, so `<key>: null` is the clearing spelling (an object
 * has no other).
 */
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
      readonly nullable: boolean;
    };

/** One field, or the fields whose values together identify an item (a bypass actor's type and id). */
export type MatchKey = string | readonly string[];

/**
 * How a declaration is compared with the live object. `matchBy` names, per nested list (by dotted object path below
 * the root, a list item spelled `[]`: `rules`, `rules[].checks`), the item key to pair by; a missing or repeated key
 * is a declaration bug.
 *
 *   a list not named here  -> object items pair by shape, others by value
 *   matchBy omitted        -> lists fall back to the default `type` pairing subsetDiff callers use
 *
 * `replace` says the write replaces the live object whole, so a non-empty live value at a path the declaration omits
 * is an `omitted` delta; callers project the live object onto the write's keys first, or server-assigned fields count.
 */
export interface DeltaOptions {
  /** The item key each nested list pairs by, under the rules above. */
  readonly matchBy?: Readonly<Record<string, MatchKey>>;

  /** The write replaces the live object whole, so what the declaration omits is swept into `omitted` deltas. */
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

/** Where the walk stands: `path` as renderPath spells it, `keyPath` as a matchBy or passthrough entry names it (dots, `[]` per list item). */
interface Site {
  readonly path: readonly PathStep[];
  readonly keyPath: string;
}

function isPassthrough(keyPath: string, passthrough: readonly string[]): boolean {
  return passthrough.some((path) => keyPath === path || keyPath.startsWith(`${path}.`));
}

function isScalar(value: unknown): boolean {
  return typeof value !== "object" || value === null;
}

/**
 * Nothing a replacing write would need to preserve: GitHub's zero values, an empty list, or a mapping
 * whose every value is empty by the same rule (an actor holder with empty lists).
 */
function isEmptySetting(value: unknown): boolean {
  if (isZeroValue(value)) {
    return true;
  }
  return isPlainObject(value) && Object.values(value).every(isEmptySetting);
}

/** Marks a live field the object has no own key for, as opposed to one holding undefined. */
const ABSENT: unique symbol = Symbol("no such live key");

function fieldSite(site: Site, key: string): Site {
  return {
    path: [...site.path, key],
    keyPath: site.keyPath === "" ? key : `${site.keyPath}.${key}`,
  };
}

function itemSite(site: Site, step: PathStep): Site {
  return { path: [...site.path, step], keyPath: `${site.keyPath}[]` };
}

export function deltas(desired: unknown, live: unknown, opts: DeltaOptions = {}): Delta[] {
  const out: Delta[] = [];
  walk(desired, live, { path: [], keyPath: "" }, opts, out);
  return out;
}

/** The delta for a desired value the live side lacks (`phantom`) or holds in another shape or value (`mismatch`). */
function unpaired(
  absent: boolean,
  path: readonly PathStep[],
  desired: unknown,
  live: unknown,
): Delta {
  return absent ? { kind: "phantom", path, desired } : { kind: "mismatch", path, desired, live };
}

/** A scalar's delta, or null: "" tolerates null and an absent key (GitHub's empty), anything else must equal the live value. */
function scalarDelta(
  desired: unknown,
  absent: boolean,
  live: unknown,
  path: readonly PathStep[],
): Delta | null {
  if (desired === "" && (live === null || live === undefined)) {
    return null;
  }
  return desired === live ? null : unpaired(absent, path, desired, live);
}

/** Under `replace`, a non-empty live value at a key the declaration omits is an `omitted` delta, outside the passthrough paths. */
function sweepOmitted(
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
  site: Site,
  replace: ReplaceSweep,
  out: Delta[],
): void {
  if (isPassthrough(site.keyPath, replace.passthrough)) {
    return;
  }

  for (const [key, value] of Object.entries(live)) {
    const child = fieldSite(site, key);
    if (
      Object.hasOwn(declared, key) ||
      isEmptySetting(value) ||
      isPassthrough(child.keyPath, replace.passthrough)
    ) {
      continue;
    }

    out.push({
      kind: "omitted",
      path: child.path,
      live: value,
      nullable: replace.nullable.includes(child.keyPath),
    });
  }
}

/** A declared mapping against the live one: each declared key walked, then the replace sweep over the live keys. */
function walkMapping(
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
  site: Site,
  opts: DeltaOptions,
  out: Delta[],
): void {
  for (const [key, value] of Object.entries(declared)) {
    // hasOwn, not indexing: a key named like a prototype member (toString) must read as absent, not as the inherited function.
    const child = Object.hasOwn(live, key) ? live[key] : ABSENT;
    walk(value, child, fieldSite(site, key), opts, out);
  }

  if (opts.replace !== undefined) {
    sweepOmitted(declared, live, site, opts.replace, out);
  }
}

function walk(
  desired: unknown,
  live: unknown | typeof ABSENT,
  site: Site,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const absent = live === ABSENT;
  const liveValue = absent ? undefined : live;
  if (desired === null || desired === undefined) {
    if (liveValue === null || liveValue === undefined || liveValue === "") {
      return;
    }
    out.push({ kind: "mismatch", path: site.path, desired, live: liveValue });
    return;
  }

  if (Array.isArray(desired)) {
    if (!Array.isArray(liveValue)) {
      out.push(unpaired(absent, site.path, desired, liveValue));
      return;
    }
    walkList(desired, liveValue, site, opts, out);
    return;
  }

  if (typeof desired === "object") {
    if (!isPlainObject(liveValue)) {
      out.push(unpaired(absent, site.path, desired, liveValue));
      return;
    }
    walkMapping(desired as Record<string, unknown>, liveValue, site, opts, out);
    return;
  }

  const delta = scalarDelta(desired, absent, liveValue, site.path);
  if (delta !== null) {
    out.push(delta);
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
  const parts = isPlainObject(item) ? fieldsOf(key).filter((field) => item[field] != null) : [];
  if (!isPlainObject(item) || parts.length === 0) {
    throw new Error(
      `BUG: matchBy pairs the list "${keyPath}" by ${describeKey(key)}, but a ${side} item carries no such key: ${JSON.stringify(item)}`,
    );
  }
  return parts.map((field) => String(item[field])).join(" ");
}

/** The live items by their declared key; a repeated key is a declaration bug, not drift. */
function liveByKey(live: unknown[], key: MatchKey, keyPath: string): Map<string, unknown> {
  const byKey = new Map<string, unknown>();
  for (const item of live) {
    const itemId = itemKey(item, key, keyPath, "live");
    if (byKey.has(itemId)) {
      throw new Error(
        `BUG: matchBy pairs the list "${keyPath}" by ${describeKey(key)}, but the live list repeats ${JSON.stringify(itemId)}`,
      );
    }
    byKey.set(itemId, item);
  }
  return byKey;
}

/** The live items by `type`, the default pairing, only when types are unique on both sides (ruleset rules); null for a list that repeats them (environment reviewers), which pairs by shape instead. */
function liveByType(desired: unknown[], live: unknown[]): Map<string, unknown> | null {
  const desiredTypes = desired.map(typeOf);
  const liveTypes = live.map(typeOf);
  const typed =
    desired.length > 0 &&
    desiredTypes.every((t) => t !== null) &&
    new Set(desiredTypes).size === desiredTypes.length &&
    liveTypes.every((t) => t !== null) &&
    new Set(liveTypes).size === liveTypes.length;
  if (!typed) {
    return null;
  }

  const byType = new Map<string, unknown>();
  for (const item of live) {
    byType.set(typeOf(item) as string, item);
  }
  return byType;
}

/** Each declared item against the live item of its key, the rest of the live list undeclared; a repeated declared key is a declaration bug. */
function walkKeyed(
  desired: unknown[],
  byKey: ReadonlyMap<string, unknown>,
  key: MatchKey,
  site: Site,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const declared = new Set<string>();
  for (const item of desired) {
    const itemId = itemKey(item, key, site.keyPath, "desired");
    if (declared.has(itemId)) {
      throw new Error(
        `BUG: matchBy pairs the list "${site.keyPath}" by ${describeKey(key)}, but the declared list repeats ${JSON.stringify(itemId)}`,
      );
    }
    declared.add(itemId);
    const match = byKey.get(itemId);
    const at = itemSite(site, { key: itemId });
    if (match === undefined) {
      out.push({ kind: "missing", path: at.path, desired: item, match: "key" });
    } else {
      walk(item, match, at, opts, out);
    }
  }

  for (const [itemId, item] of byKey) {
    if (!declared.has(itemId)) {
      out.push({
        kind: "undeclared",
        path: [...site.path, { key: itemId }],
        live: item,
        match: "key",
      });
    }
  }
}

/** Mapping items pair by shape, order-insensitive, on the declared fields alone: a live item nothing pairs with is undeclared because a full-payload write would remove it, and under `replace` a paired item's extra live fields read as omitted. */
function walkByShape(
  desired: unknown[],
  live: unknown[],
  site: Site,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const { replace: _replace, ...subset } = opts;
  const liveItems = [...live];
  for (const [index, item] of desired.entries()) {
    const matchIndex = liveItems.findIndex(
      (candidate) => deltas(item, candidate, subset).length === 0,
    );
    if (matchIndex === -1) {
      out.push({ kind: "missing", path: [...site.path, index], desired: item, match: "shape" });
      continue;
    }

    if (opts.replace !== undefined) {
      walk(item, liveItems[matchIndex], itemSite(site, index), opts, out);
    }
    liveItems.splice(matchIndex, 1);
  }

  for (const leftover of liveItems) {
    out.push({ kind: "undeclared", path: site.path, live: leftover, match: "shape" });
  }
}

/** Any other list (scalars, an empty one, mixed items) pairs by value: the first occurrence of a value the other side lacks is one delta. */
function walkByValue(
  desired: unknown[],
  live: unknown[],
  path: readonly PathStep[],
  out: Delta[],
): void {
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

/** The pairing a list takes: its matchBy key, else `type` when no matchBy was given and types are unique, else shape for mapping items, else value. */
function walkList(
  desired: unknown[],
  live: unknown[],
  site: Site,
  opts: DeltaOptions,
  out: Delta[],
): void {
  const declaredKey = opts.matchBy?.[site.keyPath];
  if (declaredKey !== undefined) {
    walkKeyed(desired, liveByKey(live, declaredKey, site.keyPath), declaredKey, site, opts, out);
    return;
  }

  const byType = opts.matchBy === undefined ? liveByType(desired, live) : null;
  if (byType !== null) {
    walkKeyed(desired, byType, "type", site, opts, out);
    return;
  }

  if (desired.length > 0 && desired.every(isPlainObject)) {
    walkByShape(desired, live, site, opts, out);
    return;
  }

  walkByValue(desired, live, site.path, out);
}

/**
 * `rulesets[main].bypass_actors[Team 1]` under a root, or `rules[deletion].parameters.x` under an empty one:
 * the path as a settings-file reader would spell it.
 */
export function renderPath(root: string, path: readonly PathStep[]): string {
  let at = root;
  for (const step of path) {
    if (typeof step === "number") {
      at = `${at}[${step}]`;
    } else if (typeof step === "string") {
      at = at === "" ? step : `${at}.${step}`;
    } else {
      at = `${at}[${step.key}]`;
    }
  }
  return at;
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

/** The line for a declared item the live list lacks, worded by the pairing that looked for it. */
function missingLine(at: string, match: ListMatch, desired: unknown): string {
  switch (match) {
    case "key":
      return `${at}: missing live`;
    case "shape":
      return `${at}: no matching live entry for ${JSON.stringify(desired)}`;
    case "value":
      return `${at}: missing ${JSON.stringify(desired)}`;
  }
}

/** The line for a live item the declaration lacks, worded by the pairing that met it. */
function undeclaredLine(at: string, match: ListMatch, live: unknown): string {
  switch (match) {
    case "key":
      return `${at}: present live but not declared`;
    case "shape":
      return `${at}: live entry not declared: ${JSON.stringify(live)}`;
    case "value":
      return `${at}: unexpected ${JSON.stringify(live)}`;
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
      return missingLine(at, delta.match, delta.desired);
    case "undeclared":
      return undeclaredLine(at, delta.match, delta.live);
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
 * hook fails with the omitted lines instead, so the run fails for that entry with its request never sent, while
 * check keeps reporting the same lines as drift. Undefined when nothing is omitted.
 */
export function refuseOmitted(
  label: string,
  omitted: readonly string[],
): (() => Result<never, SectionFailure>) | undefined {
  if (omitted.length === 0) {
    return undefined;
  }
  const message = `${label}: not applied - the update would remove ${agree(omitted.length, "a live value", "live values")} the settings file omits. ${omitted.join(" ")}`;
  return () => err(sectionFailure("refused", message));
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

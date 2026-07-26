/**
 * Declared-keys-only subset diff: desired is authoritative for exactly the
 * keys it declares; anything extra in the live object is ignored. Object
 * lists match by the `type` key when types are unique on BOTH sides
 * (ruleset rules), because the API reorders them; lists with repeated or
 * missing types (environment reviewers, bypass_actors) fall through to
 * order-insensitive subset matching. Both consumers depend on that split,
 * so keep the uniqueness gate intact when touching diffArray.
 *
 * Two tolerances are DELIBERATE, not gaps: desired null vs live absent, and
 * desired "" vs live null/absent, produce no drift, because GitHub returns
 * null (or omits the field) for empty values. Treating them as drift would
 * make every section that declares an empty field report false drift
 * forever. The cost is that a typo'd key with a null or "" value is
 * invisible here; phantomKeys() below is the tool for callers that need to
 * spot GitHub-ignored keys before a write.
 */

export function subsetDiff(desired: unknown, live: unknown, path: string): string[] {
  if (desired === null || desired === undefined) {
    if (live === null || live === undefined || live === "") {
      return [];
    }
    return [`${path}: expected empty, live has ${JSON.stringify(live)}`];
  }
  if (Array.isArray(desired)) {
    return diffArray(desired, live, path);
  }
  if (typeof desired === "object") {
    if (typeof live !== "object" || live === null || Array.isArray(live)) {
      return [`${path}: expected object, live has ${JSON.stringify(live)}`];
    }
    const liveRecord = live as Record<string, unknown>;
    const drift: string[] = [];
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      // hasOwn, not indexing: a key named like a prototype member (toString)
      // must read as absent, not as the inherited function.
      const liveValue = Object.hasOwn(liveRecord, key) ? liveRecord[key] : undefined;
      drift.push(...subsetDiff(value, liveValue, `${path}.${key}`));
    }
    return drift;
  }
  // Scalars. Tolerate live null vs desired "" (GitHub returns null for empty).
  if (desired === "" && (live === null || live === undefined)) {
    return [];
  }
  if (desired !== live) {
    if (live === undefined) {
      return [
        `${path}: declared ${JSON.stringify(desired)} but the API response has no such field (new or write-only field?)`,
      ];
    }
    return [`${path}: ${JSON.stringify(desired)} != ${JSON.stringify(live)}`];
  }
  return [];
}

/**
 * The declared top-level keys the live object does not carry at all -
 * the signature of a key GitHub accepted but ignored (a typo, or a
 * write-only field). Excludes declared null/"" values, which subsetDiff
 * deliberately treats as equal to an absent live field. Sections whose
 * apply is gated by a diff use this to warn that the gating keys can never
 * converge, instead of silently rewriting on every run.
 */
export function phantomKeys(desired: Record<string, unknown>, live: unknown): string[] {
  if (typeof live !== "object" || live === null || Array.isArray(live)) {
    return [];
  }
  const liveRecord = live as Record<string, unknown>;
  return Object.keys(desired).filter(
    (key) =>
      desired[key] !== null &&
      desired[key] !== undefined &&
      desired[key] !== "" &&
      !Object.hasOwn(liveRecord, key),
  );
}

/**
 * The apply-mode note for phantom keys - one source, so the per-section
 * copies cannot drift. `noun` names the live resource ("label"); `rewrite`
 * says what apply will keep doing ("this update will re-run").
 */
export function phantomNote(prefix: string, keys: string[], noun: string, rewrite: string): string {
  const list = keys.map((k) => `"${k}"`).join(", ");
  return `${prefix}: declared key(s) ${list} do not exist on the live ${noun}, so if GitHub ignores them ${rewrite} on every apply without converging. Fix the key name, or remove it from the settings file`;
}

/** The `type` key of an object list item, or null when the item has none. */
function typeOf(item: unknown): string | null {
  return typeof item === "object" && item !== null && "type" in (item as object)
    ? String((item as { type: unknown }).type)
    : null;
}

function diffArray(desired: unknown[], live: unknown, path: string): string[] {
  if (!Array.isArray(live)) {
    return [`${path}: expected list, live has ${JSON.stringify(live)}`];
  }
  const desiredTypes = desired.map(typeOf);
  const liveTypes = live.map(typeOf);
  // Match by `type` only when types are UNIQUE on both sides (ruleset rules);
  // environment reviewers repeat types and must fall through to subset
  // matching below.
  const typed =
    desired.length > 0 &&
    desiredTypes.every((t) => t !== null) &&
    new Set(desiredTypes).size === desiredTypes.length &&
    liveTypes.every((t) => t !== null) &&
    new Set(liveTypes).size === liveTypes.length;
  if (typed) {
    // Match by `type` (ruleset rules): order-insensitive, extras ignored only
    // if not declared - a live rule type absent from desired is NOT drift
    // (declared-keys-only), but a declared type missing live IS.
    const drift: string[] = [];
    const liveByType = new Map<string, unknown>();
    for (const item of live) {
      const type = typeOf(item);
      if (type !== null) {
        liveByType.set(type, item);
      }
    }
    const declaredTypes = new Set<string>();
    for (const item of desired) {
      const type = typeOf(item);
      if (type === null) {
        continue;
      }
      declaredTypes.add(type);
      const match = liveByType.get(type);
      if (match === undefined) {
        drift.push(`${path}[${type}]: missing live`);
      } else {
        drift.push(...subsetDiff(item, match, `${path}[${type}]`));
      }
    }
    // Undeclared live rules WOULD stay after an apply that sends the full
    // desired array, so they count as drift for rule lists specifically.
    for (const type of liveByType.keys()) {
      if (!declaredTypes.has(type)) {
        drift.push(`${path}[${type}]: present live but not declared`);
      }
    }
    return drift;
  }
  // Object lists without a `type` key (bypass_actors): order-insensitive
  // subset matching - each desired item must match SOME live item, and live
  // items matched by nothing are drift (a full-payload apply removes them).
  const objectList =
    desired.length > 0 &&
    desired.every((item) => typeof item === "object" && item !== null && !Array.isArray(item));
  if (objectList) {
    const drift: string[] = [];
    const liveItems = [...live];
    for (const [index, item] of desired.entries()) {
      const matchIndex = liveItems.findIndex(
        (candidate) => subsetDiff(item, candidate, "").length === 0,
      );
      if (matchIndex === -1) {
        drift.push(`${path}[${index}]: no matching live entry for ${JSON.stringify(item)}`);
      } else {
        liveItems.splice(matchIndex, 1);
      }
    }
    // Leftover live entries matter: a full-payload apply would remove them.
    for (const leftover of liveItems) {
      drift.push(`${path}: live entry not declared: ${JSON.stringify(leftover)}`);
    }
    return drift;
  }
  // Scalar lists (ref includes, topics): compare as sets.
  const desiredSet = new Set(desired.map((v) => JSON.stringify(v)));
  const liveSet = new Set(live.map((v) => JSON.stringify(v)));
  const drift: string[] = [];
  for (const value of desiredSet) {
    if (!liveSet.has(value)) {
      drift.push(`${path}: missing ${value}`);
    }
  }
  for (const value of liveSet) {
    if (!desiredSet.has(value)) {
      drift.push(`${path}: unexpected ${value}`);
    }
  }
  return drift;
}

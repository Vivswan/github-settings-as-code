/**
 * The leaf seam shared by the per-section generator fragments (src/sections/<key>/generators.ts) and their aggregator
 * (test/e2e/generators.ts). Like mock/support.ts, it imports no fragment and no aggregator, so the fragments depend on it without a cycle.
 */

import type { z } from "zod";
import { undeclaredPolicy } from "../../src/sections/contract/module.js";
import type {
  ListEndpoints,
  ListSectionKey,
  ListSectionModule,
} from "../../src/sections/shared/list-section.js";
import type { LiveState } from "./mock/state.js";
import type { Rng } from "./prng.js";

export type Json = Record<string, unknown>;

export const UNDECLARED_KEY = "_undeclared";

/** The layering directive's key, on a knobbed wrapper or at a layer's top level. */
export const LAYERING_KEY = "_layering";

export type LayeringDirective = "merge" | "replace";

export const LAYERING_DIRECTIVES: readonly LayeringDirective[] = ["merge", "replace"];

export type EntriesForm = Json[] | { [UNDECLARED_KEY]?: "keep" | "delete"; entries: Json[] };

/**
 * The SAME unwrap the engine uses. Entries come back by reference, so mutating them edits the generated document in
 * place, whichever form was drawn.
 */
export function entriesOf(value: unknown): Json[] {
  return undeclaredPolicy(value as EntriesForm, "keep").entries as Json[];
}

/**
 * Most draws stay plain: on the mock's empty live baselines an explicit policy changes no outcome, and the curated
 * *-undeclared-* scenarios pin delete/keep. WITNESS_SECTIONS (generators.ts) never call this: a `keep` over an
 * extra-undeclared witness would flip the outcome the oracle predicts from the witness alone.
 */
export function maybeWrapUndeclared(rng: Rng, entries: Json[]): EntriesForm {
  const knobRng = rng.fork("undeclared-knob");
  if (!knobRng.bool(0.25)) {
    return entries;
  }
  return knobRng.bool(0.5)
    ? { [UNDECLARED_KEY]: knobRng.pick(["keep", "delete"] as const), entries }
    : { entries };
}

/**
 * Names that reach URLs, step-summary cells, and request paths: pipes and backslashes hit summary-table escaping,
 * quotes, spaces, percent signs, and slashes hit URL encoding, plus unicode and a near-limit length.
 */
const HOSTILE_NAMES = [
  "plain",
  "with space",
  "with|pipe",
  'with"quote',
  "with\\backslash",
  "with%percent",
  "with/slash",
  "with#hash",
  "unicode-éñ中",
  "emoji-\u{1f600}",
  "a".repeat(48),
] as const;

/** A hostile-or-plain name, biased toward plain so most docs stay readable. */
export function genName(rng: Rng): string {
  return rng.bool(0.6)
    ? rng.pick(["bug", "chore", "docs", "feature", "infra"])
    : rng.pick(HOSTILE_NAMES);
}

/** A section's own duplicate check would reject two entries claiming one identity (under `fold`), so a claimed value gets the index appended. */
export function uniqueBy(
  entries: readonly Json[],
  fields: readonly string[],
  fold: (name: string) => string = (name) => name,
): Json[] {
  const claimed = new Set<string>();
  return entries.map((entry, index) => {
    const out: Json = { ...entry };
    for (const field of fields) {
      const value = out[field];
      if (typeof value !== "string") {
        continue;
      }
      let name = value;
      while (claimed.has(fold(name))) {
        name = `${name}-${index}`;
      }
      claimed.add(fold(name));
      out[field] = name;
    }
    return out;
  });
}

/**
 * The ONE pool secret references draw from; scenarioSecretEnv() (test/e2e/generators.ts) builds the child env from the
 * same map, so a reference never names a variable the env lacks. Distinctive values, so leak checks can hunt them.
 */
export const E2E_SECRET_ENV = {
  E2E_SECRET_A: "e2e-hook-secret-alpha",
  E2E_SECRET_B: "e2e-hook-secret-bravo",
  E2E_SECRET_C: "e2e-hook-secret-charlie",
} as const;

/**
 * How seeded live state relates to the declared settings, so the oracle predicts exactly. A keep-default section would
 * only note an extra item; its delete path is pinned by a curated scenario, not a witness kind.
 *
 * "matching"          -> mirrors EVERY field the handler diffs: check reports clean, apply is a no-op
 * "drift-update"      -> one DECLARED field diverges (never an omitted optional): check reports drift, apply updates
 * "extra-undeclared"  -> a live item the settings do not declare, delete-default sections only: check reports drift, apply DELETEs it
 */
export type LiveWitnessKind = "matching" | "drift-update" | "extra-undeclared";

export interface LiveWitness {
  /** The kind the state actually witnesses: "matching" when "drift-update" was requested but no entry declares a perturbable field. */
  kind: LiveWitnessKind;
  state: LiveState;
}

/** Perturbation description: absent from every description pool. */
export const DRIFT_DESCRIPTION = "witness-drift";

/** A sentinel colliding with a generated value would silently turn a drift witness into a matching one, so the collision throws. */
export function assertSentinelDisjoint(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(`witness sentinel collision: ${detail}`);
  }
}

// --- Generators from slices --------------------------------------------------

/** Read off zod's internal `_zod.def`, not a public API, so a zod upgrade can rename these. */
interface SliceDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  entries?: Record<string, string | number>;
  values?: readonly unknown[];
}

function defOf(schema: z.ZodType): SliceDef {
  return (schema as unknown as { _zod: { def: SliceDef } })._zod.def;
}

export interface SliceSeed {
  /** Per field, the pool to draw its value from; a field not named here draws a type-derived value. */
  readonly fields?: Readonly<Record<string, (rng: Rng) => unknown>>;
  /** Per OPTIONAL field, the probability it is present; 0.5 when not named. */
  readonly present?: Readonly<Record<string, number>>;
}

/**
 * Walked off the slice, so a new schema field is fuzzed without a generator edit. Every entry is parsed back through the
 * slice, so a draw a refinement rejects throws naming the field.
 */
export function generatorFromSlice(slice: z.ZodType, seed: SliceSeed = {}): (rng: Rng) => Json {
  if (defOf(slice).shape === undefined) {
    throw new Error(
      `generatorFromSlice: the slice is a ${defOf(slice).type}, not an object schema`,
    );
  }
  return (rng) => {
    const entry = drawObject(slice, seed, rng);
    // Parsed once at the outer boundary, so a nested issue names its full path.
    const parsed = slice.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue?.path.map(String).join(".") || "(entry)";
      throw new Error(
        `generatorFromSlice: the drawn value at "${at}" fails the slice (${issue?.message ?? "invalid"}) - seed the field with a pool`,
      );
    }
    return entry;
  };
}

/** Validation belongs to the caller holding the root slice, so a nested issue names its full path. */
function drawObject(schema: z.ZodType, seed: SliceSeed, rng: Rng): Json {
  const entry: Json = {};
  for (const [field, child] of Object.entries(defOf(schema).shape ?? {})) {
    const optional = defOf(child).type === "optional";
    if (optional && !rng.bool(seed.present?.[field] ?? 0.5)) {
      continue;
    }
    const pool = seed.fields?.[field];
    entry[field] = pool === undefined ? drawFrom(child, rng, field) : pool(rng);
  }
  return entry;
}

function drawFrom(schema: z.ZodType, rng: Rng, path: string): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "nonoptional":
    case "readonly":
      return drawFrom(def.innerType as z.ZodType, rng, path);
    case "string":
      return genName(rng);
    case "number":
      return rng.int(100);
    case "boolean":
      return rng.bool();
    case "enum":
      return rng.pick(Object.values(def.entries ?? {}));
    case "literal":
      return rng.pick(def.values ?? []);
    case "array":
      return Array.from({ length: rng.int(3) }, () =>
        drawFrom(def.element as z.ZodType, rng, `${path}[]`),
      );
    case "union":
      return drawFrom(rng.pick(def.options ?? []), rng, path);
    case "object":
      return drawObject(schema, {}, rng);
    default:
      throw new Error(
        `generatorFromSlice: no draw for the ${def.type} at "${path}" - seed the field with a pool`,
      );
  }
}

// --- Witnesses from lenses ---------------------------------------------------

export interface LensWitnessSpec<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
> {
  readonly section: ListSectionModule<K, Ends, Live, F>;
  /** Per write field, the value a drift-update witness stores instead; each disjoint from every generator pool. */
  readonly sentinels: Readonly<Record<string, unknown>>;
  /** The live item an extra-undeclared witness adds; absent when the section models no such kind. */
  readonly undeclared?: Json;
}

/**
 * A sparse seed buildState completes from the mock's defaults and server-owned fields. A drift-update on the identity
 * field is a case flip the fold still matches, which the handler reads as a rename.
 */
export function lensWitness<
  K extends ListSectionKey,
  Ends extends ListEndpoints,
  Live extends object,
  F extends string,
>(
  spec: LensWitnessSpec<K, Ends, Live, F>,
  rng: Rng,
  declared: Json[],
  kind: LiveWitnessKind,
  collection: keyof LiveState,
): LiveWitness {
  const { identity, lens } = spec.section.decl;
  type Entry = Parameters<typeof lens.toWrite>[0];
  const fold = identity.fold ?? ((name: string) => name);
  const writes = declared.map((entry) => lens.toWrite(entry as unknown as Entry));
  const items: Json[] = writes.map((write) => ({ ...write }));
  const state = { [collection]: items } as LiveState;
  if (kind === "matching") {
    return { kind, state };
  }
  if (kind === "extra-undeclared") {
    if (spec.undeclared === undefined) {
      throw new Error(
        `${spec.section.key}: no undeclared sentinel item is declared for the witness`,
      );
    }
    const sentinelKey = fold(String(spec.undeclared[identity.field]));
    for (const [index, write] of writes.entries()) {
      const claims = [
        String(write[identity.field]),
        ...(identity.aliases?.(declared[index] as unknown as Entry) ?? []),
      ];
      assertSentinelDisjoint(
        claims.every((claim) => fold(claim) !== sentinelKey),
        `a declared ${spec.section.key} entry resolves to the undeclared sentinel "${sentinelKey}"`,
      );
    }
    items.push({ ...spec.undeclared });
    return { kind, state };
  }
  const eligible = writes.flatMap((write, index) => {
    const name = String(write[identity.field]);
    const flipped = name.toUpperCase();
    const fields = Object.keys(write).filter(
      (field) => field !== identity.field && Object.hasOwn(spec.sentinels, field),
    );
    // Every candidate is checked, not only the one picked, so one build proves the whole pool.
    for (const field of fields) {
      assertSentinelDisjoint(
        (write as Json)[field] !== spec.sentinels[field],
        `the ${spec.section.key} ${field} pool contains ${JSON.stringify(spec.sentinels[field])}`,
      );
    }
    if (flipped !== name && fold(flipped) === fold(name)) {
      fields.push(identity.field);
    }
    return fields.map((field) => ({ index, field }));
  });
  if (eligible.length === 0) {
    return { kind: "matching", state };
  }
  const { index, field } = rng.pick(eligible);
  const live = items[index] as Json;
  live[field] =
    field === identity.field ? String(live[field]).toUpperCase() : spec.sentinels[field];
  return { kind: "drift-update", state };
}

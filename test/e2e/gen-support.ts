/**
 * The leaf seam shared by the per-section fuzz generator fragments
 * (src/sections/<key>/generators.ts) and their aggregator
 * (test/e2e/generators.ts): the entry-form plumbing, the shared name and
 * secret pools, and the live-witness vocabulary. Like mock/support.ts for the
 * mock fragments, this module imports no fragment and no aggregator, so the
 * fragments can depend on it without an import cycle.
 */

import { undeclaredPolicy } from "../../src/sections/contract/module.js";
import type { LiveState } from "./mock/state.js";
import type { Rng } from "./prng.js";

export type Json = Record<string, unknown>;

/** Either form a knobbed list section's generated value can take. */
export type EntriesForm = Json[] | { undeclared?: "keep" | "delete"; entries: Json[] };

/**
 * Unwrap a generated section value into its entry list through the SAME
 * helper the engine uses, so harness code reads both the plain and the
 * wrapped form without hand-rolled casts. Entries come back by reference:
 * mutating them (or pushing into them) edits the generated document in
 * place, whichever form was drawn. The default policy is irrelevant here -
 * only the entries are read.
 */
export function entriesOf(value: unknown): Json[] {
  return undeclaredPolicy(value as EntriesForm, "keep").entries as Json[];
}

/**
 * Sometimes rewrap a generated entry list in the `{undeclared, entries}`
 * form, so the fuzz corpus exercises the knob's parsing, merging, and
 * schema surface alongside the plain form. The policy draw is skewed toward
 * OMITTING `undeclared` (the wrapper alone), because with the mock's empty
 * live baselines an explicit policy changes no outcome - the delete/keep
 * behavior itself is pinned by curated scenarios (labels-undeclared-keep,
 * rulesets-undeclared-delete, milestones-undeclared-delete).
 *
 * The WITNESS sections (labels, milestones) must never call this: the
 * oracle refines their predictions from the seeded witness alone, so a
 * generated `undeclared: keep` over an extra-undeclared labels witness
 * would flip the engine's outcome (a kept note instead of drift/deletion)
 * and fail the iteration, and milestones' delete path has no witness
 * modeling it. New draws live on a forked stream so the pre-existing
 * main-stream sequence (and every recorded seed) stays stable.
 */
export function maybeWrapUndeclared(rng: Rng, entries: Json[]): EntriesForm {
  const knobRng = rng.fork("undeclared-knob");
  if (!knobRng.bool(0.25)) {
    return entries;
  }
  return knobRng.bool(0.5)
    ? { undeclared: knobRng.pick(["keep", "delete"] as const), entries }
    : { entries };
}

/**
 * Hostile string pool for names that flow into URLs, step-summary cells, and
 * request paths: pipes and backslashes (summary-table escaping), quotes,
 * spaces, percent signs and slashes (URL encoding), unicode, and a near-limit
 * length. A generator that mixes these in exercises the escaping and encoding
 * paths that a tidy ASCII name would never reach.
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

/**
 * The ONE fixed pool secret references draw from, name -> plaintext: webhook
 * config.secret and actions_secrets values alike. Single-sourced: the
 * generators draw `$NAME` references from these keys and scenarioSecretEnv()
 * (test/e2e/generators.ts) builds the scenario `env` from the same map, so a
 * generated reference can never name a variable the child env lacks. The
 * values are distinctive strings so leak checks can hunt them.
 */
export const E2E_SECRET_ENV = {
  E2E_SECRET_A: "e2e-hook-secret-alpha",
  E2E_SECRET_B: "e2e-hook-secret-bravo",
  E2E_SECRET_C: "e2e-hook-secret-charlie",
} as const;

/**
 * How a section's seeded live state relates to its declared settings, as a
 * SEMANTIC WITNESS the oracle can predict from exactly:
 *
 * - "matching": the live state mirrors EVERY field the handler diffs, so a
 *   correct engine reports exactly clean (check) or a no-op applied (apply).
 * - "drift-update": one DECLARED field diverges (never an omitted optional -
 *   a divergent value in a field the settings do not declare is not drift),
 *   so check must report drift and apply must issue an update.
 * - "extra-undeclared" (labels only): a live label the settings do not
 *   declare, so check reports undeclared drift and apply DELETEs it.
 *   Milestones keep undeclared entries by default, and their wrapped
 *   `undeclared: delete` path is pinned by a curated scenario
 *   (milestones-undeclared-delete) rather than a witness kind, so this
 *   kind is never generated for them.
 */
export type LiveWitnessKind = "matching" | "drift-update" | "extra-undeclared";

/** A generated live-state witness: the kind that actually holds, plus state. */
export interface LiveWitness {
  /**
   * The kind the state actually witnesses. May fall back to "matching" when
   * "drift-update" was requested but no entry declares a perturbable field.
   */
  kind: LiveWitnessKind;
  state: LiveState;
}

/** Perturbation description: absent from every description pool. */
export const DRIFT_DESCRIPTION = "witness-drift";

/**
 * Loud disjointness guard: a perturbation sentinel that collides with a
 * generated value would silently turn a drift witness into a matching one
 * (or an "undeclared" label into a declared one), so the collision throws
 * instead of degrading the witness.
 */
export function assertSentinelDisjoint(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(`witness sentinel collision: ${detail}`);
  }
}

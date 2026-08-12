/**
 * The labels section's fuzz generator fragment: the section-shaped settings
 * generator and the live-state witness builder, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  assertSentinelDisjoint,
  DRIFT_DESCRIPTION,
  genName,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

const HEX_COLORS = ["d73a4a", "a2eeef", "ededed", "0e8a16", "ffffff", "000000"] as const;

export function genLabels(rng: Rng): Json[] {
  const count = rng.int(4) + 1;
  const used = new Set<string>();
  const labels: Json[] = [];
  for (let i = 0; i < count; i++) {
    let n = genName(rng);
    while (used.has(n.toLowerCase())) {
      n = `${n}-${i}`;
    }
    used.add(n.toLowerCase());
    const label: Json = { name: n };
    if (rng.bool(0.8)) {
      label.color = rng.pick(HEX_COLORS);
    }
    if (rng.bool(0.5)) {
      label.description = rng.pick(["", "does a thing", genName(rng)]);
    }
    labels.push(label);
  }
  // labels is a WITNESS section: always the plain array form, never
  // maybeWrapUndeclared (its rationale explains why).
  return labels;
}

/** Perturbation color: absent from HEX_COLORS, so it always reads as drift. */
const DRIFT_COLOR = "123456";
/** The extra-undeclared live label; no generated name collides with it. */
const UNDECLARED_LABEL: Json = {
  name: "zz-undeclared-witness",
  color: "cccccc",
  description: "live label the settings never declare",
};

/**
 * A live label body that the labels handler diffs as EXACTLY equal
 * (src/sections/labels/): the live label carries the FINAL name (new_name
 * wins - the handler matches by source or target key and treats any other
 * live name as rename drift), the declared color/description verbatim (they
 * are diffed only when DECLARED, so undeclared ones take fixed fillers), and
 * every extra declared key verbatim (extras are subsetDiffed as passthrough
 * fields, so a hardcoded field list would silently read as drift).
 */
function matchingLiveLabel(label: Json): Json {
  const { name, new_name, color, description, ...extras } = label;
  return {
    name: new_name ?? name,
    color: color ?? "ededed",
    description: description ?? null,
    ...extras,
  };
}

/**
 * True when uppercasing changes the name but keeps its case-insensitive key,
 * so the flipped live name still matches the declared label and the handler
 * reads it as rename drift (existing.name !== finalName).
 */
function caseFlippable(name: string): boolean {
  const flipped = name.toUpperCase();
  return flipped !== name && flipped.toLowerCase() === name.toLowerCase();
}

/**
 * The fields of one declared label a drift-update witness may perturb. The
 * name candidate flips the case of the FINAL name (new_name resolved), so the
 * divergence reads as rename drift against the post-rename state.
 */
function labelDriftFields(label: Json): Array<"color" | "description" | "name"> {
  const fields: Array<"color" | "description" | "name"> = [];
  if (label.color !== undefined) {
    fields.push("color");
  }
  if (label.description !== undefined) {
    fields.push("description");
  }
  if (caseFlippable(String(label.new_name ?? label.name))) {
    fields.push("name");
  }
  return fields;
}

export function labelsWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const labels = declared.map(matchingLiveLabel);
  if (kind === "matching") {
    return { kind, state: { labels } };
  }
  if (kind === "extra-undeclared") {
    const undeclaredKey = String(UNDECLARED_LABEL.name).toLowerCase();
    for (const label of declared) {
      assertSentinelDisjoint(
        String(label.name).toLowerCase() !== undeclaredKey &&
          String(label.new_name ?? label.name).toLowerCase() !== undeclaredKey,
        `a declared label resolves to the undeclared sentinel "${undeclaredKey}"`,
      );
    }
    return { kind, state: { labels: [...labels, { ...UNDECLARED_LABEL }] } };
  }
  const eligible = declared
    .map((label, index) => ({ index, fields: labelDriftFields(label) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    return { kind: "matching", state: { labels } };
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = labels[index] as Json;
  const field = rng.pick(fields);
  if (field === "color") {
    assertSentinelDisjoint(
      source.color !== DRIFT_COLOR,
      `the label color pool contains ${DRIFT_COLOR}`,
    );
    live.color = DRIFT_COLOR;
  } else if (field === "description") {
    assertSentinelDisjoint(
      source.description !== DRIFT_DESCRIPTION,
      `the label description pool contains "${DRIFT_DESCRIPTION}"`,
    );
    live.description = DRIFT_DESCRIPTION;
  } else {
    live.name = String(source.new_name ?? source.name).toUpperCase();
  }
  return { kind: "drift-update", state: { labels } };
}

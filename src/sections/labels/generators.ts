/**
 * The labels fuzz generator fragment. It imports test-tree seams on purpose: the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import {
  generatorFromSlice,
  genName,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  lensWitness,
  uniqueBy,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { labelsSection, nameKey } from "./index.js";
import { LabelConfig } from "./schema.js";

const HEX_COLORS = ["d73a4a", "a2eeef", "ededed", "0e8a16", "ffffff", "000000"] as const;

const genLabel = generatorFromSlice(LabelConfig, {
  fields: {
    color: (rng) => rng.pick(HEX_COLORS),
    description: (rng) => rng.pick(["", "does a thing", genName(rng)]),
  },
  present: { color: 0.8, description: 0.5, new_name: 0.15 },
});

export function genLabels(rng: Rng): Json[] {
  const labels = Array.from({ length: rng.int(4) + 1 }, () => genLabel(rng));
  return uniqueBy(labels, ["name", "new_name"], nameKey);
}

export function labelsWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  return lensWitness(
    {
      section: labelsSection,
      // A color absent from HEX_COLORS and a description absent from its pool.
      sentinels: { color: "123456", description: "witness-drift" },
      undeclared: {
        name: "zz-undeclared-witness",
        color: "cccccc",
        description: "live label the settings never declare",
      },
    },
    rng,
    declared,
    kind,
    "labels",
  );
}

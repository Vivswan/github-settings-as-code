/**
 * The autolinks fuzz fragment: the entry generator walks the AutolinkConfig slice and the witness
 * derives from the lens, so only the corpus invariants live here (plausible templates, one entry
 * per prefix, sentinels). Imports only the test-tree seams; the bundle entry is src/main.ts.
 */

import {
  generatorFromSlice,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  lensWitness,
  uniqueBy,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { autolinksSection } from "./index.js";
import { AutolinkConfig } from "./schema.js";

const genAutolink = generatorFromSlice(AutolinkConfig, {
  fields: {
    key_prefix: (rng) => `${rng.pick(["JIRA", "TICKET", "REF"])}-`,
    url_template: (rng) => `https://example.com/browse/<num>?ref=${rng.int(100)}`,
  },
});

export function genAutolinks(rng: Rng): Json[] {
  const autolinks = Array.from({ length: rng.int(2) + 1 }, () => genAutolink(rng));
  // autolinks is a WITNESS section: always the plain array form, never maybeWrapUndeclared.
  return uniqueBy(autolinks, ["key_prefix"]);
}

export function autolinksWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  return lensWitness(
    {
      section: autolinksSection,
      // A template no generated entry can spell (the pool's carry a numeric ref).
      sentinels: { url_template: "https://witness.example.com/<num>" },
      undeclared: {
        key_prefix: "ZZ-UNDECLARED-",
        url_template: "https://undeclared.example.com/<num>",
        is_alphanumeric: true,
      },
    },
    rng,
    declared,
    kind,
    "autolinks",
  );
}

/**
 * The autolinks fuzz generator fragment.
 */

import { autolinksSection } from "../../../src/sections/autolinks/index.js";
import { AutolinkConfig } from "../../../src/sections/autolinks/schema.js";
import {
  generatorFromSlice,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  lensWitness,
} from "../../e2e/gen-support.js";
import type { Rng } from "../../e2e/prng.js";

// No pool prefix begins another: a suffixed collision ("TICKET-" and "TICKET--1") would be the
// pair the section refuses before its first create.
const KEY_PREFIXES = ["JIRA-", "TICKET-", "REF-"] as const;

const genAutolink = generatorFromSlice(AutolinkConfig, {
  fields: {
    key_prefix: (rng) => rng.pick(KEY_PREFIXES),
    url_template: (rng) => `https://example.com/browse/<num>?ref=${rng.int(100)}`,
  },
});

export function genAutolinks(rng: Rng): Json[] {
  const pool = [...KEY_PREFIXES];
  return Array.from({ length: rng.int(2) + 1 }, () => {
    const key_prefix = pool.splice(rng.int(pool.length), 1)[0];
    return { ...genAutolink(rng), key_prefix };
  });
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

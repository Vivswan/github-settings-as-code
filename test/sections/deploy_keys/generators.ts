/**
 * The deploy_keys fuzz generator fragment.
 */

import { deployKeysSection } from "../../../src/sections/deploy_keys/index.js";
import { DeployKeyConfig } from "../../../src/sections/deploy_keys/schema.js";
import {
  generatorFromSlice,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  lensWitness,
  uniqueBy,
} from "../../e2e/gen-support.js";
import type { Rng } from "../../e2e/prng.js";

/**
 * Each title owns one blob, DISTINCT from the others (GitHub rejects a reused public key with a 422, and the section
 * refuses the pair at validation), so two layers naming one title agree on its material and two titles never share
 * one. The comments are load-bearing: the mock strips them on storage the way GitHub does, so a converging apply
 * proves the section compares algorithm + blob, not the string.
 */
const DEPLOY_KEY_POOL = {
  bot: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzAlphaAlphaAlphaAlphaAlphaAlphaAlph deploy@alpha",
  ci: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzBravoBravoBravoBravoBravoBravoBrav deploy@bravo",
  mirror:
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCe2eFuzzCharlieCharlieCharlieCharlieCharlieCharlie deploy@charlie",
  release:
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTZAAAAIbmlzdHAyNTYAAABBBe2e deploy@delta",
} as const;

const DEPLOY_KEY_TITLES = Object.keys(DEPLOY_KEY_POOL) as (keyof typeof DEPLOY_KEY_POOL)[];

const genDeployKey = (title: keyof typeof DEPLOY_KEY_POOL) =>
  generatorFromSlice(DeployKeyConfig, {
    fields: { title: () => `deploy-${title}`, key: () => DEPLOY_KEY_POOL[title] },
  });

export function genDeployKeys(rng: Rng): Json[] {
  // A run of distinct titles from a random start: never the same title twice, so never the same blob twice.
  const count = rng.int(DEPLOY_KEY_TITLES.length) + 1;
  const start = rng.int(DEPLOY_KEY_TITLES.length);
  const keys = Array.from({ length: count }, (_, offset) => {
    const title = DEPLOY_KEY_TITLES[(start + offset) % DEPLOY_KEY_TITLES.length];
    if (title === undefined) {
      throw new Error("BUG: deploy key title index out of range");
    }
    return genDeployKey(title)(rng);
  });
  return uniqueBy(keys, ["title"]);
}

export function deployKeysWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  return lensWitness(
    {
      section: deployKeysSection,
      // A blob outside DEPLOY_KEY_POOL; read_only is a boolean, so no sentinel can be disjoint.
      sentinels: {
        key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWitnessDriftWitnessDriftWitnessDriftWit",
      },
    },
    rng,
    declared,
    kind,
    "deploy_keys",
  );
}

/**
 * The deploy_keys fuzz fragment: the entry generator walks the DeployKeyConfig slice and the witness
 * derives from the lens, so only the corpus invariants live here (distinct material and titles per
 * document, the material sentinel). Imports only the test-tree seams; the bundle entry is src/main.ts.
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
import { deployKeysSection } from "./index.js";
import { DEPLOY_KEYS_MOCK } from "./mock.js";
import { DeployKeyConfig } from "./schema.js";

/**
 * Plausible "algorithm blob comment" strings whose blobs are DISTINCT (GitHub rejects a reused
 * public key with a 422). The comments are load-bearing: the mock strips them on storage the way
 * GitHub does, so a converging apply proves the section compares algorithm + blob, not the string.
 */
const DEPLOY_KEY_POOL = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzAlphaAlphaAlphaAlphaAlphaAlphaAlph deploy@alpha",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzBravoBravoBravoBravoBravoBravoBrav deploy@bravo",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCe2eFuzzCharlieCharlieCharlieCharlieCharlie deploy@charlie",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTZAAAAIbmlzdHAyNTYAAABBBe2e deploy@delta",
] as const;

const genDeployKey = generatorFromSlice(DeployKeyConfig, {
  fields: { title: (rng) => `deploy-${rng.pick(["bot", "ci", "mirror"])}` },
});

export function genDeployKeys(rng: Rng): Json[] {
  // Distinct material per document: the pool is sliced, never sampled with replacement, because a
  // reused blob is rejected by the section's own conflict check before any request.
  const count = rng.int(DEPLOY_KEY_POOL.length) + 1;
  const keys = DEPLOY_KEY_POOL.slice(0, count).map((key) => ({ ...genDeployKey(rng), key }));
  // deploy_keys is a WITNESS section: always the plain array form, never maybeWrapUndeclared.
  return uniqueBy(keys, ["title"]);
}

export function deployKeysWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  return lensWitness(
    {
      section: deployKeysSection,
      defaults: DEPLOY_KEYS_MOCK.defaults,
      owned: DEPLOY_KEYS_MOCK.owned,
      // A blob outside DEPLOY_KEY_POOL; read_only is a boolean, so no sentinel can be disjoint.
      sentinels: {
        key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWitnessDriftWitnessDriftWitnessDrift",
      },
    },
    rng,
    declared,
    kind,
    "deploy_keys",
  );
}

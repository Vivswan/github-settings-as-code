/**
 * The deploy_keys section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type EntriesForm, type Json, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/**
 * The fixed pool deploy-key entries draw from: plausible
 * "algorithm blob comment" strings whose blobs are DISTINCT (GitHub rejects a
 * reused public key with a 422, account-wide, and the mock mirrors that per
 * repo). The comments are load-bearing for the corpus: the mock strips them on
 * storage the way GitHub normalizes stored material, so a converging apply
 * proves the section compares algorithm + blob, not the raw string.
 */
const DEPLOY_KEY_POOL = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzAlphaAlphaAlphaAlphaAlphaAlphaAlph deploy@alpha",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2eFuzzBravoBravoBravoBravoBravoBravoBrav deploy@bravo",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCe2eFuzzCharlieCharlieCharlieCharlieCharlie deploy@charlie",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTZAAAAIbmlzdHAyNTYAAABBBe2e deploy@delta",
] as const;

export function genDeployKeys(rng: Rng): EntriesForm {
  // Distinct keys AND distinct titles per document: the pool is sliced, never
  // sampled with replacement, because a duplicated blob 422s on create and a
  // duplicated title is rejected by the section's own duplicate check.
  const count = rng.int(DEPLOY_KEY_POOL.length) + 1;
  const entries: Json[] = DEPLOY_KEY_POOL.slice(0, count).map((key, i) => {
    const entry: Json = { title: `deploy-${rng.pick(["bot", "ci", "mirror"])}-${i}`, key };
    if (rng.bool(0.5)) {
      entry.read_only = rng.bool();
    }
    return entry;
  });
  return maybeWrapUndeclared(rng, entries);
}

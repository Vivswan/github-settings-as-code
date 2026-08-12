/**
 * The secret_scanning_custom_patterns section's fuzz generator fragment,
 * aggregated by test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type EntriesForm, type Json, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/**
 * Names and regexes come from small fixed pools (the index suffix keeps
 * names unique under the exact-name natural key); delimiters and the
 * must_match/must_not_match extras ride along occasionally so the optional
 * fields are exercised. The regexes are inert strings to this action
 * (passthrough), so simple realistic shapes are enough.
 */
export function genSecretScanningPatterns(rng: Rng): EntriesForm {
  const entries: Json[] = Array.from({ length: rng.int(3) + 1 }, (_, i) => {
    const entry: Json = {
      name: `${rng.pick(["internal-api-token", "staging-key", "vendor-secret", "license-key"])}-${i}`,
      pattern: rng.pick(["int_[a-z0-9]{8}", "key-[0-9]{6}", "tok_[A-Za-z0-9]{12}"]),
    };
    if (rng.bool(0.3)) {
      entry.start_delimiter = "\\b";
    }
    if (rng.bool(0.3)) {
      entry.end_delimiter = rng.pick(["\\b", "\\z"]);
    }
    if (rng.bool(0.2)) {
      entry.must_match = ["^prefix_prod"];
    }
    if (rng.bool(0.2)) {
      entry.must_not_match = ["test", "example"];
    }
    return entry;
  });
  return maybeWrapUndeclared(rng, entries);
}

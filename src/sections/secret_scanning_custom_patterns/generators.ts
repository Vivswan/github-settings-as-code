/**
 * The secret_scanning_custom_patterns fuzz fragment: the entry generator walks the slice, so only
 * the pools and the exact-name uniqueness rule live here. Imports only the test-tree seams; the
 * bundle entry is src/main.ts, so this never reaches lib/index.js.
 */

import {
  type EntriesForm,
  generatorFromSlice,
  type Json,
  maybeWrapUndeclared,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { SecretScanningPatternConfig } from "./schema.js";

const NAMES = ["internal-api-token", "staging-key", "vendor-secret", "license-key"] as const;
// The regexes are inert strings to this action (passthrough), so simple realistic shapes suffice.
const PATTERNS = ["int_[a-z0-9]{8}", "key-[0-9]{6}", "tok_[A-Za-z0-9]{12}"] as const;

export function genSecretScanningPatterns(rng: Rng): EntriesForm {
  // The index suffix keeps names unique under the exact-name natural key,
  // applied inside the pool so the slice validates the final name.
  let index = 0;
  const genPattern = generatorFromSlice(SecretScanningPatternConfig, {
    fields: {
      name: (rng) => `${rng.pick(NAMES)}-${index++}`,
      pattern: (rng) => rng.pick(PATTERNS),
      start_delimiter: () => "\\b",
      end_delimiter: (rng) => rng.pick(["\\b", "\\z"]),
      must_match: () => ["^prefix_prod"],
      must_not_match: () => ["test", "example"],
    },
    present: { start_delimiter: 0.3, end_delimiter: 0.3, must_match: 0.2, must_not_match: 0.2 },
  });
  const entries: Json[] = Array.from({ length: rng.int(3) + 1 }, () => genPattern(rng));
  return maybeWrapUndeclared(rng, entries);
}

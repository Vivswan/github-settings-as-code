/**
 * The secret_scanning_custom_patterns fuzz generator fragment.
 */

import { SecretScanningPatternConfig } from "../../../src/sections/secret_scanning_custom_patterns/schema.js";
import {
  type EntriesForm,
  generatorFromSlice,
  type Json,
  maybeWrapUndeclared,
} from "../../e2e/gen-support.js";
import type { Rng } from "../../e2e/prng.js";

const NAMES = ["internal-api-token", "staging-key", "vendor-secret", "license-key"] as const;
// Every pool value passes the syntax check (generatorFromSlice validates each draw against the slice), and
// three spell Hyperscan-only forms the check translates; the refused draw lives in the invalid-settings
// catalog (test/e2e/generators.ts), predicted by the same check.
const PATTERNS = [
  "int_[a-z0-9]{8}",
  "key-[0-9]{6}",
  "tok_[A-Za-z0-9]{12}",
  "(?P<token>vnd_[a-z0-9]{10})",
  "(?#vendor)vnd-[0-9]{8}",
  "lic_[\\x{41}-\\x{5A}]{6}",
] as const;

export function genSecretScanningPatterns(rng: Rng): EntriesForm {
  // The index suffix keeps names unique under the exact-name natural key; applied inside the pool
  // so the slice validates the final name.
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

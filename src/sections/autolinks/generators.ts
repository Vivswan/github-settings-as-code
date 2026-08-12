/**
 * The autolinks section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type EntriesForm, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genAutolinks(rng: Rng): EntriesForm {
  const entries = Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    key_prefix: `${rng.pick(["JIRA", "TICKET", "REF"])}-${i}-`,
    url_template: `https://example.com/browse/<num>?ref=${i}`,
    is_alphanumeric: rng.bool(),
  }));
  return maybeWrapUndeclared(rng, entries);
}

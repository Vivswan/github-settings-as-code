/**
 * The pages fuzz generator fragment, aggregated by test/e2e/generators.ts. It imports only the
 * test-tree leaf seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genPages(rng: Rng): Json | null {
  if (rng.bool(0.25)) {
    return null;
  }
  // The generator never seeds Pages into live state, so every Pages scenario is a create, and the
  // create POST must carry source.
  const pages: Json = {
    source: { branch: rng.pick(["main", "gh-pages"]), path: rng.pick(["/", "/docs"]) },
  };
  if (rng.bool(0.4)) {
    pages.https_enforced = rng.bool();
  }
  return pages;
}

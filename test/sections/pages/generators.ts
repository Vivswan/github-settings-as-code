/**
 * The pages fuzz generator fragment, aggregated by test/e2e/generators/settings.ts.
 */

import type { Json } from "../../e2e/generators/gen-support.js";
import type { Rng } from "../../e2e/generators/prng.js";

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

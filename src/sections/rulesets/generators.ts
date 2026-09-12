/**
 * The rulesets fuzz generator fragment, aggregated by test/e2e/generators.ts. It imports only the
 * test-tree leaf seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type EntriesForm, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genRulesets(rng: Rng): EntriesForm {
  const entries = Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const target = rng.pick(["branch", "tag"] as const);
    return {
      name: `${rng.pick(["protect", "guard", "lock"])}-${i}`,
      target,
      enforcement: rng.pick(["active", "disabled", "evaluate"]),
      conditions: {
        ref_name: {
          include: [target === "tag" ? "~ALL" : "~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [{ type: rng.pick(["deletion", "non_fast_forward", "required_signatures"]) }],
      // The fuzz seeds no live rulesets, so this reaches the write payloads only; the
      // hidden-key read path is the rulesets-check-bypass-hidden scenario.
      ...rng.pick([
        {},
        { bypass_actors: [] },
        { bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] },
      ]),
    };
  });
  return maybeWrapUndeclared(rng, entries);
}

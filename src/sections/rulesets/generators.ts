/**
 * The rulesets fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import { type EntriesForm, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/**
 * The five parameters the spec requires of a pull_request rule, so a drawn rule parses and passes the mock's
 * request-body check; the invalid catalog (test/e2e/generators.ts) mis-cases one field of this set.
 */
export const PULL_REQUEST_PARAMETERS = {
  dismiss_stale_reviews_on_push: true,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 1,
  required_review_thread_resolution: false,
} as const;

export function genRulesets(rng: Rng): EntriesForm {
  const entries = Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const target = rng.pick(["branch", "tag"] as const);
    // A typed rule rides beside the bare one on branch targets, so the fuzz exercises the parameter shapes too.
    const typedRule =
      target === "branch" && rng.bool()
        ? [
            {
              type: "pull_request",
              parameters: {
                ...PULL_REQUEST_PARAMETERS,
                required_approving_review_count: rng.int(3),
              },
            },
          ]
        : [];
    return {
      name: `${rng.pick(["protect", "guard", "lock"])}-${i}`,
      // The file may leave both out: the slice fills them at parse, so an omitted target is a branch ruleset.
      ...(target === "branch" && rng.bool(0.3) ? {} : { target }),
      ...(rng.bool(0.3) ? {} : { enforcement: rng.pick(["active", "disabled", "evaluate"]) }),
      conditions: {
        ref_name: {
          include: [target === "tag" ? "~ALL" : "~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        { type: rng.pick(["deletion", "non_fast_forward", "required_signatures"]) },
        ...typedRule,
      ],
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

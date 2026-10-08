/**
 * What the descriptor cannot say about a rule's parameters, applied over the generated rows (spec-rules.ts) by rule
 * type and field: gen-openapi.ts emits the `.check()` and refuses an entry naming a field the descriptor no longer
 * carries. Every check aborts, like the generated bounds: zod hands a union branch's own issues back only when it is
 * the single branch that failed on non-aborting checks, and ruleUnionError (schema.ts) must be the one report.
 */

import { z } from "zod";

/** The spec: "At least one option must be enabled"; omitting the key allows all three. */
const atLeastOneMergeMethod = new z.core.$ZodCheckMinLength({
  check: "min_length",
  minimum: 1,
  abort: true,
  when: (payload) => Array.isArray(payload.value),
  error: () =>
    'allowed_merge_methods needs at least one of "merge", "squash", "rebase"; omit the key to allow all three',
});

export const RULE_OVERRIDES = {
  pull_request: { allowed_merge_methods: atLeastOneMergeMethod },
} as const;

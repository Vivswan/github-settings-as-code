/**
 * What the descriptor cannot say about a rule's parameters, keyed by rule type and field, and attached to the
 * generated rows (src/generated/spec-rules.ts) here rather than emitted into them, so that file imports only
 * zod. RuleOverrides pins every key to a field the descriptor emits and every check to that field's type, so a key
 * the descriptor stops carrying fails typecheck naming it. Every check aborts, like the generated bounds: zod hands a
 * union branch's own issues back only when it is the single branch that failed on non-aborting checks, and
 * ruleUnionError (schema.ts) must be the one report.
 */

import { z } from "zod";
import type { SPEC_RULES } from "../../generated/spec-rules.js";

type SpecRule = (typeof SPEC_RULES)[number];

type ParametersOf<Rule> = Rule extends {
  readonly shape: { readonly parameters: z.ZodOptional<infer Parameters extends z.ZodObject> };
}
  ? Parameters
  : never;

type Unwrapped<Field> = Field extends z.ZodOptional<infer Inner> ? Inner : Field;

type FieldChecks<Parameters extends z.ZodObject> = {
  readonly [Field in keyof Parameters["shape"]]?: z.core.$ZodCheck<
    z.output<Unwrapped<Parameters["shape"][Field]>>
  >;
};

/** One optional check per field of every rule type the descriptor gives parameters. */
export type RuleOverrides = {
  readonly [Rule in SpecRule as [ParametersOf<Rule>] extends [never]
    ? never
    : Rule["shape"]["type"]["value"]]?: FieldChecks<ParametersOf<Rule>>;
};

/** The spec: "At least one option must be enabled"; omitting the key allows all three. */
const atLeastOneMergeMethod = new z.core.$ZodCheckMinLength({
  check: "min_length",
  minimum: 1,
  abort: true,
  when: (payload) => Array.isArray(payload.value),
  error: () =>
    'allowed_merge_methods needs at least one of "merge", "squash", "rebase"; omit the key to allow all three',
});

export const RULE_OVERRIDES: RuleOverrides = {
  pull_request: { allowed_merge_methods: atLeastOneMergeMethod },
};

/** What the override application reads of a generated row; a check moves no field's type. */
type LooseRow = z.ZodObject<
  {
    readonly type: z.ZodLiteral<string>;
    readonly parameters?: z.ZodOptional<
      z.ZodObject<Readonly<Record<string, z.ZodType>>, z.core.$loose>
    >;
  },
  z.core.$loose
>;

type LooseOverrides = Readonly<
  Record<string, Readonly<Record<string, z.core.$ZodCheck | undefined>> | undefined>
>;

const isOptional = (field: z.ZodType): field is z.ZodOptional<z.ZodType> =>
  field instanceof z.ZodOptional;

/** Attached inside an optional field, as the generated bounds are, so the published schema carries the check. */
function checked(field: z.ZodType, check: z.core.$ZodCheck): z.ZodType {
  // RuleOverrides typed the check by its field; the loose row sees neither type.
  const attach = (inner: z.ZodType) => inner.check(check as z.core.$ZodCheck<unknown>);
  return isOptional(field) ? attach(field.unwrap()).optional() : attach(field);
}

/**
 * The rows with their overrides attached. zod's extend() starts a fresh registry entry, so the rebuilt row and
 * parameters object take the published id and prose back from the ones they replace.
 */
export function withOverrides(
  rows: typeof SPEC_RULES,
  overrides: RuleOverrides,
): typeof SPEC_RULES {
  const loose: readonly LooseRow[] = rows;
  const byType: LooseOverrides = overrides;
  const rebuilt: readonly LooseRow[] = loose.map((row) => {
    const inner = row.shape.parameters?.unwrap();
    const checks = byType[row.shape.type.value];
    if (inner === undefined || checks === undefined) {
      return row;
    }
    const shape = Object.fromEntries(
      Object.entries(inner.shape).map(([name, field]) => {
        const check = checks[name];
        return [name, check === undefined ? field : checked(field, check)];
      }),
    );
    return row
      .extend({
        parameters: inner
          .extend(shape)
          .meta(inner.meta() ?? {})
          .optional(),
      })
      .meta(row.meta() ?? {});
  });
  return rebuilt as typeof SPEC_RULES;
}

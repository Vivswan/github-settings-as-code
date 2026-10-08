/**
 * The `rulesets:` section's entry-config declaration (see src/schema.ts). What the settings file alone can show
 * wrong is refused here, before any request; what only the live repository can judge stays with GitHub.
 */

import { z } from "zod";
import { isPlainObject } from "../../plain-data.js";
import { rule as gatedRule, open } from "../shared/schema-helpers.js";
import { SPEC_RULES } from "./spec-rules.js";

// --- Ref-name conditions ------------------------------------------------------

/** The two tokens GitHub reads in a ref-name pattern; any other "~" means nothing, since no ref name contains one. */
const REF_NAME_TOKENS = ["~ALL", "~DEFAULT_BRANCH"] as const;

/**
 * What git check-ref-format refuses in a ref name and a ruleset fnmatch pattern has no use for either (GitHub
 * documents "\\" quoting and "[^...]" as unsupported): "~" outside the two tokens, "^", ":", "\\", space, "..", "@{",
 * and control characters. A pattern carrying one is a typo. "*", "?", and "[" are pattern syntax and stay.
 */
const REF_NAME_ILLEGAL = String.raw`[~^:\\ \x00-\x1f\x7f]|\.\.|@\{`;

/** A token, or a value with no illegal sequence at any position; as a regex so the published schema carries the rule. */
const REF_NAME_PATTERN = new RegExp(
  `^(?:${REF_NAME_TOKENS.join("|")}|(?:(?!${REF_NAME_ILLEGAL})[\\s\\S])*)$`,
);

/** JSON's rendering, which escapes every control character but DEL, so the message never carries an invisible one. */
const quoted = (text: string) => JSON.stringify(text).replace(/\x7f/g, "\\u007f");

// normalizeRefName (index.ts) passes every "~" value through unprefixed, so a typo'd token would reach GitHub as written.
const RefNamePattern = z.string().regex(REF_NAME_PATTERN, {
  error: (issue) => {
    const value = String(issue.input);
    const hit = new RegExp(REF_NAME_ILLEGAL).exec(value)?.[0] ?? "";
    return hit === "~"
      ? `${quoted(value)} is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH (case-sensitive), and no ref name contains "~"`
      : `${quoted(value)} contains ${quoted(hit)}: git refuses "~", "^", ":", "\\", space, "..", "@{", and control characters in a ref name, and a ruleset pattern has no use for them`;
  },
});

// --- Bypass actors --------------------------------------------------------------

const BYPASS_ACTOR_TYPES = [
  "Integration",
  "OrganizationAdmin",
  "RepositoryRole",
  "Team",
  "DeployKey",
  "User",
] as const;

/** The actor types whose actor_id GitHub requires; OrganizationAdmin ignores it and DeployKey documents it as null. */
const IDENTIFIED_ACTOR_TYPES: ReadonlySet<string> = new Set([
  "Integration",
  "RepositoryRole",
  "Team",
  "User",
]);

const BypassActorConfig = z
  .looseObject({
    // The spec's order, which is also the code-point order a bare mapping rendered in, so canonical documents keep their bytes.
    actor_id: z.int().nullable().optional(),
    actor_type: z.enum(BYPASS_ACTOR_TYPES),
    bypass_mode: z.enum(["always", "pull_request", "exempt"]).optional(),
  })
  .check(
    gatedRule((actor, refineCtx) => {
      if (IDENTIFIED_ACTOR_TYPES.has(actor.actor_type) && typeof actor.actor_id !== "number") {
        refineCtx.addIssue({
          code: "custom",
          path: ["actor_id"],
          message: `a ${actor.actor_type} bypass actor needs its numeric actor_id (the id GitHub assigns the app, role, team, or user); GitHub rejects the ruleset without it`,
        });
      }
      if (actor.actor_type === "DeployKey" && typeof actor.actor_id === "number") {
        refineCtx.addIssue({
          code: "custom",
          path: ["actor_id"],
          message:
            "a DeployKey bypass actor takes no actor_id (GitHub documents it as null); remove the key or write null",
        });
      }
      if (actor.actor_type === "DeployKey" && actor.bypass_mode === "pull_request") {
        refineCtx.addIssue({
          code: "custom",
          path: ["bypass_mode"],
          message:
            'bypass_mode "pull_request" does not apply to a DeployKey actor; use "always" or "exempt"',
        });
      }
    }),
  )
  .meta({ id: "BypassActorConfig" });

// --- Rules ------------------------------------------------------------------------

export const KNOWN_RULE_TYPES: readonly string[] = SPEC_RULES.map(
  (known) => known.shape.type.value,
);

/**
 * A rule type the spec does not know passes through untouched, so a type GitHub ships tomorrow reaches it the
 * day it ships and a typo'd type comes back as GitHub's own 422 (the rulesets-invalid-rule-type scenario).
 * The published schema says the same through `not`.
 */
const UnknownRule = z
  .looseObject({
    type: z
      .string()
      .check(
        gatedRule((type, refineCtx) => {
          if (KNOWN_RULE_TYPES.includes(type)) {
            refineCtx.addIssue({ code: "custom", continue: false });
          }
        }),
      )
      .meta({ not: { enum: [...KNOWN_RULE_TYPES] } }),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "UnknownRule" });

/**
 * zod reports a failed union as "Invalid input" unless exactly one branch failed on non-aborting checks alone, and
 * here every branch aborts, so the report is built from the branch the rule's type selects.
 */
function ruleUnionError(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "invalid_union") {
    return undefined;
  }
  const [known = [], unknown = []] = issue.errors;
  const type = (issue.input as { type?: unknown } | null)?.type;
  const own = typeof type === "string" && KNOWN_RULE_TYPES.includes(type) ? known : unknown;
  return own
    .map((sub) =>
      sub.path.length === 0 ? sub.message : `${z.core.toDotPath(sub.path)}: ${sub.message}`,
    )
    .join("; ");
}

const RuleConfig = z
  .union([z.discriminatedUnion("type", [...SPEC_RULES]), UnknownRule], { error: ruleUnionError })
  .meta({ id: "RuleConfig" });

// --- The ruleset --------------------------------------------------------------------

export const RulesetConfig = open({
  name: z.string(),
  // The file may omit both: target takes the default GitHub documents for a create, enforcement the value chosen
  // here (the create requires one). The parsed entry carries both, so the PUT sends them and the comparison never
  // reads a live value under either key as omitted.
  target: z.enum(["branch", "tag", "push"]).default("branch"),
  enforcement: z.enum(["active", "evaluate", "disabled"]).default("active"),
  conditions: open({
    ref_name: open({
      include: z.array(RefNamePattern).optional(),
      exclude: z.array(RefNamePattern).optional(),
    }).optional(),
  }).optional(),
  rules: z.array(RuleConfig).optional(),
  bypass_actors: z.array(BypassActorConfig).optional(),
})
  .check(
    gatedRule((ruleset, refineCtx) => {
      // The spec: `pull_request` bypass applies to branch rulesets only; the target defaults to branch upstream. The
      // target, the actor list, or an actor may be raw beside its own shape issue (see ../shared/raw-values.ts): only
      // the two other targets carry the restriction, a non-list holds no actors, and a non-mapping declares no mode.
      const target: unknown = ruleset.target;
      if (target !== "tag" && target !== "push") {
        return;
      }
      const actors: unknown = ruleset.bypass_actors;
      for (const [index, actor] of (Array.isArray(actors) ? actors : []).entries()) {
        if (isPlainObject(actor) && actor.bypass_mode === "pull_request") {
          refineCtx.addIssue({
            code: "custom",
            path: ["bypass_actors", index, "bypass_mode"],
            message: `bypass_mode "pull_request" applies to branch rulesets only, and this ruleset targets ${target}; use "always" or "exempt"`,
          });
        }
      }
    }),
  )
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;

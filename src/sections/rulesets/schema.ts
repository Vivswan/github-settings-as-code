/**
 * The `rulesets:` section's entry-config declaration (see src/schema.ts). What the settings file alone can show
 * wrong is refused here, before any request; what only the live repository can judge stays with GitHub.
 */

import { z } from "zod";
import { isMapping } from "../shared/raw-values.js";

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
  .superRefine((actor, refineCtx) => {
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
  })
  .meta({ id: "BypassActorConfig" });

// --- Rules ------------------------------------------------------------------------

/**
 * Every check inside a rule aborts, the way a type or enum failure does: zod hands a union branch's own issues
 * back only when it is the single branch that failed on non-aborting checks, and ruleUnionError below must be the
 * one report. zod's safe-integer range check and its bound checks continue unless told otherwise.
 */
const integer = () => z.int({ abort: true });

/** The spec's `type: integer` with its documented bounds. */
const bounded = (min: number, max: number) =>
  integer().min(min, { abort: true }).max(max, { abort: true });

/** The spec: "At least one option must be enabled"; omitting the key allows all three. */
const atLeastOneMergeMethod = new z.core.$ZodCheckMinLength({
  check: "min_length",
  minimum: 1,
  abort: true,
  when: (payload) => Array.isArray(payload.value),
  error: () =>
    'allowed_merge_methods needs at least one of "merge", "squash", "rebase"; omit the key to allow all three',
});

const PATTERN_OPERATORS = ["starts_with", "ends_with", "contains", "regex"] as const;

/** Shared by the five *_pattern rule types. */
const PatternRuleParameters = z
  .looseObject({
    name: z.string().optional(),
    negate: z.boolean().optional(),
    operator: z.enum(PATTERN_OPERATORS),
    pattern: z.string(),
  })
  .meta({ id: "PatternRuleParameters" });

const ReviewDismissalActorConfig = z
  .looseObject({
    id: integer(),
    type: z.enum(["User", "Team", "IntegrationInstallation", "RepositoryRole"]),
  })
  .meta({ id: "ReviewDismissalActorConfig" });

const RequiredReviewerConfig = z
  .looseObject({
    file_patterns: z.array(z.string()),
    minimum_approvals: integer(),
    reviewer: z.looseObject({ id: integer(), type: z.literal("Team") }),
  })
  .meta({ id: "RequiredReviewerConfig" });

const StatusCheckConfig = z
  .looseObject({
    context: z.string(),
    integration_id: integer().optional(),
  })
  .meta({ id: "StatusCheckConfig" });

const WorkflowFileConfig = z
  .looseObject({
    path: z.string(),
    ref: z.string().optional(),
    repository_id: integer(),
    sha: z.string().optional(),
  })
  .meta({ id: "WorkflowFileConfig" });

const CodeScanningToolConfig = z
  .looseObject({
    alerts_threshold: z.enum(["none", "errors", "errors_and_warnings", "all"]),
    security_alerts_threshold: z.enum([
      "none",
      "critical",
      "high_or_higher",
      "medium_or_higher",
      "all",
    ]),
    tool: z.string(),
  })
  .meta({ id: "CodeScanningToolConfig" });

/** One published definition per rule type, keyed by the type GitHub names (`Rule<merge_queue>`). */
const ruleId = (type: string) => ({ id: `Rule<${type}>` });

// Loose, not plain: the snapshot projection (shared/snapshot-helpers.ts) keeps a live field the shape does not
// name only behind an explicit catchall, and a field GitHub adds to a rule or an actor must survive a snapshot.

/** A rule type the spec gives no parameters. */
const bareRule = <T extends string>(type: T) =>
  z.looseObject({ type: z.literal(type) }).meta(ruleId(type));

/** A rule type whose parameters the spec shapes. */
const rule = <T extends string, P extends z.core.$ZodShape>(type: T, parameters: P) =>
  z
    .looseObject({ type: z.literal(type), parameters: z.looseObject(parameters).optional() })
    .meta(ruleId(type));

const patternRule = <T extends string>(type: T) =>
  z
    .looseObject({ type: z.literal(type), parameters: PatternRuleParameters.optional() })
    .meta(ruleId(type));

/**
 * The rule types the vendored OpenAPI spec knows, parameters typed as it types them: the casing GitHub sets is
 * refused at parse instead of coming back as a 422 (merge_queue spells MERGE|SQUASH|REBASE, pull_request's
 * allowed_merge_methods spell merge|squash|rebase). The mock's RULESET_RULE_TYPES pins this list to the spec.
 */
const KNOWN_RULES = [
  bareRule("creation"),
  rule("update", { update_allows_fetch_and_merge: z.boolean() }),
  bareRule("deletion"),
  bareRule("required_linear_history"),
  rule("merge_queue", {
    check_response_timeout_minutes: bounded(1, 360),
    grouping_strategy: z.enum(["ALLGREEN", "HEADGREEN"]),
    max_entries_to_build: bounded(0, 100),
    max_entries_to_merge: bounded(0, 100),
    merge_method: z.enum(["MERGE", "SQUASH", "REBASE"]),
    min_entries_to_merge: bounded(0, 100),
    min_entries_to_merge_wait_minutes: bounded(0, 360),
  }),
  rule("required_deployments", { required_deployment_environments: z.array(z.string()) }),
  bareRule("required_signatures"),
  rule("pull_request", {
    allowed_merge_methods: z
      .array(z.enum(["merge", "squash", "rebase"]))
      .check(atLeastOneMergeMethod)
      .optional(),
    dismiss_stale_reviews_on_push: z.boolean(),
    dismissal_restriction: z
      .looseObject({
        allowed_actors: z.array(ReviewDismissalActorConfig).optional(),
        enabled: z.boolean(),
      })
      .optional(),
    require_code_owner_review: z.boolean(),
    require_last_push_approval: z.boolean(),
    required_approving_review_count: bounded(0, 10),
    required_review_thread_resolution: z.boolean(),
    required_reviewers: z.array(RequiredReviewerConfig).optional(),
  }),
  rule("required_status_checks", {
    do_not_enforce_on_create: z.boolean().optional(),
    required_status_checks: z.array(StatusCheckConfig),
    strict_required_status_checks_policy: z.boolean(),
  }),
  bareRule("non_fast_forward"),
  patternRule("commit_message_pattern"),
  patternRule("commit_author_email_pattern"),
  patternRule("committer_email_pattern"),
  patternRule("branch_name_pattern"),
  patternRule("tag_name_pattern"),
  rule("workflows", {
    do_not_enforce_on_create: z.boolean().optional(),
    workflows: z.array(WorkflowFileConfig),
  }),
  rule("code_scanning", { code_scanning_tools: z.array(CodeScanningToolConfig) }),
  rule("copilot_code_review", {
    review_draft_pull_requests: z.boolean().optional(),
    review_on_push: z.boolean().optional(),
  }),
  bareRule("license_compliance_scanning"),
  rule("file_path_restriction", { restricted_file_paths: z.array(z.string()) }),
  rule("max_file_path_length", { max_file_path_length: bounded(1, 32767) }),
  rule("file_extension_restriction", { restricted_file_extensions: z.array(z.string()) }),
  rule("max_file_size", { max_file_size: bounded(1, 100) }),
] as const;

export const KNOWN_RULE_TYPES: readonly string[] = KNOWN_RULES.map(
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
      .refine((type) => !KNOWN_RULE_TYPES.includes(type), { abort: true })
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
  .union([z.discriminatedUnion("type", [...KNOWN_RULES]), UnknownRule], { error: ruleUnionError })
  .meta({ id: "RuleConfig" });

// --- The ruleset --------------------------------------------------------------------

export const RulesetConfig = z
  .object({
    name: z.string(),
    // The file may omit both: target takes the default GitHub documents for a create, enforcement the value chosen
    // here (the create requires one). The parsed entry carries both, so the PUT sends them and the comparison never
    // reads a live value under either key as omitted.
    target: z.enum(["branch", "tag", "push"]).default("branch"),
    enforcement: z.enum(["active", "evaluate", "disabled"]).default("active"),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(RefNamePattern).optional(),
            exclude: z.array(RefNamePattern).optional(),
          })
          .optional(),
      })
      .optional(),
    rules: z.array(RuleConfig).optional(),
    bypass_actors: z.array(BypassActorConfig).optional(),
  })
  .superRefine((ruleset, refineCtx) => {
    // The spec: `pull_request` bypass applies to branch rulesets only; the target defaults to branch upstream. The
    // target, the actor list, or an actor may be raw beside its own shape issue (see ../shared/raw-values.ts): only
    // the two other targets carry the restriction, a non-list holds no actors, and a non-mapping declares no mode.
    const target: unknown = ruleset.target;
    if (target !== "tag" && target !== "push") {
      return;
    }
    const actors: unknown = ruleset.bypass_actors;
    for (const [index, actor] of (Array.isArray(actors) ? actors : []).entries()) {
      if (isMapping(actor) && actor.bypass_mode === "pull_request") {
        refineCtx.addIssue({
          code: "custom",
          path: ["bypass_actors", index, "bypass_mode"],
          message: `bypass_mode "pull_request" applies to branch rulesets only, and this ruleset targets ${target}; use "always" or "exempt"`,
        });
      }
    }
  })
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;

/**
 * The settings-file schema, single-sourced in zod: each config below is ONE
 * declaration that produces the exported config type (z.infer), the engine's
 * tolerant runtime shape (loosen() in sections/contract), and the published
 * lib/settings.schema.json (.github/scripts/gen-settings-schema.ts). The
 * .describe() strings become the published schema's descriptions; .meta({id})
 * names its definitions; superRefine/refine checks are runtime-only (invisible
 * to toJSONSchema) and survive loosen(), so upfront document validation keeps
 * every invariant.
 *
 * Authoring rules:
 * - z.object (strip) is the default: the published schema leaves it OPEN
 *   (passthrough-first forward compatibility) and loosen() turns it into a
 *   passthrough looseObject for the runtime.
 * - z.strictObject only where the runtime rejects unknown keys in the shape
 *   itself - the {undeclared, entries} wrapper and the nested shapes whose
 *   endpoints offer no passthrough destination: it emits
 *   additionalProperties: false and loosen() keeps it strict.
 * - z.looseObject where the config type carries an index signature (the
 *   GitHub-bound passthrough mappings), so the inferred type keeps it.
 * - Runtime checks that read UNDECLARED keys (base-key sweeps, the
 *   misplaced-secret traps) see them only through loosen()'s passthrough
 *   clone - the authored strip parse is never used at runtime.
 *
 * The sections in PROBOT_PARITY_KEYS (declared below) keep the Probot
 * Settings app schema (https://github.com/repository-settings/app) in their
 * plain-array form, so an existing Probot config applies to them unchanged;
 * every section not in PROBOT_PARITY_KEYS is an addition. Only DECLARED keys
 * are ever applied or compared, so omitting a key means "leave it alone".
 */

import { z } from "zod";
import { ActionsSecretConfig } from "./sections/actions_secrets/schema.js";
import { ActionsVariableConfig } from "./sections/actions_variables/schema.js";
import { AgentsSecretConfig } from "./sections/agents_secrets/schema.js";
import { AgentsVariableConfig } from "./sections/agents_variables/schema.js";
import { AutolinkConfig } from "./sections/autolinks/schema.js";
import { BranchConfig } from "./sections/branches/schema.js";
import { CheckSuitePreferencesConfig } from "./sections/check_suite_preferences/schema.js";
import { CodeQualitySetupConfig } from "./sections/code_quality_setup/schema.js";
import { CodeScanningDefaultSetupConfig } from "./sections/code_scanning_default_setup/schema.js";
import { CodespacesSecretConfig } from "./sections/codespaces_secrets/schema.js";
import { CollaboratorConfig } from "./sections/collaborators/schema.js";
import { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
import { DependabotSecretConfig } from "./sections/dependabot_secrets/schema.js";
import { DeployKeyConfig } from "./sections/deploy_keys/schema.js";
import { InteractionLimitsConfig } from "./sections/interaction_limits/schema.js";
import { LabelConfig } from "./sections/labels/schema.js";
import { MilestoneConfig } from "./sections/milestones/schema.js";
import { PagesConfig } from "./sections/pages/schema.js";
import { RepositoryConfig } from "./sections/repository/schema.js";
import { RulesetConfig } from "./sections/rulesets/schema.js";
import { SecretScanningPatternConfig } from "./sections/secret_scanning_custom_patterns/schema.js";
import { SEALED_SECRET_VALUE_DOC, SECRET_NAME_DOC } from "./sections/shared/schema-helpers.js";
import { TeamConfig } from "./sections/teams/schema.js";
import { WorkflowConfig } from "./sections/workflows/schema.js";
import type { MustBeNever } from "./types.js";

export { ActionsSecretConfig } from "./sections/actions_secrets/schema.js";
export { ActionsVariableConfig } from "./sections/actions_variables/schema.js";
export { AgentsSecretConfig } from "./sections/agents_secrets/schema.js";
export { AgentsVariableConfig } from "./sections/agents_variables/schema.js";
export { AutolinkConfig } from "./sections/autolinks/schema.js";
export {
  BranchConfig,
  BranchProtectionConfig,
  type BypassActor,
  parseBypassActor,
} from "./sections/branches/schema.js";
export {
  AutoTriggerCheckConfig,
  CheckSuitePreferencesConfig,
} from "./sections/check_suite_preferences/schema.js";
export { CodeQualitySetupConfig } from "./sections/code_quality_setup/schema.js";
export { CodeScanningDefaultSetupConfig } from "./sections/code_scanning_default_setup/schema.js";
export { CodespacesSecretConfig } from "./sections/codespaces_secrets/schema.js";
export { CollaboratorConfig } from "./sections/collaborators/schema.js";
export { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
export { DependabotSecretConfig } from "./sections/dependabot_secrets/schema.js";
export { DeployKeyConfig } from "./sections/deploy_keys/schema.js";
export {
  INTERACTION_LIMITS_ROUTED_KEYS,
  InteractionLimitsConfig,
} from "./sections/interaction_limits/schema.js";
export { LabelConfig } from "./sections/labels/schema.js";
export { MilestoneConfig } from "./sections/milestones/schema.js";
export { PagesConfig } from "./sections/pages/schema.js";
export { RepositoryConfig } from "./sections/repository/schema.js";
export { RulesetConfig } from "./sections/rulesets/schema.js";
export { SecretScanningPatternConfig } from "./sections/secret_scanning_custom_patterns/schema.js";
export { TeamConfig } from "./sections/teams/schema.js";
export { WorkflowConfig } from "./sections/workflows/schema.js";
export type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "./types.js";

const UndeclaredPolicySchema = z
  .enum(["keep", "delete"])
  .describe("What apply does to live resources the settings file does not declare.")
  .meta({ id: "UndeclaredPolicy" });

const WRAPPER_DOC =
  "The wrapped form of a list, overriding what happens to live resources the file does not declare. The plain array form keeps the list's own default policy (for a top-level section that is the section default, and a multi-repo defaults file can set it; a nested list such as environments[].variables has its own fixed default and never inherits one); this wrapper can set it explicitly, and with `undeclared` omitted it behaves exactly like the plain array. The wrapper is this action's own vocabulary (nothing here passes through to GitHub), so its keys are strict: anything besides `undeclared` and `entries` is rejected upfront as a typo.";

/**
 * The knobbed form of a list section's value: the plain entry array, or the
 * strict {undeclared, entries} wrapper (published under the definition name
 * "UndeclaredPolicyList<Entry>", matching the UndeclaredPolicyList type).
 * loosen() recognizes this union and rewraps it with the routed check that
 * keeps precise per-entry issue paths.
 */
function knobbed<T extends z.ZodType>(entry: T, entryName: string) {
  const wrapper = z
    .strictObject({
      undeclared: UndeclaredPolicySchema.describe(
        'What apply does to live resources `entries` does not declare: "delete" removes them, "keep" leaves them alone and surfaces each as a note. Omitted, the list\'s own default applies.',
      ).optional(),
      entries: z
        .array(entry)
        .describe("The declared entries, exactly as the plain array form lists them."),
    })
    .describe(WRAPPER_DOC)
    .meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

// --- Config schemas -----------------------------------------------------------

export const DeploymentBranchPolicyConfig = z
  .object({
    name: z
      .string()
      .describe(
        'The name pattern branches or tags must match to deploy (e.g. "release/*"), the natural key.',
      ),
    // Checked as a plain string at runtime (the handler compares it against
    // the live pattern): GitHub stays the authority on its values, and the
    // published schema documents the upstream enum through the meta.
    type: z
      .string()
      .optional()
      .describe(
        'What the pattern matches: "branch" (the upstream default) or "tag". Immutable on GitHub, so changing it is applied as delete plus recreate.',
      )
      .meta({ enum: ["branch", "tag"] }),
  })
  .describe(
    "One custom deployment branch-policy pattern, matched by exact name. Extra fields pass through to the create call verbatim.",
  )
  .meta({ id: "DeploymentBranchPolicyConfig" });
export type DeploymentBranchPolicyConfig = z.infer<typeof DeploymentBranchPolicyConfig>;

export const DeploymentProtectionRuleConfig = z
  .strictObject({
    app: z
      .string()
      .describe(
        'The slug of the GitHub App providing the gate (e.g. "my-gate-app"), the natural key.',
      ),
  })
  .describe(
    "One custom deployment protection rule, matched by the slug of the GitHub App that provides it. No other key is accepted: the enable call sends only the App's resolved integration id, so an extra key would have no destination.",
  )
  .meta({ id: "DeploymentProtectionRuleConfig" });
export type DeploymentProtectionRuleConfig = z.infer<typeof DeploymentProtectionRuleConfig>;

export const EnvironmentVariableConfig = z
  .object({
    name: z.string().describe("The variable name, the natural key (case-insensitive on GitHub)."),
    value: z
      .string()
      .describe("The plain-text value; environment secrets are the place for secrets."),
  })
  .describe("One per-environment Actions variable, matched by case-insensitive name.")
  .meta({ id: "EnvironmentVariableConfig" });
export type EnvironmentVariableConfig = z.infer<typeof EnvironmentVariableConfig>;

export const EnvironmentSecretConfig = z
  .strictObject({
    name: z.string().describe(SECRET_NAME_DOC),
    value: z.string().describe(SEALED_SECRET_VALUE_DOC),
  })
  .describe(
    "One per-environment Actions secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
  )
  .meta({ id: "EnvironmentSecretConfig" });
export type EnvironmentSecretConfig = z.infer<typeof EnvironmentSecretConfig>;

/**
 * GitHub's hard cap on pinned environments per repository, shared by the
 * shape's upfront cap check and the environments handler's pin planning.
 */
export const MAX_PINNED_ENVIRONMENTS = 10;

export const EnvironmentConfig = z
  .object({
    name: z.string().describe("The environment name, the natural key."),
    // A ROUTED SCALAR (see EnvironmentRoutedScalars), never part of the PUT
    // body: the environments handler strips it and applies it through the
    // GraphQL pin mutations after every PUT.
    pinned: z
      .boolean()
      .optional()
      .describe(
        "Pin this environment on the repository home page's deployments sidebar (GraphQL-only; the REST environment PUT carries no pin field). Pin ORDER is the declaration order of the entries with `pinned: true` - together they must LEAD the repository's pinned list in that order, compared by rank (GitHub's live position numbers may carry holes after an unpin and are never read literally). `pinned: false` unpins; an entry without the key leaves its pin state untouched. Live pins on environments the settings file does not declare are never unpinned; when they sit among the declared ranks, apply moves them after the declared pins (surfaced as a note). GitHub allows at most 10 pinned environments, so more than 10 `pinned: true` entries are rejected upfront.",
      ),
    wait_timer: z.number().optional().describe("Minutes to wait before deployments proceed."),
    prevent_self_review: z
      .boolean()
      .optional()
      .describe("Whether the deployer may approve their own deployment."),
    reviewers: z
      .array(z.object({ type: z.enum(["User", "Team"]), id: z.number() }))
      .optional()
      .describe("Required reviewers by numeric user/team id."),
    deployment_branch_policy: z
      .object({
        protected_branches: z.boolean().describe("Restrict to branches with protection rules."),
        custom_branch_policies: z
          .boolean()
          .describe("Restrict to name patterns, declared under `deployment_branch_policies`."),
      })
      .nullable()
      .optional()
      .describe("Which branches may deploy; null clears the policy."),
    deployment_branch_policies: knobbed(
      DeploymentBranchPolicyConfig,
      "DeploymentBranchPolicyConfig",
    )
      .optional()
      .describe(
        "Custom deployment branch-policy patterns for this environment, reconciled only when this key is declared (an absent key leaves the live patterns untouched). Declaring it requires the sibling `deployment_branch_policy` to set `custom_branch_policies: true`; without the flag GitHub rejects every pattern write. A pattern's `type` is immutable on GitHub, so a declared type that differs from the live one is applied as delete plus recreate. Within a declared key, live patterns the entries do not declare are DELETED by default; the wrapped `{undeclared: keep, entries}` form keeps them as notes.",
      ),
    deployment_protection_rules: knobbed(
      DeploymentProtectionRuleConfig,
      "DeploymentProtectionRuleConfig",
    )
      .optional()
      .describe(
        "Custom deployment protection rules for this environment, reconciled only when this key is declared (an absent key leaves the live rules untouched). Each rule is a GitHub App gate, declared by its App slug and resolved to the App's integration id at apply time; GitHub offers no update call, so the model is enable/disable only. Within a declared key, live rules the entries do not declare are KEPT by default - Apps can enable themselves as gates, and silently removing a deployment gate is security-relevant - and the wrapped `{undeclared: delete, entries}` form opts into disabling them.",
      ),
    variables: knobbed(EnvironmentVariableConfig, "EnvironmentVariableConfig")
      .optional()
      .describe(
        "Actions variables for this environment, reconciled only when this key is declared (an absent key leaves the live variables untouched). Values are plain text by design - use environment secrets for anything sensitive. Within a declared `variables` key, live variables the entries do not declare are DELETED by default; the wrapped `{undeclared: keep, entries}` form keeps them as notes. Names match case-insensitively, as GitHub treats them.",
      ),
    secrets: knobbed(EnvironmentSecretConfig, "EnvironmentSecretConfig")
      .optional()
      .describe(
        "Actions secrets for this environment, reconciled only when this key is declared (an absent key leaves the live secrets untouched). Each value is a whole-value `$NAME` reference to the action step's environment, never a literal, sealed client-side against the environment's public key; GitHub cannot return a value, so check mode verifies existence only and apply re-seals every declared value on each run. Within a declared `secrets` key, live secrets the entries do not declare are KEPT by default (their values are unrecoverable); the wrapped `{undeclared: delete, entries}` form opts into deletion.",
      ),
  })
  .superRefine((entry, refineCtx) => {
    // Secrets live under the plural `secrets` list; a singular entry-level
    // `secret` would pass the loose runtime shape into the environment PUT
    // body verbatim and configure nothing, so the misplacement is rejected
    // by name (the webhooks entry-level `secret` pin precedent). Only the
    // loosen()ed runtime shape can see the undeclared key - which is the
    // only shape that ever parses documents.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing",
      });
    }
    // The flag-pairing invariant lives HERE, in the shape, not in the
    // section's validate hook: upfront document validation rejects the
    // document in BOTH modes before ANY section writes. A hook-level check
    // would fire only when this section runs (the apply-mode preflight
    // ignores non-permission errors), after earlier sections already
    // wrote - and the pattern POST itself would 404 only after the
    // environment PUT landed, half-applying the run. The published schema
    // mirrors it as the if/then stamped through this schema's meta.
    if (entry.deployment_branch_policies === undefined) {
      return;
    }
    if (entry.deployment_branch_policy?.custom_branch_policies !== true) {
      refineCtx.addIssue({
        code: "custom",
        path: ["deployment_branch_policies"],
        message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`,
      });
    }
  })
  .describe("One deployment environment, matched by name.")
  .meta({
    id: "EnvironmentConfig",
    if: { required: ["deployment_branch_policies"] },
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword paired with `if` above, not a thenable
    then: {
      required: ["deployment_branch_policy"],
      properties: {
        deployment_branch_policy: {
          type: "object",
          required: ["custom_branch_policies"],
          properties: { custom_branch_policies: { const: true } },
        },
      },
    },
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

/**
 * The per-environment keys ROUTED to their own API operations instead of the
 * environment PUT body - each is a scalar the PUT does not accept, applied
 * through a dedicated call after the PUT. This type is where routed-ness
 * is DECLARED: environments.ts pins its ROUTED_SCALAR_KEYS strip list to
 * these keys in both directions (the NESTED_KEYS lockstep pattern), so a key
 * added here without strip handling - or stripped without being declared
 * here - fails to compile. A routed scalar belongs here, never among the
 * plain EnvironmentConfig fields, or it would ride the passthrough PUT
 * verbatim and configure nothing.
 */
export type EnvironmentRoutedScalars = Pick<EnvironmentConfig, "pinned">;

export const ActionsConfig = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("PUT /repos/{r}/actions/permissions: whether Actions runs at all."),
    allowed_actions: z
      .enum(["all", "local_only", "selected"])
      .optional()
      .describe('Which actions may run; "selected" pairs with selected_actions below.'),
    selected_actions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/selected-actions (allowed_actions: selected)"),
    default_workflow_permissions: z
      .enum(["read", "write"])
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/workflow: the default GITHUB_TOKEN grant."),
    can_approve_pull_request_reviews: z
      .boolean()
      .optional()
      .describe("Whether workflows may approve pull request reviews."),
    access_level: z
      .enum(["none", "user", "organization"])
      .optional()
      .describe("PUT /repos/{r}/actions/permissions/access (private repositories only)"),
    artifact_and_log_retention: z
      .object({ days: z.number() })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/artifact-and-log-retention: how many days artifacts and workflow logs are kept, e.g. { days: 90 }. The body passes through verbatim, so future fields GitHub adds work unchanged.",
      ),
    // STRICT, unlike its siblings: each cache limit is the entire body of
    // its own endpoint, so an unrecognized cache key has no passthrough
    // destination and can only be a typo.
    cache: z
      .strictObject({
        max_cache_retention_days: z.number().optional(),
        max_cache_size_gb: z.number().optional(),
      })
      .optional()
      .describe(
        "Actions cache limits, each key routed to its own endpoint: max_cache_retention_days -> PUT /repos/{r}/actions/cache/retention-limit, max_cache_size_gb -> PUT /repos/{r}/actions/cache/storage-limit. Keys other than these two are rejected (each limit has its own single-field endpoint, so an extra key could only be a typo).",
      ),
    oidc_customization_sub: z
      .object({
        use_default: z.boolean(),
        include_claim_keys: z.array(z.string()).optional(),
        use_immutable_subject: z.boolean().optional(),
      })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/oidc/customization/sub: the OIDC subject claim template for this repository's workflow tokens, e.g. { use_default: false, include_claim_keys: [repo, context] } (keys must be unique). Claim-key ORDER defines the subject format, so check mode compares a declared list positionally; an omitted list on a custom template opts into the organization template and is not compared. use_immutable_subject switches the whole subject to the stable repository-ID-based format; omitted, the organization setting or the repository's creation date decides, and only a declared value is compared. Unlike the rest of this section, these endpoints need the \"Actions\" PAT permission rather than Administration.",
      ),
    fork_pr_contributor_approval: z
      .object({ approval_policy: z.string() })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/fork-pr-contributor-approval: when workflows triggered by fork pull requests need a maintainer's approval before they run, e.g. { approval_policy: first_time_contributors }. The policies GitHub accepts today are first_time_contributors_new_to_github, first_time_contributors, and all_external_contributors. The body passes through verbatim, so future fields GitHub adds work unchanged.",
      ),
    fork_pr_workflows_private_repos: z
      .object({
        run_workflows_from_fork_pull_requests: z.boolean(),
        send_write_tokens_to_workflows: z.boolean(),
        send_secrets_and_variables: z.boolean(),
        require_approval_for_fork_pr_workflows: z.boolean(),
      })
      .optional()
      .describe(
        "PUT /repos/{r}/actions/permissions/fork-pr-workflows-private-repos: whether pull requests from forks may run workflows on this private repository, and what those workflows receive. All four toggles are required: GitHub does not document whether the PUT preserves or resets an omitted toggle, so the file declares the complete policy - which is also the posture that leaves no toggle unwatched. The body passes through verbatim, so future fields GitHub adds work unchanged.",
      ),
  })
  .superRefine((declared, refineCtx) => {
    // The policy-allowlist contradiction lives HERE, in the shape, not in
    // run(): upfront document validation rejects the document in BOTH modes
    // before ANY section writes. A run()-time throw would fire only when this
    // section runs, after earlier sections already wrote - half-applying the
    // run (the environments flag-pairing precedent).
    if (declared.selected_actions === undefined || declared.allowed_actions === undefined) {
      return;
    }
    if (declared.allowed_actions !== "selected") {
      refineCtx.addIssue({
        code: "custom",
        path: ["selected_actions"],
        message: `selected_actions is declared together with allowed_actions: "${declared.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`,
      });
    }
  })
  .describe("GitHub Actions settings, routed to the right endpoint by key.")
  .meta({ id: "ActionsConfig" });
export type ActionsConfig = z.infer<typeof ActionsConfig>;

export const WebhookDeliveryConfig = z
  .looseObject({
    url: z
      .string()
      .describe(
        "The delivery URL, the natural key: a changed url declares a NEW hook (the old one becomes undeclared).",
      ),
    content_type: z.string().optional().describe('Payload encoding: "json" or "form".'),
    secret: z
      .string()
      .optional()
      .describe(
        'The shared delivery secret, as a whole-value `$NAME` reference to an environment variable on the action step (never a literal: settings files are committed plaintext). Resolved at apply time; GitHub echoes it back as "********", so check mode cannot verify it and apply re-sends it on every run so rotations propagate.',
      ),
    // Values pass through as-is beyond the type: GitHub is the authority on
    // what it accepts, and it stores numbers as their string form.
    insecure_ssl: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Whether to skip TLS verification ("0" verify / "1" skip); GitHub stores it as a string.',
      ),
  })
  .catchall(z.unknown().describe("Future config fields pass through verbatim."))
  .describe("A webhook's `config` mapping, sent to the config sub-endpoint on update.")
  .meta({ id: "WebhookDeliveryConfig" });
export type WebhookDeliveryConfig = z.infer<typeof WebhookDeliveryConfig>;

export const WebhookConfig = z
  .object({
    name: z
      .literal("web")
      .optional()
      .describe(
        'GitHub\'s hook name; "web" is the only value modern hooks take, so anything else is rejected.',
      ),
    config: WebhookDeliveryConfig.describe("The delivery settings; config.url is the natural key."),
    events: z
      .array(z.string())
      .optional()
      .describe(
        'Events that trigger deliveries, compared order-insensitively; GitHub defaults a new hook to ["push"].',
      ),
    active: z
      .boolean()
      .optional()
      .describe("Whether deliveries fire; GitHub defaults a new hook to true."),
  })
  .superRefine((entry, refineCtx) => {
    // The secret lives under config; an ENTRY-level secret would pass the
    // loose runtime shape, ship the raw reference text verbatim, and create
    // a silently unauthenticated hook - the exact failure this feature
    // exists to prevent - so the misplacement is rejected by name (the
    // `name: "web"` pin precedent). Only the loosen()ed runtime shape can
    // see the undeclared key - which is the only shape that ever parses
    // documents.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "a webhook secret belongs under config.secret, not at the entry level; here it would pass through verbatim and the hook would be created without a working secret",
      });
    }
  })
  .describe(
    "One repository webhook, matched to the live repo by config.url. Hook URLs are configuration, not credentials: they appear in drift lines and notes on purpose. The secret never does.",
  )
  .meta({ id: "WebhookConfig" });
export type WebhookConfig = z.infer<typeof WebhookConfig>;

// --- The settings document ----------------------------------------------------

export const SettingsFile = z
  .object({
    repository: RepositoryConfig.optional().describe(
      "Repo fields sent verbatim to PATCH /repos/{r}, plus the special keys RepositoryConfig documents.",
    ),
    labels: knobbed(LabelConfig, "LabelConfig")
      .optional()
      .describe(
        "Issue/PR labels; undeclared labels are DELETED by default (Probot parity; the wrapped form can set `undeclared: keep`).",
      ),
    rulesets: knobbed(RulesetConfig, "RulesetConfig")
      .optional()
      .describe(
        "Repository rulesets, upserted by name; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`).",
      ),
    branches: z.array(BranchConfig).optional().describe("Classic branch protection per branch."),
    environments: z
      .array(EnvironmentConfig)
      .superRefine((entries, refineCtx) => {
        // The cap invariant lives in the shape like the flag pairing: upfront
        // document validation rejects the document in BOTH modes before ANY
        // section writes, where a hook-level check would fire only mid-run.
        const pinnedIndexes = entries.flatMap((entry, index) =>
          entry.pinned === true ? [index] : [],
        );
        if (pinnedIndexes.length > MAX_PINNED_ENVIRONMENTS) {
          refineCtx.addIssue({
            code: "custom",
            path: [pinnedIndexes[MAX_PINNED_ENVIRONMENTS] as number, "pinned"],
            message: `the settings file declares ${pinnedIndexes.length} environments with pinned: true, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments per repository. Declare pinned: true on at most ${MAX_PINNED_ENVIRONMENTS} entries`,
          });
        }
      })
      .optional()
      .describe("Deployment environments, upserted by name."),
    autolinks: knobbed(AutolinkConfig, "AutolinkConfig")
      .optional()
      .describe(
        "Autolink references; undeclared ones are DELETED by default (the wrapped form can set `undeclared: keep`).",
      ),
    actions: ActionsConfig.optional().describe("GitHub Actions permissions for the repository."),
    actions_secrets: knobbed(ActionsSecretConfig, "ActionsSecretConfig")
      .optional()
      .describe(
        "Repository Actions secrets, written by name with values sealed client-side; each value is a whole-value `$NAME` reference to the action step's environment, never a literal. Undeclared secrets are kept by default (the wrapped form can set `undeclared: delete`; a deleted secret's value is unrecoverable).",
      ),
    dependabot_secrets: knobbed(DependabotSecretConfig, "DependabotSecretConfig")
      .optional()
      .describe(
        "Repository Dependabot secrets (private-registry credentials Dependabot uses), written by name with values sealed client-side; each value is a whole-value `$NAME` reference to the action step's environment, never a literal. Undeclared secrets are kept by default (the wrapped form can set `undeclared: delete`; a deleted secret's value is unrecoverable).",
      ),
    codespaces_secrets: knobbed(CodespacesSecretConfig, "CodespacesSecretConfig")
      .optional()
      .describe(
        "Repository Codespaces secrets (development environment secrets), written by name with values sealed client-side; each value is a whole-value `$NAME` reference to the action step's environment, never a literal. Undeclared secrets are kept by default (the wrapped form can set `undeclared: delete`; a deleted secret's value is unrecoverable).",
      ),
    agents_secrets: knobbed(AgentsSecretConfig, "AgentsSecretConfig")
      .optional()
      .describe(
        "Repository Copilot agents secrets (the secret store Copilot coding agents read), written by name with values sealed client-side; each value is a whole-value `$NAME` reference to the action step's environment, never a literal. Undeclared secrets are kept by default (the wrapped form can set `undeclared: delete`; a deleted secret's value is unrecoverable).",
      ),
    workflows: z
      .array(WorkflowConfig)
      .optional()
      .describe("Per-workflow enable/disable state; undeclared workflows are untouched."),
    check_suite_preferences: CheckSuitePreferencesConfig.optional().describe(
      "Check suite preferences: per-GitHub-App `auto_trigger_checks` toggles controlling whether pushes automatically create check suites. Write-only upstream (GitHub exposes no read endpoint), so check mode cannot verify them and apply re-asserts the declared preferences on every run. The token owner must be a repository administrator.",
    ),
    pages: PagesConfig.nullable()
      .optional()
      .describe("GitHub Pages configuration; null disables Pages on the repository."),
    code_scanning_default_setup: CodeScanningDefaultSetupConfig.optional().describe(
      "Code scanning default setup (CodeQL).",
    ),
    code_quality_setup: CodeQualitySetupConfig.optional().describe("Code quality analysis setup."),
    collaborators: knobbed(CollaboratorConfig, "CollaboratorConfig")
      .optional()
      .describe(
        "Direct collaborators, with pending invitations reconciled alongside; undeclared ones are REMOVED (pending invitations cancelled) by default (owner never touched; the wrapped form can set `undeclared: keep`).",
      ),
    teams: z
      .array(TeamConfig)
      .optional()
      .describe("Org team access to the repo; skipped on personal accounts."),
    milestones: knobbed(MilestoneConfig, "MilestoneConfig")
      .optional()
      .describe(
        "Milestones, upserted by title; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`, which detaches deleted milestones from their issues).",
      ),
    interaction_limits: InteractionLimitsConfig.nullable()
      .optional()
      .describe(
        "Temporary interaction limits; null clears an active repo-level limit, and an absent key leaves whatever is live untouched. Limits self-expire (GitHub's expiry tops out at six_months), so apply re-arms the declared limit on every run and check mode reports drift once it lapses. The pull_request_creation_cap and pull_request_creation_bypass keys manage the persistent pull request creation cap and its bypass list instead; `interaction_limits: null` clears the base limit only and never touches them.",
      ),
    actions_variables: knobbed(ActionsVariableConfig, "ActionsVariableConfig")
      .optional()
      .describe(
        "GitHub Actions repository variables, upserted by name; undeclared ones are DELETED by default (the wrapped form can set `undeclared: keep`). Names are case-insensitive (GitHub stores them uppercased). Values are plain text BY DESIGN - variables are readable configuration, which is what makes check-mode diffing possible; secrets are write-only material and deliberately not this section.",
      ),
    agents_variables: knobbed(AgentsVariableConfig, "AgentsVariableConfig")
      .optional()
      .describe(
        "Copilot agents repository variables (the plain-text configuration Copilot coding agents read), upserted by name; undeclared ones are DELETED by default (the wrapped form can set `undeclared: keep`). Names are case-insensitive (GitHub stores them uppercased). Values are plain text BY DESIGN - variables are readable configuration, which is what makes check-mode diffing possible; secrets are write-only material and deliberately not this section.",
      ),
    webhooks: knobbed(WebhookConfig, "WebhookConfig")
      .optional()
      .describe(
        "Repository webhooks, managed one per config.url; undeclared hooks are kept by default and surfaced as notes, since integrations create their own hooks (the wrapped form can set `undeclared: delete`).",
      ),
    custom_properties: knobbed(CustomPropertyConfig, "CustomPropertyConfig")
      .optional()
      .describe(
        'Values of organization-defined custom properties, set per repository (the property DEFINITIONS are organization-scoped and out of scope); organization repos only, skipped with a note on personal accounts. `value: null` unsets a property (reverting to the org default, if any), and booleans/numbers are normalized to their string form (GitHub transports true_false values as the strings "true"/"false"). Undeclared live values are kept by default - an unset can revert to an org default this action does not model, and a property whose values only org actors may edit would reject the write - and the wrapped form can set `undeclared: delete` to opt into unsetting them.',
      ),
    deploy_keys: knobbed(DeployKeyConfig, "DeployKeyConfig")
      .optional()
      .describe(
        "Deploy keys, matched by title. The declared material is a PUBLIC key, safe in a committed settings file. Keys are immutable upstream, so any change is applied as delete plus recreate. Undeclared keys are kept by default - deleting a live deploy key breaks whatever service authenticates with it, and deployment tooling installs its own keys - and the wrapped form can set `undeclared: delete`.",
      ),
    secret_scanning_custom_patterns: knobbed(
      SecretScanningPatternConfig,
      "SecretScanningPatternConfig",
    )
      .optional()
      .describe(
        "Repository-level secret scanning custom patterns, matched by name. The name is immutable upstream (the update PATCH takes no name field), so a renamed entry is applied as a create of the new name - plus, under `undeclared: delete`, deletion of the old one; under the default keep policy the old pattern stays live and is surfaced as a note. Undeclared patterns are kept by default: removing a pattern disposes of its alerts, so deletion stays a human opt-in (the wrapped form can set `undeclared: delete`). When this action deletes a pattern it always asks GitHub to RESOLVE the pattern's alerts rather than delete them, keeping the audit trail.",
      ),
  })
  .describe("One settings.yml document: every top-level section is optional.")
  .meta({ id: "SettingsFile" });
export type SettingsFile = z.infer<typeof SettingsFile>;

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  // environments before branches on purpose: branches' required_deployments
  // names deployment environments, and GitHub silently drops names that do
  // not exist, so environments declared in the same file must land first.
  "environments",
  "branches",
  "autolinks",
  "actions",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "workflows",
  "check_suite_preferences",
  "pages",
  "code_scanning_default_setup",
  "code_quality_setup",
  "collaborators",
  "teams",
  "milestones",
  "interaction_limits",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  // Last on purpose: when the repository section enables secret scanning
  // (via security_and_analysis), the patterns run against a repository whose
  // scanning is already on. That helps a warn-policy bootstrap and every
  // later run, but it cannot make the pair land in ONE apply under the
  // default fail policy: preflight probes every declared section read-only
  // BEFORE any write, so the patterns list 404s (scanning still off) and
  // aborts the run before the repository section could enable it. Enable
  // scanning first, or bootstrap under on-missing-permission: warn.
  "secret_scanning_custom_patterns",
] as const satisfies readonly (keyof SettingsFile)[];

/** A recognized top-level section name. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * The sections that take the `undeclared` policy knob: their SettingsFile
 * value is a union of the plain entry array and UndeclaredPolicyList. The
 * defaults merge (engine/merge.ts) normalizes and resolves exactly these
 * sections; the lockstep types below pin the list to the SettingsFile
 * declarations in both directions.
 */
export const UNDECLARED_POLICY_SECTIONS = [
  "labels",
  "rulesets",
  "autolinks",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "collaborators",
  "milestones",
  "actions_variables",
  "agents_variables",
  "webhooks",
  "custom_properties",
  "deploy_keys",
  "secret_scanning_custom_patterns",
] as const satisfies readonly SectionKey[];

/** A section key that takes the `undeclared` policy knob. */
export type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];

/**
 * The section keys whose SettingsFile value accepts the wrapped form. Both
 * union branches are required - the plain entry array AND the wrapper - so
 * a future section whose config object merely carries an `entries` property
 * does not classify as knobbed by accident.
 */
type KnobbedByType = {
  [K in SectionKey]: [Extract<NonNullable<SettingsFile[K]>, readonly unknown[]>] extends [never]
    ? never
    : [Extract<NonNullable<SettingsFile[K]>, { entries: readonly unknown[] }>] extends [never]
      ? never
      : K;
}[SectionKey];
/** Compile-time lockstep: a knobbed SettingsFile type missing from the list fails here. */
type _KnobListComplete = MustBeNever<
  Exclude<KnobbedByType, (typeof UNDECLARED_POLICY_SECTIONS)[number]>
>;
/** Compile-time lockstep: a listed section whose type lacks the wrapper fails here. */
type _KnobListSound = MustBeNever<
  Exclude<(typeof UNDECLARED_POLICY_SECTIONS)[number], KnobbedByType>
>;

/**
 * The sections whose plain-array settings.yml form matches the Probot
 * Settings app schema, so an existing Probot config applies to them as-is
 * (the wrapped `undeclared` form is this action's own addition on top). The
 * single source the README's "Migrating from the Probot Settings app"
 * paragraph is pinned against. `satisfies` keeps every entry a real section
 * key.
 */
export const PROBOT_PARITY_KEYS = [
  "repository",
  "labels",
  "branches",
  "collaborators",
  "teams",
  "milestones",
] as const satisfies readonly SectionKey[];

/** Compile-time lockstep: a SettingsFile property missing from SECTION_KEYS fails here. */
type _UnlistedSection = MustBeNever<Exclude<keyof SettingsFile, SectionKey>>;

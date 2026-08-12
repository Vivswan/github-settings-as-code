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
import { AutolinkConfig } from "./sections/autolinks/schema.js";
import { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
import { LabelConfig } from "./sections/labels/schema.js";
import { MilestoneConfig } from "./sections/milestones/schema.js";
import { PagesConfig } from "./sections/pages/schema.js";
import {
  SEALED_SECRET_VALUE_DOC,
  SECRET_NAME_DOC,
  sealedSecretConfig,
} from "./sections/shared/schema-helpers.js";
import type { MustBeNever } from "./types.js";

export { ActionsSecretConfig } from "./sections/actions_secrets/schema.js";
export { AutolinkConfig } from "./sections/autolinks/schema.js";
export { CustomPropertyConfig } from "./sections/custom_properties/schema.js";
export { LabelConfig } from "./sections/labels/schema.js";
export { MilestoneConfig } from "./sections/milestones/schema.js";
export { PagesConfig } from "./sections/pages/schema.js";
export type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "./types.js";

/**
 * Cycle-safe description of a rejected toggle value for shape errors:
 * scalars verbatim (strings quoted, so a YAML "no" stays visibly a string),
 * containers by kind only - JSON.stringify on an arbitrary YAML value would
 * throw on a cyclic alias and kill the run before the normal failure path.
 */
function describeToggleValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "a mapping";
  }
  return String(value);
}

/** A boolean whose error names the YAML string-vs-boolean gotcha. */
function repositoryToggle(description: string) {
  return z
    .boolean({
      error: (issue) =>
        `${describeToggleValue(issue.input)} is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
    })
    .optional()
    .describe(description);
}

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

// --- Actor vocabulary (branches force_push_bypassers) ------------------------

/** A parsed force_push_bypassers actor string. */
export type BypassActor =
  | { kind: "user"; login: string }
  | { kind: "team"; org: string; team: string }
  | { kind: "app"; slug: string };

const NAME_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

/**
 * Parse one declared actor string, or null when it fits no form: a bare
 * login is a user, "org/team-slug" is a team, and "app/slug" is a GitHub
 * App (the "app" head is reserved; an organization named "app" cannot be
 * addressed as a team holder here).
 */
export function parseBypassActor(raw: string): BypassActor | null {
  const parts = raw.split("/");
  if (parts.length === 1) {
    const login = parts[0] as string;
    return NAME_SEGMENT.test(login) ? { kind: "user", login } : null;
  }
  if (parts.length !== 2) {
    return null;
  }
  const [head, tail] = parts as [string, string];
  if (!NAME_SEGMENT.test(head) || !NAME_SEGMENT.test(tail)) {
    return null;
  }
  return head === "app" ? { kind: "app", slug: tail } : { kind: "team", org: head, team: tail };
}

const ACTOR_FORM_ERROR =
  'each force_push_bypassers actor must be a bare user login ("octocat"), "org/team-slug" for a team, or "app/slug" for a GitHub App';

// --- Config schemas -----------------------------------------------------------

export const RepositoryConfig = z
  .looseObject({
    topics: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Repository topics, replaced wholesale via PUT /repos/{r}/topics; a comma-separated string or a list, lowercased and deduped.",
      ),
    enable_vulnerability_alerts: repositoryToggle(
      "Dependabot alerts, via PUT/DELETE /repos/{r}/vulnerability-alerts. On read, 404 means off.",
    ),
    enable_automated_security_fixes: repositoryToggle(
      "Dependabot security updates, via PUT/DELETE /repos/{r}/automated-security-fixes. On read, 404 means off, as does a 200 body with enabled: false.",
    ),
    enable_private_vulnerability_reporting: repositoryToggle(
      "Private vulnerability reporting, via PUT/DELETE /repos/{r}/private-vulnerability-reporting. Repositories where the feature does not apply (observed: private repos) read as off.",
    ),
    enable_git_lfs: repositoryToggle(
      "Git LFS, via PUT/DELETE /repos/{r}/lfs. Write-only upstream: check mode cannot verify it, and apply re-asserts it on every run.",
    ),
    enable_immutable_releases: repositoryToggle(
      "Immutable releases, via PUT/DELETE /repos/{r}/immutable-releases. On read, 404 means off. When the repository owner enforces immutable releases (enforced_by_owner in the GET body), writes answer 409 and the setting cannot be changed from the repository; apply reports that as a note instead of a change.",
    ),
    enable_sponsorships: repositoryToggle(
      "Display a Sponsor button on the repository, via the GraphQL updateRepository mutation (hasSponsorshipsEnabled) - GraphQL is the setting's only read and write surface (the REST repo PATCH and GET carry no such field). A stored repository toggle independent of any FUNDING.yml content.",
    ),
    issue_creation_policy: z
      .enum(["all", "collaborators_only"], {
        error: (issue) =>
          `${describeToggleValue(issue.input)} is not a recognized policy. Use "all" (everyone) or "collaborators_only"`,
      })
      .optional()
      .describe(
        'Who may create issues: "all" (everyone) or "collaborators_only", mapped to GitHub\'s ALL/COLLABORATORS_ONLY GraphQL enum at the API boundary. GraphQL-only upstream (Repository.issueCreationPolicy and the updateRepository mutation): the REST repo PATCH accepts an issue_creation_policy field and silently ignores it, and no REST GET returns it.',
      ),
  })
  .catchall(z.unknown().describe("Everything else passes through to PATCH /repos/{r} verbatim."))
  .describe(
    "The `repository:` section. Every field not documented here is sent verbatim to PATCH /repos/{r} (Probot parity), so current and future repo fields work unchanged; the keys below route to their own endpoints instead. Only declared keys are ever applied or compared.",
  )
  .meta({ id: "RepositoryConfig" });
export type RepositoryConfig = z.infer<typeof RepositoryConfig>;

export const RulesetConfig = z
  .object({
    name: z.string().describe("The ruleset name, the natural key."),
    target: z
      .enum(["branch", "tag", "push"])
      .optional()
      .describe('What the ruleset applies to; defaults to "branch" upstream.'),
    enforcement: z
      .string()
      .optional()
      .describe('"active", "evaluate", or "disabled". Created rulesets default to "active".'),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .optional()
          .describe("Short ref names are auto-prefixed (staging -> refs/heads/staging)."),
      })
      .optional()
      .describe("Which refs the ruleset covers."),
    rules: z
      .array(
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional()
      .describe("Rule list, passed through verbatim (future rule types included)."),
    bypass_actors: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Who may bypass the ruleset, passed through verbatim."),
  })
  .describe("One repository ruleset, matched to the live repo by name.")
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;

export const BranchProtectionConfig = z
  .looseObject({
    required_signatures: z
      .boolean({
        error:
          'required_signatures must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous',
      })
      .optional()
      .describe(
        "Require signed commits on the branch. A routed key the PUT silently drops, so it is applied through the POST/DELETE .../protection/required_signatures sub-endpoint after the PUT. GitHub does not document whether the protection PUT preserves an existing signature requirement, so declare the toggle on any branch that carries one - a declared value is pinned either way.",
      ),
    force_push_bypassers: z
      .array(
        z.string().refine((raw) => parseBypassActor(raw) !== null, { error: ACTOR_FORM_ERROR }),
      )
      .optional()
      .describe(
        'Who may force-push to the branch when "allow force pushes" is in its "specify who" mode. Each actor is one string: a bare login is a user ("octocat"), "org/team-slug" is a team, and "app/slug" is a GitHub App. A REST-invisible surface, so this routed key is stripped from the protection PUT and applied through the updateBranchProtectionRule GraphQL mutation after it; check mode reads the live list back through GraphQL. An empty list clears every allowance; an absent key leaves the live list untouched.',
      ),
    required_deployments: z
      .strictObject({ environments: z.array(z.string()) })
      .nullable()
      .optional()
      .describe(
        "Require deployments to succeed before merging (the checkbox and its environment list). REST-invisible like force_push_bypassers, so the routed key rides the same GraphQL mutation. Declaring `null` turns the requirement OFF; an absent key leaves the live state untouched. GitHub SILENTLY drops environment names that do not exist on the repository, so apply verifies the mutation's read-back and fails loudly naming any dropped name; the environments section runs before branches, so environments declared in the same settings file exist by the time this key applies.",
      ),
  })
  .describe("The protection PUT payload, passed through verbatim except its routed keys.")
  .meta({ id: "BranchProtectionConfig" });
export type BranchProtectionConfig = z.infer<typeof BranchProtectionConfig>;

/** The first duplicate under case-insensitive comparison, or null. */
function duplicateIn(list: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return item;
    }
    seen.add(key);
  }
  return null;
}

export const BranchConfig = z
  .object({
    name: z
      .string()
      .describe(
        'The branch name, or a wildcard pattern (any name containing `*`, `?`, or `[`, e.g. "release/*"). A literal name applies through the REST protection endpoints; a wildcard rule is REST-invisible, so it applies entirely through the GraphQL branch-protection-rule mutations and its protection accepts only the keys this action can round-trip through that surface (the validator names them; prefer rulesets for new pattern-based configuration).',
      ),
    protection: BranchProtectionConfig.nullable().describe(
      "PUT .../protection payload; null removes protection (Probot parity).",
    ),
  })
  .superRefine((entry, refineCtx) => {
    // The routed lists are replace-wholesale semantics keyed by actor or
    // environment identity, which GitHub canonicalizes case-insensitively:
    // a duplicate would apply "successfully" and then drift forever
    // against the deduplicated read-back, so both lists reject them
    // upfront (rejectDuplicates' precedent, at the field level).
    const routed = entry.protection;
    if (routed !== null) {
      const duplicateActor = duplicateIn(routed.force_push_bypassers ?? []);
      if (duplicateActor !== null) {
        refineCtx.addIssue({
          code: "custom",
          path: ["protection", "force_push_bypassers"],
          message: `force_push_bypassers lists "${duplicateActor}" more than once (actor names are case-insensitive); keep one entry per actor`,
        });
      }
      const duplicateEnv = duplicateIn(
        routed.required_deployments === null
          ? []
          : (routed.required_deployments?.environments ?? []),
      );
      if (duplicateEnv !== null) {
        refineCtx.addIssue({
          code: "custom",
          path: ["protection", "required_deployments", "environments"],
          message: `required_deployments.environments lists "${duplicateEnv}" more than once (environment names are case-insensitive); keep one entry per environment`,
        });
      }
    }
  })
  .describe("Classic protection for one branch name or wildcard pattern.")
  .meta({ id: "BranchConfig" });
export type BranchConfig = z.infer<typeof BranchConfig>;

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

export const DependabotSecretConfig = sealedSecretConfig(
  "DependabotSecretConfig",
  "One repository Dependabot secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
);
export type DependabotSecretConfig = z.infer<typeof DependabotSecretConfig>;

export const CodespacesSecretConfig = sealedSecretConfig(
  "CodespacesSecretConfig",
  "One repository Codespaces secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
);
export type CodespacesSecretConfig = z.infer<typeof CodespacesSecretConfig>;

export const AgentsSecretConfig = sealedSecretConfig(
  "AgentsSecretConfig",
  "One repository Copilot agents secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
);
export type AgentsSecretConfig = z.infer<typeof AgentsSecretConfig>;

export const WorkflowConfig = z
  .object({
    path: z.string().describe('Full ".github/workflows/ci.yml" or the bare "ci.yml" file name.'),
    state: z
      .enum(["active", "disabled"])
      .describe('Desired state; every live disabled_* variant counts as "disabled".'),
  })
  .describe(
    "One workflow's enable/disable state, keyed by its file path. Keys other than path and state are rejected (the enable/disable calls carry no payload, so an extra key could only be a typo).",
  )
  .meta({ id: "WorkflowConfig" });
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

export const CodeScanningDefaultSetupConfig = z
  .object({
    state: z
      .enum(["configured", "not-configured"])
      .optional()
      .describe('Turn default setup on ("configured") or off ("not-configured").'),
    query_suite: z.enum(["default", "extended"]).optional().describe("CodeQL query suite to run."),
    languages: z
      .array(z.string())
      .optional()
      .describe("Languages to scan, compared as a set; GitHub auto-detects when omitted."),
    runner_type: z
      .enum(["standard", "labeled"])
      .optional()
      .describe('Run on GitHub-hosted ("standard") or labeled self-hosted runners.'),
    runner_label: z
      .string()
      .nullable()
      .optional()
      .describe('Runner label when runner_type is "labeled"; null clears it.'),
    threat_model: z
      .enum(["remote", "remote_and_local"])
      .optional()
      .describe("Whether to model local sources as threats in addition to remote ones."),
  })
  .describe("PATCH /repos/{r}/code-scanning/default-setup, sent verbatim.")
  .meta({ id: "CodeScanningDefaultSetupConfig" });
export type CodeScanningDefaultSetupConfig = z.infer<typeof CodeScanningDefaultSetupConfig>;

export const CodeQualitySetupConfig = z
  .object({
    state: z
      .enum(["configured", "not-configured"])
      .optional()
      .describe('Turn code quality analysis on ("configured") or off ("not-configured").'),
    languages: z
      .array(z.string())
      .optional()
      .describe("Languages to analyze, compared as a set; GitHub auto-detects when omitted."),
    runner_type: z
      .enum(["standard", "labeled"])
      .optional()
      .describe('Run on GitHub-hosted ("standard") or labeled self-hosted runners.'),
    runner_label: z
      .string()
      .nullable()
      .optional()
      .describe('Runner label when runner_type is "labeled"; null clears it.'),
    ai_findings_option: z
      .enum(["disabled", "on_push"])
      .optional()
      .describe(
        'AI-powered findings: "on_push" runs them on every push, "disabled" turns them off.',
      ),
  })
  .describe("PATCH /repos/{r}/code-quality/setup, sent verbatim.")
  .meta({ id: "CodeQualitySetupConfig" });
export type CodeQualitySetupConfig = z.infer<typeof CodeQualitySetupConfig>;

export const AutoTriggerCheckConfig = z
  .object({
    app_id: z.int().describe("The id of the GitHub App the preference applies to."),
    setting: z
      .boolean()
      .describe(
        "Whether pushes automatically create check suites for this app; GitHub defaults each app to true.",
      ),
  })
  .describe("One per-app auto-trigger toggle. Extra fields pass through verbatim.")
  .meta({ id: "AutoTriggerCheckConfig" });
export type AutoTriggerCheckConfig = z.infer<typeof AutoTriggerCheckConfig>;

export const CheckSuitePreferencesConfig = z
  .looseObject({
    auto_trigger_checks: z
      .array(AutoTriggerCheckConfig)
      .describe("Per-app toggles for whether pushes automatically create check suites."),
  })
  .catchall(z.unknown().describe("Future preference fields pass through verbatim."))
  .describe(
    "PATCH /repos/{r}/check-suites/preferences, sent verbatim. Write-only upstream: GitHub exposes no read endpoint for these preferences, so check mode cannot verify them and apply re-asserts the declared preferences on every run.",
  )
  .meta({ id: "CheckSuitePreferencesConfig" });
export type CheckSuitePreferencesConfig = z.infer<typeof CheckSuitePreferencesConfig>;

export const CollaboratorConfig = z
  .object({
    username: z.string().describe("GitHub login, the natural key."),
    permission: z
      .string()
      .optional()
      .describe(
        '"pull", "triage", "push", "maintain", "admin", or a custom org role; defaults to "push".',
      ),
  })
  .describe(
    'One direct collaborator, matched by username. Keys other than username and permission are rejected (a misspelled "permission" would otherwise silently grant the default role).',
  )
  .meta({ id: "CollaboratorConfig" });
export type CollaboratorConfig = z.infer<typeof CollaboratorConfig>;

export const TeamConfig = z
  .object({
    name: z.string().describe("The team slug, the natural key."),
    permission: z
      .string()
      .optional()
      .describe('Same vocabulary as collaborators; defaults to "push".'),
  })
  .describe(
    'One org team\'s access to the repository, matched by team slug. Keys other than name and permission are rejected (a misspelled "permission" would otherwise silently grant the default role).',
  )
  .meta({ id: "TeamConfig" });
export type TeamConfig = z.infer<typeof TeamConfig>;

export const ActionsVariableConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The variable name, the natural key; case-insensitive (stored uppercased by GitHub).",
      ),
    value: z.string().describe("The plain-text value workflows read through the vars context."),
  })
  .describe("One GitHub Actions repository variable, matched by case-insensitive name.")
  .meta({ id: "ActionsVariableConfig" });
export type ActionsVariableConfig = z.infer<typeof ActionsVariableConfig>;

export const AgentsVariableConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The variable name, the natural key; case-insensitive (stored uppercased by GitHub).",
      ),
    value: z.string().describe("The plain-text value Copilot coding agents read."),
  })
  .describe("One Copilot agents repository variable, matched by case-insensitive name.")
  .meta({ id: "AgentsVariableConfig" });
export type AgentsVariableConfig = z.infer<typeof AgentsVariableConfig>;

/**
 * The interaction_limits keys routed to their own .../interaction-limits/pulls
 * sub-endpoints instead of the base PUT body, shared by the shape's base-key
 * sweep below and the section handler's strip.
 */
export const INTERACTION_LIMITS_ROUTED_KEYS: ReadonlySet<string> = new Set([
  "pull_request_creation_cap",
  "pull_request_creation_bypass",
]);

export const InteractionLimitsConfig = z
  .object({
    limit: z
      .string()
      .optional()
      .describe(
        'Who may interact: "existing_users", "contributors_only", or "collaborators_only". Optional when only the pull-request keys below are declared; an omitted limit leaves the live base limit untouched.',
      ),
    expiry: z
      .string()
      .optional()
      .describe(
        'How long the limit lasts ("one_day" through "six_months"); GitHub defaults to one_day. Write-only: GitHub reports back the computed expires_at, never the duration, so check mode cannot verify this field and apply re-arms it on every run. Requires a sibling `limit`.',
      ),
    // The cap object IS the PATCH body, open so future fields ride it; the
    // flag is typed so a YAML-quoted "true" fails upfront in document
    // validation, before any section writes (the branches precedent).
    pull_request_creation_cap: z
      .object({
        enabled: z
          .boolean({
            error:
              'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
          })
          .describe("Whether the cap is enforced."),
        max_open_pull_requests: z
          .number()
          .optional()
          .describe("The maximum number of open pull requests one user may have (1-1000)."),
      })
      .optional()
      .describe(
        "The pull request creation cap, routed to GET/PATCH /repos/{r}/interaction-limits/pulls/creation-cap. Unlike the base limit it is persistent desired state with no self-expiry and reads back verbatim, so check mode diffs it exactly and apply PATCHes only on divergence. max_open_pull_requests is 1-1000. On repositories where the cap is not available, the endpoints answer 405: apply surfaces that as a note, check mode as drift.",
      ),
    pull_request_creation_bypass: z
      .array(z.string())
      .optional()
      .describe(
        "User logins exempt from the pull request creation cap, routed to GET/PUT/DELETE /repos/{r}/interaction-limits/pulls/bypass-list and reconciled: apply removes the undeclared logins and then adds the missing ones (removals first - the list holds at most 100 users); logins compare case-insensitively. An empty list removes everyone. At most 100 logins.",
      ),
  })
  .superRefine((declared, refineCtx) => {
    // Rejected here, in the shape, so upfront document validation fails
    // the run in BOTH modes before ANY section writes (the actions
    // precedent). Base keys are read off the parsed record because the
    // runtime shape is loose passthrough (only the loosen()ed clone, which
    // keeps unknown keys, ever parses documents).
    const record = declared as Record<string, unknown>;
    const baseKeys = Object.keys(record).filter((key) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key));
    if (
      baseKeys.length === 0 &&
      record.pull_request_creation_cap === undefined &&
      record.pull_request_creation_bypass === undefined
    ) {
      refineCtx.addIssue({
        code: "custom",
        message:
          "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)",
      });
    }
    if (baseKeys.length > 0 && record.limit === undefined) {
      // Base keys ride the base PUT, whose body GitHub rejects without a
      // limit - and a run that never issues the PUT would silently drop
      // them; reject the contradiction upfront instead.
      refineCtx.addIssue({
        code: "custom",
        path: ["limit"],
        message: `key(s) [${baseKeys.join(", ")}] ride the base interaction-limits PUT, which requires a limit; declare limit alongside them, or remove them`,
      });
    }
    const bypass = record.pull_request_creation_bypass;
    if (!Array.isArray(bypass)) {
      return;
    }
    if (bypass.length > 100) {
      // 100 is what makes single-request reconciliation valid (the writes
      // take at most 100 users per request), not just value validation:
      // GitHub also caps the list itself at 100.
      refineCtx.addIssue({
        code: "custom",
        path: ["pull_request_creation_bypass"],
        message: `GitHub caps the bypass list at 100 users, but ${bypass.length} logins are declared; trim the list`,
      });
    }
    // Logins are case-insensitive on GitHub, so two spellings of one login
    // would fight each other on every run instead of converging.
    const seen = new Map<string, string>();
    for (const login of bypass as string[]) {
      const key = login.toLowerCase();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, login);
      } else {
        refineCtx.addIssue({
          code: "custom",
          path: ["pull_request_creation_bypass"],
          message: `"${first}" and "${login}" name the same login (logins are case-insensitive); keep exactly one`,
        });
      }
    }
  })
  .describe(
    "The `interaction_limits:` section. The base object is sent verbatim to PUT /repos/{r}/interaction-limits minus the two routed keys below, which go to their own .../interaction-limits/pulls sub-endpoints instead. GitHub reads the base limit back as limit, origin, and the computed expires_at only. Declare at least one of `limit`, `pull_request_creation_cap`, or `pull_request_creation_bypass`.",
  )
  .meta({ id: "InteractionLimitsConfig" });
export type InteractionLimitsConfig = z.infer<typeof InteractionLimitsConfig>;

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

export const DeployKeyConfig = z
  .object({
    title: z.string().describe("The key title shown in the settings UI, the natural key."),
    key: z
      .string()
      .describe(
        'The PUBLIC key material, e.g. "ssh-ed25519 AAAAC3... comment". Public by nature, so it is safe in a committed file. Compared as algorithm + blob with the trailing comment ignored (GitHub may strip or rewrite comments on storage); keys are immutable upstream, so a changed key is applied as delete plus recreate.',
      ),
    read_only: z
      .boolean()
      .optional()
      .describe(
        "Whether the key is restricted to read-only access; GitHub defaults to false (read/write).",
      ),
  })
  .describe(
    "One deploy key, matched by exact title (GitHub documents no case folding for titles). Extra fields pass through to the create call verbatim.",
  )
  .meta({ id: "DeployKeyConfig" });
export type DeployKeyConfig = z.infer<typeof DeployKeyConfig>;

const DELIMITER_CLEAR_ERROR =
  "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";

export const SecretScanningPatternConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The pattern name, the natural key; immutable upstream, so a rename creates the new name (the old one follows the undeclared policy).",
      ),
    pattern: z.string().describe("The regular expression the secret format must match."),
    // min(1): "" cannot mean "clear the delimiter" - the PATCH updates
    // provided fields only - so the spelling fails at document validation,
    // before any repository is touched.
    start_delimiter: z
      .string()
      .min(1, DELIMITER_CLEAR_ERROR)
      .optional()
      .describe(
        "Regular expression for the characters that must come before the secret. An empty string is rejected: a delimiter cannot be cleared through the update call - remove the pattern and redeclare it without the field instead.",
      ),
    end_delimiter: z
      .string()
      .min(1, DELIMITER_CLEAR_ERROR)
      .optional()
      .describe(
        "Regular expression for the characters that must come after the secret. An empty string is rejected, like start_delimiter.",
      ),
    must_match: z
      .array(z.string())
      .optional()
      .describe("Additional regular expressions a match must also satisfy, compared in order."),
    must_not_match: z
      .array(z.string())
      .optional()
      .describe("Regular expressions a match must NOT satisfy, compared in order."),
  })
  .describe(
    "One secret scanning custom pattern, matched by exact name. Only the fields below are accepted: `state` and `push_protection_enabled` are readable but NOT writable through the custom-pattern endpoints, so they cannot be declared. A delimiter, once set, cannot be cleared back to GitHub's default through the update PATCH (the endpoint updates provided fields only); remove the pattern and redeclare it without the field instead.",
  )
  .meta({ id: "SecretScanningPatternConfig" });
export type SecretScanningPatternConfig = z.infer<typeof SecretScanningPatternConfig>;

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

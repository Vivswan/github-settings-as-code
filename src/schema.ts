/**
 * Types for the settings file. The sections in PROBOT_PARITY_KEYS keep the
 * Probot Settings app schema (https://github.com/repository-settings/app) in
 * their plain-array form, so an existing Probot config applies to them
 * unchanged; the remaining sections
 * (rulesets, autolinks, actions, actions_secrets, dependabot_secrets,
 * codespaces_secrets, workflows, pages, code_scanning_default_setup,
 * interaction_limits, actions_variables, webhooks)
 * are additions. Only DECLARED keys are ever applied or compared, so omitting a
 * key means "leave it alone".
 */

/** One settings.yml document: every top-level section is optional. */
export interface SettingsFile {
  /** Repo fields sent verbatim to PATCH /repos/{r}, plus the special keys RepositoryConfig documents. */
  repository?: RepositoryConfig;
  /** Issue/PR labels; undeclared labels are DELETED by default (Probot parity; the wrapped form can set `undeclared: keep`). */
  labels?: LabelConfig[] | UndeclaredPolicyList<LabelConfig>;
  /** Repository rulesets, upserted by name; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`). */
  rulesets?: RulesetConfig[] | UndeclaredPolicyList<RulesetConfig>;
  /** Classic branch protection per branch. */
  branches?: BranchConfig[];
  /** Deployment environments, upserted by name. */
  environments?: EnvironmentConfig[];
  /** Autolink references; undeclared ones are DELETED by default (the wrapped form can set `undeclared: keep`). */
  autolinks?: AutolinkConfig[] | UndeclaredPolicyList<AutolinkConfig>;
  /** GitHub Actions permissions for the repository. */
  actions?: ActionsConfig;
  /**
   * Repository Actions secrets, written by name with values sealed
   * client-side; each value is a whole-value `$NAME` reference to the action
   * step's environment, never a literal. Undeclared secrets are kept by
   * default (the wrapped form can set `undeclared: delete`; a deleted
   * secret's value is unrecoverable).
   */
  actions_secrets?: ActionsSecretConfig[] | UndeclaredPolicyList<ActionsSecretConfig>;
  /**
   * Repository Dependabot secrets (private-registry credentials Dependabot
   * uses), written by name with values sealed client-side; each value is a
   * whole-value `$NAME` reference to the action step's environment, never a
   * literal. Undeclared secrets are kept by default (the wrapped form can
   * set `undeclared: delete`; a deleted secret's value is unrecoverable).
   */
  dependabot_secrets?: DependabotSecretConfig[] | UndeclaredPolicyList<DependabotSecretConfig>;
  /**
   * Repository Codespaces secrets (development environment secrets), written
   * by name with values sealed client-side; each value is a whole-value
   * `$NAME` reference to the action step's environment, never a literal.
   * Undeclared secrets are kept by default (the wrapped form can set
   * `undeclared: delete`; a deleted secret's value is unrecoverable).
   */
  codespaces_secrets?: CodespacesSecretConfig[] | UndeclaredPolicyList<CodespacesSecretConfig>;
  /** Per-workflow enable/disable state; undeclared workflows are untouched. */
  workflows?: WorkflowConfig[];
  /** GitHub Pages configuration; null disables Pages on the repository. */
  pages?: PagesConfig | null;
  /** Code scanning default setup (CodeQL). */
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
  /** Direct collaborators; undeclared ones are REMOVED by default (owner never touched; the wrapped form can set `undeclared: keep`). */
  collaborators?: CollaboratorConfig[] | UndeclaredPolicyList<CollaboratorConfig>;
  /** Org team access to the repo; skipped on personal accounts. */
  teams?: TeamConfig[];
  /** Milestones, upserted by title; undeclared ones are kept by default (the wrapped form can set `undeclared: delete`, which detaches deleted milestones from their issues). */
  milestones?: MilestoneConfig[] | UndeclaredPolicyList<MilestoneConfig>;
  /**
   * Temporary interaction limits; null clears an active repo-level limit,
   * and an absent key leaves whatever is live untouched. Limits self-expire
   * (GitHub's expiry tops out at six_months), so apply re-arms the declared
   * limit on every run and check mode reports drift once it lapses.
   */
  interaction_limits?: InteractionLimitsConfig | null;
  /**
   * GitHub Actions repository variables, upserted by name; undeclared ones
   * are DELETED by default (the wrapped form can set `undeclared: keep`).
   * Names are case-insensitive (GitHub stores them uppercased). Values are
   * plain text BY DESIGN - variables are readable configuration, which is
   * what makes check-mode diffing possible; secrets are write-only material
   * and deliberately not this section.
   */
  actions_variables?: ActionsVariableConfig[] | UndeclaredPolicyList<ActionsVariableConfig>;
  /**
   * Repository webhooks, managed one per config.url; undeclared hooks are
   * kept by default and surfaced as notes, since integrations create their
   * own hooks (the wrapped form can set `undeclared: delete`).
   */
  webhooks?: WebhookConfig[] | UndeclaredPolicyList<WebhookConfig>;
  /**
   * Values of organization-defined custom properties, set per repository
   * (the property DEFINITIONS are organization-scoped and out of scope);
   * organization repos only, skipped with a note on personal accounts.
   * `value: null` unsets a property (reverting to the org default, if any),
   * and booleans/numbers are normalized to their string form (GitHub
   * transports true_false values as the strings "true"/"false"). Undeclared
   * live values are kept by default - an unset can revert to an org default
   * this action does not model, and a property whose values only org actors
   * may edit would reject the write - and the wrapped form can set
   * `undeclared: delete` to opt into unsetting them.
   */
  custom_properties?: CustomPropertyConfig[] | UndeclaredPolicyList<CustomPropertyConfig>;
  /**
   * Deploy keys, matched by title. The declared material is a PUBLIC key,
   * safe in a committed settings file. Keys are immutable upstream, so any
   * change is applied as delete plus recreate. Undeclared keys are kept by
   * default - deleting a live deploy key breaks whatever service
   * authenticates with it, and deployment tooling installs its own keys -
   * and the wrapped form can set `undeclared: delete`.
   */
  deploy_keys?: DeployKeyConfig[] | UndeclaredPolicyList<DeployKeyConfig>;
  /**
   * Repository-level secret scanning custom patterns, matched by name. The
   * name is immutable upstream (the update PATCH takes no name field), so a
   * renamed entry is applied as a create of the new name - plus, under
   * `undeclared: delete`, deletion of the old one; under the default keep
   * policy the old pattern stays live and is surfaced as a note. Undeclared
   * patterns are kept by default: removing a pattern disposes of its alerts,
   * so deletion stays a human opt-in (the wrapped form can set
   * `undeclared: delete`). When this action deletes a pattern it always asks
   * GitHub to RESOLVE the pattern's alerts rather than delete them, keeping
   * the audit trail.
   */
  secret_scanning_custom_patterns?:
    | SecretScanningPatternConfig[]
    | UndeclaredPolicyList<SecretScanningPatternConfig>;
}

/**
 * The `repository:` section. Every field not documented here is sent verbatim
 * to PATCH /repos/{r} (Probot parity), so current and future repo fields work
 * unchanged; the keys below route to their own endpoints instead. Only
 * declared keys are ever applied or compared.
 */
export interface RepositoryConfig {
  /** Repository topics, replaced wholesale via PUT /repos/{r}/topics; a comma-separated string or a list, lowercased and deduped. */
  topics?: string | string[];
  /** Dependabot alerts, via PUT/DELETE /repos/{r}/vulnerability-alerts. On read, 404 means off. */
  enable_vulnerability_alerts?: boolean;
  /** Dependabot security updates, via PUT/DELETE /repos/{r}/automated-security-fixes. On read, 404 means off, as does a 200 body with enabled: false. */
  enable_automated_security_fixes?: boolean;
  /** Private vulnerability reporting, via PUT/DELETE /repos/{r}/private-vulnerability-reporting. Repositories where the feature does not apply (observed: private repos) read as off. */
  enable_private_vulnerability_reporting?: boolean;
  /** Git LFS, via PUT/DELETE /repos/{r}/lfs. Write-only upstream: check mode cannot verify it, and apply re-asserts it on every run. */
  enable_git_lfs?: boolean;
  /**
   * Immutable releases, via PUT/DELETE /repos/{r}/immutable-releases. On
   * read, 404 means off. When the repository owner enforces immutable
   * releases (enforced_by_owner in the GET body), writes answer 409 and the
   * setting cannot be changed from the repository; apply reports that as a
   * note instead of a change.
   */
  enable_immutable_releases?: boolean;
  /** Everything else passes through to PATCH /repos/{r} verbatim. */
  [key: string]: unknown;
}

/** What apply does to live resources the settings file does not declare. */
export type UndeclaredPolicy = "keep" | "delete";

/**
 * The wrapped form of a list, overriding what happens to live resources the
 * file does not declare. The plain array form keeps the list's own default
 * policy (for a top-level section that is the section default, and a
 * multi-repo defaults file can set it; a nested list such as
 * environments[].variables has its own fixed default and never inherits
 * one); this wrapper can set it explicitly, and with
 * `undeclared` omitted it behaves exactly like the plain array. The wrapper is
 * this action's own vocabulary (nothing here passes through to GitHub), so
 * its keys are strict: anything besides `undeclared` and `entries` is
 * rejected upfront as a typo.
 */
export interface UndeclaredPolicyList<E> {
  /**
   * What apply does to live resources `entries` does not declare: "delete"
   * removes them, "keep" leaves them alone and surfaces each as a note.
   * Omitted, the list's own default applies.
   */
  undeclared?: UndeclaredPolicy;
  /** The declared entries, exactly as the plain array form lists them. */
  entries: E[];
}

/** One label, matched to the live repo by name. */
export interface LabelConfig {
  /** The label name, the natural key. */
  name: string;
  /** Hex color, with or without the leading "#". */
  color?: string;
  /** Short explanation shown in the label picker. */
  description?: string;
  /** Probot compat: rename an existing label. */
  new_name?: string;
}

/** One repository ruleset, matched to the live repo by name. */
export interface RulesetConfig {
  /** The ruleset name, the natural key. */
  name: string;
  /** What the ruleset applies to; defaults to "branch" upstream. */
  target?: "branch" | "tag" | "push";
  /** "active", "evaluate", or "disabled". Created rulesets default to "active". */
  enforcement?: string;
  /** Which refs the ruleset covers. */
  conditions?: {
    /** Short ref names are auto-prefixed (staging -> refs/heads/staging). */
    ref_name?: { include?: string[]; exclude?: string[] };
  };
  /** Rule list, passed through verbatim (future rule types included). */
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  /** Who may bypass the ruleset, passed through verbatim. */
  bypass_actors?: Array<Record<string, unknown>>;
}

/** Classic protection for one branch. */
export interface BranchConfig {
  /** The branch name. */
  name: string;
  /**
   * PUT .../protection payload; null removes protection (Probot parity).
   * `required_signatures` (a boolean) is the one key the PUT does not
   * accept, so it is applied through its own
   * POST/DELETE .../protection/required_signatures sub-endpoint instead.
   * GitHub does not document whether the protection PUT preserves an
   * existing signature requirement, so declare the toggle on any branch
   * that carries one - a declared value is pinned either way.
   */
  protection: Record<string, unknown> | null;
}

/** One deployment environment, matched by name. */
export interface EnvironmentConfig {
  /** The environment name, the natural key. */
  name: string;
  /** Minutes to wait before deployments proceed. */
  wait_timer?: number;
  /** Whether the deployer may approve their own deployment. */
  prevent_self_review?: boolean;
  /** Required reviewers by numeric user/team id. */
  reviewers?: Array<{ type: "User" | "Team"; id: number }>;
  /** Which branches may deploy; null clears the policy. */
  deployment_branch_policy?: {
    /** Restrict to branches with protection rules. */
    protected_branches: boolean;
    /** Restrict to name patterns, declared under `deployment_branch_policies`. */
    custom_branch_policies: boolean;
  } | null;
  /**
   * Custom deployment branch-policy patterns for this environment, reconciled
   * only when this key is declared (an absent key leaves the live patterns
   * untouched). Declaring it requires the sibling `deployment_branch_policy`
   * to set `custom_branch_policies: true`; without the flag GitHub rejects
   * every pattern write. A pattern's `type` is immutable on GitHub, so a
   * declared type that differs from the live one is applied as delete plus
   * recreate. Within a declared key, live patterns the entries do not declare
   * are DELETED by default; the wrapped `{undeclared: keep, entries}` form
   * keeps them as notes.
   */
  deployment_branch_policies?:
    | DeploymentBranchPolicyConfig[]
    | UndeclaredPolicyList<DeploymentBranchPolicyConfig>;
  /**
   * Custom deployment protection rules for this environment, reconciled only
   * when this key is declared (an absent key leaves the live rules
   * untouched). Each rule is a GitHub App gate, declared by its App slug and
   * resolved to the App's integration id at apply time; GitHub offers no
   * update call, so the model is enable/disable only. Within a declared key,
   * live rules the entries do not declare are KEPT by default - Apps can
   * enable themselves as gates, and silently removing a deployment gate is
   * security-relevant - and the wrapped `{undeclared: delete, entries}` form
   * opts into disabling them.
   */
  deployment_protection_rules?:
    | DeploymentProtectionRuleConfig[]
    | UndeclaredPolicyList<DeploymentProtectionRuleConfig>;
  /**
   * Actions variables for this environment, reconciled only when this key is
   * declared (an absent key leaves the live variables untouched). Values are
   * plain text by design - use environment secrets for anything sensitive.
   * Within a declared `variables` key, live variables the entries do not
   * declare are DELETED by default; the wrapped `{undeclared: keep, entries}`
   * form keeps them as notes. Names match case-insensitively, as GitHub
   * treats them.
   */
  variables?: EnvironmentVariableConfig[] | UndeclaredPolicyList<EnvironmentVariableConfig>;
  /**
   * Actions secrets for this environment, reconciled only when this key is
   * declared (an absent key leaves the live secrets untouched). Each value
   * is a whole-value `$NAME` reference to the action step's environment,
   * never a literal, sealed client-side against the environment's public
   * key; GitHub cannot return a value, so check mode verifies existence
   * only and apply re-seals every declared value on each run. Within a
   * declared `secrets` key, live secrets the entries do not declare are
   * KEPT by default (their values are unrecoverable); the wrapped
   * `{undeclared: delete, entries}` form opts into deletion.
   */
  secrets?: EnvironmentSecretConfig[] | UndeclaredPolicyList<EnvironmentSecretConfig>;
}

/**
 * One custom deployment branch-policy pattern, matched by exact name. Extra
 * fields pass through to the create call verbatim.
 */
export interface DeploymentBranchPolicyConfig {
  /** The name pattern branches or tags must match to deploy (e.g. "release/*"), the natural key. */
  name: string;
  /**
   * What the pattern matches: "branch" (the upstream default) or "tag".
   * Immutable on GitHub, so changing it is applied as delete plus recreate.
   */
  type?: "branch" | "tag";
}

/**
 * One custom deployment protection rule, matched by the slug of the GitHub
 * App that provides it. No other key is accepted: the enable call sends only
 * the App's resolved integration id, so an extra key would have no
 * destination.
 */
export interface DeploymentProtectionRuleConfig {
  /** The slug of the GitHub App providing the gate (e.g. "my-gate-app"), the natural key. */
  app: string;
}

/** One per-environment Actions variable, matched by case-insensitive name. */
export interface EnvironmentVariableConfig {
  /** The variable name, the natural key (case-insensitive on GitHub). */
  name: string;
  /** The plain-text value; environment secrets are the place for secrets. */
  value: string;
}

/**
 * One per-environment Actions secret, matched by case-insensitive name
 * (GitHub stores secret names uppercase). Keys other than name and value are
 * rejected: the API body is built from the sealed value alone, so an extra
 * key would silently do nothing.
 */
export interface EnvironmentSecretConfig {
  /** The secret name, the natural key; compared case-insensitively and written uppercase. */
  name: string;
  /**
   * A whole-value `$NAME` reference to an environment variable holding the
   * secret - never a literal (settings files are committed plaintext).
   * Resolved from the action step's env at run time and sealed with a
   * libsodium sealed box before upload; GitHub cannot return the value, so
   * check mode verifies existence only and apply re-seals it on every run.
   */
  value: string;
}

/** One autolink reference, matched by key prefix. */
export interface AutolinkConfig {
  /** Text prefix that triggers the link (e.g. "TICKET-"), the natural key. */
  key_prefix: string;
  /** Target URL template containing "<num>". */
  url_template: string;
  /** Whether <num> also matches letters; upstream default is true. */
  is_alphanumeric?: boolean;
}

/** GitHub Actions settings, routed to the right endpoint by key. */
export interface ActionsConfig {
  /** PUT /repos/{r}/actions/permissions: whether Actions runs at all. */
  enabled?: boolean;
  /** Which actions may run; "selected" pairs with selected_actions below. */
  allowed_actions?: "all" | "local_only" | "selected";
  /** PUT /repos/{r}/actions/permissions/selected-actions (allowed_actions: selected) */
  selected_actions?: Record<string, unknown>;
  /** PUT /repos/{r}/actions/permissions/workflow: the default GITHUB_TOKEN grant. */
  default_workflow_permissions?: "read" | "write";
  /** Whether workflows may approve pull request reviews. */
  can_approve_pull_request_reviews?: boolean;
  /** PUT /repos/{r}/actions/permissions/access (private repositories only) */
  access_level?: "none" | "user" | "organization";
  /**
   * PUT /repos/{r}/actions/permissions/artifact-and-log-retention: how many
   * days artifacts and workflow logs are kept, e.g. { days: 90 }. The body
   * passes through verbatim, so future fields GitHub adds work unchanged.
   */
  artifact_and_log_retention?: { days: number };
  /**
   * Actions cache limits, each key routed to its own endpoint:
   * max_cache_retention_days -> PUT /repos/{r}/actions/cache/retention-limit,
   * max_cache_size_gb -> PUT /repos/{r}/actions/cache/storage-limit. Keys
   * other than these two are rejected (each limit has its own single-field
   * endpoint, so an extra key could only be a typo).
   */
  cache?: { max_cache_retention_days?: number; max_cache_size_gb?: number };
  /**
   * PUT /repos/{r}/actions/oidc/customization/sub: the OIDC subject claim
   * template for this repository's workflow tokens, e.g.
   * { use_default: false, include_claim_keys: [repo, context] } (keys must
   * be unique). Claim-key ORDER defines the subject format, so check mode
   * compares a declared list positionally; an omitted list on a custom
   * template opts into the organization template and is not compared.
   * use_immutable_subject switches the whole subject to the stable
   * repository-ID-based format; omitted, the organization setting or the
   * repository's creation date decides, and only a declared value is
   * compared. Unlike the rest of this section, these
   * endpoints need the "Actions" PAT permission rather than Administration.
   */
  oidc_customization_sub?: {
    use_default: boolean;
    include_claim_keys?: string[];
    use_immutable_subject?: boolean;
  };
  /**
   * PUT /repos/{r}/actions/permissions/fork-pr-contributor-approval: when
   * workflows triggered by fork pull requests need a maintainer's approval
   * before they run, e.g. { approval_policy: first_time_contributors }.
   * The policies GitHub accepts today are
   * first_time_contributors_new_to_github, first_time_contributors, and
   * all_external_contributors. The body passes through verbatim, so future
   * fields GitHub adds work unchanged.
   */
  fork_pr_contributor_approval?: { approval_policy: string };
  /**
   * PUT /repos/{r}/actions/permissions/fork-pr-workflows-private-repos:
   * whether pull requests from forks may run workflows on this private
   * repository, and what those workflows receive. All four toggles are
   * required: GitHub does not document whether the PUT preserves or resets
   * an omitted toggle, so the file declares the complete policy - which is
   * also the posture that leaves no toggle unwatched. The body passes
   * through verbatim, so future fields GitHub adds work unchanged.
   */
  fork_pr_workflows_private_repos?: {
    run_workflows_from_fork_pull_requests: boolean;
    send_write_tokens_to_workflows: boolean;
    send_secrets_and_variables: boolean;
    require_approval_for_fork_pr_workflows: boolean;
  };
}

/**
 * One repository Actions secret, matched by case-insensitive name (GitHub
 * stores secret names uppercase). Keys other than name and value are rejected:
 * the API body is built from the sealed value alone, so an extra key would
 * silently do nothing.
 */
export interface ActionsSecretConfig {
  /** The secret name, the natural key; compared case-insensitively and written uppercase. */
  name: string;
  /**
   * A whole-value `$NAME` reference to an environment variable holding the
   * secret - never a literal (settings files are committed plaintext).
   * Resolved from the action step's env at run time and sealed with a
   * libsodium sealed box before upload; GitHub cannot return the value, so
   * check mode verifies existence only and apply re-seals it on every run.
   */
  value: string;
}

/**
 * One repository Dependabot secret, matched by case-insensitive name (GitHub
 * stores secret names uppercase). Keys other than name and value are rejected:
 * the API body is built from the sealed value alone, so an extra key would
 * silently do nothing.
 */
export interface DependabotSecretConfig {
  /** The secret name, the natural key; compared case-insensitively and written uppercase. */
  name: string;
  /**
   * A whole-value `$NAME` reference to an environment variable holding the
   * secret - never a literal (settings files are committed plaintext).
   * Resolved from the action step's env at run time and sealed with a
   * libsodium sealed box before upload; GitHub cannot return the value, so
   * check mode verifies existence only and apply re-seals it on every run.
   */
  value: string;
}

/**
 * One repository Codespaces secret, matched by case-insensitive name (GitHub
 * stores secret names uppercase). Keys other than name and value are rejected:
 * the API body is built from the sealed value alone, so an extra key would
 * silently do nothing.
 */
export interface CodespacesSecretConfig {
  /** The secret name, the natural key; compared case-insensitively and written uppercase. */
  name: string;
  /**
   * A whole-value `$NAME` reference to an environment variable holding the
   * secret - never a literal (settings files are committed plaintext).
   * Resolved from the action step's env at run time and sealed with a
   * libsodium sealed box before upload; GitHub cannot return the value, so
   * check mode verifies existence only and apply re-seals it on every run.
   */
  value: string;
}

/** One workflow's enable/disable state, keyed by its file path. Keys other than path and state are rejected (the enable/disable calls carry no payload, so an extra key could only be a typo). */
export interface WorkflowConfig {
  /** Full ".github/workflows/ci.yml" or the bare "ci.yml" file name. */
  path: string;
  /** Desired state; every live disabled_* variant counts as "disabled". */
  state: "active" | "disabled";
}

/** PATCH /repos/{r}/code-scanning/default-setup, sent verbatim. */
export interface CodeScanningDefaultSetupConfig {
  /** Turn default setup on ("configured") or off ("not-configured"). */
  state?: "configured" | "not-configured";
  /** CodeQL query suite to run. */
  query_suite?: "default" | "extended";
  /** Languages to scan, compared as a set; GitHub auto-detects when omitted. */
  languages?: string[];
  /** Run on GitHub-hosted ("standard") or labeled self-hosted runners. */
  runner_type?: "standard" | "labeled";
  /** Runner label when runner_type is "labeled"; null clears it. */
  runner_label?: string | null;
  /** Whether to model local sources as threats in addition to remote ones. */
  threat_model?: "remote" | "remote_and_local";
}

/** GitHub Pages site configuration; use `pages: null` to disable the site. */
export interface PagesConfig {
  /** "workflow" (GitHub Actions) or "legacy" (branch). */
  build_type?: "workflow" | "legacy";
  /** The update PUT requires both branch and path when source is sent. */
  source?: { branch: string; path?: string };
  /** Custom domain; null removes it. */
  cname?: string | null;
  /** Whether HTTPS is enforced for the site. */
  https_enforced?: boolean;
}

/** One direct collaborator, matched by username. Keys other than username and permission are rejected (a misspelled "permission" would otherwise silently grant the default role). */
export interface CollaboratorConfig {
  /** GitHub login, the natural key. */
  username: string;
  /** "pull", "triage", "push", "maintain", "admin", or a custom org role; defaults to "push". */
  permission?: string;
}

/** One org team's access to the repository, matched by team slug. Keys other than name and permission are rejected (a misspelled "permission" would otherwise silently grant the default role). */
export interface TeamConfig {
  /** The team slug, the natural key. */
  name: string;
  /** Same vocabulary as collaborators; defaults to "push". */
  permission?: string;
}

/** One milestone, matched by title. */
export interface MilestoneConfig {
  /** The milestone title, the natural key. */
  title: string;
  /** Longer explanation of the milestone. */
  description?: string;
  /** Open or closed; untouched unless declared. */
  state?: "open" | "closed";
}

/** One GitHub Actions repository variable, matched by case-insensitive name. */
export interface ActionsVariableConfig {
  /** The variable name, the natural key; case-insensitive (stored uppercased by GitHub). */
  name: string;
  /** The plain-text value workflows read through the vars context. */
  value: string;
}

/** PUT /repos/{r}/interaction-limits, sent verbatim. GitHub reads back limit, origin, and the computed expires_at only. */
export interface InteractionLimitsConfig {
  /** Who may interact: "existing_users", "contributors_only", or "collaborators_only". */
  limit: string;
  /**
   * How long the limit lasts ("one_day" through "six_months"); GitHub
   * defaults to one_day. Write-only: GitHub reports back the computed
   * expires_at, never the duration, so check mode cannot verify this field
   * and apply re-arms it on every run.
   */
  expiry?: string;
}

/**
 * One repository webhook, matched to the live repo by config.url. Hook URLs
 * are configuration, not credentials: they appear in drift lines and notes
 * on purpose. The secret never does.
 */
export interface WebhookConfig {
  /** GitHub's hook name; "web" is the only value modern hooks take, so anything else is rejected. */
  name?: "web";
  /** The delivery settings; config.url is the natural key. */
  config: WebhookDeliveryConfig;
  /** Events that trigger deliveries, compared order-insensitively; GitHub defaults a new hook to ["push"]. */
  events?: string[];
  /** Whether deliveries fire; GitHub defaults a new hook to true. */
  active?: boolean;
}

/** A webhook's `config` mapping, sent to the config sub-endpoint on update. */
export interface WebhookDeliveryConfig {
  /** The delivery URL, the natural key: a changed url declares a NEW hook (the old one becomes undeclared). */
  url: string;
  /** Payload encoding: "json" or "form". */
  content_type?: string;
  /**
   * The shared delivery secret, as a whole-value `$NAME` reference to an
   * environment variable on the action step (never a literal: settings
   * files are committed plaintext). Resolved at apply time; GitHub echoes
   * it back as "********", so check mode cannot verify it and apply
   * re-sends it on every run so rotations propagate.
   */
  secret?: string;
  /** Whether to skip TLS verification ("0" verify / "1" skip); GitHub stores it as a string. */
  insecure_ssl?: string | number;
  /** Future config fields pass through verbatim. */
  [key: string]: unknown;
}

/**
 * One custom property value, matched by the API's property_name verbatim.
 * Keys other than property_name and value are rejected: the bulk PATCH body
 * is built from exactly these two fields, so an extra key would have no
 * destination.
 */
export interface CustomPropertyConfig {
  /** The organization-defined property's name, the natural key. */
  property_name: string;
  /**
   * The value to set: a string (single_select and string properties), a list
   * of strings (multi_select, compared as a set - list each option once), or
   * a boolean (true_false, normalized to the "true"/"false" string GitHub
   * transports). Numbers are likewise sent as their string form - through
   * YAML's parsed number, so quote any numeric value you want sent verbatim
   * (unquoted, 1.10 arrives as "1.1" and 1e21 as "1e+21"). `null` unsets the
   * property, reverting to the org default, if any.
   */
  value: string | string[] | boolean | number | null;
}

/**
 * One deploy key, matched by exact title (GitHub documents no case folding
 * for titles). Extra fields pass through to the create call verbatim.
 */
export interface DeployKeyConfig {
  /** The key title shown in the settings UI, the natural key. */
  title: string;
  /**
   * The PUBLIC key material, e.g. "ssh-ed25519 AAAAC3... comment". Public by
   * nature, so it is safe in a committed file. Compared as algorithm + blob
   * with the trailing comment ignored (GitHub may strip or rewrite comments
   * on storage); keys are immutable upstream, so a changed key is applied as
   * delete plus recreate.
   */
  key: string;
  /** Whether the key is restricted to read-only access; GitHub defaults to false (read/write). */
  read_only?: boolean;
}

/**
 * One secret scanning custom pattern, matched by exact name. Only the fields
 * below are accepted: `state` and `push_protection_enabled` are readable but
 * NOT writable through the custom-pattern endpoints, so they cannot be
 * declared. A delimiter, once set, cannot be cleared back to GitHub's
 * default through the update PATCH (the endpoint updates provided fields
 * only); remove the pattern and redeclare it without the field instead.
 */
export interface SecretScanningPatternConfig {
  /** The pattern name, the natural key; immutable upstream, so a rename creates the new name (the old one follows the undeclared policy). */
  name: string;
  /** The regular expression the secret format must match. */
  pattern: string;
  /** Regular expression for the characters that must come before the secret. */
  start_delimiter?: string;
  /** Regular expression for the characters that must come after the secret. */
  end_delimiter?: string;
  /** Additional regular expressions a match must also satisfy, compared in order. */
  must_match?: string[];
  /** Regular expressions a match must NOT satisfy, compared in order. */
  must_not_match?: string[];
}

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "actions",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "workflows",
  "pages",
  "code_scanning_default_setup",
  "collaborators",
  "teams",
  "milestones",
  "interaction_limits",
  "actions_variables",
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
  "collaborators",
  "milestones",
  "actions_variables",
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

/**
 * Compile-time exhaustiveness helper: `MustBeNever<Exclude<Union, Covered>>`
 * fails to compile when the Union has a member the Covered set omits. The one
 * definition the exhaustiveness checks in this file, orchestrate.ts, and
 * inputs.ts all use, so the idiom cannot drift between them.
 */
export type MustBeNever<T extends never> = T;

/** Compile-time lockstep: a SettingsFile property missing from SECTION_KEYS fails here. */
type _UnlistedSection = MustBeNever<Exclude<keyof SettingsFile, SectionKey>>;

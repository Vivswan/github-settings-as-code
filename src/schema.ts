/**
 * Types for the settings file. The sections in PROBOT_PARITY_KEYS keep the
 * Probot Settings app schema (https://github.com/repository-settings/app), so
 * an existing Probot config applies to them unchanged; the remaining sections
 * (rulesets, autolinks, actions, workflows, pages, code_scanning_default_setup)
 * are additions. Only DECLARED keys are ever applied or compared, so omitting a
 * key means "leave it alone".
 */

/** One settings.yml document: every top-level section is optional. */
export interface SettingsFile {
  /** Repo fields sent verbatim to PATCH /repos/{r}, plus the special keys RepositoryConfig documents. */
  repository?: RepositoryConfig;
  /** Issue/PR labels; undeclared labels are DELETED (Probot parity). */
  labels?: LabelConfig[];
  /** Repository rulesets, upserted by name; undeclared ones are kept. */
  rulesets?: RulesetConfig[];
  /** Classic branch protection per branch. */
  branches?: BranchConfig[];
  /** Deployment environments, upserted by name. */
  environments?: EnvironmentConfig[];
  /** Autolink references; undeclared ones are DELETED. */
  autolinks?: AutolinkConfig[];
  /** GitHub Actions permissions for the repository. */
  actions?: ActionsConfig;
  /** Per-workflow enable/disable state; undeclared workflows are untouched. */
  workflows?: WorkflowConfig[];
  /** GitHub Pages configuration; null disables Pages on the repository. */
  pages?: PagesConfig | null;
  /** Code scanning default setup (CodeQL). */
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
  /** Direct collaborators; undeclared ones are REMOVED (owner never touched). */
  collaborators?: CollaboratorConfig[];
  /** Org team access to the repo; skipped on personal accounts. */
  teams?: TeamConfig[];
  /** Milestones, upserted by title; undeclared ones are kept. */
  milestones?: MilestoneConfig[];
  /**
   * Temporary interaction limits; null clears an active repo-level limit,
   * and an absent key leaves whatever is live untouched. Limits self-expire
   * (GitHub's expiry tops out at six_months), so apply re-arms the declared
   * limit on every run and check mode reports drift once it lapses.
   */
  interaction_limits?: InteractionLimitsConfig | null;
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
    /** Restrict to name patterns (declared separately, a known gap). */
    custom_branch_policies: boolean;
  } | null;
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

/** Every recognized top-level section, in execution order. */
export const SECTION_KEYS = [
  "repository",
  "labels",
  "rulesets",
  "branches",
  "environments",
  "autolinks",
  "actions",
  "workflows",
  "pages",
  "code_scanning_default_setup",
  "collaborators",
  "teams",
  "milestones",
  "interaction_limits",
] as const satisfies readonly (keyof SettingsFile)[];

/** A recognized top-level section name. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * The sections whose settings.yml schema matches the Probot Settings app, so
 * an existing Probot config applies to them as-is. The single source the
 * README's "Migrating from the Probot Settings app" paragraph is pinned
 * against. `satisfies` keeps every entry a real section key.
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

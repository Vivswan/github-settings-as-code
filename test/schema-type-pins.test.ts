/**
 * Conversion pins: the settings types were hand-written interfaces before
 * the zod single source in src/schema.ts; these compile-time checks pin
 * every exported config type (z.infer) against a verbatim copy of the old
 * interfaces, assignable in BOTH directions, so the conversion cannot have
 * moved a type accidentally. One deliberate divergence is annotated inline
 * (deployment branch-policy `type`). Delete this file once the zod source
 * has bedded in - it guards the conversion, not an ongoing invariant.
 */

import { describe, expect, test } from "bun:test";
import type * as New from "../src/schema.js";

// --- The pre-conversion interfaces, comments stripped, verbatim otherwise ---

interface SettingsFile {
  repository?: RepositoryConfig;
  labels?: LabelConfig[] | UndeclaredPolicyList<LabelConfig>;
  rulesets?: RulesetConfig[] | UndeclaredPolicyList<RulesetConfig>;
  branches?: BranchConfig[];
  environments?: EnvironmentConfig[];
  autolinks?: AutolinkConfig[] | UndeclaredPolicyList<AutolinkConfig>;
  actions?: ActionsConfig;
  actions_secrets?: ActionsSecretConfig[] | UndeclaredPolicyList<ActionsSecretConfig>;
  dependabot_secrets?: DependabotSecretConfig[] | UndeclaredPolicyList<DependabotSecretConfig>;
  codespaces_secrets?: CodespacesSecretConfig[] | UndeclaredPolicyList<CodespacesSecretConfig>;
  agents_secrets?: AgentsSecretConfig[] | UndeclaredPolicyList<AgentsSecretConfig>;
  workflows?: WorkflowConfig[];
  check_suite_preferences?: CheckSuitePreferencesConfig;
  pages?: PagesConfig | null;
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
  code_quality_setup?: CodeQualitySetupConfig;
  collaborators?: CollaboratorConfig[] | UndeclaredPolicyList<CollaboratorConfig>;
  teams?: TeamConfig[];
  milestones?: MilestoneConfig[] | UndeclaredPolicyList<MilestoneConfig>;
  interaction_limits?: InteractionLimitsConfig | null;
  actions_variables?: ActionsVariableConfig[] | UndeclaredPolicyList<ActionsVariableConfig>;
  agents_variables?: AgentsVariableConfig[] | UndeclaredPolicyList<AgentsVariableConfig>;
  webhooks?: WebhookConfig[] | UndeclaredPolicyList<WebhookConfig>;
  custom_properties?: CustomPropertyConfig[] | UndeclaredPolicyList<CustomPropertyConfig>;
  deploy_keys?: DeployKeyConfig[] | UndeclaredPolicyList<DeployKeyConfig>;
  secret_scanning_custom_patterns?:
    | SecretScanningPatternConfig[]
    | UndeclaredPolicyList<SecretScanningPatternConfig>;
}

interface RepositoryConfig {
  topics?: string | string[];
  enable_vulnerability_alerts?: boolean;
  enable_automated_security_fixes?: boolean;
  enable_private_vulnerability_reporting?: boolean;
  enable_git_lfs?: boolean;
  enable_immutable_releases?: boolean;
  enable_sponsorships?: boolean;
  issue_creation_policy?: "all" | "collaborators_only";
  [key: string]: unknown;
}

type UndeclaredPolicy = "keep" | "delete";

interface UndeclaredPolicyList<E> {
  undeclared?: UndeclaredPolicy;
  entries: E[];
}

interface LabelConfig {
  name: string;
  color?: string;
  description?: string;
  new_name?: string;
}

interface RulesetConfig {
  name: string;
  target?: "branch" | "tag" | "push";
  enforcement?: string;
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
  };
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors?: Array<Record<string, unknown>>;
}

interface BranchProtectionConfig {
  required_signatures?: boolean;
  force_push_bypassers?: string[];
  required_deployments?: { environments: string[] } | null;
  [key: string]: unknown;
}

interface BranchConfig {
  name: string;
  protection: BranchProtectionConfig | null;
}

interface EnvironmentRoutedScalars {
  pinned?: boolean;
}

interface EnvironmentConfig extends EnvironmentRoutedScalars {
  name: string;
  wait_timer?: number;
  prevent_self_review?: boolean;
  reviewers?: Array<{ type: "User" | "Team"; id: number }>;
  deployment_branch_policy?: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
  deployment_branch_policies?:
    | DeploymentBranchPolicyConfig[]
    | UndeclaredPolicyList<DeploymentBranchPolicyConfig>;
  deployment_protection_rules?:
    | DeploymentProtectionRuleConfig[]
    | UndeclaredPolicyList<DeploymentProtectionRuleConfig>;
  variables?: EnvironmentVariableConfig[] | UndeclaredPolicyList<EnvironmentVariableConfig>;
  secrets?: EnvironmentSecretConfig[] | UndeclaredPolicyList<EnvironmentSecretConfig>;
}

interface DeploymentBranchPolicyConfig {
  name: string;
  // The ONE deliberate divergence from the pre-conversion interface, which
  // said `"branch" | "tag"`: the runtime deliberately defers the vocabulary
  // to GitHub (the shape always checked a plain string), so the zod source
  // types it as the runtime behaves; the published schema still documents
  // the upstream enum through the field's meta.
  type?: string;
}

interface DeploymentProtectionRuleConfig {
  app: string;
}

interface EnvironmentVariableConfig {
  name: string;
  value: string;
}

interface EnvironmentSecretConfig {
  name: string;
  value: string;
}

interface AutolinkConfig {
  key_prefix: string;
  url_template: string;
  is_alphanumeric?: boolean;
}

interface ActionsConfig {
  enabled?: boolean;
  allowed_actions?: "all" | "local_only" | "selected";
  selected_actions?: Record<string, unknown>;
  default_workflow_permissions?: "read" | "write";
  can_approve_pull_request_reviews?: boolean;
  access_level?: "none" | "user" | "organization";
  artifact_and_log_retention?: { days: number };
  cache?: { max_cache_retention_days?: number; max_cache_size_gb?: number };
  oidc_customization_sub?: {
    use_default: boolean;
    include_claim_keys?: string[];
    use_immutable_subject?: boolean;
  };
  fork_pr_contributor_approval?: { approval_policy: string };
  fork_pr_workflows_private_repos?: {
    run_workflows_from_fork_pull_requests: boolean;
    send_write_tokens_to_workflows: boolean;
    send_secrets_and_variables: boolean;
    require_approval_for_fork_pr_workflows: boolean;
  };
}

interface ActionsSecretConfig {
  name: string;
  value: string;
}

interface DependabotSecretConfig {
  name: string;
  value: string;
}

interface CodespacesSecretConfig {
  name: string;
  value: string;
}

interface AgentsSecretConfig {
  name: string;
  value: string;
}

interface WorkflowConfig {
  path: string;
  state: "active" | "disabled";
}

interface CodeScanningDefaultSetupConfig {
  state?: "configured" | "not-configured";
  query_suite?: "default" | "extended";
  languages?: string[];
  runner_type?: "standard" | "labeled";
  runner_label?: string | null;
  threat_model?: "remote" | "remote_and_local";
}

interface CodeQualitySetupConfig {
  state?: "configured" | "not-configured";
  languages?: string[];
  runner_type?: "standard" | "labeled";
  runner_label?: string | null;
  ai_findings_option?: "disabled" | "on_push";
}

interface CheckSuitePreferencesConfig {
  auto_trigger_checks: AutoTriggerCheckConfig[];
  [key: string]: unknown;
}

interface AutoTriggerCheckConfig {
  app_id: number;
  setting: boolean;
}

interface PagesConfig {
  build_type?: "workflow" | "legacy";
  source?: { branch: string; path?: string };
  cname?: string | null;
  https_enforced?: boolean;
  public?: boolean;
}

interface CollaboratorConfig {
  username: string;
  permission?: string;
}

interface TeamConfig {
  name: string;
  permission?: string;
}

interface MilestoneConfig {
  title: string;
  description?: string;
  state?: "open" | "closed";
}

interface ActionsVariableConfig {
  name: string;
  value: string;
}

interface AgentsVariableConfig {
  name: string;
  value: string;
}

interface InteractionLimitsConfig {
  limit?: string;
  expiry?: string;
  pull_request_creation_cap?: {
    enabled: boolean;
    max_open_pull_requests?: number;
  };
  pull_request_creation_bypass?: string[];
}

interface WebhookConfig {
  name?: "web";
  config: WebhookDeliveryConfig;
  events?: string[];
  active?: boolean;
}

interface WebhookDeliveryConfig {
  url: string;
  content_type?: string;
  secret?: string;
  insecure_ssl?: string | number;
  [key: string]: unknown;
}

interface CustomPropertyConfig {
  property_name: string;
  value: string | string[] | boolean | number | null;
}

interface DeployKeyConfig {
  title: string;
  key: string;
  read_only?: boolean;
}

interface SecretScanningPatternConfig {
  name: string;
  pattern: string;
  start_delimiter?: string;
  end_delimiter?: string;
  must_match?: string[];
  must_not_match?: string[];
}

// --- The pins -----------------------------------------------------------------

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

type _SettingsFile = Expect<MutuallyAssignable<SettingsFile, New.SettingsFile>>;
type _RepositoryConfig = Expect<MutuallyAssignable<RepositoryConfig, New.RepositoryConfig>>;
type _UndeclaredPolicy = Expect<MutuallyAssignable<UndeclaredPolicy, New.UndeclaredPolicy>>;
type _LabelConfig = Expect<MutuallyAssignable<LabelConfig, New.LabelConfig>>;
type _RulesetConfig = Expect<MutuallyAssignable<RulesetConfig, New.RulesetConfig>>;
type _BranchProtectionConfig = Expect<
  MutuallyAssignable<BranchProtectionConfig, New.BranchProtectionConfig>
>;
type _BranchConfig = Expect<MutuallyAssignable<BranchConfig, New.BranchConfig>>;
type _EnvironmentRoutedScalars = Expect<
  MutuallyAssignable<EnvironmentRoutedScalars, New.EnvironmentRoutedScalars>
>;
type _EnvironmentConfig = Expect<MutuallyAssignable<EnvironmentConfig, New.EnvironmentConfig>>;
type _DeploymentBranchPolicyConfig = Expect<
  MutuallyAssignable<DeploymentBranchPolicyConfig, New.DeploymentBranchPolicyConfig>
>;
type _DeploymentProtectionRuleConfig = Expect<
  MutuallyAssignable<DeploymentProtectionRuleConfig, New.DeploymentProtectionRuleConfig>
>;
type _EnvironmentVariableConfig = Expect<
  MutuallyAssignable<EnvironmentVariableConfig, New.EnvironmentVariableConfig>
>;
type _EnvironmentSecretConfig = Expect<
  MutuallyAssignable<EnvironmentSecretConfig, New.EnvironmentSecretConfig>
>;
type _AutolinkConfig = Expect<MutuallyAssignable<AutolinkConfig, New.AutolinkConfig>>;
type _ActionsConfig = Expect<MutuallyAssignable<ActionsConfig, New.ActionsConfig>>;
type _ActionsSecretConfig = Expect<
  MutuallyAssignable<ActionsSecretConfig, New.ActionsSecretConfig>
>;
type _DependabotSecretConfig = Expect<
  MutuallyAssignable<DependabotSecretConfig, New.DependabotSecretConfig>
>;
type _CodespacesSecretConfig = Expect<
  MutuallyAssignable<CodespacesSecretConfig, New.CodespacesSecretConfig>
>;
type _AgentsSecretConfig = Expect<MutuallyAssignable<AgentsSecretConfig, New.AgentsSecretConfig>>;
type _WorkflowConfig = Expect<MutuallyAssignable<WorkflowConfig, New.WorkflowConfig>>;
type _CodeScanningDefaultSetupConfig = Expect<
  MutuallyAssignable<CodeScanningDefaultSetupConfig, New.CodeScanningDefaultSetupConfig>
>;
type _CodeQualitySetupConfig = Expect<
  MutuallyAssignable<CodeQualitySetupConfig, New.CodeQualitySetupConfig>
>;
type _CheckSuitePreferencesConfig = Expect<
  MutuallyAssignable<CheckSuitePreferencesConfig, New.CheckSuitePreferencesConfig>
>;
type _AutoTriggerCheckConfig = Expect<
  MutuallyAssignable<AutoTriggerCheckConfig, New.AutoTriggerCheckConfig>
>;
type _PagesConfig = Expect<MutuallyAssignable<PagesConfig, New.PagesConfig>>;
type _CollaboratorConfig = Expect<MutuallyAssignable<CollaboratorConfig, New.CollaboratorConfig>>;
type _TeamConfig = Expect<MutuallyAssignable<TeamConfig, New.TeamConfig>>;
type _MilestoneConfig = Expect<MutuallyAssignable<MilestoneConfig, New.MilestoneConfig>>;
type _ActionsVariableConfig = Expect<
  MutuallyAssignable<ActionsVariableConfig, New.ActionsVariableConfig>
>;
type _AgentsVariableConfig = Expect<
  MutuallyAssignable<AgentsVariableConfig, New.AgentsVariableConfig>
>;
type _InteractionLimitsConfig = Expect<
  MutuallyAssignable<InteractionLimitsConfig, New.InteractionLimitsConfig>
>;
type _WebhookConfig = Expect<MutuallyAssignable<WebhookConfig, New.WebhookConfig>>;
type _WebhookDeliveryConfig = Expect<
  MutuallyAssignable<WebhookDeliveryConfig, New.WebhookDeliveryConfig>
>;
type _CustomPropertyConfig = Expect<
  MutuallyAssignable<CustomPropertyConfig, New.CustomPropertyConfig>
>;
type _DeployKeyConfig = Expect<MutuallyAssignable<DeployKeyConfig, New.DeployKeyConfig>>;
type _SecretScanningPatternConfig = Expect<
  MutuallyAssignable<SecretScanningPatternConfig, New.SecretScanningPatternConfig>
>;
type _UndeclaredPolicyList = Expect<
  MutuallyAssignable<UndeclaredPolicyList<LabelConfig>, New.UndeclaredPolicyList<New.LabelConfig>>
>;

describe("schema type pins", () => {
  test("the compile-time pins above are what this file is for", () => {
    // The assertions are the type aliases; tsc enforces them. This test only
    // keeps the file in the suite so a typecheck-skipping run still loads it.
    expect(true).toBe(true);
  });
});

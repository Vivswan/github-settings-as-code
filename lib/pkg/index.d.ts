import { Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { Endpoints } from "@octokit/types";
//#region src/schema.d.ts
export declare const SettingsFile: z.ZodObject<{
  repository: z.ZodOptional<z.ZodObject<{
    topics: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
    enable_vulnerability_alerts: z.ZodOptional<z.ZodBoolean>;
    enable_automated_security_fixes: z.ZodOptional<z.ZodBoolean>;
    enable_private_vulnerability_reporting: z.ZodOptional<z.ZodBoolean>;
    enable_git_lfs: z.ZodOptional<z.ZodBoolean>;
    enable_immutable_releases: z.ZodOptional<z.ZodBoolean>;
    enable_sponsorships: z.ZodOptional<z.ZodBoolean>;
    issue_creation_policy: z.ZodOptional<z.ZodEnum<{
      all: "all";
      collaborators_only: "collaborators_only";
    }>>;
  }, z.core.$catchall<z.ZodUnknown>>>;
  labels: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    color: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    new_name: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      color: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      new_name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  rulesets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    target: z.ZodOptional<z.ZodEnum<{
      branch: "branch";
      push: "push";
      tag: "tag";
    }>>;
    enforcement: z.ZodOptional<z.ZodString>;
    conditions: z.ZodOptional<z.ZodObject<{
      ref_name: z.ZodOptional<z.ZodObject<{
        include: z.ZodOptional<z.ZodArray<z.ZodString>>;
        exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>>;
    }, z.core.$strip>>;
    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
      type: z.ZodString;
      parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>>;
    bypass_actors: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      target: z.ZodOptional<z.ZodEnum<{
        branch: "branch";
        push: "push";
        tag: "tag";
      }>>;
      enforcement: z.ZodOptional<z.ZodString>;
      conditions: z.ZodOptional<z.ZodObject<{
        ref_name: z.ZodOptional<z.ZodObject<{
          include: z.ZodOptional<z.ZodArray<z.ZodString>>;
          exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>>;
      rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>>>;
      bypass_actors: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  branches: z.ZodOptional<z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    protection: z.ZodNullable<z.ZodObject<{
      required_signatures: z.ZodOptional<z.ZodBoolean>;
      force_push_bypassers: z.ZodOptional<z.ZodArray<z.ZodString>>;
      required_deployments: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        environments: z.ZodArray<z.ZodString>;
      }, z.core.$strict>>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>>;
  environments: z.ZodOptional<z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    pinned: z.ZodOptional<z.ZodBoolean>;
    wait_timer: z.ZodOptional<z.ZodNumber>;
    prevent_self_review: z.ZodOptional<z.ZodBoolean>;
    reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
      type: z.ZodEnum<{
        Team: "Team";
        User: "User";
      }>;
      id: z.ZodNumber;
    }, z.core.$strip>>>;
    deployment_branch_policy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
      protected_branches: z.ZodBoolean;
      custom_branch_policies: z.ZodBoolean;
    }, z.core.$strip>>>;
    deployment_branch_policies: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      type: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>, z.ZodObject<{
      _undeclared: z.ZodOptional<z.ZodEnum<{
        delete: "delete";
        keep: "keep";
      }>>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>;
    }, z.core.$strict>]>>;
    deployment_protection_rules: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      app: z.ZodString;
    }, z.core.$strict>>, z.ZodObject<{
      _undeclared: z.ZodOptional<z.ZodEnum<{
        delete: "delete";
        keep: "keep";
      }>>;
      entries: z.ZodArray<z.ZodObject<{
        app: z.ZodString;
      }, z.core.$strict>>;
    }, z.core.$strict>]>>;
    variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>, z.ZodObject<{
      _undeclared: z.ZodOptional<z.ZodEnum<{
        delete: "delete";
        keep: "keep";
      }>>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$strict>]>>;
    secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strict>>, z.ZodObject<{
      _undeclared: z.ZodOptional<z.ZodEnum<{
        delete: "delete";
        keep: "keep";
      }>>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strict>>;
    }, z.core.$strict>]>>;
  }, z.core.$strip>>>;
  autolinks: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    key_prefix: z.ZodString;
    url_template: z.ZodString;
    is_alphanumeric: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      key_prefix: z.ZodString;
      url_template: z.ZodString;
      is_alphanumeric: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  actions: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowed_actions: z.ZodOptional<z.ZodEnum<{
      all: "all";
      local_only: "local_only";
      selected: "selected";
    }>>;
    selected_actions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    default_workflow_permissions: z.ZodOptional<z.ZodEnum<{
      read: "read";
      write: "write";
    }>>;
    can_approve_pull_request_reviews: z.ZodOptional<z.ZodBoolean>;
    access_level: z.ZodOptional<z.ZodEnum<{
      none: "none";
      organization: "organization";
      user: "user";
    }>>;
    artifact_and_log_retention: z.ZodOptional<z.ZodObject<{
      days: z.ZodNumber;
    }, z.core.$strip>>;
    cache: z.ZodOptional<z.ZodObject<{
      max_cache_retention_days: z.ZodOptional<z.ZodNumber>;
      max_cache_size_gb: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    oidc_customization_sub: z.ZodOptional<z.ZodObject<{
      use_default: z.ZodBoolean;
      include_claim_keys: z.ZodOptional<z.ZodArray<z.ZodString>>;
      use_immutable_subject: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    fork_pr_contributor_approval: z.ZodOptional<z.ZodObject<{
      approval_policy: z.ZodString;
    }, z.core.$strip>>;
    fork_pr_workflows_private_repos: z.ZodOptional<z.ZodObject<{
      run_workflows_from_fork_pull_requests: z.ZodBoolean;
      send_write_tokens_to_workflows: z.ZodBoolean;
      send_secrets_and_variables: z.ZodBoolean;
      require_approval_for_fork_pr_workflows: z.ZodBoolean;
    }, z.core.$strip>>;
  }, z.core.$strip>>;
  actions_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  dependabot_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  codespaces_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  agents_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  workflows: z.ZodOptional<z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    state: z.ZodEnum<{
      active: "active";
      disabled: "disabled";
    }>;
  }, z.core.$strip>>>;
  check_suite_preferences: z.ZodOptional<z.ZodObject<{
    auto_trigger_checks: z.ZodArray<z.ZodObject<{
      app_id: z.ZodInt;
      setting: z.ZodBoolean;
    }, z.core.$strip>>;
  }, z.core.$catchall<z.ZodUnknown>>>;
  pages: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    build_type: z.ZodOptional<z.ZodEnum<{
      legacy: "legacy";
      workflow: "workflow";
    }>>;
    source: z.ZodOptional<z.ZodObject<{
      branch: z.ZodString;
      path: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    cname: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    https_enforced: z.ZodOptional<z.ZodBoolean>;
    public: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>>;
  code_scanning_default_setup: z.ZodOptional<z.ZodObject<{
    state: z.ZodOptional<z.ZodEnum<{
      configured: "configured";
      "not-configured": "not-configured";
    }>>;
    query_suite: z.ZodOptional<z.ZodEnum<{
      default: "default";
      extended: "extended";
    }>>;
    languages: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runner_type: z.ZodOptional<z.ZodEnum<{
      labeled: "labeled";
      standard: "standard";
    }>>;
    runner_label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    threat_model: z.ZodOptional<z.ZodEnum<{
      remote: "remote";
      remote_and_local: "remote_and_local";
    }>>;
  }, z.core.$strip>>;
  code_quality_setup: z.ZodOptional<z.ZodObject<{
    state: z.ZodOptional<z.ZodEnum<{
      configured: "configured";
      "not-configured": "not-configured";
    }>>;
    languages: z.ZodOptional<z.ZodArray<z.ZodString>>;
    runner_type: z.ZodOptional<z.ZodEnum<{
      labeled: "labeled";
      standard: "standard";
    }>>;
    runner_label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    ai_findings_option: z.ZodOptional<z.ZodEnum<{
      disabled: "disabled";
      on_push: "on_push";
    }>>;
  }, z.core.$strip>>;
  collaborators: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    username: z.ZodString;
    permission: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      username: z.ZodString;
      permission: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  teams: z.ZodOptional<z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    permission: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  milestones: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodEnum<{
      closed: "closed";
      open: "open";
    }>>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      title: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      state: z.ZodOptional<z.ZodEnum<{
        closed: "closed";
        open: "open";
      }>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  interaction_limits: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    limit: z.ZodOptional<z.ZodString>;
    expiry: z.ZodOptional<z.ZodString>;
    pull_request_creation_cap: z.ZodOptional<z.ZodObject<{
      enabled: z.ZodBoolean;
      max_open_pull_requests: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    pull_request_creation_bypass: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strip>>>;
  actions_variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  agents_variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  webhooks: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodOptional<z.ZodLiteral<"web">>;
    config: z.ZodObject<{
      url: z.ZodString;
      content_type: z.ZodOptional<z.ZodString>;
      secret: z.ZodOptional<z.ZodString>;
      insecure_ssl: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    }, z.core.$catchall<z.ZodUnknown>>;
    events: z.ZodOptional<z.ZodArray<z.ZodString>>;
    active: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodOptional<z.ZodLiteral<"web">>;
      config: z.ZodObject<{
        url: z.ZodString;
        content_type: z.ZodOptional<z.ZodString>;
        secret: z.ZodOptional<z.ZodString>;
        insecure_ssl: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      }, z.core.$catchall<z.ZodUnknown>>;
      events: z.ZodOptional<z.ZodArray<z.ZodString>>;
      active: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  custom_properties: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    property_name: z.ZodString;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean, z.ZodNumber, z.ZodNull]>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      property_name: z.ZodString;
      value: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean, z.ZodNumber, z.ZodNull]>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  deploy_keys: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    title: z.ZodString;
    key: z.ZodString;
    read_only: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      title: z.ZodString;
      key: z.ZodString;
      read_only: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  secret_scanning_custom_patterns: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    pattern: z.ZodString;
    start_delimiter: z.ZodOptional<z.ZodString>;
    end_delimiter: z.ZodOptional<z.ZodString>;
    must_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
    must_not_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<z.ZodEnum<{
      delete: "delete";
      keep: "keep";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      pattern: z.ZodString;
      start_delimiter: z.ZodOptional<z.ZodString>;
      end_delimiter: z.ZodOptional<z.ZodString>;
      must_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
      must_not_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      merge: "merge";
      replace: "replace";
    }>>;
  }, z.core.$strict>]>>;
  _layering: z.ZodOptional<z.ZodEnum<{
    merge: "merge";
    replace: "replace";
  }>>;
}, z.core.$strip>;
export type SettingsFile = z.infer<typeof SettingsFile>;
/** Every recognized top-level section, in execution order. */
export declare const SECTION_KEYS: readonly ["repository", "labels", "rulesets", "environments", "branches", "autolinks", "actions", "actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets", "workflows", "check_suite_preferences", "pages", "code_scanning_default_setup", "code_quality_setup", "collaborators", "teams", "milestones", "interaction_limits", "actions_variables", "agents_variables", "webhooks", "custom_properties", "deploy_keys", "secret_scanning_custom_patterns"];
type SectionKey = (typeof SECTION_KEYS)[number];
export declare const UNDECLARED_POLICY_SECTIONS: readonly ["labels", "rulesets", "autolinks", "actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets", "collaborators", "milestones", "actions_variables", "agents_variables", "webhooks", "custom_properties", "deploy_keys", "secret_scanning_custom_patterns"];
type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];
/** Sections whose plain form (no wrapper) matches the Probot Settings app schema; docs/start/migrating-from-probot.md is pinned against this list. */
export declare const PROBOT_PARITY_KEYS: readonly ["repository", "labels", "branches", "collaborators", "teams", "milestones"];
/**
 * Directives to the merge, not sections: declared on the document so the published schema types them.
 * validateSectionShapes copies only SECTION_KEYS, so none of them reaches the apply path.
 */
export declare const DOCUMENT_DIRECTIVE_KEYS: readonly ["_layering"];
//#endregion
//#region src/problem.d.ts
/**
 * The advice appended to a transient (non-permission) API failure: a network
 * blip or a 5xx that survived the retries. One source for the discovery
 * problems rendered here and multi.ts's remote-file read failure, so the "not
 * a permission problem" wording cannot drift between them.
 */
export declare const RERUN_ADVICE = "This is not a permission problem; re-run the workflow, and retry later if it persists";
/** Names as an error message lists them: each quoted, comma-separated. */
export declare function quoteList(names: readonly string[]): string;
/** The run modes that read exactly one settings file. */
type EngineMode = "apply" | "check";
/** How a non-mapping settings document's top level reads, in typeof terms. */
type TopLevelShape = "list" | "null" | "undefined" | "boolean" | "number" | "bigint" | "string" | "symbol" | "function";
/** Which input named an unreadable settings file; each role's advice names its fix. */
type SettingsFileRole = "settings-file" | "defaults-file" | "layer";
/** One repos-dir file the central resolution cannot turn into a target. */
type CentralFileProblem = {
  readonly kind: "not-a-slug";
  readonly filePath: string;
  readonly slug: string;
} | {
  readonly kind: "duplicate";
  readonly slug: string;
  readonly first: string;
  readonly second: string;
} | {
  readonly kind: "ownerless";
  readonly files: readonly string[];
};
/**
 * Every failure the run reports as data. The layer members carry only what
 * their prose needs: the prose fragments are literal unions, the positions are
 * numbers, and a document value enters only as `actual`, which the renderer
 * describes by SHAPE. `keyField` is the module's declared key field, never
 * read from a document.
 */
type Problem = {
  readonly code: "input-unsupported-value";
  readonly input: string;
  readonly value: string;
  readonly noun: string;
  readonly allowed: readonly string[];
  readonly fallback: string;
} | {
  readonly code: "input-unknown-sections";
  readonly unknown: ReadonlyArray<{
    readonly input: "required-sections" | "sections";
    readonly names: readonly string[];
  }>;
  readonly known: readonly string[];
} | {
  readonly code: "input-report-key-unused";
  readonly channel: string;
} | {
  readonly code: "input-report-key-missing";
} | {
  readonly code: "input-report-key-invalid";
  readonly reason: string;
} | {
  readonly code: "input-rejected-in-merge";
  readonly inputs: readonly string[];
} | {
  readonly code: "input-merged-file-missing";
} | {
  readonly code: "input-settings-file-empty";
  readonly value: string;
} | {
  readonly code: "input-merge-only";
  readonly inputs: readonly string[];
  readonly mode: EngineMode;
} | {
  readonly code: "input-snapshot-only";
  readonly inputs: readonly string[];
  readonly mode: EngineMode;
} | {
  readonly code: "input-rejected-in-snapshot";
  readonly inputs: readonly string[];
} | {
  readonly code: "input-snapshot-destination-missing";
} | {
  readonly code: "input-snapshot-destinations-both";
} | {
  readonly code: "input-snapshot-file-with-multi";
} | {
  readonly code: "input-repository-with-snapshot-dir";
} | {
  readonly code: "input-snapshot-dir-without-targets";
} | {
  readonly code: "input-token-missing";
} | {
  readonly code: "input-report-without-redaction";
} | {
  readonly code: "input-affiliation-unsupported";
  readonly entry: string;
  readonly allowed: readonly string[];
} | {
  readonly code: "input-exclude-pattern-invalid";
  readonly pattern: string;
} | {
  readonly code: "input-repository-with-multi";
} | {
  readonly code: "input-settings-file-with-multi";
} | {
  readonly code: "discovery-filters-without-wildcard";
  readonly filters: readonly string[];
  /** Where the run's targets come from instead of `repos: "*"`. */
  readonly targets: "single-repo" | "explicit-repos" | "repos-dir" | "snapshot-file";
} | {
  readonly code: "input-defaults-file-without-multi";
} | {
  readonly code: "input-settings-file-is-list";
  readonly value: string;
  readonly mode: EngineMode;
} | {
  readonly code: "input-repository-not-slug";
  readonly value: string;
} | {
  readonly code: "settings-not-mapping";
  readonly source: string;
  readonly shape: TopLevelShape;
} | {
  readonly code: "settings-not-plain-mapping";
  readonly source: string;
} | {
  readonly code: "settings-unknown-sections";
  readonly source: string;
  readonly unknown: readonly string[];
  readonly known: readonly string[];
} | {
  readonly code: "settings-malformed-sections";
  readonly source: string;
  readonly issues: readonly string[];
} | {
  readonly code: "yaml-invalid";
  readonly reason: string;
} | {
  readonly code: "settings-file-unreadable";
  readonly role: SettingsFileRole;
  readonly path: string;
  readonly reason: string;
} | {
  readonly code: "layer-cycle";
  readonly layer: string;
  readonly site: string;
} | {
  readonly code: "layer-wrong-shape";
  readonly layer: string;
  readonly site: string;
  readonly expected: "a mapping" | "a list of mappings or an {_undeclared, entries} wrapper";
  readonly actual: unknown;
  readonly detail?: " without an entries list";
} | {
  readonly code: "layer-bad-directive";
  readonly layer: string;
  readonly site: string;
  readonly actual: unknown;
} | {
  readonly code: "layer-no-layering-key";
  readonly layer: string;
  readonly site: string;
} | {
  readonly code: "layer-no-key";
  readonly layer: string;
  readonly site: string;
  readonly keyField: string;
} | {
  readonly code: "layer-duplicate-key";
  readonly layer: string;
  readonly site: string;
  readonly keyField: string;
  readonly first: number;
  readonly second: number;
} | {
  readonly code: "required-sections-excluded";
  readonly excluded: readonly SectionKey[];
} | {
  readonly code: "artifact-uploader-missing";
} | {
  readonly code: "merged-file-is-layer";
  readonly mergedFile: string;
  /** The colliding layer's position in the settings-file list, from 0. */
  readonly index: number;
  readonly layer: string;
} | {
  readonly code: "merged-file-unwritable";
  readonly path: string;
  readonly reason: string;
} | {
  readonly code: "snapshot-file-is-settings-file";
  readonly snapshotFile: string;
  readonly settingsFile: string;
} | {
  readonly code: "snapshot-dir-overlaps-repos-dir";
  readonly snapshotDir: string;
  readonly reposDir: string;
} | {
  readonly code: "no-targets";
  readonly filteredOut: number;
} | {
  readonly code: "repo-slug-invalid";
  readonly value: string;
} | {
  readonly code: "repos-input-wildcard-mixed";
} | {
  readonly code: "repos-input-invalid-entries";
  readonly invalid: readonly string[];
  readonly duplicated: readonly string[];
} | {
  readonly code: "repos-dir-missing";
  readonly reposDir: string;
} | {
  readonly code: "repos-dir-unreadable";
  readonly reposDir: string;
  readonly reason: string;
} | {
  readonly code: "repos-dir-invalid-files";
  readonly reposDir: string;
  readonly files: readonly CentralFileProblem[];
} | {
  readonly code: "discovery-request-failed";
  readonly path: string;
  readonly status: number;
  readonly message: string;
  /** True for a denial or an invalid token, where a user PAT is the fix. */
  readonly denied: boolean;
} | {
  readonly code: "discovery-transport-failed";
  readonly reason: string;
} | {
  readonly code: "discovery-response-not-a-list";
  readonly path: string;
} | {
  readonly code: "age-recipient-invalid";
  readonly reason: string;
};
/** The members with these codes, for a function's own error type. */
type ProblemOf<C extends Problem["code"]> = Extract<Problem, {
  readonly code: C;
}>;
/** The layer boundary's members: what mergeLayers refuses. */
type LayerProblem = Extract<Problem, {
  readonly code: `layer-${string}`;
}>;
/** The settings document's members: what validateSettingsDoc refuses (a file's read failure is not one). */
type SettingsProblem = ProblemOf<"settings-not-mapping" | "settings-not-plain-mapping" | "settings-unknown-sections" | "settings-malformed-sections">;
/**
 * The ONE place a problem is worded. INVARIANT for the layer members: a
 * message names the layer as the layer list names it, the site's key path, and
 * the kind of problem - never a value from the document. mode: merge has no
 * private-repos redaction context, so a value echoed there (a label name, a
 * rule type, a mis-shaped section body) could land a private repository's
 * settings in a public log. `actual` reaches the prose only through
 * describeShape; the marker test in test/engine/layers.test.ts pins this.
 */
export declare function describeProblem(problem: Problem): string;
//#endregion
//#region src/discovery/targets.d.ts
interface TargetBase {
  slug: string;
  /** Where this target came from, for messages: a file path or the input name. */
  origin: string;
}
type CentralTarget = TargetBase & {
  source: "central";
  /** The checked-in settings file to read. */
  filePath: string;
};
type RemoteTarget = TargetBase & {
  source: "remote";
};
type Target = CentralTarget | RemoteTarget;
/** PARSED ONCE at a validating boundary, so downstream code never re-splits a string; the only constructor derives all three from one value. */
interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}
/**
 * The smart constructor lives beside SLUG_RE so every boundary (the repository input, the repos list, discovery's
 * full_name) validates and splits through the same definition.
 */
export declare function parseRepoSlug(raw: string): Result<RepoRef, ProblemOf<"repo-slug-invalid">>;
/**
 * A central file wins over a repos-input entry for the same repository (noticed, not an error). The notice renders the
 * slug through `display`; a CENTRAL origin is a repos-dir FILE PATH that can embed the real repository name, so for a
 * redacted target it is rendered generically ("a repos-dir file") to keep the name away from its placeholder.
 */
export declare function dedupeTargets(central: CentralTarget[], remote: RemoteTarget[], notice: (message: string) => void, display: (slug: string) => string, isRedacted?: (slug: string) => boolean): Target[];
//#endregion
//#region src/discovery/central.d.ts
export declare function resolveCentralTargets(reposDir: string, adminOwner: string): Result<{
  targets: CentralTarget[];
  warnings: string[];
}, ProblemOf<"repos-dir-missing" | "repos-dir-unreadable" | "repos-dir-invalid-files">>;
//#endregion
//#region src/io.d.ts
/**
 * The output port every layer reports through. Defined at the root so the
 * engine (which calls it) and the action layer (which implements it over
 * @actions/core) share one contract without importing each other.
 */
type AnnotationLevel = "notice" | "warning" | "error";
/**
 * The action outputs, the one list every Io.output call is typed over; the
 * action layer pins a description to each (OUTPUT_DECLS in src/action/io.ts).
 */
type OutputName = "result" | "skipped-sections" | "repos-result";
declare const MASK_PAIR: unique symbol;
type Minted<F> = F & {
  readonly [MASK_PAIR]: true;
};
/**
 * Both members are branded over one Set by maskRegistry(), so a plain function cannot replace either. Pairing members
 * from two calls still typechecks; closing that would take one opaque registry value on Io.
 */
interface MaskPair {
  /**
   * Redaction registers every private slug here as defense in depth. Required, not optional, so a missing
   * implementation cannot silently no-op in production.
   */
  readonly mask: Minted<(value: string) => void>;
  /** The API trace reads it to redact structurally (whole path, dropped payload) where the runner's literal `***` cannot. */
  readonly masked: Minted<() => ReadonlySet<string>>;
}
interface Io extends MaskPair {
  annotate(level: AnnotationLevel, message: string): void;
  log(line: string): void;
  /** A trace line, shown only when the run has step debug logging enabled. */
  debug(line: string): void;
  summary(markdown: string): void;
  output(name: OutputName, value: string): void;
}
export declare function maskRegistry(sink: (value: string) => void): MaskPair;
/**
 * `text` with every occurrence of every masked value replaced by `***`: the
 * one redactor for the Ios that mask text themselves (collectingIo, the CLI's
 * streams) where the action leaves it to the runner. Occurrences are located
 * in the original text and overlapping or touching ones are merged, so two
 * values that overlap (a prefix of another, or "ABC" and "BCD" across "ABCD")
 * leave no fragment, as replacing one value after another would.
 */
export declare function redactRanges(text: string, masked: ReadonlySet<string>): string;
/**
 * Only annotate and log take the prefix: the debug trace, summary, and outputs are rendered by their writers, and the
 * mask pair registers raw values, not rendered lines.
 */
export declare function prefixedIo(io: Io, prefix: string): Io;
interface CollectedLine {
  level?: AnnotationLevel;
  line: string;
}
/**
 * An Io that records instead of printing. Every captured line, output, and summary block is redacted against the
 * values registered so far, as a runner masks its log, so a library caller that prints the capture cannot leak
 * a secret. The debug trace is dropped, as a runner without step debugging drops it.
 */
export declare function collectingIo(): {
  io: Io;
  lines: CollectedLine[];
  outputs: Partial<Record<OutputName, string>>;
  summary: string[];
};
/** An Io that drops everything. Fresh per call, so one caller's masks never reach another's registry. */
export declare function silentIo(): Io;
//#endregion
//#region src/github/scheduler.d.ts
/**
 * The limiter class the throttling plugin schedules through, injectable so a test run keeps the plugin's rate-limit
 * decisions while skipping Bottleneck's pacing: each Bottleneck limiter yields through several zero-delay timers per
 * job, around 11 ms on every request across the plugin's three limiters, and the notification limiter spaces issue
 * creates by three real seconds whatever the plugin's time unit.
 *
 * TIMERS_SCHEDULER     -> Bottleneck itself: real pacing, real Retry-After sleeps
 * IMMEDIATE_SCHEDULER  -> every job runs at once; a request the plugin decides to retry is retried without sleeping
 */
/**
 * Bottleneck's "failed" contract: a numeric return is the wait before a retry; anything else, a handler that throws
 * included, fails the job with the ORIGINAL error. The throttling plugin's handler reads `error.response.headers` on
 * a transport error that has no response, so a propagated handler exception would replace "socket hang up".
 */
type FailedHandler = (error: unknown, info: {
  retryCount: number;
  args: unknown[];
  options: unknown;
}) => unknown;
interface SchedulerLimiter {
  on(name: string, handler: FailedHandler): unknown;
  /** Both Bottleneck call shapes: `schedule(fn, ...args)` and `schedule(options, fn, ...args)`. */
  schedule(...call: unknown[]): Promise<unknown>;
}
interface SchedulerGroup {
  key(id: string): SchedulerLimiter;
}
/**
 * The slice of Bottleneck's class the throttling plugin calls on the class it is handed, declared structurally so the
 * library's public declarations never name `bottleneck/light.js`, which publishes no types of its own.
 */
interface Scheduler {
  new (): SchedulerLimiter;
  Group: new (options: {
    id: string;
    maxConcurrent?: number;
    minTime?: number;
    timeout?: number;
  }) => SchedulerGroup;
  /** The plugin attaches its rate-limit listeners to a plain object through this emitter. */
  Events: new (target: object) => unknown;
}
//#endregion
//#region src/github/api.d.ts
interface ApiError {
  status: number;
  message: string;
  body: string;
  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;
  /**
   * Content-free rate-limit classification from structural signals alone (429, retry-after, errors[].type RATE_LIMITED,
   * the secondary-rate phrase; the ambiguous zero-quota header only when the body was withheld). isRateLimitError reads
   * it beside its message fallback, so a secondary limit arriving as a 403 is never misread as a permission failure.
   */
  rateLimited?: true;
  /**
   * Tolerance decisions read this instead of the status, which is a lossy fold (FORBIDDEN and a mixed
   * [FORBIDDEN, UNPROCESSABLE] both land on 403/422). The values are structural enums, never echoes, so the field
   * survives a withheld response.
   *
   * every errors[] entry carries a string type  -> the types, deduped and sorted
   * any entry untyped                           -> omitted, and the response is never tolerable
   */
  graphqlTypes?: readonly string[];
}
/**
 * The single source for the header default here, the action.yml `api-version` default, and the inputs fallback; the
 * action-yml contract test asserts the three stay equal.
 */
export declare const DEFAULT_API_VERSION = "2022-11-28";
/**
 * `kind` is declared explicitly, NEVER derived from the POST method every GraphQL call shares. This module must not
 * import from sections/, so GraphqlOpDecl extends this shape structurally.
 */
interface GraphqlOp {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly query: string;
}
interface GithubClient {
  /**
   * `redactTrace` holds the request's `/repos/<owner>/<repo>` slug redacted for the request's duration, for the
   * visibility probe, which must not leak the slug before it knows whether the repository is private.
   */
  tryRequest(method: string, path: string, payload?: unknown, options?: {
    accept?: string;
    raw?: boolean;
    redactTrace?: boolean;
  }): Promise<{
    data: unknown;
  } | {
    error: ApiError;
  }>;
  /**
   * Failures, including the errors[] GitHub delivers inside an HTTP 200, come back as the same ApiError the REST
   * classifiers read. `slug` names the owner/repo: GraphQL carries the target in the request BODY, invisible to the
   * URL-based trace redaction.
   */
  tryGraphql(op: GraphqlOp, variables: Readonly<Record<string, unknown>>, slug: string): Promise<{
    data: Record<string, unknown>;
  } | {
    error: ApiError;
  }>;
}
type TraceIo = Pick<Io, "debug" | "masked">;
interface GithubApiOptions {
  token: string;
  /** Trace sink for redacted request lines; defaults to a silent trace with nothing masked. */
  io?: TraceIo;
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Real milliseconds in one plugin second: Retry-After units, the retry backoff step, and the write limiter's gap.
   * Undefined reads RETRY_BASE_MS once; the plugin topology is the same at every value.
   */
  retryBaseMs?: number;
  /** The limiter the throttling plugin paces through; TIMERS_SCHEDULER unless RETRY_BASE_MS selects the immediate one. */
  scheduler?: Scheduler;
  /** Passed to octokit verbatim; octokit-core's own agent string when omitted. */
  userAgent?: string;
}
/** The Octokit instance is built here and never injected: a consumer needing control over transport or plugins implements GithubClient directly. */
export declare class GithubApi implements GithubClient {
  private readonly octokit;
  private readonly trace;
  private readonly baseUrl;
  private readonly apiVersion;
  constructor(options: GithubApiOptions);
  tryRequest(method: string, path: string, payload?: unknown, options?: {
    accept?: string;
    raw?: boolean;
    redactTrace?: boolean;
  }): Promise<{
    data: unknown;
  } | {
    error: ApiError;
  }>;
  private request;
  /**
   * The load-bearing difference from REST: GraphQL failures arrive as an HTTP 200 carrying a non-empty errors[].
   *
   * any errors[] entry, even beside partial data   -> { error }, so a section never acts on a half-answered query
   * `extensions.warnings` (legacy node-ID notices)  -> the debug trace only
   */
  tryGraphql(op: GraphqlOp, variables: Readonly<Record<string, unknown>>, slug: string): Promise<{
    data: Record<string, unknown>;
  } | {
    error: ApiError;
  }>;
}
/**
 * Rate limiting in a 403 costume: primary exhaustion and secondary limits arrive as 403 once the throttling plugin gives
 * up. A withheld response has no message to read, so its `rateLimited` flag stands in, as does a GraphQL RATE_LIMITED
 * error, whose 200 the mapper rewrites to 403.
 */
export declare function isRateLimitError(error: ApiError): boolean;
/**
 * True when an error means the token lacks access, as opposed to a bad payload: a status fold, blind
 * to the body. A message an endpoint declares as a definitive rejection (sections/contract/endpoints.ts)
 * is classified ahead of this in throwFor, where the endpoint is known.
 */
export declare function isPermissionError(error: ApiError): boolean;
//#endregion
//#region src/private-open.d.ts
declare const PRIVATE: unique symbol;
//#endregion
//#region src/private.d.ts
interface Private<T> {
  readonly [PRIVATE]: T;
}
//#endregion
//#region src/discovery/discover.d.ts
interface DiscoveredRepoRef {
  slug: string;
  visibility: "public" | "private" | "internal";
}
/**
 * A repository a filter dropped: only ever named in the skip notice, so a
 * non-public one carries its slug sealed (opened under `private-repos: show`).
 */
type FilteredRepoRef = {
  slug: string;
  visibility: "public";
} | {
  slug: Private<string>;
  visibility: "private" | "internal";
};
/** Allowed values per discovery-filter input; the single source the input validation and types derive from. */
export declare const VISIBILITY_FILTERS: readonly ["all", "public", "private", "internal"];
export declare const ARCHIVED_FILTERS: readonly ["skip", "include", "only"];
export declare const FORKS_FILTERS: readonly ["include", "exclude", "only"];
export declare const AFFILIATIONS: readonly ["owner", "collaborator", "organization_member"];
/** Filters applied to repos: "*" discovery only, never to explicit targets. */
interface DiscoveryFilters {
  visibility: (typeof VISIBILITY_FILTERS)[number];
  archived: (typeof ARCHIVED_FILTERS)[number];
  forks: (typeof FORKS_FILTERS)[number];
  affiliation: string[];
  topics: string[];
  exclude: string[];
}
export declare const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters;
interface DiscoveryResult {
  repos: DiscoveredRepoRef[];
  filtered: Array<{
    reason: string;
    repos: FilteredRepoRef[];
  }>;
}
type DiscoveryProblem = ProblemOf<"discovery-request-failed" | "discovery-transport-failed" | "discovery-response-not-a-list">;
export declare function discoverRepos(api: GithubClient, filters: DiscoveryFilters): ResultAsync<DiscoveryResult, DiscoveryProblem>;
//#endregion
//#region src/discovery/repos-input.d.ts
export declare function parseReposInput(raw: string): Result<{
  slugs: string[];
  discover: boolean;
}, ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries">>;
//#endregion
//#region src/engine/layers.d.ts
/** One settings document in the stack, named for notices and refusals. */
interface Layer {
  readonly name: string;
  readonly doc: unknown;
}
type Layering = "merge" | "replace";
/** A lower declaration a higher layer deleted with `null`. */
interface OptOutNotice {
  readonly layer: string;
  readonly path: string;
}
/**
 * A layer validated on its own is seen as the merge could leave it: every null the merge would read as a marker drops,
 * every other null stays for the validator to judge. A cyclic input yields a cyclic clone; the merge is what refuses those.
 *
 * `rulesets[main].bypass_actors: null`  -> dropped (a mapping key inside a keyed list the merge combines)
 * `branches[].protection: null`         -> kept (inside a list the merge copies as written)
 * a null list element                   -> kept
 */
export declare function stripNulls(doc: unknown): unknown;
/** Value-free under the refusals' invariant: mode: merge has no redaction context, so no document value may reach a log through the merge. */
export declare function describeOptOut(notice: OptOutNotice): string;
export declare function mergeLayers(layers: readonly Layer[], options: {
  readonly layering: Layering;
}): Result<{
  settings: unknown;
  notices: OptOutNotice[];
}, LayerProblem>;
//#endregion
//#region src/sections/contract/permissions.d.ts
/** A fine-grained-PAT permission resource under Repository permissions. */
type PatResource = "administration" | "issues" | "environments" | "actions" | "pages" | "code_scanning_alerts" | "contents" | "variables" | "webhooks" | "secrets" | "dependabot_secrets" | "codespaces_secrets" | "custom_properties" | "secret_scanning_alerts" | "agent_secrets" | "agent_variables" | "checks";
interface SectionPermission {
  /** Fine-grained PAT repository permissions; ANY one of these grants access. */
  readonly repo: readonly [PatResource, ...PatResource[]];
  /** Additional organization permission required (teams only). */
  readonly org?: "members";
}
/**
 * `access` defaults to "write" (a section both reads and writes), and a denial on an override endpoint
 * passes overrideAdviceLevel (./errors.ts) so the advice asks for exactly the level the section needs.
 * The output is user-facing: EXPECTED_GRANT in test/sections/registry.test.ts pins every grant character for character.
 */
export declare function grantFor(permission: SectionPermission, caveat?: string, access?: "read" | "write"): string;
//#endregion
//#region src/upstream-gaps/index.d.ts
/**
 * GENERATED by gen-gaps-index.ts - do not edit. Every pending upstream gap,
 * aggregated in sorted file order; regenerate with
 * `bun .github/scripts/gen-gaps-index.ts` after adding, deleting, or
 * transforming a gap file. The derivations below degrade gracefully to an
 * empty gaps set, so this file survives an empty directory.
 */
declare const GAPS: readonly [{
  readonly routes: readonly ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"];
  readonly documentedInSpec: false;
} & {
  readonly kind: "octokit";
}];
type GapUnion = (typeof GAPS)[number];
/**
 * Routes GitHub documents but the pinned @octokit/types release does not
 * carry yet: the octokit-kind gaps' routes (spec-only gaps are keyof
 * Endpoints already). Only the route STRING is consumed (never octokit's
 * parameter/response typing), so the literal union defineGap preserves is
 * enough; an empty GAPS degrades it to never.
 */
type SupplementalRoute = Extract<GapUnion, {
  kind: "octokit";
}>["routes"][number];
//#endregion
//#region src/sections/contract/endpoints.d.ts
/** `keyof Endpoints` makes a typo'd path or wrong method a compile error; SupplementalRoute covers routes octokit lags (src/upstream-gaps). */
type Route = keyof Endpoints | SupplementalRoute;
/**
 * The statuses throwFor's permission branch swallows for a granted operation. A `hints` key on one is
 * dead advice (HintableStatus excludes them); `denialHint` carries an ambiguity, and `rejections` claims
 * back the one message GitHub reserves for a definite meaning.
 */
type DenialStatus = 403 | 404;
/** A public ("none") operation's 403/404 is never a payload rejection either, so the exclusion holds for it too. */
type HintableStatus = 400 | 412 | 422;
/**
 * A response whose status a denial shares but whose exact message GitHub reserves for one definite
 * meaning: the protection PUT's 404 "Branch not found". throwFor classifies a match ahead of its
 * permission branch as a hard section error, so no on-missing-permission policy can skip it and the
 * grant advice never renders for it. The message must be one no denial body spells; the registry
 * test pins every declaration against the e2e mock's denial responses.
 */
interface DefinitiveRejection {
  readonly status: DenialStatus;
  /** Compared whole, never as a substring: "Not Found" is a fine-grained denial. */
  readonly message: string;
  /** What to fix, as a lowercase clause without a trailing period; throwFor starts a sentence with it. */
  readonly advice: string;
}
type GetRoute = Extract<Route, `GET ${string}`>;
/**
 * `statuses` keys are the outcomes the handler treats as normal (the e2e mock reads the keys); its 4xx keys
 * other than 401 and 429 are the tolerated errors (toleratedStatuses). The request helpers build paths from
 * these declarations via expand(), so a section can never call a path it has not declared.
 */
type EndpointDecl = (EndpointDeclFields & {
  readonly route: GetRoute;
  readonly permission?: SectionPermission | "none";
  readonly accessGrade?: never;
  readonly alwaysRewrite?: never;
  readonly unverifiable?: never;
  /**
   * Omitted, the read is available to plan(), so check mode and preflight may meet it. "execution" gates it
   * behind the ExecTools token only a thunk receives (ReadPort in ./plan.ts), so check mode never issues it.
   *
   *   e2e mock          -> treats an execution read in check mode as a violation
   *   denialPosture()   -> rejects a primaryRead on it: no denied first read can be classified from it
   */
  readonly phase?: "execution";
}) | (EndpointDeclFields & Recurrence & {
  readonly route: Exclude<Route, GetRoute>;
  /** Overrides the section's permission; "none" means public. Resolved by endpointPermission(). */
  readonly permission?: SectionPermission | "none";
  readonly accessGrade?: never;
  readonly phase?: never;
}) | GatedReadDecl;
/**
 * A WRITE's behaviour on a converged second apply, at most one flag: `alwaysRewrite` recurs by
 * contract (sealed secret PUTs, the interaction-limits re-arm, the Git LFS toggle, the check suite
 * PATCH); `unverifiable` may recur, carrying a value GitHub never echoes back. The e2e idempotence proof reads both.
 */
type Recurrence = {
  readonly alwaysRewrite?: never;
  readonly unverifiable?: never;
} | {
  readonly alwaysRewrite: true;
  readonly unverifiable?: never;
} | {
  readonly alwaysRewrite?: never;
  readonly unverifiable: true;
};
/**
 * A GET GitHub gates at WRITE (the Codespaces secrets GETs), read by endpointKind().
 * A public endpoint has no grant to gate, so `permission: "none"` is not representable.
 */
interface GatedReadDecl extends EndpointDeclFields {
  readonly route: GetRoute;
  readonly permission?: SectionPermission;
  readonly accessGrade: "write";
  readonly alwaysRewrite?: never;
  readonly unverifiable?: never;
  readonly phase?: never;
}
interface EndpointDeclFields {
  readonly statuses: Readonly<Record<number, string>>;
  /**
   * By default an advisory READ's failures come back as { error } instead of aborting the section; a rate
   * limit still throws, and an explicit `tolerate` narrows the set (declaredTolerance). The e2e mock
   * derives its advisory-read exemption from this flag via allEndpoints().
   */
  readonly advisory?: boolean;
  /**
   * Payloads pass through verbatim, so a hint names the failure CLASS and points at the docs, never valid
   * values that could go stale; throwFor appends it to the status's rejection message. Style: one or two sentences, no trailing period.
   */
  readonly hints?: Readonly<Partial<Record<HintableStatus, string>>>;
  /**
   * Appended to the PermissionDenied message (which never reads `hints`) when a 403/404 can mean
   * something other than a missing grant (Git LFS disabled account-wide) and the body does not tell
   * the readings apart; a body that does is a `rejections` entry. One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /** The endpoint's definitive rejections (see DefinitiveRejection); the e2e mock serves the same declarations. */
  readonly rejections?: readonly DefinitiveRejection[];
  /**
   * When GitHub caps per_page below the standard 100 (the Actions variables list: 30). The page loop
   * requests exactly this many and treats a shorter page as the last, so a request GitHub would silently
   * clamp cannot truncate the walk after page one.
   */
  readonly pageSize?: number;
  /**
   * The section's PRIMARY READ and what a fine-grained 404 on it means: "denied" classifies as
   * PermissionDenied and stops the section (an advisory read only exposes tryCall, which returns it as
   * { error }), "absent" reads as a missing resource and proceeds. At most one per section; the read port
   * (ReadPort in ./plan.ts) and denialPosture() read it.
   */
  readonly primaryRead?: {
    readonly notFound: "denied" | "absent";
  };
}
export declare function endpointMethod(route: Route): string;
export declare function endpointPath(route: Route): string;
/** Minus `owner` and `repo`, which expand() fills from the context; the helpers make `params` compiler-required and typo-proof from it. */
type PathParams<R extends string> = R extends `${string}{${infer T}}${infer Rest}` ? (T extends "owner" | "repo" ? never : T) | PathParams<Rest> : never;
/**
 * Excluded from every declared tolerance (they describe the credential or the transport, not the resource);
 * an advisory read still absorbs a 401, and a rate limit is caught per request.
 */
type TransportStatus = 401 | 429;
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
/** toleratedStatuses() is the runtime twin. */
type DeclaredErrorStatus<E extends EndpointDecl> = { [S in keyof E["statuses"] & number]: S extends TransportStatus ? never : `${S}` extends `4${Digit}${Digit}` ? S : never; }[keyof E["statuses"] & number];
//#endregion
//#region src/sections/contract/graphql.d.ts
/**
 * RATE_LIMITED is absent on purpose (throttling is a transport concern every operation handles alike),
 * as is INSUFFICIENT_SCOPES (a wrong token; the transport folds it into the 403 class).
 */
declare const GRAPHQL_TOLERABLE_ERRORS: readonly ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE"];
type GraphqlTolerableError = (typeof GRAPHQL_TOLERABLE_ERRORS)[number];
/**
 * `path` leads from the data root to the connection field (["repository", "branchProtectionRules"]),
 * which must select `nodes { ... }` and `pageInfo { hasNextPage endCursor }`; GraphqlPaginatedReadDecl's
 * query type enforces the `$cursor` variable.
 */
interface GraphqlConnectionDecl {
  readonly path: readonly [string, ...string[]];
}
/**
 * `_variables` is type-only (never set at runtime; covariant, so a concretely typed declaration still
 * erases to the metadata consumers' default) and lets the request helpers type-check call-site variables.
 */
interface GraphqlOpCommon<V extends Record<string, unknown>> {
  /**
   * The wire dispatch key (operationName on every call), globally unique across sections
   * (allGraphqlOps asserts it): the mock and the coverage tripwire address the operation by it without parsing the query.
   */
  readonly name: string;
  /**
   * As EndpointDecl.statuses: "ok" documents the success meaning, and each
   * declared error type is a TOLERATED outcome (tryCallGraphql returns it as
   * { error } instead of throwing).
   */
  readonly outcomes: Readonly<{
    ok: string;
  } & Partial<Record<GraphqlTolerableError, string>>>;
  /** As EndpointDecl.permission: "none" means public, omitted means the section's own. */
  readonly permission?: SectionPermission | "none";
  /** Read only by the e2e mock, which exempts advisory reads from its denial barrier; the GraphQL helpers tolerate by declared outcomes alone. */
  readonly advisory?: boolean;
  /**
   * Appended to the PermissionDenied message for an operation whose
   * FORBIDDEN/NOT_FOUND can mean something other than a missing token grant.
   * One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /** GraphQL rejections carry no HTTP status for a hint to key on; the `never` makes declaring one a compile error (see FailingOp). */
  readonly hints?: never;
  /** Type-only marker for `V`; never set at runtime. */
  readonly _variables?: V;
}
/**
 * `kind` is declared, NEVER derived from the POST every GraphQL call shares: it drives the preflight
 * read-only guard, the mock's permission gate, and the fuzz oracle, and the union pins each kind to its
 * operation type, so a mutation declared "read" does not compile. A repo-addressed READ takes $owner/$repo
 * (the mock routes multi-repo reads by them); a mutation addresses its target by node id.
 */
type GraphqlOpDecl<V extends Record<string, unknown> = Record<string, unknown>> = (GraphqlOpCommon<V> & {
  readonly kind: "read";
  readonly query: `query ${string}`;
  readonly connection?: undefined;
  /** As EndpointDecl.phase: a read only a thunk may issue, at execution. */
  readonly phase?: "execution";
}) | GraphqlPaginatedReadDecl<V> | (GraphqlOpCommon<V> & {
  readonly kind: "write";
  readonly query: `mutation ${string}`;
  /** Pagination is a read concern. */
  readonly connection?: never;
  readonly phase?: never;
});
/**
 * A read declaring `connection` MUST take the $cursor variable listGraphqlConnection's loop owns (the
 * template type refuses a cursorless query) and callers must never supply `cursor` (the `?: never` pin).
 * Annotate connection ops with THIS type so the pairing is checked at the declaration.
 */
type GraphqlPaginatedReadDecl<V extends Record<string, unknown> = Record<string, unknown>> = GraphqlOpCommon<V & {
  cursor?: never;
}> & {
  readonly kind: "read";
  readonly query: `query ${string}$cursor${string}`;
  readonly connection: GraphqlConnectionDecl;
  readonly phase?: "execution";
};
/**
 * Recovered from the `op` argument alone: inferring from the variables argument would let a typo'd call
 * site WIDEN the shape instead of failing. A declaration reached through a widened dictionary
 * (`section.graphql.role`) erases to the permissive default, so helpers must be fed the consts.
 */
type GraphqlVariablesOf<O extends GraphqlOpDecl> = O extends {
  readonly _variables?: infer V;
} ? Extract<V, Record<string, unknown>> : Record<string, unknown>;
//#endregion
//#region src/types.d.ts
/**
 * Leaf type vocabulary shared by the settings schema and its consumers; zod-free, since these are the generic types
 * the zod schemas cannot express.
 */
/** What apply does to live resources the settings file does not declare. */
type UndeclaredPolicy = "keep" | "delete";
/**
 * The wrapper knobbed() and nestedKnobbed() build. The underscored keys are this action's DIRECTIVES, never GitHub
 * settings; each key's meaning is published from src/sections/shared/shared.docs.yml, the one source the JSON Schema and the docs render from.
 */
interface UndeclaredPolicyList<E> {
  _undeclared?: UndeclaredPolicy;
  entries: E[];
  /** Only a TOP-LEVEL section's wrapper takes it (see nestedKnobbed()). */
  _layering?: "merge" | "replace";
}
type MustBeNever<T extends never> = T;
//#endregion
//#region src/sections/contract/module.d.ts
type EndpointDict = Readonly<Record<string, EndpointDecl>>;
type GraphqlDict = Readonly<Record<string, GraphqlOpDecl>>;
/**
 * `E` and `G` must be the module's LITERAL (`as const`) dictionaries: ../registry.ts derives the
 * `${key}.${role}` unions from them, and the e2e mock's handler tables are typed by those unions.
 */
interface SectionMeta<K extends SectionKey = SectionKey, E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> {
  readonly key: K;
  /** Drives the grant prose (sectionGrant), the e2e mock's permission gate, and the fuzz oracle. */
  readonly permission: SectionPermission;
  /** Appended to the derived grant advice when a denial can mean more than a missing grant (an ambiguous 403). */
  readonly grantCaveat?: string;
  /**
   * "org": the resources exist only under an ORGANIZATION owner, so the handler probes GET /orgs/{org}
   * (404 tolerated) and no-ops with a note on a personal account. The single source of owner-kind modeling:
   * the fuzz oracle's personal-account fold reads it, and test/sections/registry.test.ts pins it to the probe endpoint.
   */
  readonly ownerSensitivity?: "org";
  /** Every REST endpoint the section may call, by role; the e2e mock's routes and USED_PATHS derive from it. */
  readonly endpoints: E;
  /**
   * Every GraphQL operation the section may issue, by role; the e2e mock, the coverage tripwire, and the
   * fuzz generators iterate allGraphqlOps().
   */
  readonly graphql?: G;
  /**
   * The generated Sections table's Undeclared-default column derives from it, and test/sections/docs-registry.test.ts
   * fails a COVERAGE Notes cell that contradicts it; the wrapped `{_undeclared, entries}` form overrides it per run.
   *
   *   "delete"     -> lists live resources and DELETES undeclared ones; `_undeclared: keep` softens to notes
   *   "keep"       -> lists live resources and KEEPS undeclared ones as notes; `_undeclared: delete` hardens
   *   "untouched"  -> takes no `_undeclared` knob; the section applies no undeclared policy
   *
   * The conditional type pins the pairing: a section in UNDECLARED_POLICY_SECTIONS says "delete" or "keep", one outside it "untouched".
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
  /** Read by engine/layers.ts for the layered merge; a knobbed section that declares none always replaces. */
  readonly layering?: K extends UndeclaredPolicySection ? KeyedListLayering : never;
}
/**
 * engine/layers.ts pairs two entries when their key sets intersect, the planner's own duplicate test,
 * so a merged document is always one the planner accepts.
 */
interface KeyedListLayering {
  /**
   * Folded as the planner folds them (a label claims its name plus its pre-rename name); null when the
   * entry carries none, which the layer boundary refuses.
   */
  readonly keys: (entry: Readonly<Record<string, unknown>>) => readonly string[] | null;
  /** The entry field the keys come from, for refusal prose ("name", "type"). */
  readonly keyField: string;
  /** A matched pair: "replace" (higher wins wholesale) or "merge" (key by key, nested keyed lists below). */
  readonly combine: "replace" | "merge";
  /** Fields of a merged entry that are themselves keyed lists (rulesets' `rules`). */
  readonly nested?: Readonly<Record<string, KeyedListLayering>>;
}
/** Used verbatim in permission errors; the Sections table on docs/reference/sections.md mirrors it in its PAT permission column. */
export declare function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string;
/**
 * `wire` is what the request does; `grade` is what GitHub gates it at, so an accessGrade override
 * write-gates a wire read (a GraphQL operation's kind is both). `phase` matters for reads (writes always carry "plan" and run at apply):
 *
 *   read, phase "plan"       -> available to plan(), so check mode and preflight may meet it
 *   read, phase "execution"  -> issued by a thunk, apply only (see EndpointDecl.phase)
 */
interface SectionOperation {
  readonly role: string;
  readonly wire: "read" | "write";
  readonly grade: "read" | "write";
  readonly permission: SectionPermission | "none";
  readonly phase: "plan" | "execution";
}
/**
 * REST and GraphQL flattened, so a derivation over "everything this section can call" cannot skip the
 * GraphQL dictionary; _OperationDictionariesFlattened pins the flattening total.
 */
export declare function sectionOperations(section: SectionMeta): SectionOperation[];
/**
 * How GitHub gates a section's planning reads under a read-only grant. Read by the fuzz oracle and the docs.
 *
 *   "plain"        -> every read succeeds (also a section with no reads)
 *   "write-gated"  -> denied at the first read
 *   "mixed"        -> reads until the handler reaches a gated one
 */
type ReadGating = "plain" | "write-gated" | "mixed";
export declare function readGating(section: SectionMeta): ReadGating;
interface WriteGatedRead {
  readonly route: Route;
  readonly permission: SectionPermission;
}
/** GraphQL reads are never here: a GraphQL read is gated at read (its kind IS the gate), so the REST dictionary is complete. */
export declare function writeGatedReads(section: SectionMeta): WriteGatedRead[];
/** What a fine-grained 404 on a section's primary read means (see EndpointDecl.primaryRead). */
type DenialPosture = NonNullable<EndpointDecl["primaryRead"]>["notFound"];
/**
 * A section with no planning read classifies nothing before its first write, so it is "absent".
 * Read by the fuzz oracle and the e2e mock.
 */
export declare function denialPosture(section: SectionMeta): DenialPosture;
/**
 * validateSettingsDoc (engine/orchestrate.ts) has run every section's shape before a handler sees this,
 * so plan() carries the proof in its parameter type instead of a per-section cast. Only `undefined` (the
 * absent-section marker) is excluded: a nullable section (interaction_limits) keeps its `null`.
 */
type SectionInput<K extends SectionKey> = Exclude<SettingsFile[K], undefined>;
interface SectionModuleBase<K extends SectionKey = SectionKey, E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> extends SectionMeta<K, E, G> {
  /**
   * Declared fields are checked and unknown fields pass through, so validation does not fight
   * passthrough-first forward compatibility. STRICT nested sub-shapes are sanctioned only where the
   * endpoint offers no passthrough destination (actions.cache, the environment secrets and
   * deployment_protection_rules entries), where an extra key can only be a typo.
   */
  shape: z.ZodType;
  /**
   * Declared only by CLOSED sections, whose API calls never forward extra entry keys (collaborators, teams,
   * workflows), so an unrecognized key would apply "successfully" and never converge; open passthrough
   * sections must NOT declare it, since their extra keys reach GitHub.
   *
   *   `known` mapped over EVERY entry key          -> a new schema field forces a decision here; a phantom key is an excess property
   *   EntryOf sees through the wrapped form        -> a closed section that also takes the knob (collaborators) stays closed in both forms
   *   validateSectionShapes (engine/validate.ts)   -> rejects before any section writes
   */
  closedSurface?: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never] ? never : {
    /** Key order is the order the error prose lists them in. */
    known: { readonly [P in Extract<keyof EntryOf<NonNullable<SettingsFile[K]>>, string>]: true; };
    /**
     * Method syntax on purpose: a function-typed property is contravariant in its parameter, which
     * would stop the module's exact type from erasing to SectionModule<SectionKey> in ../registry.ts.
     */
    describe(entry: EntryOf<NonNullable<SettingsFile[K]>>): string;
    /** What the unrecognized key would silently do, as message prose. */
    consequence: string;
  };
  /**
   * Declared only by sections with designated secret fields (every webhooks entry's config.secret); the
   * values are returned raw, and nothing here reads the environment.
   *
   *   check mode and preflight   -> the engine validates each as a whole-value `$NAME` reference
   *   apply                      -> the engine resolves and masks them all up front, so ctx.resolveSecret never misses
   */
  secretValues?(declared: SectionInput<K>): DeclaredSecretValue[];
}
/**
 * What a section reads back as a settings document: its live state in the section's own declared
 * form, or `undefined` when nothing exists (the engine omits the key). `notes` carry what the value
 * cannot: a secret's unreadable value, a feature the repository lacks.
 */
interface SectionSnapshot<K extends SectionKey = SectionKey> {
  readonly value: SettingsFile[K] | undefined;
  readonly notes: readonly string[];
}
/**
 * plan() only READS (through the port in PlanContext) and returns the operations that would converge the
 * repository; the engine renders them as drift in check mode and executes them in apply mode.
 * Modules register in ../registry.ts.
 *
 *   snapshot() present  -> reads through the same port, so it cannot write either
 *   snapshot() absent   -> the section is unsupported by snapshot (snapshotUnsupportedNote)
 */
interface SectionModule<K extends SectionKey = SectionKey, E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> extends SectionModuleBase<K, E, G> {
  plan(ctx: PlanContext<E, G>, desired: SectionInput<K>): Promise<SectionPlan<PlannedOp<E, G>>>;
  snapshot?(ctx: PlanContext<E, G>): Promise<SectionSnapshot<K>>;
  /** Pinned so a non-literal object carrying a run() handler is not assignable either. */
  run?: never;
}
/**
 * `label` names the OWNING ENTRY (a secret name, a webhook url) so a validation error can point at it;
 * it is configuration the settings file already spells, never a value.
 */
interface DeclaredSecretValue {
  readonly label: string;
  readonly value: string;
}
type EntryOf<T> = T extends readonly (infer E)[] ? E : T extends {
  entries: readonly (infer E)[];
} ? E : never;
/**
 * Only the WORDS live here, so the keep-note cannot drift between sections; which branch runs stays in
 * each section's own control flow on purpose.
 */
declare function undeclaredNote(opts: {
  /** The subject naming the live resource: `label "stale"`, `autolink JIRA-`. */
  subject: string;
  /** How the resource presents; the common case is the default. */
  state?: string;
  /** The pronoun for "add ... to the settings file" ("it" unless plural). */
  add?: string;
  /** What adding it would manage ("it", or "their access" for people). */
  manage?: string;
  /** What `_undeclared: delete` would make apply do, with any consequence. */
  action: string;
}): string;
/**
 * The knob clause derives from the list's DEFAULT policy so it can never contradict the section: under a
 * keep default this branch is reachable only because the file set `_undeclared: delete`, so the line says
 * so. Pass the same default the policy was unwrapped with.
 */
declare function undeclaredDrift(listDefault: UndeclaredPolicy, opts: {
  /** The drift-line prefix with the natural key: `labels[stale]`. */
  label: string;
  /** What apply will do, with any consequence worth naming. */
  action: string;
  /** When "not in the settings file" understates it (a PENDING INVITATION rather than a collaborator); the knob clause follows it. */
  state?: string;
  /** The pronoun for "add ... to the settings file" ("it" unless plural). */
  add?: string;
  /** What adding it would keep ("it", or "their access" for people). */
  keep?: string;
}): string;
//#endregion
//#region src/sections/contract/requests.d.ts
/**
 * A rest tuple, not an optional object param: that is what makes omitting the whole argument a compile
 * error for a route that needs params (the `[never]` trick alone cannot forbid an omitted argument).
 * `Extra` carries per-helper extras (query/payload/tolerate/accept).
 */
type OptsArg<E extends EndpointDecl, Extra> = [PathParams<E["route"]>] extends [never] ? [opts?: {
  params?: undefined;
} & Extra] : [opts: {
  params: Readonly<Record<PathParams<E["route"]>, string>>;
} & Extra];
//#endregion
//#region src/sections/contract/plan.d.ts
/**
 * What a payload thunk may produce and the transport serializes verbatim. `undefined` is allowed inside
 * objects because JSON drops it (a declared optional the file omits).
 */
type PlainData = string | number | boolean | null | readonly PlainData[] | {
  readonly [key: string]: PlainData | undefined;
};
/**
 * The plaintext behind a `$NAME` reference is resolved and masked up front, so check mode never sees one.
 * Only a thunk holds this token, which the port's execution-phase reads demand.
 */
interface ExecTools {
  resolveSecret(reference: string): string;
}
/** A plan() body has no ExecTools token, so an execution-phase read does not compile there; a thunk passes the one it received. */
type Gated<T> = { readonly [K in keyof T]: T[K] extends ((...args: infer A) => infer R) ? (exec: ExecTools, ...args: A) => R : T[K]; };
type ReadRole<E extends EndpointDict> = { [R in keyof E & string]: E[R]["route"] extends `GET ${string}` ? R : never; }[keyof E & string];
type WriteRole<E extends EndpointDict> = Exclude<keyof E & string, ReadRole<E>>;
type GraphqlReadRole<G extends GraphqlDict> = { [R in keyof G & string]: G[R] extends {
  readonly kind: "read";
} ? R : never; }[keyof G & string];
type GraphqlWriteRole<G extends GraphqlDict> = Exclude<keyof G & string, GraphqlReadRole<G>>;
/** The request helpers (./requests.ts) bound to ONE read endpoint, minus the declaration argument and any payload. */
interface BoundRead<E extends EndpointDecl> {
  call(...args: OptsArg<E, {
    query?: Readonly<Record<string, string>>;
    describe?: string;
  }>): Promise<unknown>;
  tryCall(...args: OptsArg<E, {
    query?: Readonly<Record<string, string>>;
    tolerate?: readonly DeclaredErrorStatus<E>[];
    describe?: string;
  }>): Promise<{
    data: unknown;
  } | {
    error: ApiError;
  }>;
  probeAbsent(...args: OptsArg<E, {
    query?: Readonly<Record<string, string>>;
    tolerate?: readonly DeclaredErrorStatus<E>[];
    accept?: string;
    describe?: string;
  }>): Promise<{
    data: unknown;
  } | {
    missing: true;
  }>;
  listAll(...args: OptsArg<E, {
    query?: Readonly<Record<string, string>>;
  }>): Promise<unknown[]>;
  listAllEnveloped(envelopeKey: string, ...args: OptsArg<E, {
    query?: Readonly<Record<string, string>>;
  }>): Promise<unknown[]>;
}
type BoundGraphqlRead<O extends GraphqlOpDecl> = {
  call(variables: Readonly<GraphqlVariablesOf<O>>, opts?: {
    describe?: string;
  }): Promise<Record<string, unknown>>;
  tryCall(variables: Readonly<GraphqlVariablesOf<O>>, opts?: {
    tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
    describe?: string;
  }): Promise<{
    data: Record<string, unknown>;
  } | {
    error: ApiError;
  }>;
} & (O extends GraphqlPaginatedReadDecl ? {
  /** Every node of the declared connection (the loop owns `$cursor`). */
  listConnection(variables: Readonly<GraphqlVariablesOf<O>> & {
    cursor?: never;
  }): Promise<{
    items: unknown[];
  } | {
    error: ApiError;
  }>;
} : {
  listConnection?: never;
});
/**
 * Write roles are absent from the type, so `ctx.read.<writeRole>` does not compile. A role with a
 * `primaryRead` posture exposes only the helpers that honor it; a `phase: "execution"` role exposes them Gated.
 */
type BoundReads<E extends EndpointDict, G extends GraphqlDict> = { readonly [R in ReadRole<E>]: ReadPort<E[R]>; } & { readonly [R in GraphqlReadRole<G>]: GraphqlReadPort<G[R]>; };
type GraphqlReadPort<O extends GraphqlOpDecl> = O extends {
  readonly phase: "execution";
} ? Gated<BoundGraphqlRead<O>> : BoundGraphqlRead<O>;
/**
 * Only the helpers that honor the declaration's posture are exposed, so a handler cannot bypass an
 * advisory, denied, or absent posture by picking another helper.
 */
type ReadPort<E extends EndpointDecl> = E extends {
  readonly phase: "execution";
} ? Gated<PlanReadPort<E>> : PlanReadPort<E>;
type PlanReadPort<E extends EndpointDecl> = E extends {
  readonly advisory: true;
} ? Pick<BoundRead<E>, "tryCall"> : E extends {
  readonly primaryRead: {
    notFound: "denied";
  };
} ? Pick<BoundRead<E>, "call" | "listAll" | "listAllEnveloped"> : E extends {
  readonly primaryRead: {
    notFound: "absent";
  };
} ? Pick<BoundRead<E>, "probeAbsent" | "tryCall"> : BoundRead<E>;
interface PlanContext<E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> {
  /** The target repository, parsed once at the boundary (see RepoRef). */
  readonly repo: RepoRef;
  readonly read: BoundReads<E, G>;
}
/**
 * `D` is the drift type its arm demands: an ordinary operation must justify itself with at least one
 * drift line (DriftFor), so "check reported clean while apply mutated" is unrepresentable.
 */
interface PlannedOpBase<D extends Justification = Justification> {
  /**
   * Check mode renders these; apply renders `change`.
   *   labels[bug]: color d73a4a != live ffffff; apply will update it
   */
  readonly drift: D;
  /**
   * A thunk when the line depends on what the server echoed (one line or several, never none); a throw
   * is the verification failure.
   */
  readonly change: string | ((response: unknown) => string | readonly [string, ...string[]]);
  /** The operation in settings-file terms ("arming the interaction limit"), for the failure prose; the `describe` the request helpers take. */
  readonly describe?: string;
  /**
   * For a server-assigned value (a created environment's node id) a later operation's thunk reads from
   * where the hook stores it. It must not render; a throw fails the operation.
   */
  readonly capture?: (response: unknown) => void;
  /**
   * Execution-time reads before the request is sealed and issued (bypass actors' node ids, pinned ahead
   * of the first write so a bad input fails while live state is untouched). A throw fails the operation
   * with its request never sent.
   */
  readonly before?: Late<void>;
}
/**
 * Occupies the drift slot, rendered as a check-mode note beside the drift lines the op does resolve;
 * admitted only on an endpoint declaring `unverifiable: true` (DriftFor).
 */
interface Unverifiable {
  readonly unverifiable: string;
  readonly lines: readonly string[];
}
type Justification = readonly string[] | Unverifiable;
/** The ONLY place a plan may touch a secret; async so it can read a value an earlier operation created. */
type Late<T> = (exec: ExecTools) => T | Promise<T>;
/**
 * A tolerated status means the operation did not apply: a note in place of its change line, or a
 * failure carrying the section's own advice where throwFor's generic text would mislead.
 */
type ToleratedOutcome = {
  readonly note: string;
  readonly failure?: never;
} | {
  readonly failure: string;
  readonly note?: never;
};
/** `statuses` defaults to the endpoint's tolerable set and may name only those, so an undeclared tolerance cannot compile. */
interface Tolerance<E extends EndpointDecl> {
  readonly statuses?: readonly [DeclaredErrorStatus<E>, ...DeclaredErrorStatus<E>[]];
  readonly outcome: (error: ApiError) => ToleratedOutcome;
}
/**
 * Empty drift is legal only on an alwaysRewrite write (it recurs by declaration) or inside an Unverifiable
 * facet; everywhere else "check reported clean while apply mutated" stays unrepresentable.
 */
type DriftFor<E extends EndpointDecl> = (E extends {
  readonly alwaysRewrite: true;
} ? readonly string[] : readonly [string, ...string[]]) | (E extends {
  readonly unverifiable: true;
} ? Unverifiable : never);
/** Required exactly when the route has path params beyond owner/repo (the OptsArg rule, per role). */
type RestParams<R extends string> = [PathParams<R>] extends [never] ? {
  readonly params?: undefined;
} : {
  readonly params: Readonly<Record<PathParams<R>, string>>;
};
type PlannedRestOp<E extends EndpointDict, R extends WriteRole<E>> = PlannedOpBase<DriftFor<E[R]>> & RestParams<E[R]["route"]> & {
  readonly role: R;
  readonly query?: Readonly<Record<string, string>>;
  readonly payload?: PlainData | Late<PlainData>;
  readonly tolerate?: Tolerance<E[R]>;
  readonly variables?: never;
};
/**
 * A planned GraphQL mutation under one specific role of a literal dictionary. Always
 * drift-bearing: alwaysRewrite is a REST endpoint declaration and no GraphQL mutation writes
 * a value it cannot read back, so none is unconditional by contract.
 */
type PlannedGraphqlOp<G extends GraphqlDict, R extends GraphqlWriteRole<G>> = PlannedOpBase<readonly [string, ...string[]]> & {
  readonly role: R;
  readonly variables: Readonly<GraphqlVariablesOf<G[R]>> | Late<Readonly<GraphqlVariablesOf<G[R]>>>;
  readonly params?: never;
  readonly query?: never;
  readonly payload?: never;
  /** Tolerance is by HTTP status, which a GraphQL rejection has none of. */
  readonly tolerate?: never;
};
/**
 * The view the engine executes; it resolves `role` against the section's declarations at runtime
 * (REST first, then GraphQL; ../registry.ts asserts the two role spaces are disjoint).
 */
interface ErasedPlannedOp extends PlannedOpBase {
  readonly role: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly payload?: PlainData | Late<PlainData>;
  readonly tolerate?: {
    readonly statuses?: readonly number[];
    readonly outcome: (error: ApiError) => ToleratedOutcome;
  };
  readonly variables?: Readonly<Record<string, unknown>> | Late<Readonly<Record<string, unknown>>>;
}
/**
 * Against a section's LITERAL dictionaries the type is exact: `role` must be a declared WRITE role, a REST
 * op's `params` carry exactly the route's path params, a GraphQL op's `variables` match its declaration.
 *
 *   wide default `G` (REST-only, or a forgotten `typeof GRAPHQL`)  -> the GraphQL arm collapses to never
 *   erased dictionaries (the engine's view)                         -> widens to ErasedPlannedOp
 */
type PlannedOp<E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> = string extends keyof E ? ErasedPlannedOp : { [R in WriteRole<E>]: PlannedRestOp<E, R>; }[WriteRole<E>] | (string extends keyof G ? never : { [R in GraphqlWriteRole<G>]: PlannedGraphqlOp<G, R>; }[GraphqlWriteRole<G>]);
/**
 * `ops` run in order in apply mode and render their drift in check mode; `notes` render in both modes.
 * `drift` holds the op-less lines, a finding no operation can fix (a declared workflow whose file does
 * not exist): check mode reports it as drift, apply surfaces it as notes, so it is never silent.
 */
interface SectionPlan<Op extends PlannedOpBase = ErasedPlannedOp> {
  ops: Op[];
  notes: string[];
  drift: string[];
}
//#endregion
//#region src/sections/shared/list-section.d.ts
/** A list section enumerates its live resources, so it is exactly a section with an undeclared policy. */
type ListSectionKey = UndeclaredPolicySection;
type Declared<K extends ListSectionKey> = Exclude<SettingsFile[K], undefined>;
type Entry<K extends ListSectionKey> = EntryOf<NonNullable<SettingsFile[K]>>;
type Paramless<R extends Route> = R extends Route ? [PathParams<R>] extends [never] ? R : never : never;
type UpdateDecl = EndpointDecl & {
  readonly route: Extract<Route, `PATCH ${string}` | `PUT ${string}`>;
};
type RemoveDecl = EndpointDecl & {
  readonly route: Extract<Route, `DELETE ${string}`>;
};
/**
 * `update` exists only when GitHub can edit the resource; without it a drifted item is deleted and
 * recreated. A type alias, so it keeps EndpointDict's index signature.
 */
type ListEndpoints = {
  readonly list: EndpointDecl & {
    readonly route: Paramless<Extract<Route, `GET ${string}`>>;
    readonly primaryRead: {
      readonly notFound: "denied";
    };
  };
  readonly create: EndpointDecl & {
    readonly route: Paramless<Extract<Route, `POST ${string}`>>;
  };
} & ({
  readonly remove: RemoveDecl;
} | {
  readonly update: UpdateDecl;
  readonly remove: RemoveDecl;
});
type ListRoleName = "list" | "create" | "update" | "remove";
type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends ((member: infer I) => void) ? I : never;
type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;
/**
 * Pins a dictionary to the factory's roles at the declaration. An intersection, so the index signature stays.
 *
 *   a union of dictionaries    -> refused (a union hides its members' roles from keyof)
 *   a fifth role               -> never
 *   `update` not PATCH or PUT  -> refused (a DELETE would pass the immutable arm's structural match)
 */
type OnlyListRoles<Ends> = (IsUnion<Ends> extends true ? never : unknown) & { readonly [R in Exclude<keyof Ends, ListRoleName>]: never; } & { readonly [R in keyof Ends & "update"]: UpdateDecl; };
type SameParams<A extends string, B extends string> = [PathParams<A>] extends [PathParams<B>] ? [PathParams<B>] extends [PathParams<A>] ? Readonly<Record<PathParams<A>, string>> : never : never;
/**
 * One address serves update and remove, so when both exist they must spell the SAME params; a dictionary
 * whose item routes disagree collapses to never.
 */
type Address<Ends extends ListEndpoints> = Ends extends {
  readonly update: {
    readonly route: infer U extends string;
  };
} ? SameParams<U, Ends["remove"]["route"]> : Readonly<Record<PathParams<Ends["remove"]["route"]>, string>>;
/** Declared fields only: an omitted optional stays OUT (never undefined), so it is neither written nor compared. */
type Write<F extends string> = { readonly [P in F]: string; } & {
  readonly [key: string]: PlainData;
};
/** A live item in the same terms, each field normalized as GitHub stores it. */
type Comparable<F extends string> = { readonly [P in F]: string; } & Readonly<Record<string, unknown>>;
type NoteWording = Pick<Parameters<typeof undeclaredNote>[0], "state" | "add" | "manage">;
type DriftWording = Pick<Parameters<typeof undeclaredDrift>[1], "state" | "add" | "keep">;
/** `unpaginated` also drives the derived mock's list handler (test/e2e/mock/list-fragment.ts). */
interface Listing {
  /** The query the list carries (milestones' state=all: the default listing omits closed items). */
  readonly query?: Readonly<Record<string, string>>;
  /** GitHub serves the whole list in one response and ignores page params (autolinks), so the page loop is skipped. */
  readonly unpaginated?: true;
}
interface ListSectionDecl<K extends ListSectionKey, Ends extends ListEndpoints, Live extends object, F extends string> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  /** The output noun for change lines and notes ("label"). */
  readonly noun: string;
  /** The entry config slice (src/sections/<key>/schema.ts); the loose shape derives from it. */
  readonly entry: z.ZodType<Entry<K>>;
  /** The fields of a live list item the section reads; extras ride along for the comparison. */
  readonly live: z.ZodType<Live>;
  readonly endpoints: Ends & OnlyListRoles<Ends>;
  readonly listing?: Listing;
  readonly identity: {
    /** The write field naming the resource, as the live item carries it ("name", "title"). */
    readonly field: F;
    /** Folds a name to its matching key; omitted when GitHub matches exactly. */
    readonly fold?: (name: string) => string;
    /**
     * Names an entry also answers to (a label's pre-rename `name`), so a live item under one is this
     * entry's, renamed by the update, not undeclared.
     */
    readonly aliases?: (entry: Entry<K>) => readonly string[];
    /**
     * The update body's key for the name when GitHub renames through another one (labels' `new_name`);
     * omitted, the name travels under `field`.
     *
     *   entry declares a value under it  -> it is renaming: that value is the name it writes (the lens puts it under `field`)
     *   the entry's `field`              -> its current name
     */
    readonly renameKey?: string;
  };
  /** The path params addressing one live item for update and remove; unrepresentable when the two routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;
  readonly lens: {
    /** The entry in wire terms: the create body, and what a converged live item reads back as. */
    readonly toWrite: (entry: Entry<K>) => Write<F>;
    /**
     * A live item in the same terms as toWrite, so the two compare field by field.
     *
     *   identity field          -> verbatim
     *   other declared fields   -> normalized as GitHub stores them (a color lowercased without "#", a null description as "")
     *   every other live field  -> kept, so declared passthrough keys compare against what the API echoed
     */
    readonly fromLive: (live: Live) => Comparable<F>;
    /** Per entry field holding a list, the item key to pair by (see DeltaOptions.matchBy); `{}` when none does. */
    readonly matchBy: Readonly<Partial<Record<keyof Entry<K> & string, string>>>;
  };
  /**
   * The body recreating a drifted item of a resource GitHub cannot edit (no update role), when the
   * write alone would drop a live field the file leaves undeclared (a deploy key's read_only).
   */
  readonly recreate?: "update" extends keyof Ends ? never : (live: Live, write: Write<F>) => Write<F>;
  /**
   * Conflicts the identities cannot show, one line each naming the fix; any line fails the section.
   *
   *   `declared`  -> sees only the entries and runs BEFORE the read (a settings-file mistake costs no request)
   *   `live`      -> runs after the read and before any write (a deploy key's material held by another key)
   */
  readonly conflicts?: {
    readonly declared?: (writes: readonly Write<F>[]) => readonly string[];
    readonly live?: (writes: readonly Write<F>[], live: readonly Comparable<F>[]) => readonly string[];
  };
  readonly prose: {
    /** What apply does to an undeclared live resource, as the note and drift spell it ("DELETE it"). */
    readonly undeclaredAction: string;
    readonly undeclaredNote?: NoteWording;
    readonly undeclaredDrift?: DriftWording;
  };
  /** The designated secret-field values of one entry, for the engine's up-front resolution. */
  readonly secretValues?: (entry: Entry<K>) => readonly DeclaredSecretValue[];
  /**
   * Omitted, the list always replaces. The pairing itself is derived from `identity`, the very claims the
   * planner's duplicate check reads, so the merge and the planner cannot disagree about which entries are one.
   */
  readonly layering?: Pick<KeyedListLayering, "combine">;
}
/** The module listSection() mints: SectionModule<K, Ends> at the registry, plus its declaration. */
interface ListSectionModule<K extends ListSectionKey, Ends extends ListEndpoints, Live extends object, F extends string> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  readonly endpoints: Ends;
  readonly shape: z.ZodType;
  readonly secretValues?: (declared: Declared<K>) => DeclaredSecretValue[];
  readonly layering?: KeyedListLayering;
  readonly plan: (ctx: PlanContext<Ends>, desired: Declared<K>) => Promise<SectionPlan<PlannedOp<Ends>>>;
  readonly snapshot: (ctx: PlanContext<Ends>) => Promise<SectionSnapshot<K>>;
  /** The declaration, for the harness derivations (the mock's transformers, the fuzz witness). */
  readonly decl: ListSectionDecl<K, Ends, Live, F>;
}
//#endregion
//#region src/sections/environments/endpoints.d.ts
declare const ENDPOINTS$1: {
  readonly probe: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}";
    readonly statuses: {
      readonly 200: "the environment";
      readonly 404: "no such environment yet";
    };
    readonly primaryRead: {
      readonly notFound: "absent";
    };
  };
  readonly update: {
    readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}";
    readonly statuses: {
      readonly 200: "environment created or updated";
    };
    readonly hints: {
      readonly 422: 'Usually "reviewers" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or "deployment_branch_policy" does not declare both boolean keys (or null to clear it)';
    };
  };
  readonly listVariables: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables";
    readonly statuses: {
      readonly 200: "the environment variable list";
    };
    readonly pageSize: 30;
  };
  readonly createVariable: {
    readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables";
    readonly statuses: {
      readonly 201: "environment variable created";
    };
  };
  readonly updateVariable: {
    readonly route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
    readonly statuses: {
      readonly 204: "environment variable updated";
    };
  };
  readonly removeVariable: {
    readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
    readonly statuses: {
      readonly 204: "environment variable deleted";
    };
  };
  readonly listSecrets: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets";
    readonly statuses: {
      readonly 200: "the environment secrets list (names and timestamps; never values)";
    };
  };
  readonly secretsPublicKey: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key";
    readonly statuses: {
      readonly 200: "the environment sealing public key";
    };
  };
  readonly putSecret: {
    readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
    readonly statuses: {
      readonly 201: "environment secret created";
      readonly 204: "environment secret updated";
    };
    readonly alwaysRewrite: true;
  };
  readonly removeSecret: {
    readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
    readonly statuses: {
      readonly 204: "environment secret deleted";
    };
  };
  readonly listPolicies: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
    readonly statuses: {
      readonly 200: "the deployment branch-policy pattern list";
    };
    readonly permission: {
      readonly repo: readonly ["actions"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
  };
  readonly createPolicy: {
    readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
    readonly statuses: {
      readonly 200: "deployment branch policy created";
      readonly 303: "a policy with this name pattern already exists";
    };
    readonly permission: {
      readonly repo: readonly ["administration"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
    readonly hints: {
      readonly 422: 'Usually the pattern\'s "type" is not one of the values GitHub accepts ("branch" or "tag"); see the deployment branch policies endpoint documentation';
    };
  };
  readonly removePolicy: {
    readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}";
    readonly statuses: {
      readonly 204: "deployment branch policy deleted";
    };
    readonly permission: {
      readonly repo: readonly ["administration"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
  };
  readonly listProtectionRules: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
    readonly statuses: {
      readonly 200: "the enabled custom deployment protection rules";
    };
    readonly permission: {
      readonly repo: readonly ["actions"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist";
  };
  readonly listProtectionRuleApps: {
    readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps";
    readonly statuses: {
      readonly 200: "the protection-rule Apps available to this environment";
    };
    readonly permission: {
      readonly repo: readonly ["administration"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist";
  };
  readonly createProtectionRule: {
    readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
    readonly statuses: {
      readonly 201: "custom deployment protection rule enabled";
    };
    readonly permission: {
      readonly repo: readonly ["administration"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist";
  };
  readonly removeProtectionRule: {
    readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}";
    readonly statuses: {
      readonly 204: "custom deployment protection rule disabled";
    };
    readonly permission: {
      readonly repo: readonly ["administration"];
    };
    readonly denialHint: "a 404 here can also mean the environment does not exist";
  };
};
//#endregion
//#region src/sections/environments/pins.d.ts
declare const GRAPHQL_OPS: {
  readonly pins: {
    readonly name: "EnvironmentPins";
    readonly kind: "read";
    readonly query: "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
    readonly connection: {
      readonly path: readonly ["repository", "pinnedEnvironments"];
    };
    readonly outcomes: {
      readonly ok: "the pinned environments with their 1-based positions";
      readonly NOT_FOUND: "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)";
    };
  } & {
    readonly _variables?: {
      owner: string;
      repo: string;
    } | undefined;
  };
  readonly pin: {
    readonly name: "PinEnvironment";
    readonly kind: "write";
    readonly query: "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }";
    readonly outcomes: {
      readonly ok: "the environment was pinned or unpinned";
      readonly UNPROCESSABLE: string;
    };
  } & {
    readonly _variables?: {
      environmentId: string;
      pinned: boolean;
    } | undefined;
  };
  readonly reorder: {
    readonly name: "ReorderEnvironment";
    readonly kind: "write";
    readonly query: "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }";
    readonly outcomes: {
      readonly ok: "the pinned environment moved to its declared position";
    };
  } & {
    readonly _variables?: {
      environmentId: string;
      position: number;
    } | undefined;
  };
};
type EnvironmentsOp = PlannedOp<typeof ENDPOINTS$1, typeof GRAPHQL_OPS>;
type EnvironmentsPlan = SectionPlan<EnvironmentsOp>;
//#endregion
//#region src/sections/branches/endpoints.d.ts
declare const ENDPOINTS: {
  readonly getProtection: {
    readonly route: "GET /repos/{owner}/{repo}/branches/{branch}/protection";
    readonly statuses: {
      readonly 200: "the branch protection";
      readonly 404: "the branch is unprotected or does not exist";
    };
    readonly primaryRead: {
      readonly notFound: "absent";
    };
  };
  readonly putProtection: {
    readonly route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection";
    readonly statuses: {
      readonly 200: "protection replaced";
    };
    readonly rejections: readonly [DefinitiveRejection];
    readonly hints: {
      readonly 422: string;
    };
  };
  readonly removeProtection: {
    readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection";
    readonly statuses: {
      readonly 204: "protection removed";
    };
  };
  readonly sigPost: {
    readonly route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
    readonly statuses: {
      readonly 200: "signed commits now required";
    };
  };
  readonly sigDelete: {
    readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
    readonly statuses: {
      readonly 204: "signed-commit requirement removed";
    };
  };
  readonly branchProbe: {
    readonly route: "GET /repos/{owner}/{repo}/branches/{branch}";
    readonly statuses: {
      readonly 200: "the branch exists";
      readonly 404: "no such branch";
    };
    readonly permission: {
      readonly repo: readonly ["contents"];
    };
    readonly advisory: true;
  };
  readonly appLookup: {
    readonly route: "GET /apps/{app_slug}";
    readonly statuses: {
      readonly 200: "the GitHub App";
      readonly 404: "no App with this slug";
    };
    readonly permission: "none";
    readonly phase: "execution";
  };
};
//#endregion
//#region src/sections/branches/graphql-rules.d.ts
declare const GRAPHQL: {
  readonly rulesQuery: {
    readonly name: "BranchProtectionRules";
    readonly kind: "read";
    readonly connection: {
      readonly path: readonly ["repository", "branchProtectionRules"];
    };
    readonly outcomes: {
      readonly ok: "the repository's classic branch protection rules";
      readonly NOT_FOUND: "the repository is not visible to the token; read as no rules";
    };
    readonly query: "query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
  } & {
    readonly _variables?: {
      owner: string;
      repo: string;
    } | undefined;
  };
  readonly repoLookup: {
    readonly name: "BranchProtectionRepository";
    readonly kind: "read";
    readonly phase: "execution";
    readonly outcomes: {
      readonly ok: "the repository's GraphQL node id";
    };
    readonly query: "query BranchProtectionRepository($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) { id }\n}";
  } & {
    readonly _variables?: {
      owner: string;
      repo: string;
    } | undefined;
  };
  readonly actorUser: {
    readonly name: "BranchProtectionActorUser";
    readonly kind: "read";
    readonly phase: "execution";
    readonly outcomes: {
      readonly ok: "the user's node id";
      readonly NOT_FOUND: "no user with this login, or the token cannot see it";
    };
    readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file";
    readonly query: "query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  user(login: $login) { id }\n}";
  } & {
    readonly _variables?: {
      owner: string;
      repo: string;
      login: string;
    } | undefined;
  };
  readonly actorTeam: {
    readonly name: "BranchProtectionActorTeam";
    readonly kind: "read";
    readonly phase: "execution";
    readonly outcomes: {
      readonly ok: "the team's node id";
      readonly NOT_FOUND: "no organization with this login, or the token cannot see it";
    };
    readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file";
    readonly query: "query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  organization(login: $org) { team(slug: $team) { id } }\n}";
  } & {
    readonly _variables?: {
      owner: string;
      repo: string;
      org: string;
      team: string;
    } | undefined;
  };
  readonly createRule: {
    readonly name: "CreateBranchProtectionRule";
    readonly kind: "write";
    readonly outcomes: {
      readonly ok: "rule created";
      readonly UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)";
    };
    readonly query: "mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {\n  createBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
  } & {
    readonly _variables?: {
      input: Record<string, unknown>;
    } | undefined;
  };
  readonly updateRule: {
    readonly name: "UpdateBranchProtectionRule";
    readonly kind: "write";
    readonly outcomes: {
      readonly ok: "rule updated";
      readonly NOT_FOUND: "no rule with this node id";
      readonly UNPROCESSABLE: "GitHub rejected the update";
    };
    readonly query: "mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {\n  updateBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
  } & {
    readonly _variables?: {
      input: Record<string, unknown>;
    } | undefined;
  };
  readonly deleteRule: {
    readonly name: "DeleteBranchProtectionRule";
    readonly kind: "write";
    readonly outcomes: {
      readonly ok: "rule deleted";
      readonly NOT_FOUND: "no rule with this node id";
    };
    readonly query: "mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {\n  deleteBranchProtectionRule(input: $input) { clientMutationId }\n}";
  } & {
    readonly _variables?: {
      input: Record<string, unknown>;
    } | undefined;
  };
};
type BranchesPlan = SectionPlan<PlannedOp<typeof ENDPOINTS, typeof GRAPHQL>>;
//#endregion
//#region src/sections/shared/secrets-engine.d.ts
interface SecretEntry {
  name: string;
  value: string;
}
/**
 * Each value is labelled with its entry's secret NAME so a validation error can point at it. DEFENSIVE by
 * contract: a malformed container returns [] instead of throwing, so the actionable error always comes
 * from shape validation, never a TypeError here.
 */
declare function listSecretValues(declared: unknown): DeclaredSecretValue[];
//#endregion
//#region src/sections/shared/repo-secrets.d.ts
type RepoSecretsKey = "actions_secrets" | "dependabot_secrets" | "codespaces_secrets" | "agents_secrets";
/**
 * The factory derives the routes from THIS map, so a key paired with another family's segment (which the
 * mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE to the
 * segment its own KEY spells, so a fifth family breaking the `<segment>_secrets` naming must say so here.
 */
declare const SECRETS_SEGMENTS: {
  readonly actions_secrets: "actions";
  readonly dependabot_secrets: "dependabot";
  readonly codespaces_secrets: "codespaces";
  readonly agents_secrets: "agents";
};
type SecretsSegment<K extends RepoSecretsKey = RepoSecretsKey> = (typeof SECRETS_SEGMENTS)[K];
/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare. A type alias, not an interface,
 * so it keeps the implicit index signature EndpointDict expects.
 */
type RepoSecretsEndpoints<P extends SecretsSegment> = {
  readonly list: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/secrets`;
    readonly statuses: {
      readonly 200: string;
    };
    readonly accessGrade?: "write";
    readonly primaryRead: {
      readonly notFound: "denied";
    };
  };
  readonly publicKey: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/secrets/public-key`;
    readonly statuses: {
      readonly 200: string;
    };
    readonly accessGrade?: "write";
  };
  readonly put: {
    readonly route: `PUT /repos/{owner}/{repo}/${P}/secrets/{secret_name}`;
    readonly statuses: {
      readonly 201: string;
      readonly 204: string;
    };
    readonly alwaysRewrite: true;
  };
  readonly remove: {
    readonly route: `DELETE /repos/{owner}/{repo}/${P}/secrets/{secret_name}`;
    readonly statuses: {
      readonly 204: string;
    };
  };
};
type RepoSecretsDeclared<K extends RepoSecretsKey> = Exclude<SettingsFile[K], undefined>;
/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoSecretsPlan<K extends RepoSecretsKey> = { [F in RepoSecretsKey]: (ctx: PlanContext<RepoSecretsEndpoints<SecretsSegment<F>>>, declared: RepoSecretsDeclared<F>) => Promise<SectionPlan<PlannedOp<RepoSecretsEndpoints<SecretsSegment<F>>>>>; }[K];
/**
 * Checked HERE as a fresh object literal, once per family key: the factory hands ../registry.ts a module
 * IDENTIFIER, where excess-property checking no longer runs, so a `known` key no entry type carries any
 * more would otherwise compile silently. The intersection admits a key present in ANY constituent, but a
 * key only one family dropped breaks SecretEntry and the shared plan signature first.
 */
declare const CLOSED_SURFACE: {
  known: {
    name: true;
    value: true;
  };
  describe: (entry: SecretEntry) => string;
  consequence: string;
};
/** The module shape repoSecretsSection() mints (SectionModule<K> at the registry). */
interface RepoSecretsSectionModule<K extends RepoSecretsKey> {
  readonly key: K;
  readonly undeclaredDefault: "keep";
  readonly permission: {
    readonly repo: readonly [PatResource];
  };
  readonly endpoints: RepoSecretsEndpoints<SecretsSegment<K>>;
  readonly shape: z.ZodType;
  readonly secretValues: typeof listSecretValues;
  readonly closedSurface: typeof CLOSED_SURFACE;
  readonly plan: RepoSecretsPlan<K>;
  readonly snapshot: (ctx: PlanContext<RepoSecretsEndpoints<SecretsSegment<K>>>) => Promise<SectionSnapshot<K>>;
}
//#endregion
//#region src/sections/shared/setup-section.d.ts
type SetupKey = "code_scanning_default_setup" | "code_quality_setup";
/** The factory derives routes, shape, and grade from THIS map, so a key paired with another setup's facts is unrepresentable. */
declare const SETUPS: {
  readonly code_scanning_default_setup: {
    readonly path: "code-scanning/default-setup";
    readonly slice: z.ZodObject<{
      state: z.ZodOptional<z.ZodEnum<{
        configured: "configured";
        "not-configured": "not-configured";
      }>>;
      query_suite: z.ZodOptional<z.ZodEnum<{
        default: "default";
        extended: "extended";
      }>>;
      languages: z.ZodOptional<z.ZodArray<z.ZodString>>;
      runner_type: z.ZodOptional<z.ZodEnum<{
        labeled: "labeled";
        standard: "standard";
      }>>;
      runner_label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      threat_model: z.ZodOptional<z.ZodEnum<{
        remote: "remote";
        remote_and_local: "remote_and_local";
      }>>;
    }, z.core.$strip>;
    readonly read: {};
  };
  readonly code_quality_setup: {
    readonly path: "code-quality/setup";
    readonly slice: z.ZodObject<{
      state: z.ZodOptional<z.ZodEnum<{
        configured: "configured";
        "not-configured": "not-configured";
      }>>;
      languages: z.ZodOptional<z.ZodArray<z.ZodString>>;
      runner_type: z.ZodOptional<z.ZodEnum<{
        labeled: "labeled";
        standard: "standard";
      }>>;
      runner_label: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      ai_findings_option: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        on_push: "on_push";
      }>>;
    }, z.core.$strip>;
    readonly read: {
      readonly accessGrade: "write";
    };
  };
};
type Setup<K extends SetupKey = SetupKey> = (typeof SETUPS)[K];
/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare.
 */
type SetupEndpoints<K extends SetupKey> = {
  readonly get: {
    readonly route: `GET /repos/{owner}/{repo}/${Setup<K>["path"]}`;
    readonly statuses: {
      readonly 200: string;
    };
    readonly primaryRead: {
      readonly notFound: "denied";
    };
    readonly accessGrade?: "write";
  };
  readonly update: {
    readonly route: `PATCH /repos/{owner}/{repo}/${Setup<K>["path"]}`;
    readonly statuses: {
      readonly 200: string;
      readonly 202: string;
      readonly 409: string;
    };
  };
};
type SetupDeclared<K extends SetupKey> = Exclude<SettingsFile[K], undefined>;
/**
 * One setup's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the factory's one
 * SharedPlan can be assigned to it.
 */
type SetupPlan<K extends SetupKey> = { [F in SetupKey]: (ctx: PlanContext<SetupEndpoints<F>>, declared: SetupDeclared<F>) => Promise<SectionPlan<PlannedOp<SetupEndpoints<F>>>>; }[K];
/** The module shape setupSection() mints (SectionModule<K> at the registry). */
interface SetupSectionModule<K extends SetupKey> {
  readonly key: K;
  readonly undeclaredDefault: "untouched";
  readonly permission: SectionPermission;
  readonly grantCaveat: string;
  readonly endpoints: SetupEndpoints<K>;
  readonly shape: z.ZodType;
  readonly plan: SetupPlan<K>;
  readonly snapshot: (ctx: PlanContext<SetupEndpoints<K>>) => Promise<SectionSnapshot<K>>;
}
//#endregion
//#region src/sections/shared/repo-variables.d.ts
type RepoVariablesKey = "actions_variables" | "agents_variables";
/**
 * The factory derives the routes from THIS map, so a key paired with the other family's segment (which
 * the mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE
 * to the segment its own KEY spells.
 */
declare const VARIABLES_SEGMENTS: {
  readonly actions_variables: "actions";
  readonly agents_variables: "agents";
};
type VariablesSegment<K extends RepoVariablesKey = RepoVariablesKey> = (typeof VARIABLES_SEGMENTS)[K];
/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare. A type alias, not an interface,
 * so it keeps the implicit index signature EndpointDict expects.
 */
type RepoVariablesEndpoints<P extends VariablesSegment> = {
  readonly list: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: {
      readonly 200: string;
    };
    readonly pageSize: number;
    readonly primaryRead: {
      readonly notFound: "denied";
    };
  };
  readonly create: {
    readonly route: `POST /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: {
      readonly 201: string;
    };
  };
  readonly update: {
    readonly route: `PATCH /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: {
      readonly 204: string;
    };
  };
  readonly remove: {
    readonly route: `DELETE /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: {
      readonly 204: string;
    };
  };
};
type RepoVariablesDeclared<K extends RepoVariablesKey> = Exclude<SettingsFile[K], undefined>;
/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoVariablesPlan<K extends RepoVariablesKey> = { [F in RepoVariablesKey]: (ctx: PlanContext<RepoVariablesEndpoints<VariablesSegment<F>>>, declared: RepoVariablesDeclared<F>) => Promise<SectionPlan<PlannedOp<RepoVariablesEndpoints<VariablesSegment<F>>>>>; }[K];
/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: {
    readonly repo: readonly [PatResource];
  };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  readonly plan: RepoVariablesPlan<K>;
  readonly snapshot: (ctx: PlanContext<RepoVariablesEndpoints<VariablesSegment<K>>>) => Promise<SectionSnapshot<K>>;
}
//#endregion
//#region src/sections/registry.d.ts
declare const byKey: {
  repository: {
    key: "repository";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    endpoints: {
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "the repository";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "repository fields patched";
        };
      };
      readonly topics: {
        readonly route: "PUT /repos/{owner}/{repo}/topics";
        readonly statuses: {
          readonly 200: "topics replaced";
        };
      };
      readonly vulnerabilityAlertsGet: {
        readonly route: "GET /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts are enabled";
          readonly 404: "vulnerability alerts are disabled";
        };
      };
      readonly vulnerabilityAlertsPut: {
        readonly route: "PUT /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts enabled";
        };
      };
      readonly vulnerabilityAlertsRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts disabled";
        };
      };
      readonly automatedSecurityFixesGet: {
        readonly route: "GET /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 200: "the automated security fixes state";
          readonly 404: "the feature is not enabled";
        };
      };
      readonly automatedSecurityFixesPut: {
        readonly route: "PUT /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes enabled";
        };
      };
      readonly automatedSecurityFixesRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes disabled";
        };
      };
      readonly privateVulnerabilityReportingGet: {
        readonly route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 200: "the private vulnerability reporting state readable from the body";
          readonly 404: "the feature is not applicable on this repository (observed: private repos); read as not enabled";
          readonly 422: "the same condition as 404, alternate answer";
        };
      };
      readonly privateVulnerabilityReportingPut: {
        readonly route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting enabled";
        };
      };
      readonly privateVulnerabilityReportingRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting disabled";
          readonly 404: "the feature is not applicable, so it is already off";
          readonly 422: "the feature is not applicable, so it is already off";
        };
      };
      readonly immutableReleasesGet: {
        readonly route: "GET /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 200: "the immutable releases state readable from the body";
          readonly 404: "immutable releases are not enabled";
        };
      };
      readonly immutableReleasesPut: {
        readonly route: "PUT /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases enabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      };
      readonly immutableReleasesRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases disabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      };
      readonly lfsPut: {
        readonly route: "PUT /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 202: "Git LFS enabled (GitHub processes the change asynchronously)";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      };
      readonly lfsRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 204: "Git LFS disabled";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      };
    };
    graphql: {
      readonly featuresQuery: {
        readonly name: "RepositoryFeatures";
        readonly kind: "read";
        readonly query: "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }";
        readonly outcomes: {
          readonly ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses";
        };
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly updateFeatures: {
        readonly name: "UpdateRepositoryFeatures";
        readonly kind: "write";
        readonly query: "mutation UpdateRepositoryFeatures(\n    $repositoryId: ID!\n    $hasSponsorshipsEnabled: Boolean\n    $issueCreationPolicy: IssueCreationPolicy\n  ) {\n    updateRepository(\n      input: {\n        repositoryId: $repositoryId\n        hasSponsorshipsEnabled: $hasSponsorshipsEnabled\n        issueCreationPolicy: $issueCreationPolicy\n      }\n    ) {\n      repository { hasSponsorshipsEnabled issueCreationPolicy }\n    }\n  }";
        readonly outcomes: {
          readonly ok: "the carried values set; the echoed state verifies each one took";
        };
      } & {
        readonly _variables?: {
          repositoryId: string;
          hasSponsorshipsEnabled?: boolean;
          issueCreationPolicy?: ({
            readonly all: "ALL";
            readonly collaborators_only: "COLLABORATORS_ONLY";
          })["all" | "collaborators_only"];
        } | undefined;
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "the repository";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "repository fields patched";
        };
      };
      readonly topics: {
        readonly route: "PUT /repos/{owner}/{repo}/topics";
        readonly statuses: {
          readonly 200: "topics replaced";
        };
      };
      readonly vulnerabilityAlertsGet: {
        readonly route: "GET /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts are enabled";
          readonly 404: "vulnerability alerts are disabled";
        };
      };
      readonly vulnerabilityAlertsPut: {
        readonly route: "PUT /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts enabled";
        };
      };
      readonly vulnerabilityAlertsRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts disabled";
        };
      };
      readonly automatedSecurityFixesGet: {
        readonly route: "GET /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 200: "the automated security fixes state";
          readonly 404: "the feature is not enabled";
        };
      };
      readonly automatedSecurityFixesPut: {
        readonly route: "PUT /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes enabled";
        };
      };
      readonly automatedSecurityFixesRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes disabled";
        };
      };
      readonly privateVulnerabilityReportingGet: {
        readonly route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 200: "the private vulnerability reporting state readable from the body";
          readonly 404: "the feature is not applicable on this repository (observed: private repos); read as not enabled";
          readonly 422: "the same condition as 404, alternate answer";
        };
      };
      readonly privateVulnerabilityReportingPut: {
        readonly route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting enabled";
        };
      };
      readonly privateVulnerabilityReportingRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting disabled";
          readonly 404: "the feature is not applicable, so it is already off";
          readonly 422: "the feature is not applicable, so it is already off";
        };
      };
      readonly immutableReleasesGet: {
        readonly route: "GET /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 200: "the immutable releases state readable from the body";
          readonly 404: "immutable releases are not enabled";
        };
      };
      readonly immutableReleasesPut: {
        readonly route: "PUT /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases enabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      };
      readonly immutableReleasesRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases disabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      };
      readonly lfsPut: {
        readonly route: "PUT /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 202: "Git LFS enabled (GitHub processes the change asynchronously)";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      };
      readonly lfsRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 204: "Git LFS disabled";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      };
    }, {
      readonly featuresQuery: {
        readonly name: "RepositoryFeatures";
        readonly kind: "read";
        readonly query: "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }";
        readonly outcomes: {
          readonly ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses";
        };
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly updateFeatures: {
        readonly name: "UpdateRepositoryFeatures";
        readonly kind: "write";
        readonly query: "mutation UpdateRepositoryFeatures(\n    $repositoryId: ID!\n    $hasSponsorshipsEnabled: Boolean\n    $issueCreationPolicy: IssueCreationPolicy\n  ) {\n    updateRepository(\n      input: {\n        repositoryId: $repositoryId\n        hasSponsorshipsEnabled: $hasSponsorshipsEnabled\n        issueCreationPolicy: $issueCreationPolicy\n      }\n    ) {\n      repository { hasSponsorshipsEnabled issueCreationPolicy }\n    }\n  }";
        readonly outcomes: {
          readonly ok: "the carried values set; the echoed state verifies each one took";
        };
      } & {
        readonly _variables?: {
          repositoryId: string;
          hasSponsorshipsEnabled?: boolean;
          issueCreationPolicy?: ({
            readonly all: "ALL";
            readonly collaborators_only: "COLLABORATORS_ONLY";
          })["all" | "collaborators_only"];
        } | undefined;
      };
    }>, declared: {
      [x: string]: unknown;
      topics?: string | string[] | undefined;
      enable_vulnerability_alerts?: boolean | undefined;
      enable_automated_security_fixes?: boolean | undefined;
      enable_private_vulnerability_reporting?: boolean | undefined;
      enable_git_lfs?: boolean | undefined;
      enable_immutable_releases?: boolean | undefined;
      enable_sponsorships?: boolean | undefined;
      issue_creation_policy?: "all" | "collaborators_only" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly role: "updateFeatures";
      readonly variables: Late<Readonly<{
        repositoryId: string;
        hasSponsorshipsEnabled?: boolean;
        issueCreationPolicy?: ({
          readonly all: "ALL";
          readonly collaborators_only: "COLLABORATORS_ONLY";
        })["all" | "collaborators_only"];
      }>> | Readonly<{
        repositoryId: string;
        hasSponsorshipsEnabled?: boolean;
        issueCreationPolicy?: ({
          readonly all: "ALL";
          readonly collaborators_only: "COLLABORATORS_ONLY";
        })["all" | "collaborators_only"];
      }>;
      readonly params?: never;
      readonly query?: never;
      readonly payload?: never;
      readonly tolerate?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "automatedSecurityFixesPut";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes enabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "automatedSecurityFixesRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/automated-security-fixes";
        readonly statuses: {
          readonly 204: "automated security fixes disabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "immutableReleasesPut";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases enabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "immutableReleasesRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/immutable-releases";
        readonly statuses: {
          readonly 204: "immutable releases disabled";
          readonly 409: "the repository owner enforces immutable releases";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly string[]> & {
      readonly params?: undefined;
    } & {
      readonly role: "lfsPut";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 202: "Git LFS enabled (GitHub processes the change asynchronously)";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly string[]> & {
      readonly params?: undefined;
    } & {
      readonly role: "lfsRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/lfs";
        readonly statuses: {
          readonly 204: "Git LFS disabled";
        };
        readonly denialHint: string;
        readonly alwaysRewrite: true;
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "privateVulnerabilityReportingPut";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting enabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "privateVulnerabilityReportingRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting";
        readonly statuses: {
          readonly 204: "private vulnerability reporting disabled";
          readonly 404: "the feature is not applicable, so it is already off";
          readonly 422: "the feature is not applicable, so it is already off";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "topics";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/topics";
        readonly statuses: {
          readonly 200: "topics replaced";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "repository fields patched";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "vulnerabilityAlertsPut";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts enabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "vulnerabilityAlertsRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts";
        readonly statuses: {
          readonly 204: "vulnerability alerts disabled";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
  };
  labels: ListSectionModule<"labels", {
    readonly list: {
      readonly route: "GET /repos/{owner}/{repo}/labels";
      readonly statuses: {
        readonly 200: "the label list";
      };
      readonly primaryRead: {
        readonly notFound: "denied";
      };
    };
    readonly create: {
      readonly route: "POST /repos/{owner}/{repo}/labels";
      readonly statuses: {
        readonly 201: "label created";
      };
    };
    readonly update: {
      readonly route: "PATCH /repos/{owner}/{repo}/labels/{name}";
      readonly statuses: {
        readonly 200: "label updated";
      };
    };
    readonly remove: {
      readonly route: "DELETE /repos/{owner}/{repo}/labels/{name}";
      readonly statuses: {
        readonly 204: "label deleted";
      };
    };
  }, {
    [x: string]: unknown;
    name: string;
    color: string;
    description: string | null;
  }, "name">;
  rulesets: {
    key: "rulesets";
    undeclaredDefault: "keep";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/rulesets";
        readonly statuses: {
          readonly 200: "the repository ruleset list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/rulesets";
        readonly statuses: {
          readonly 201: "ruleset created";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      };
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 200: "the ruleset";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 200: "ruleset updated";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 204: "ruleset deleted";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    layering: {
      keys: (entry: Readonly<Record<string, unknown>>) => string[] | null;
      keyField: string;
      combine: "merge";
      nested: {
        rules: {
          keys: (rule: Readonly<Record<string, unknown>>) => string[] | null;
          keyField: string;
          combine: "replace";
        };
      };
    };
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/rulesets";
        readonly statuses: {
          readonly 200: "the repository ruleset list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/rulesets";
        readonly statuses: {
          readonly 201: "ruleset created";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      };
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 200: "the ruleset";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 200: "ruleset updated";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 204: "ruleset deleted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      name: string;
      target?: "branch" | "push" | "tag" | undefined;
      enforcement?: string | undefined;
      conditions?: {
        ref_name?: {
          include?: string[] | undefined;
          exclude?: string[] | undefined;
        } | undefined;
      } | undefined;
      rules?: {
        type: string;
        parameters?: Record<string, unknown> | undefined;
      }[] | undefined;
      bypass_actors?: Record<string, unknown>[] | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name: string;
        target?: "branch" | "push" | "tag" | undefined;
        enforcement?: string | undefined;
        conditions?: {
          ref_name?: {
            include?: string[] | undefined;
            exclude?: string[] | undefined;
          } | undefined;
        } | undefined;
        rules?: {
          type: string;
          parameters?: Record<string, unknown> | undefined;
        }[] | undefined;
        bypass_actors?: Record<string, unknown>[] | undefined;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "create";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "POST /repos/{owner}/{repo}/rulesets";
        readonly statuses: {
          readonly 201: "ruleset created";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"ruleset_id", string>>;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 204: "ruleset deleted";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"ruleset_id", string>>;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}";
        readonly statuses: {
          readonly 200: "ruleset updated";
        };
        readonly hints: {
          readonly 422: "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
  };
  environments: {
    key: "environments";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    grantCaveat: string;
    endpoints: {
      readonly probe: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}";
        readonly statuses: {
          readonly 200: "the environment";
          readonly 404: "no such environment yet";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}";
        readonly statuses: {
          readonly 200: "environment created or updated";
        };
        readonly hints: {
          readonly 422: 'Usually "reviewers" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or "deployment_branch_policy" does not declare both boolean keys (or null to clear it)';
        };
      };
      readonly listVariables: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables";
        readonly statuses: {
          readonly 200: "the environment variable list";
        };
        readonly pageSize: 30;
      };
      readonly createVariable: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables";
        readonly statuses: {
          readonly 201: "environment variable created";
        };
      };
      readonly updateVariable: {
        readonly route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
        readonly statuses: {
          readonly 204: "environment variable updated";
        };
      };
      readonly removeVariable: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
        readonly statuses: {
          readonly 204: "environment variable deleted";
        };
      };
      readonly listSecrets: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets";
        readonly statuses: {
          readonly 200: "the environment secrets list (names and timestamps; never values)";
        };
      };
      readonly secretsPublicKey: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key";
        readonly statuses: {
          readonly 200: "the environment sealing public key";
        };
      };
      readonly putSecret: {
        readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
        readonly statuses: {
          readonly 201: "environment secret created";
          readonly 204: "environment secret updated";
        };
        readonly alwaysRewrite: true;
      };
      readonly removeSecret: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
        readonly statuses: {
          readonly 204: "environment secret deleted";
        };
      };
      readonly listPolicies: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
        readonly statuses: {
          readonly 200: "the deployment branch-policy pattern list";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
      };
      readonly createPolicy: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
        readonly statuses: {
          readonly 200: "deployment branch policy created";
          readonly 303: "a policy with this name pattern already exists";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
        readonly hints: {
          readonly 422: 'Usually the pattern\'s "type" is not one of the values GitHub accepts ("branch" or "tag"); see the deployment branch policies endpoint documentation';
        };
      };
      readonly removePolicy: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}";
        readonly statuses: {
          readonly 204: "deployment branch policy deleted";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
      };
      readonly listProtectionRules: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
        readonly statuses: {
          readonly 200: "the enabled custom deployment protection rules";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly listProtectionRuleApps: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps";
        readonly statuses: {
          readonly 200: "the protection-rule Apps available to this environment";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly createProtectionRule: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
        readonly statuses: {
          readonly 201: "custom deployment protection rule enabled";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly removeProtectionRule: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}";
        readonly statuses: {
          readonly 204: "custom deployment protection rule disabled";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
    };
    graphql: {
      readonly pins: {
        readonly name: "EnvironmentPins";
        readonly kind: "read";
        readonly query: "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
        readonly connection: {
          readonly path: readonly ["repository", "pinnedEnvironments"];
        };
        readonly outcomes: {
          readonly ok: "the pinned environments with their 1-based positions";
          readonly NOT_FOUND: "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)";
        };
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly pin: {
        readonly name: "PinEnvironment";
        readonly kind: "write";
        readonly query: "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }";
        readonly outcomes: {
          readonly ok: "the environment was pinned or unpinned";
          readonly UNPROCESSABLE: string;
        };
      } & {
        readonly _variables?: {
          environmentId: string;
          pinned: boolean;
        } | undefined;
      };
      readonly reorder: {
        readonly name: "ReorderEnvironment";
        readonly kind: "write";
        readonly query: "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }";
        readonly outcomes: {
          readonly ok: "the pinned environment moved to its declared position";
        };
      } & {
        readonly _variables?: {
          environmentId: string;
          position: number;
        } | undefined;
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    secretValues(declared: unknown): DeclaredSecretValue[];
    plan(ctx: PlanContext<{
      readonly probe: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}";
        readonly statuses: {
          readonly 200: "the environment";
          readonly 404: "no such environment yet";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}";
        readonly statuses: {
          readonly 200: "environment created or updated";
        };
        readonly hints: {
          readonly 422: 'Usually "reviewers" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or "deployment_branch_policy" does not declare both boolean keys (or null to clear it)';
        };
      };
      readonly listVariables: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables";
        readonly statuses: {
          readonly 200: "the environment variable list";
        };
        readonly pageSize: 30;
      };
      readonly createVariable: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables";
        readonly statuses: {
          readonly 201: "environment variable created";
        };
      };
      readonly updateVariable: {
        readonly route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
        readonly statuses: {
          readonly 204: "environment variable updated";
        };
      };
      readonly removeVariable: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}";
        readonly statuses: {
          readonly 204: "environment variable deleted";
        };
      };
      readonly listSecrets: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets";
        readonly statuses: {
          readonly 200: "the environment secrets list (names and timestamps; never values)";
        };
      };
      readonly secretsPublicKey: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key";
        readonly statuses: {
          readonly 200: "the environment sealing public key";
        };
      };
      readonly putSecret: {
        readonly route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
        readonly statuses: {
          readonly 201: "environment secret created";
          readonly 204: "environment secret updated";
        };
        readonly alwaysRewrite: true;
      };
      readonly removeSecret: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}";
        readonly statuses: {
          readonly 204: "environment secret deleted";
        };
      };
      readonly listPolicies: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
        readonly statuses: {
          readonly 200: "the deployment branch-policy pattern list";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
      };
      readonly createPolicy: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies";
        readonly statuses: {
          readonly 200: "deployment branch policy created";
          readonly 303: "a policy with this name pattern already exists";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
        readonly hints: {
          readonly 422: 'Usually the pattern\'s "type" is not one of the values GitHub accepts ("branch" or "tag"); see the deployment branch policies endpoint documentation';
        };
      };
      readonly removePolicy: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}";
        readonly statuses: {
          readonly 204: "deployment branch policy deleted";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
      };
      readonly listProtectionRules: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
        readonly statuses: {
          readonly 200: "the enabled custom deployment protection rules";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly listProtectionRuleApps: {
        readonly route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps";
        readonly statuses: {
          readonly 200: "the protection-rule Apps available to this environment";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly createProtectionRule: {
        readonly route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules";
        readonly statuses: {
          readonly 201: "custom deployment protection rule enabled";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
      readonly removeProtectionRule: {
        readonly route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}";
        readonly statuses: {
          readonly 204: "custom deployment protection rule disabled";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly denialHint: "a 404 here can also mean the environment does not exist";
      };
    }, {
      readonly pins: {
        readonly name: "EnvironmentPins";
        readonly kind: "read";
        readonly query: "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
        readonly connection: {
          readonly path: readonly ["repository", "pinnedEnvironments"];
        };
        readonly outcomes: {
          readonly ok: "the pinned environments with their 1-based positions";
          readonly NOT_FOUND: "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)";
        };
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly pin: {
        readonly name: "PinEnvironment";
        readonly kind: "write";
        readonly query: "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }";
        readonly outcomes: {
          readonly ok: "the environment was pinned or unpinned";
          readonly UNPROCESSABLE: string;
        };
      } & {
        readonly _variables?: {
          environmentId: string;
          pinned: boolean;
        } | undefined;
      };
      readonly reorder: {
        readonly name: "ReorderEnvironment";
        readonly kind: "write";
        readonly query: "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }";
        readonly outcomes: {
          readonly ok: "the pinned environment moved to its declared position";
        };
      } & {
        readonly _variables?: {
          environmentId: string;
          position: number;
        } | undefined;
      };
    }>, desired: {
      name: string;
      pinned?: boolean | undefined;
      wait_timer?: number | undefined;
      prevent_self_review?: boolean | undefined;
      reviewers?: {
        type: "Team" | "User";
        id: number;
      }[] | undefined;
      deployment_branch_policy?: {
        protected_branches: boolean;
        custom_branch_policies: boolean;
      } | null | undefined;
      deployment_branch_policies?: {
        name: string;
        type?: string | undefined;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          name: string;
          type?: string | undefined;
        }[];
      } | undefined;
      deployment_protection_rules?: {
        app: string;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          app: string;
        }[];
      } | undefined;
      variables?: {
        name: string;
        value: string;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          name: string;
          value: string;
        }[];
      } | undefined;
      secrets?: {
        name: string;
        value: string;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          name: string;
          value: string;
        }[];
      } | undefined;
    }[]): Promise<EnvironmentsPlan>;
  };
  branches: {
    key: "branches";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    endpoints: {
      readonly getProtection: {
        readonly route: "GET /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 200: "the branch protection";
          readonly 404: "the branch is unprotected or does not exist";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly putProtection: {
        readonly route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 200: "protection replaced";
        };
        readonly rejections: readonly [DefinitiveRejection];
        readonly hints: {
          readonly 422: string;
        };
      };
      readonly removeProtection: {
        readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 204: "protection removed";
        };
      };
      readonly sigPost: {
        readonly route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
        readonly statuses: {
          readonly 200: "signed commits now required";
        };
      };
      readonly sigDelete: {
        readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
        readonly statuses: {
          readonly 204: "signed-commit requirement removed";
        };
      };
      readonly branchProbe: {
        readonly route: "GET /repos/{owner}/{repo}/branches/{branch}";
        readonly statuses: {
          readonly 200: "the branch exists";
          readonly 404: "no such branch";
        };
        readonly permission: {
          readonly repo: readonly ["contents"];
        };
        readonly advisory: true;
      };
      readonly appLookup: {
        readonly route: "GET /apps/{app_slug}";
        readonly statuses: {
          readonly 200: "the GitHub App";
          readonly 404: "no App with this slug";
        };
        readonly permission: "none";
        readonly phase: "execution";
      };
    };
    graphql: {
      readonly rulesQuery: {
        readonly name: "BranchProtectionRules";
        readonly kind: "read";
        readonly connection: {
          readonly path: readonly ["repository", "branchProtectionRules"];
        };
        readonly outcomes: {
          readonly ok: "the repository's classic branch protection rules";
          readonly NOT_FOUND: "the repository is not visible to the token; read as no rules";
        };
        readonly query: "query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly repoLookup: {
        readonly name: "BranchProtectionRepository";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the repository's GraphQL node id";
        };
        readonly query: "query BranchProtectionRepository($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) { id }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly actorUser: {
        readonly name: "BranchProtectionActorUser";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the user's node id";
          readonly NOT_FOUND: "no user with this login, or the token cannot see it";
        };
        readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file";
        readonly query: "query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  user(login: $login) { id }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
          login: string;
        } | undefined;
      };
      readonly actorTeam: {
        readonly name: "BranchProtectionActorTeam";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the team's node id";
          readonly NOT_FOUND: "no organization with this login, or the token cannot see it";
        };
        readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file";
        readonly query: "query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  organization(login: $org) { team(slug: $team) { id } }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
          org: string;
          team: string;
        } | undefined;
      };
      readonly createRule: {
        readonly name: "CreateBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule created";
          readonly UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)";
        };
        readonly query: "mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {\n  createBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
      readonly updateRule: {
        readonly name: "UpdateBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule updated";
          readonly NOT_FOUND: "no rule with this node id";
          readonly UNPROCESSABLE: "GitHub rejected the update";
        };
        readonly query: "mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {\n  updateBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
      readonly deleteRule: {
        readonly name: "DeleteBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule deleted";
          readonly NOT_FOUND: "no rule with this node id";
        };
        readonly query: "mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {\n  deleteBranchProtectionRule(input: $input) { clientMutationId }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly getProtection: {
        readonly route: "GET /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 200: "the branch protection";
          readonly 404: "the branch is unprotected or does not exist";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly putProtection: {
        readonly route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 200: "protection replaced";
        };
        readonly rejections: readonly [DefinitiveRejection];
        readonly hints: {
          readonly 422: string;
        };
      };
      readonly removeProtection: {
        readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection";
        readonly statuses: {
          readonly 204: "protection removed";
        };
      };
      readonly sigPost: {
        readonly route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
        readonly statuses: {
          readonly 200: "signed commits now required";
        };
      };
      readonly sigDelete: {
        readonly route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures";
        readonly statuses: {
          readonly 204: "signed-commit requirement removed";
        };
      };
      readonly branchProbe: {
        readonly route: "GET /repos/{owner}/{repo}/branches/{branch}";
        readonly statuses: {
          readonly 200: "the branch exists";
          readonly 404: "no such branch";
        };
        readonly permission: {
          readonly repo: readonly ["contents"];
        };
        readonly advisory: true;
      };
      readonly appLookup: {
        readonly route: "GET /apps/{app_slug}";
        readonly statuses: {
          readonly 200: "the GitHub App";
          readonly 404: "no App with this slug";
        };
        readonly permission: "none";
        readonly phase: "execution";
      };
    }, {
      readonly rulesQuery: {
        readonly name: "BranchProtectionRules";
        readonly kind: "read";
        readonly connection: {
          readonly path: readonly ["repository", "branchProtectionRules"];
        };
        readonly outcomes: {
          readonly ok: "the repository's classic branch protection rules";
          readonly NOT_FOUND: "the repository is not visible to the token; read as no rules";
        };
        readonly query: "query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly repoLookup: {
        readonly name: "BranchProtectionRepository";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the repository's GraphQL node id";
        };
        readonly query: "query BranchProtectionRepository($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) { id }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
        } | undefined;
      };
      readonly actorUser: {
        readonly name: "BranchProtectionActorUser";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the user's node id";
          readonly NOT_FOUND: "no user with this login, or the token cannot see it";
        };
        readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file";
        readonly query: "query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  user(login: $login) { id }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
          login: string;
        } | undefined;
      };
      readonly actorTeam: {
        readonly name: "BranchProtectionActorTeam";
        readonly kind: "read";
        readonly phase: "execution";
        readonly outcomes: {
          readonly ok: "the team's node id";
          readonly NOT_FOUND: "no organization with this login, or the token cannot see it";
        };
        readonly denialHint: "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file";
        readonly query: "query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {\n  repository(owner: $owner, name: $repo) { id }\n  organization(login: $org) { team(slug: $team) { id } }\n}";
      } & {
        readonly _variables?: {
          owner: string;
          repo: string;
          org: string;
          team: string;
        } | undefined;
      };
      readonly createRule: {
        readonly name: "CreateBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule created";
          readonly UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)";
        };
        readonly query: "mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {\n  createBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
      readonly updateRule: {
        readonly name: "UpdateBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule updated";
          readonly NOT_FOUND: "no rule with this node id";
          readonly UNPROCESSABLE: "GitHub rejected the update";
        };
        readonly query: "mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {\n  updateBranchProtectionRule(input: $input) {\n    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }\n  }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
      readonly deleteRule: {
        readonly name: "DeleteBranchProtectionRule";
        readonly kind: "write";
        readonly outcomes: {
          readonly ok: "rule deleted";
          readonly NOT_FOUND: "no rule with this node id";
        };
        readonly query: "mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {\n  deleteBranchProtectionRule(input: $input) { clientMutationId }\n}";
      } & {
        readonly _variables?: {
          input: Record<string, unknown>;
        } | undefined;
      };
    }>, desired: {
      name: string;
      protection: {
        [x: string]: unknown;
        required_signatures?: boolean | undefined;
        force_push_bypassers?: string[] | undefined;
        required_deployments?: {
          environments: string[];
        } | null | undefined;
      } | null;
    }[]): Promise<BranchesPlan>;
  };
  autolinks: ListSectionModule<"autolinks", {
    readonly list: {
      readonly route: "GET /repos/{owner}/{repo}/autolinks";
      readonly statuses: {
        readonly 200: "the autolink list";
      };
      readonly primaryRead: {
        readonly notFound: "denied";
      };
    };
    readonly create: {
      readonly route: "POST /repos/{owner}/{repo}/autolinks";
      readonly statuses: {
        readonly 201: "autolink created";
      };
    };
    readonly remove: {
      readonly route: "DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}";
      readonly statuses: {
        readonly 204: "autolink deleted";
      };
    };
  }, {
    [x: string]: unknown;
    id: number;
    key_prefix: string;
  }, "key_prefix">;
  actions: {
    key: "actions";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    grantCaveat: string;
    endpoints: {
      readonly getPermissions: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions";
        readonly statuses: {
          readonly 200: "the Actions permissions policy";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly putPermissions: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions";
        readonly statuses: {
          readonly 204: "Actions permissions policy applied";
        };
      };
      readonly getSelected: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/selected-actions";
        readonly statuses: {
          readonly 200: "the selected-actions allowlist";
          readonly 404: "no allowlist because the policy is not selected";
          readonly 409: "the allowed_actions policy is not selected, so the allowlist does not apply";
        };
      };
      readonly putSelected: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions";
        readonly statuses: {
          readonly 204: "selected-actions allowlist applied";
        };
      };
      readonly getWorkflow: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/workflow";
        readonly statuses: {
          readonly 200: "the workflow token permissions";
        };
      };
      readonly putWorkflow: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow";
        readonly statuses: {
          readonly 204: "workflow token permissions applied";
        };
      };
      readonly getAccess: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/access";
        readonly statuses: {
          readonly 200: "the workflows access level";
        };
      };
      readonly putAccess: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/access";
        readonly statuses: {
          readonly 204: "workflows access level applied";
        };
      };
      readonly getRetention: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention";
        readonly statuses: {
          readonly 200: "the artifact and log retention window";
        };
      };
      readonly putRetention: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention";
        readonly statuses: {
          readonly 204: "artifact and log retention applied";
        };
        readonly hints: {
          readonly 422: "the retention window must be a whole number of days within the plan's maximum; see the artifact-and-log-retention endpoint documentation";
        };
      };
      readonly getCacheRetention: {
        readonly route: "GET /repos/{owner}/{repo}/actions/cache/retention-limit";
        readonly statuses: {
          readonly 200: "the cache retention limit";
        };
      };
      readonly putCacheRetention: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/retention-limit";
        readonly statuses: {
          readonly 204: "cache retention limit applied";
        };
        readonly hints: {
          readonly 400: "the retention limit must be a whole number of days within the allowed range; see the cache retention-limit endpoint documentation";
        };
      };
      readonly getCacheStorage: {
        readonly route: "GET /repos/{owner}/{repo}/actions/cache/storage-limit";
        readonly statuses: {
          readonly 200: "the cache storage limit";
        };
      };
      readonly putCacheStorage: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/storage-limit";
        readonly statuses: {
          readonly 204: "cache storage limit applied";
        };
        readonly hints: {
          readonly 400: "the storage limit must be a whole number of gigabytes within the allowed range; see the cache storage-limit endpoint documentation";
        };
      };
      readonly getOidcSub: {
        readonly route: "GET /repos/{owner}/{repo}/actions/oidc/customization/sub";
        readonly statuses: {
          readonly 200: "the OIDC subject claim template";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
      };
      readonly putOidcSub: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub";
        readonly statuses: {
          readonly 201: "OIDC subject claim template applied";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly hints: {
          readonly 400: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
          readonly 422: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
        };
      };
      readonly getForkPrApproval: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval";
        readonly statuses: {
          readonly 200: "the fork PR contributor approval policy";
        };
      };
      readonly putForkPrApproval: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval";
        readonly statuses: {
          readonly 204: "fork PR contributor approval policy applied";
        };
        readonly hints: {
          readonly 422: "approval_policy must be one of the contributor approval policies GitHub accepts; see the fork-pr-contributor-approval endpoint documentation";
        };
      };
      readonly getForkPrPrivate: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos";
        readonly statuses: {
          readonly 200: "the private-repo fork PR workflow settings";
        };
        readonly denialHint: "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
      };
      readonly putForkPrPrivate: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos";
        readonly statuses: {
          readonly 204: "private-repo fork PR workflow settings applied";
        };
        readonly denialHint: "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
        readonly hints: {
          readonly 422: "the settings object must carry run_workflows_from_fork_pull_requests with boolean toggles only; see the fork-pr-workflows-private-repos endpoint documentation";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly getPermissions: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions";
        readonly statuses: {
          readonly 200: "the Actions permissions policy";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly putPermissions: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions";
        readonly statuses: {
          readonly 204: "Actions permissions policy applied";
        };
      };
      readonly getSelected: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/selected-actions";
        readonly statuses: {
          readonly 200: "the selected-actions allowlist";
          readonly 404: "no allowlist because the policy is not selected";
          readonly 409: "the allowed_actions policy is not selected, so the allowlist does not apply";
        };
      };
      readonly putSelected: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions";
        readonly statuses: {
          readonly 204: "selected-actions allowlist applied";
        };
      };
      readonly getWorkflow: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/workflow";
        readonly statuses: {
          readonly 200: "the workflow token permissions";
        };
      };
      readonly putWorkflow: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow";
        readonly statuses: {
          readonly 204: "workflow token permissions applied";
        };
      };
      readonly getAccess: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/access";
        readonly statuses: {
          readonly 200: "the workflows access level";
        };
      };
      readonly putAccess: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/access";
        readonly statuses: {
          readonly 204: "workflows access level applied";
        };
      };
      readonly getRetention: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention";
        readonly statuses: {
          readonly 200: "the artifact and log retention window";
        };
      };
      readonly putRetention: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention";
        readonly statuses: {
          readonly 204: "artifact and log retention applied";
        };
        readonly hints: {
          readonly 422: "the retention window must be a whole number of days within the plan's maximum; see the artifact-and-log-retention endpoint documentation";
        };
      };
      readonly getCacheRetention: {
        readonly route: "GET /repos/{owner}/{repo}/actions/cache/retention-limit";
        readonly statuses: {
          readonly 200: "the cache retention limit";
        };
      };
      readonly putCacheRetention: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/retention-limit";
        readonly statuses: {
          readonly 204: "cache retention limit applied";
        };
        readonly hints: {
          readonly 400: "the retention limit must be a whole number of days within the allowed range; see the cache retention-limit endpoint documentation";
        };
      };
      readonly getCacheStorage: {
        readonly route: "GET /repos/{owner}/{repo}/actions/cache/storage-limit";
        readonly statuses: {
          readonly 200: "the cache storage limit";
        };
      };
      readonly putCacheStorage: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/storage-limit";
        readonly statuses: {
          readonly 204: "cache storage limit applied";
        };
        readonly hints: {
          readonly 400: "the storage limit must be a whole number of gigabytes within the allowed range; see the cache storage-limit endpoint documentation";
        };
      };
      readonly getOidcSub: {
        readonly route: "GET /repos/{owner}/{repo}/actions/oidc/customization/sub";
        readonly statuses: {
          readonly 200: "the OIDC subject claim template";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
      };
      readonly putOidcSub: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub";
        readonly statuses: {
          readonly 201: "OIDC subject claim template applied";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly hints: {
          readonly 400: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
          readonly 422: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
        };
      };
      readonly getForkPrApproval: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval";
        readonly statuses: {
          readonly 200: "the fork PR contributor approval policy";
        };
      };
      readonly putForkPrApproval: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval";
        readonly statuses: {
          readonly 204: "fork PR contributor approval policy applied";
        };
        readonly hints: {
          readonly 422: "approval_policy must be one of the contributor approval policies GitHub accepts; see the fork-pr-contributor-approval endpoint documentation";
        };
      };
      readonly getForkPrPrivate: {
        readonly route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos";
        readonly statuses: {
          readonly 200: "the private-repo fork PR workflow settings";
        };
        readonly denialHint: "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
      };
      readonly putForkPrPrivate: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos";
        readonly statuses: {
          readonly 204: "private-repo fork PR workflow settings applied";
        };
        readonly denialHint: "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
        readonly hints: {
          readonly 422: "the settings object must carry run_workflows_from_fork_pull_requests with boolean toggles only; see the fork-pr-workflows-private-repos endpoint documentation";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      enabled?: boolean | undefined;
      allowed_actions?: "all" | "local_only" | "selected" | undefined;
      selected_actions?: Record<string, unknown> | undefined;
      default_workflow_permissions?: "read" | "write" | undefined;
      can_approve_pull_request_reviews?: boolean | undefined;
      access_level?: "none" | "organization" | "user" | undefined;
      artifact_and_log_retention?: {
        days: number;
      } | undefined;
      cache?: {
        max_cache_retention_days?: number | undefined;
        max_cache_size_gb?: number | undefined;
      } | undefined;
      oidc_customization_sub?: {
        use_default: boolean;
        include_claim_keys?: string[] | undefined;
        use_immutable_subject?: boolean | undefined;
      } | undefined;
      fork_pr_contributor_approval?: {
        approval_policy: string;
      } | undefined;
      fork_pr_workflows_private_repos?: {
        run_workflows_from_fork_pull_requests: boolean;
        send_write_tokens_to_workflows: boolean;
        send_secrets_and_variables: boolean;
        require_approval_for_fork_pr_workflows: boolean;
      } | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putAccess";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/access";
        readonly statuses: {
          readonly 204: "workflows access level applied";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putCacheRetention";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/retention-limit";
        readonly statuses: {
          readonly 204: "cache retention limit applied";
        };
        readonly hints: {
          readonly 400: "the retention limit must be a whole number of days within the allowed range; see the cache retention-limit endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putCacheStorage";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/cache/storage-limit";
        readonly statuses: {
          readonly 204: "cache storage limit applied";
        };
        readonly hints: {
          readonly 400: "the storage limit must be a whole number of gigabytes within the allowed range; see the cache storage-limit endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putForkPrApproval";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval";
        readonly statuses: {
          readonly 204: "fork PR contributor approval policy applied";
        };
        readonly hints: {
          readonly 422: "approval_policy must be one of the contributor approval policies GitHub accepts; see the fork-pr-contributor-approval endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putForkPrPrivate";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos";
        readonly statuses: {
          readonly 204: "private-repo fork PR workflow settings applied";
        };
        readonly denialHint: "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
        readonly hints: {
          readonly 422: "the settings object must carry run_workflows_from_fork_pull_requests with boolean toggles only; see the fork-pr-workflows-private-repos endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putOidcSub";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub";
        readonly statuses: {
          readonly 201: "OIDC subject claim template applied";
        };
        readonly permission: {
          readonly repo: readonly ["actions"];
        };
        readonly hints: {
          readonly 400: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
          readonly 422: "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putPermissions";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions";
        readonly statuses: {
          readonly 204: "Actions permissions policy applied";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putRetention";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention";
        readonly statuses: {
          readonly 204: "artifact and log retention applied";
        };
        readonly hints: {
          readonly 422: "the retention window must be a whole number of days within the plan's maximum; see the artifact-and-log-retention endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putSelected";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions";
        readonly statuses: {
          readonly 204: "selected-actions allowlist applied";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "putWorkflow";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow";
        readonly statuses: {
          readonly 204: "workflow token permissions applied";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
  };
  actions_secrets: RepoSecretsSectionModule<"actions_secrets">;
  dependabot_secrets: RepoSecretsSectionModule<"dependabot_secrets">;
  codespaces_secrets: RepoSecretsSectionModule<"codespaces_secrets">;
  agents_secrets: RepoSecretsSectionModule<"agents_secrets">;
  workflows: {
    key: "workflows";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/actions/workflows";
        readonly statuses: {
          readonly 200: "the workflow list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly enable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable";
        readonly statuses: {
          readonly 204: "workflow enabled";
        };
      };
      readonly disable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable";
        readonly statuses: {
          readonly 204: "workflow disabled";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        path: true;
        state: true;
      };
      describe: (w: {
        path: string;
        state: "active" | "disabled";
      }) => string;
      consequence: string;
    };
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/actions/workflows";
        readonly statuses: {
          readonly 200: "the workflow list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly enable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable";
        readonly statuses: {
          readonly 204: "workflow enabled";
        };
      };
      readonly disable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable";
        readonly statuses: {
          readonly 204: "workflow disabled";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      path: string;
      state: "active" | "disabled";
    }[]): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"workflow_id", string>>;
    } & {
      readonly role: "disable";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable";
        readonly statuses: {
          readonly 204: "workflow disabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"workflow_id", string>>;
    } & {
      readonly role: "enable";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable";
        readonly statuses: {
          readonly 204: "workflow enabled";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/actions/workflows";
        readonly statuses: {
          readonly 200: "the workflow list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly enable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable";
        readonly statuses: {
          readonly 204: "workflow enabled";
        };
      };
      readonly disable: {
        readonly route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable";
        readonly statuses: {
          readonly 204: "workflow disabled";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: never[];
    } | {
      value: {
        path: string;
        state: "active" | "disabled";
      }[];
      notes: never[];
    }>;
  };
  check_suite_preferences: {
    key: "check_suite_preferences";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    grantCaveat: string;
    endpoints: {
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/check-suites/preferences";
        readonly statuses: {
          readonly 200: "the resulting preferences plus the repository";
        };
        readonly alwaysRewrite: true;
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(_ctx: PlanContext<{
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/check-suites/preferences";
        readonly statuses: {
          readonly 200: "the resulting preferences plus the repository";
        };
        readonly alwaysRewrite: true;
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      [x: string]: unknown;
      auto_trigger_checks: {
        app_id: number;
        setting: boolean;
      }[];
    }): Promise<SectionPlan<PlannedOpBase<readonly string[]> & {
      readonly params?: undefined;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/check-suites/preferences";
        readonly statuses: {
          readonly 200: "the resulting preferences plus the repository";
        };
        readonly alwaysRewrite: true;
      }> | undefined;
      readonly variables?: never;
    }>>;
  };
  pages: {
    key: "pages";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    endpoints: {
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 200: "the Pages site";
          readonly 404: "Pages is not enabled on the repository";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 201: "Pages enabled";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages configuration updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages disabled";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 200: "the Pages site";
          readonly 404: "Pages is not enabled on the repository";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 201: "Pages enabled";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages configuration updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages disabled";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      build_type?: "legacy" | "workflow" | undefined;
      source?: {
        branch: string;
        path?: string | undefined;
      } | undefined;
      cname?: string | null | undefined;
      https_enforced?: boolean | undefined;
      public?: boolean | undefined;
    } | null): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "create";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "POST /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 201: "Pages enabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages disabled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages configuration updated";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 200: "the Pages site";
          readonly 404: "Pages is not enabled on the repository";
        };
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 201: "Pages enabled";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages configuration updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/pages";
        readonly statuses: {
          readonly 204: "Pages disabled";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: never[];
    } | {
      value: {
        build_type?: "legacy" | "workflow" | undefined;
        source?: {
          branch: string;
          path?: string | undefined;
        } | undefined;
        cname?: string | null | undefined;
        https_enforced?: boolean | undefined;
        public?: boolean | undefined;
      } | null;
      notes: never[];
    }>;
  };
  code_scanning_default_setup: SetupSectionModule<"code_scanning_default_setup">;
  code_quality_setup: SetupSectionModule<"code_quality_setup">;
  collaborators: {
    key: "collaborators";
    undeclaredDefault: "delete";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/collaborators";
        readonly statuses: {
          readonly 200: "the direct-collaborator list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 201: "invitation created";
          readonly 204: "collaborator already had the access";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 204: "collaborator removed";
        };
      };
      readonly listInvitations: {
        readonly route: "GET /repos/{owner}/{repo}/invitations";
        readonly statuses: {
          readonly 200: "the pending-invitation list";
        };
      };
      readonly updateInvitation: {
        readonly route: "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 200: "invitation permission updated";
        };
      };
      readonly cancelInvitation: {
        readonly route: "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 204: "invitation cancelled";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        username: true;
        permission: true;
      };
      describe: (c: {
        username: string;
        permission?: string | undefined;
      }) => string;
      consequence: string;
    };
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/collaborators";
        readonly statuses: {
          readonly 200: "the direct-collaborator list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly update: {
        readonly route: "PUT /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 201: "invitation created";
          readonly 204: "collaborator already had the access";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 204: "collaborator removed";
        };
      };
      readonly listInvitations: {
        readonly route: "GET /repos/{owner}/{repo}/invitations";
        readonly statuses: {
          readonly 200: "the pending-invitation list";
        };
      };
      readonly updateInvitation: {
        readonly route: "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 200: "invitation permission updated";
        };
      };
      readonly cancelInvitation: {
        readonly route: "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 204: "invitation cancelled";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      username: string;
      permission?: string | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        username: string;
        permission?: string | undefined;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"invitation_id", string>>;
    } & {
      readonly role: "cancelInvitation";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 204: "invitation cancelled";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"username", string>>;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 204: "collaborator removed";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"username", string>>;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/collaborators/{username}";
        readonly statuses: {
          readonly 201: "invitation created";
          readonly 204: "collaborator already had the access";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"invitation_id", string>>;
    } & {
      readonly role: "updateInvitation";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}";
        readonly statuses: {
          readonly 200: "invitation permission updated";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
  };
  teams: {
    key: "teams";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    ownerSensitivity: "org";
    endpoints: {
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly probe: {
        readonly route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "the team's access to the repository";
          readonly 404: "the team has no access";
        };
      };
      readonly grant: {
        readonly route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access granted";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        name: true;
        permission: true;
      };
      describe: (t: {
        name: string;
        permission?: string | undefined;
      }) => string;
      consequence: string;
    };
    plan(ctx: PlanContext<{
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly probe: {
        readonly route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 200: "the team's access to the repository";
          readonly 404: "the team has no access";
        };
      };
      readonly grant: {
        readonly route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access granted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      name: string;
      permission?: string | undefined;
    }[]): Promise<SectionPlan<PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"org" | "team_slug", string>>;
    } & {
      readonly role: "grant";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access granted";
        };
      }> | undefined;
      readonly variables?: never;
    }>>;
  };
  milestones: {
    key: "milestones";
    undeclaredDefault: "keep";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 200: "the milestone list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 201: "milestone created";
        };
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 200: "milestone updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 204: "milestone deleted";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 200: "the milestone list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 201: "milestone created";
        };
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 200: "milestone updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 204: "milestone deleted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      title: string;
      description?: string | undefined;
      state?: "closed" | "open" | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        title: string;
        description?: string | undefined;
        state?: "closed" | "open" | undefined;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "create";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "POST /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 201: "milestone created";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"milestone_number", string>>;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 204: "milestone deleted";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"milestone_number", string>>;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 200: "milestone updated";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 200: "the milestone list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/milestones";
        readonly statuses: {
          readonly 201: "milestone created";
        };
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 200: "milestone updated";
        };
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}";
        readonly statuses: {
          readonly 204: "milestone deleted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: never[];
    } | {
      value: UndeclaredPolicyList<{
        title: string;
        description?: string | undefined;
        state?: "closed" | "open" | undefined;
      }>;
      notes: never[];
    }>;
  };
  interaction_limits: {
    key: "interaction_limits";
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    endpoints: {
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "the active interaction limit, or an empty object when none is set";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly put: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "interaction limit set";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
        readonly hints: {
          readonly 422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation";
        };
        readonly alwaysRewrite: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 204: "interaction limit cleared";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
      };
      readonly capGet: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "the pull request creation cap";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly accessGrade: "write";
      };
      readonly capPatch: {
        readonly route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "pull request creation cap updated";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly hints: {
          readonly 422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation";
        };
      };
      readonly bypassList: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 200: "the pull request creation cap bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly accessGrade: "write";
      };
      readonly bypassAdd: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users added to the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation";
        };
      };
      readonly bypassRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users removed from the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    plan(ctx: PlanContext<{
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "the active interaction limit, or an empty object when none is set";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly put: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "interaction limit set";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
        readonly hints: {
          readonly 422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation";
        };
        readonly alwaysRewrite: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 204: "interaction limit cleared";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
      };
      readonly capGet: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "the pull request creation cap";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly accessGrade: "write";
      };
      readonly capPatch: {
        readonly route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "pull request creation cap updated";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly hints: {
          readonly 422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation";
        };
      };
      readonly bypassList: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 200: "the pull request creation cap bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly accessGrade: "write";
      };
      readonly bypassAdd: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users added to the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation";
        };
      };
      readonly bypassRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users removed from the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, desired: {
      limit?: string | undefined;
      expiry?: string | undefined;
      pull_request_creation_cap?: {
        enabled: boolean;
        max_open_pull_requests?: number | undefined;
      } | undefined;
      pull_request_creation_bypass?: string[] | undefined;
    } | null): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "bypassAdd";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users added to the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "bypassRemove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users removed from the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "capPatch";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "pull request creation cap updated";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly hints: {
          readonly 422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly string[]> & {
      readonly params?: undefined;
    } & {
      readonly role: "put";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "interaction limit set";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
        readonly hints: {
          readonly 422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation";
        };
        readonly alwaysRewrite: true;
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 204: "interaction limit cleared";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly get: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "the active interaction limit, or an empty object when none is set";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly put: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 200: "interaction limit set";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
        readonly hints: {
          readonly 422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation";
        };
        readonly alwaysRewrite: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits";
        readonly statuses: {
          readonly 204: "interaction limit cleared";
          readonly 409: "an organization- or user-level interaction limit overrides this repository's";
        };
      };
      readonly capGet: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "the pull request creation cap";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly accessGrade: "write";
      };
      readonly capPatch: {
        readonly route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap";
        readonly statuses: {
          readonly 200: "pull request creation cap updated";
          readonly 405: "the pull request creation cap is not available on this repository";
        };
        readonly hints: {
          readonly 422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation";
        };
      };
      readonly bypassList: {
        readonly route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 200: "the pull request creation cap bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly accessGrade: "write";
      };
      readonly bypassAdd: {
        readonly route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users added to the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation";
        };
      };
      readonly bypassRemove: {
        readonly route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";
        readonly statuses: {
          readonly 204: "users removed from the bypass list";
        };
        readonly denialHint: "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
        readonly hints: {
          readonly 422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: string[];
    } | {
      value: {
        limit?: string | undefined;
        expiry?: string | undefined;
        pull_request_creation_cap?: {
          enabled: boolean;
          max_open_pull_requests?: number | undefined;
        } | undefined;
        pull_request_creation_bypass?: string[] | undefined;
      };
      notes: string[];
    }>;
  };
  actions_variables: RepoVariablesSectionModule<"actions_variables">;
  agents_variables: RepoVariablesSectionModule<"agents_variables">;
  webhooks: {
    key: "webhooks";
    undeclaredDefault: "keep";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 200: "the webhook list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 201: "webhook created";
        };
        readonly unverifiable: true;
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 200: "webhook events/active updated";
        };
      };
      readonly updateConfig: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config";
        readonly statuses: {
          readonly 200: "webhook config updated";
        };
        readonly unverifiable: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 204: "webhook deleted";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    secretValues: (declared: unknown) => DeclaredSecretValue[];
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 200: "the webhook list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 201: "webhook created";
        };
        readonly unverifiable: true;
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 200: "webhook events/active updated";
        };
      };
      readonly updateConfig: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config";
        readonly statuses: {
          readonly 200: "webhook config updated";
        };
        readonly unverifiable: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 204: "webhook deleted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      name?: "web" | undefined;
      config: {
        [x: string]: unknown;
        url: string;
        content_type?: string | undefined;
        secret?: string | undefined;
        insecure_ssl?: string | number | undefined;
      };
      events?: string[] | undefined;
      active?: boolean | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name?: "web" | undefined;
        config: {
          [x: string]: unknown;
          url: string;
          content_type?: string | undefined;
          secret?: string | undefined;
          insecure_ssl?: string | number | undefined;
        };
        events?: string[] | undefined;
        active?: boolean | undefined;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<Unverifiable | readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "create";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "POST /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 201: "webhook created";
        };
        readonly unverifiable: true;
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"hook_id", string>>;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 204: "webhook deleted";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"hook_id", string>>;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 200: "webhook events/active updated";
        };
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<Unverifiable | readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"hook_id", string>>;
    } & {
      readonly role: "updateConfig";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config";
        readonly statuses: {
          readonly 200: "webhook config updated";
        };
        readonly unverifiable: true;
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 200: "the webhook list";
        };
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/hooks";
        readonly statuses: {
          readonly 201: "webhook created";
        };
        readonly unverifiable: true;
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 200: "webhook events/active updated";
        };
      };
      readonly updateConfig: {
        readonly route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config";
        readonly statuses: {
          readonly 200: "webhook config updated";
        };
        readonly unverifiable: true;
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}";
        readonly statuses: {
          readonly 204: "webhook deleted";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: string[];
    } | {
      value: UndeclaredPolicyList<{
        name?: "web" | undefined;
        config: {
          [x: string]: unknown;
          url: string;
          content_type?: string | undefined;
          secret?: string | undefined;
          insecure_ssl?: string | number | undefined;
        };
        events?: string[] | undefined;
        active?: boolean | undefined;
      }>;
      notes: string[];
    }>;
  };
  custom_properties: {
    key: "custom_properties";
    undeclaredDefault: "keep";
    permission: SectionPermission;
    ownerSensitivity: "org";
    endpoints: {
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 200: "the custom property values";
        };
        readonly permission: "none";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 204: "custom property values updated";
        };
        readonly denialHint: "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy";
        readonly hints: {
          readonly 422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        property_name: true;
        value: true;
      };
      describe: (p: {
        property_name: string;
        value: string | number | boolean | string[] | null;
      }) => string;
      consequence: string;
    };
    plan(ctx: PlanContext<{
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 200: "the custom property values";
        };
        readonly permission: "none";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 204: "custom property values updated";
        };
        readonly denialHint: "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy";
        readonly hints: {
          readonly 422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      property_name: string;
      value: string | number | boolean | string[] | null;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        property_name: string;
        value: string | number | boolean | string[] | null;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 204: "custom property values updated";
        };
        readonly denialHint: "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy";
        readonly hints: {
          readonly 422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings";
        };
      }> | undefined;
      readonly variables?: never;
    }>>;
    snapshot(ctx: PlanContext<{
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
        readonly primaryRead: {
          readonly notFound: "absent";
        };
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 200: "the custom property values";
        };
        readonly permission: "none";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/properties/values";
        readonly statuses: {
          readonly 204: "custom property values updated";
        };
        readonly denialHint: "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy";
        readonly hints: {
          readonly 422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: string[];
    } | {
      value: UndeclaredPolicyList<{
        property_name: string;
        value: string | number | boolean | string[] | null;
      }>;
      notes: never[];
    }>;
  };
  deploy_keys: ListSectionModule<"deploy_keys", {
    readonly list: {
      readonly route: "GET /repos/{owner}/{repo}/keys";
      readonly statuses: {
        readonly 200: "the deploy key list";
      };
      readonly primaryRead: {
        readonly notFound: "denied";
      };
    };
    readonly create: {
      readonly route: "POST /repos/{owner}/{repo}/keys";
      readonly statuses: {
        readonly 201: "deploy key created";
      };
      readonly hints: {
        readonly 422: "A public key can be attached to only ONE repository account-wide, so a 422 here can mean the key is already in use elsewhere; generate a distinct keypair per repository";
      };
    };
    readonly remove: {
      readonly route: "DELETE /repos/{owner}/{repo}/keys/{key_id}";
      readonly statuses: {
        readonly 204: "deploy key deleted";
      };
    };
  }, {
    [x: string]: unknown;
    id: number;
    title: string;
    key: string;
    read_only?: boolean | undefined;
  }, "title">;
  secret_scanning_custom_patterns: {
    key: "secret_scanning_custom_patterns";
    undeclaredDefault: "keep";
    permission: SectionPermission;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 200: "the custom-pattern list";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 201: "patterns created";
        };
        readonly hints: {
          readonly 422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}";
        readonly statuses: {
          readonly 200: "pattern updated";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 204: "patterns deleted";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        name: true;
        pattern: true;
        start_delimiter: true;
        end_delimiter: true;
        must_match: true;
        must_not_match: true;
      };
      describe: (p: {
        name: string;
        pattern: string;
        start_delimiter?: string | undefined;
        end_delimiter?: string | undefined;
        must_match?: string[] | undefined;
        must_not_match?: string[] | undefined;
      }) => string;
      consequence: string;
    };
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 200: "the custom-pattern list";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 201: "patterns created";
        };
        readonly hints: {
          readonly 422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}";
        readonly statuses: {
          readonly 200: "pattern updated";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 204: "patterns deleted";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>, declared: {
      name: string;
      pattern: string;
      start_delimiter?: string | undefined;
      end_delimiter?: string | undefined;
      must_match?: string[] | undefined;
      must_not_match?: string[] | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name: string;
        pattern: string;
        start_delimiter?: string | undefined;
        end_delimiter?: string | undefined;
        must_match?: string[] | undefined;
        must_not_match?: string[] | undefined;
      }[];
      _layering?: "merge" | "replace" | undefined;
    }): Promise<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "create";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 201: "patterns created";
        };
        readonly hints: {
          readonly 422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params?: undefined;
    } & {
      readonly role: "remove";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 204: "patterns deleted";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      }> | undefined;
      readonly variables?: never;
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"pattern_id", string>>;
    } & {
      readonly role: "update";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}";
        readonly statuses: {
          readonly 200: "pattern updated";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      }> | undefined;
      readonly variables?: never;
    })>>;
    snapshot(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 200: "the custom-pattern list";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
        readonly primaryRead: {
          readonly notFound: "denied";
        };
      };
      readonly create: {
        readonly route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 201: "patterns created";
        };
        readonly hints: {
          readonly 422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly update: {
        readonly route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}";
        readonly statuses: {
          readonly 200: "pattern updated";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
      readonly remove: {
        readonly route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns";
        readonly statuses: {
          readonly 204: "patterns deleted";
        };
        readonly hints: {
          readonly 412: "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
        };
        readonly denialHint: "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
      };
    }, Readonly<Record<string, GraphqlOpDecl>>>): Promise<{
      value: undefined;
      notes: never[];
    } | {
      value: UndeclaredPolicyList<{
        name: string;
        pattern: string;
        start_delimiter?: string | undefined;
        end_delimiter?: string | undefined;
        must_match?: string[] | undefined;
        must_not_match?: string[] | undefined;
      }>;
      notes: never[];
    }>;
  };
};
type SectionModules = typeof byKey;
/**
 * Derived from each module's literal ENDPOINTS, so every consumer (the mock handler tables, dispatch,
 * fault directives) tracks the declarations by construction.
 */
type SectionEndpointKey<K extends SectionKey = SectionKey> = { [S in SectionKey]: `${S}.${keyof SectionModules[S]["endpoints"] & string}`; }[K];
type SectionGraphqlKey<K extends SectionKey = SectionKey> = { [S in SectionKey]: SectionModules[S] extends {
  readonly graphql: infer G;
} ? `${S}.${keyof G & string}` : never; }[K];
export declare const SECTIONS: readonly SectionModule[];
/** The section module for a key (validate.ts reads shape + closedSurface). */
export declare function sectionModule<K extends SectionKey>(key: K): SectionModule<K>;
type TaggedEndpoint = EndpointDecl & {
  readonly section: SectionKey;
  readonly role: string;
};
/**
 * The single view the e2e mock's route table and USED_PATHS iterate, keyed by the exact SectionEndpointKey
 * union so an undeclared lookup does not compile.
 *
 *   frozen (record, tagged entries, nested statuses/permission)  -> they reference the declarations, which must never mutate
 *   `sections` injectable                                        -> the scope-free assert is testable; an injected list keeps string keys
 */
export declare function allEndpoints(): Readonly<Record<SectionEndpointKey, TaggedEndpoint>>;
export declare function allEndpoints(sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints">>): Readonly<Record<string, TaggedEndpoint>>;
type TaggedGraphqlOp = GraphqlOpDecl & {
  readonly section: SectionKey;
  readonly role: string;
};
/**
 * The allEndpoints() sibling for the mock's dispatch table, the coverage tripwire, and the fault-key
 * universe; frozen for the same reason. Operation NAMES must be globally unique (the wire dispatch key),
 * and a role never collides with a REST role in the same section (fault directives share one "section.role" key space).
 */
export declare function allGraphqlOps(): Readonly<Record<SectionGraphqlKey, TaggedGraphqlOp>>;
export declare function allGraphqlOps(sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints" | "graphql">>): Readonly<Record<string, TaggedGraphqlOp>>;
//#endregion
//#region src/engine/secret-refs.d.ts
/**
 * settings.yml is committed plaintext and GitHub does not interpolate ${{ secrets }} inside repository files, so a
 * designated secret field carries a whole-value `$NAME` reference resolved from the step's environment at run time.
 * Every edge fails closed; nothing here logs a value, and the module knows no field names.
 *
 * a literal value                 -> rejected: committed plaintext is what the mechanism prevents
 * "prefix-$TOKEN"                 -> rejected: shipping it as a literal secret is worse than failing
 * $INPUT_*, $GITHUB_*, ...        -> refused: reserved runner variables
 * a reference in a target's file  -> refused: a target must not route the operator's environment into itself
 */
/** Who authored the source: a `target` document (fetched from the target repository) has its references refused; flows/multi.ts decides. */
type SettingsSource = "operator" | "target";
//#endregion
//#region src/engine/section-selection.d.ts
export declare class SectionSelection {
  private readonly onlyKeys;
  private readonly requiredKeys;
  /** The selection that processes every declared section and requires none. */
  static readonly ALL: SectionSelection;
  private constructor();
  /** The only public way in; a refusal names the required sections the allowlist excludes. */
  static of(input: {
    only?: Iterable<SectionKey>;
    required?: Iterable<SectionKey>;
  }): Result<SectionSelection, ProblemOf<"required-sections-excluded">>;
  /** The allowlist; empty means every declared section is processed. */
  get only(): ReadonlySet<SectionKey>;
  /** The sections that must fully apply even under on-missing-permission: warn. */
  get required(): ReadonlySet<SectionKey>;
}
//#endregion
//#region src/engine/orchestrate.d.ts
/**
 * `httpStatus` is the safe code of the PermissionDenied behind a failed or skipped section (the redacted view shows it
 * as `HTTP 403` in place of the hidden detail); the `?: never` pin makes a code on a healthy row unrepresentable.
 */
type SectionOutcome = {
  key: SectionKey;
  status: "applied" | "clean" | "drift" | "excluded";
  detail: string[];
  httpStatus?: never;
} | {
  key: SectionKey;
  status: "failed" | "skipped";
  detail: string[];
  /** Optional: a generic (non-denial) failure legitimately carries none. */
  httpStatus?: number;
};
/**
 * The brand has exactly one construction site (validateSettingsDoc's success return), so a RepoRunOptions built from an
 * unvalidated document is a compile error. The value is the PARSED document zod built, never the caller's object.
 */
declare const validatedSettings: unique symbol;
type ValidatedSettings = SettingsFile & {
  readonly [validatedSettings]: true;
};
interface RepoRunOptions {
  repo: RepoRef;
  settings: ValidatedSettings;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  sections: SectionSelection;
  /** Omitted, "operator". The multi-repo flow passes "target" for a target's own settings.yml, so its secret references are refused. */
  secretSource?: SettingsSource;
  secretEnv?: Record<string, string | undefined>;
}
type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";
/**
 * Worst-first, the ranking worstOf() applies; the single source for the action.yml `result` output docs too (the
 * contract test imports it). The lockstep below keeps it locked to RepoResult.
 */
export declare const REPO_RESULTS: readonly ["failed", "drift", "partial", "skipped", "applied", "clean"];
interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  /** Non-empty when the preflight barrier refused to write anything. */
  preflightDenied: string[];
}
export declare function skippedSectionKeys(outcomes: ReadonlyArray<Pick<SectionOutcome, "key" | "status">>): SectionKey[];
/**
 * The ONE boundary that turns a raw parsed document into the ValidatedSettings the engine accepts. Unknown top-level
 * keys are errors, except outside a non-empty `sections` allowlist, where they downgrade to a warning.
 */
export declare function validateSettingsDoc(settings: unknown, sourceLabel: string, onlySections: ReadonlySet<SectionKey>, io: Io): Result<ValidatedSettings, SettingsProblem>;
/** A plan section has no write capability, so planning IS the read-only probe; `active` is injectable for tests. */
export declare function preflightProbe(api: GithubClient, repo: RepoRef, active: typeof SECTIONS, settings: ValidatedSettings): Promise<string[]>;
export declare function runForRepo(api: GithubClient, opts: RepoRunOptions, io: Io): Promise<RepoRunResult>;
export declare function worstOf(results: Array<{
  result: RepoResult;
}>, check: boolean): RepoResult;
//#endregion
//#region src/engine/snapshot.d.ts
/**
 * One section's end state: read back ("snapshot", its notes in detail), denied under the warn
 * policy ("skipped"), without a snapshot handler ("unsupported", the reason in detail), or failed.
 */
interface SectionSnapshotOutcome {
  key: SectionKey;
  status: "snapshot" | "skipped" | "unsupported" | "failed";
  detail: string[];
}
/**
 * The document exists only when the run did not fail: a denial under the fail policy and a
 * section producing a value its own schema rejects both withhold it, so a failed result cannot be
 * rendered by mistake. "partial" says a section was skipped or failed without failing the run.
 */
type SnapshotResult = {
  repo: string;
  result: "snapshot" | "partial";
  settings: ValidatedSettings;
  outcomes: SectionSnapshotOutcome[];
} | {
  repo: string;
  result: "failed";
  settings?: never;
  outcomes: SectionSnapshotOutcome[];
};
/** A snapshot result that carries a document. */
type RenderableSnapshot = Extract<SnapshotResult, {
  settings: ValidatedSettings;
}>;
/**
 * The snapshot as a settings file: the language-server schema pin, a comment header naming the
 * repository, the moment (supplied by the caller, so the text is deterministic), and every
 * outcome line, then the document as the merge flow writes one. A message spanning several
 * physical lines (an API error body) is commented line by line, so no line escapes the header.
 */
export declare function renderSnapshotYaml(result: RenderableSnapshot, opts: {
  schemaUrl: string;
  timestamp: string;
}): string;
//#endregion
//#region src/github/repo-visibility.d.ts
/** A repository's visibility as the probe established it; "unknown" means it could not. */
type RepoVisibility = "public" | "private" | "internal" | "unknown";
export declare function createVisibilityResolver(api: GithubClient): (slug: string) => Promise<RepoVisibility>;
//#endregion
//#region src/report/artifact-report.d.ts
/** For config parse: a malformed `report-public-key` is rejected before any API work. Accepts exactly what the age library accepts. */
export declare function parseRecipient(recipient: string): Result<void, ProblemOf<"age-recipient-invalid">>;
/** Decrypt locally with `age -d -i key.txt private-report.md.age`. */
export declare function encryptReport(recipient: string, content: string): Promise<Uint8Array>;
/** The upload port: the action implements it over @actions/artifact, tests capture. */
interface ArtifactUploader {
  upload(name: string, file: {
    name: string;
    data: Uint8Array;
  }): Promise<void>;
}
type ArtifactDelivery = {
  uploaded: true;
} | {
  warning: string;
};
/**
 * Never throws: report delivery is auxiliary, so every failure is a warning and the run's result stays untouched. The
 * messages describe the artifact service or the recipient, never the report content, which leaves this module only as ciphertext.
 */
export declare function deliverArtifactReport(uploader: ArtifactUploader, document: string, recipient: string): Promise<ArtifactDelivery>;
//#endregion
//#region src/report/delivery.d.ts
/**
 * A report reaches only a redacted target proven private or internal (flows/deliver.ts decides).
 *
 * `none`              -> delivers nothing
 * `issue`             -> the full report on the private target repo itself, the one GitHub-ACL-private channel a public run has
 * `issue-on-failure`  -> the same issue, created only when the run needs attention; recovery closes it with the healthy report
 * `artifact`          -> the delivered reports as one age-encrypted artifact, for readers with the key but no GitHub access
 */
export declare const PRIVATE_REPORT_CHANNELS: readonly ["none", "issue", "issue-on-failure", "artifact"];
type PrivateReportChannel = (typeof PRIVATE_REPORT_CHANNELS)[number];
/**
 * One target's rich end state: slug, section outcomes with live detail, and
 * the note for a skip or failure that produced no outcomes. Open in the clear;
 * sealed with the transcript when redacted.
 */
interface TargetDetail {
  slug: string;
  outcomes: RepoRunResult["outcomes"];
  note?: string;
}
interface RedactedDetail extends TargetDetail {
  transcript: CollectedLine[];
}
interface ReportRunMeta {
  /** The admin repository the workflow ran in (GITHUB_REPOSITORY / selfSlug). */
  adminRepo: string;
  /** Link to the workflow run (may be empty on local runs). */
  runUrl: string;
  mode: string;
  /** ISO timestamp captured once at the run's start, passed in (never Date.now here). */
  timestamp: string;
}
/**
 * `on` is false when the channel is off or the target is not redacted. The notice is returned rather than emitted, so
 * the caller can route it through the target's capturing sink.
 */
export declare function applyMarkerInjection(settings: ValidatedSettings, on: boolean): {
  settings: ValidatedSettings;
  notice?: string;
};
declare const CONCLUDED: unique symbol;
/** The brand makes runOutcome() the only constructor, so the report cannot be told a result and a verdict that disagree. */
interface RunConclusion {
  readonly result: RepoResult;
  readonly exitCode: 0 | 1;
  readonly [CONCLUDED]: true;
}
interface ReportTarget {
  /** The owner/name pair the issue channel posts into; null when the slug did not parse. */
  repo: RepoRef | null;
  /** The public placeholder, the only name a delivery warning may carry. */
  display: string;
  /** The target's own conclusion; an exit of 1 opens the report issue, 0 closes it. */
  conclusion: RunConclusion;
  detail: Private<RedactedDetail>;
}
/**
 * A delivery failure is one safe warning (placeholder and HTTP status, or the artifact service; never a slug or report
 * content) and never changes any target's result.
 */
interface ReportChannel {
  deliver(target: ReportTarget): Promise<void>;
  flush(): Promise<void>;
}
/**
 * The flows check for the artifact uploader before any API work (requireUploader); the throw here is the backstop for
 * a caller that skipped that check, an invariant violation and not a run outcome.
 */
export declare function openReportChannel(api: GithubClient, channel: PrivateReportChannel, meta: ReportRunMeta, reportPublicKey: string, io: Io, uploader?: ArtifactUploader): ReportChannel | null;
//#endregion
//#region src/flows/redact.d.ts
export declare const PRIVATE_REPOS_POLICIES: readonly ["redact", "show"];
type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];
/** One multi-repo target's end state: safe closed values plus the detail the public view projects from. */
interface TargetOutcome {
  source: Target["source"];
  result: RepoRunResult["result"];
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  detail: TargetDetail | Private<RedactedDetail>;
}
/** A leak-free section outcome: key and status survive, detail is hidden. */
type RedactedOutcome = {
  key: SectionKey;
  status: RepoRunResult["outcomes"][number]["status"];
  detail: string[];
};
/** The public rendering of one target's detail: the section rows and the note under its heading. */
interface PublicDetail {
  outcomes: RedactedOutcome[];
  note?: string;
}
export declare function publicDetail(detail: TargetOutcome["detail"]): PublicDetail;
interface PublicTargetView extends PublicDetail {
  display: string;
  source: Target["source"];
  result: RepoRunResult["result"];
}
export declare function toPublicView(target: TargetOutcome): PublicTargetView;
interface RedactionPlan {
  isRedacted(slug: string): boolean;
  display(slug: string): string;
  /** Every slug that must be masked: redacted targets plus discovery-filtered privates. */
  maskedSlugs: string[];
}
export declare function planRedaction(policy: PrivateReposPolicy, orderedTargetSlugs: string[], extraPrivateSlugs: Private<string>[], isPrivateSlug: (slug: string) => boolean, selfSlug: string): RedactionPlan;
/**
 * Lets nothing textual out: annotate/log are recorded for the private report, debug/summary/output are dropped (those
 * surfaces are written from the public view), only the mask registry passes through. The lines are recorded UNMASKED so
 * the report can name the private slug; a masked secret never reaches them, because a resolved plaintext is consumed
 * only inside payload thunks and sealing, and GithubApi withholds every error body and transport message of a
 * secret-carrying request (the e2e runner's checkReportLeaks sweeps each delivered report for the run's secrets).
 */
export declare function capturingIo(io: Io): {
  io: Io;
  drain(): CollectedLine[];
};
//#endregion
//#region src/flows/deliver.d.ts
interface DeliveryConfig {
  mode: "apply" | "check";
  privateReport: PrivateReportChannel;
  /** The age recipient the `artifact` channel encrypts every report to; empty for the other channels. */
  reportPublicKey: string;
  /** The repository the run acts for; a target equal to it is never redacted. */
  selfSlug: string;
  /** Link to the workflow run, for the private report metadata; may be empty. */
  runUrl: string;
}
interface RunFlowConfig extends DeliveryConfig {
  onMissingPermission: "fail" | "warn";
  sections: SectionSelection;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
}
type FinishedRun = {
  kind: "single";
  mode: DeliveryConfig["mode"];
  target: Omit<TargetOutcome, "source">;
} | {
  kind: "multi";
  mode: DeliveryConfig["mode"];
  targets: TargetOutcome[];
};
/** The public view is projected first, so nothing below carries a redacted slug. */
export declare function concludeRun(io: Io, run: FinishedRun): number;
/**
 * A run that failed before any target ran gets a failed target's conclusion and no summary; the one place a fatal problem becomes text.
 * `describe` is the action's wording unless the caller's face (the command line) words a remedy differently.
 */
export declare function failRun(io: Io, problem: Problem, describe?: (problem: Problem) => string): number;
/** Not a RepoResult: a merge has no target, so it never enters worstOf and never appears beside the per-repo values. */
export declare const MERGE_RESULT = "merged";
interface FinishedMerge {
  layers: readonly string[];
  mergedFile: string;
}
export declare function concludeMerge(io: Io, run: FinishedMerge): number;
//#endregion
//#region src/flows/merge.d.ts
interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}
export declare function runMerge(cfg: MergeConfig, io: Io): Result<FinishedMerge, Problem>;
//#endregion
//#region src/flows/multi.d.ts
/** The single source for the action.yml `settings-file` default, the multi-repo override guard in src/flows/inputs.ts, and the prose below. */
export declare const DEFAULT_SETTINGS_FILE = ".github/settings.yml";
/**
 * Where a multi-repo run's targets come from and how their slugs may appear:
 * the inputs resolveTargets reads. Apply, check, and snapshot share it, so
 * the three modes name the same fleet from the same inputs.
 */
interface TargetsConfig extends Pick<RunFlowConfig, "privateRepos" | "selfSlug"> {
  reposDir: string;
  reposInput: string;
  /** The owner a bare `<name>.yml` file under repos-dir belongs to. */
  adminOwner: string;
  discoveryFilters: DiscoveryFilters;
  /** Filter inputs the user explicitly set, for the misuse rejections. */
  discoveryFiltersSet: string[];
}
interface MultiConfig extends RunFlowConfig, TargetsConfig {
  defaultsFile: string;
}
/** The fleet a run acts on, with the redaction decision every target reports under. */
interface ResolvedTargets {
  /** Deduped, central first, in the order the run processes them. */
  targets: Target[];
  plan: RedactionPlan;
  /** A slug's resolved visibility; "unknown" for a slug never resolved. */
  visibilityOf: (slug: string) => RepoVisibility;
}
/**
 * Resolve the run's targets (repos-dir files, explicit repos, "*" discovery),
 * decide redaction, and register every masked slug BEFORE the first line is
 * emitted. A config problem (bad repos input, discovery failure, misplaced
 * filters, no targets) comes back as the error; nothing has been emitted about
 * a target when it does.
 */
export declare function resolveTargets(api: GithubClient, cfg: TargetsConfig, io: Io): ResultAsync<ResolvedTargets, Problem>;
/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) come back as the error
 * before any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
export declare function runMulti(api: GithubClient, cfg: MultiConfig, io: Io, uploader?: ArtifactUploader): ResultAsync<TargetOutcome[], Problem>;
//#endregion
//#region src/flows/single.d.ts
interface SingleConfig extends RunFlowConfig {
  repo: RepoRef;
  settingsFile: string;
}
type SingleOutcome = Omit<TargetOutcome, "source">;
export declare function runSingle(api: GithubClient, cfg: SingleConfig, io: Io, uploader?: ArtifactUploader): ResultAsync<SingleOutcome, Problem>;
//#endregion
//#region src/flows/snapshot.d.ts
/**
 * The `result` output of a mode: snapshot run, worst first: `failed` when a
 * target failed (a denial under the fail policy, a value a section's own
 * schema rejects, an unwritable file), `partial` when a section was skipped
 * or failed without failing its target, `snapshot` when every target read
 * fully back. Not RepoResult values: a snapshot applies nothing, so they
 * never enter worstOf beside the per-repo values.
 */
export declare const SNAPSHOT_RESULTS: readonly ["failed", "partial", "snapshot"];
type SnapshotRunResult = (typeof SNAPSHOT_RESULTS)[number];
/**
 * The schema the written file's editor hint points at: the schema of this
 * release line, spelled as the README's quick start spells it. The marker
 * lets a major release rewrite the tag here (release-please-config.json lists
 * this file); test/docs/readme.test.ts pins it to the README's hint.
 */
export declare const SNAPSHOT_SCHEMA_URL = "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json";
interface SnapshotConfigBase {
  onMissingPermission: "fail" | "warn";
  /** The allowlist; its required set is unused, since a snapshot never writes. */
  sections: SectionSelection;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
  /** The repository the run acts for; a target equal to it is never redacted. */
  selfSlug: string;
}
/**
 * A mode: snapshot run: one repository written to `snapshotFile`, or the
 * multi-repo targets (resolved exactly as apply resolves them) written under
 * `snapshotDir` as `<owner>/<name>.yml` each. No settings file, no report
 * channel: a snapshot reads and writes a file, and the type carries that.
 */
type SnapshotConfig = (SnapshotConfigBase & {
  form: "file";
  repo: RepoRef;
  snapshotFile: string;
}) | (SnapshotConfigBase & TargetsConfig & {
  form: "dir";
  snapshotDir: string;
});
/** One target as the summary and the outputs see it: closed values, detail already projected. */
interface SnapshotTargetView {
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  source?: Target["source"];
  result: SnapshotRunResult;
  outcomes: Array<{
    key: SectionKey;
    status: SnapshotResult["outcomes"][number]["status"];
    detail: string[];
  }>;
  note: string;
  /** Where the file went, as the public view may show it. */
  file?: string;
}
/** A finished mode: snapshot run as runSnapshot hands it over: every target's public view. */
type FinishedSnapshot = {
  form: "file";
  view: SnapshotTargetView;
} | {
  form: "dir";
  snapshotDir: string;
  views: SnapshotTargetView[];
};
/**
 * Execute a mode: snapshot run. A destination that would overwrite an authored
 * file, or a fleet that cannot be resolved, comes back as the error before any
 * target is read; otherwise every target's public view, which concludeSnapshot
 * turns into the summary, the outputs, and the exit code.
 */
export declare function runSnapshot(api: GithubClient, cfg: SnapshotConfig, io: Io): ResultAsync<FinishedSnapshot, Problem>;
/** A finished mode: snapshot run: the summary, the outputs, the result line, and the exit code. */
export declare function concludeSnapshot(io: Io, finished: FinishedSnapshot): number;
//#endregion
//#region src/flows/inputs.d.ts
/** Default `private-repos`, pinned against action.yml by the contract test. */
export declare const DEFAULT_PRIVATE_REPOS = "redact";
/**
 * One input's action.yml entry and its row in the generated Inputs table on docs/reference/inputs.md. The runner
 * applies the defaults; parseConfig() falls back to them outside the runner.
 */
interface InputDecl {
  /** The action.yml description; the generator folds it to width. */
  readonly description: string;
  /** The action.yml default, verbatim (an empty string means "unset"). */
  readonly default: string;
  /** The Inputs table's Meaning cell: the one-line gist. */
  readonly summary: string;
  /**
   * The Inputs table's Default cell when the raw default is not what a reader should see: an expression, a prose
   * fallback, or the effective value for an empty raw default.
   */
  readonly shownDefault?: string;
  /**
   * A comma- or newline-separated list. parseConfig reads such an input only
   * through its list() port (repos is split by the target resolver instead),
   * and the CLI lets the flag repeat; a single-value input has no `list`.
   */
  readonly list?: true;
}
/**
 * The single source the inputs reference page and action.yml are generated from (bun run build:action-docs), in their
 * listing order; adding an input here is the whole declaration. A new mode's inputs go beside their mode's.
 */
export declare const INPUT_DECLS: {
  readonly token: {
    readonly description: "Token used for the API calls. Most sections need a fine-grained PAT with Administration read/write on the repository - the default GITHUB_TOKEN can never hold that permission.";
    readonly default: "${{ github.token }}";
    readonly summary: "Token for the API calls (see [Token permissions](docs/reference/permissions.md))";
    readonly shownDefault: "`github.token`";
  };
  readonly repository: {
    readonly description: "Target repository (owner/name). Defaults to the current repository. Single-repo mode only; cannot be combined with repos or repos-dir.";
    readonly default: "";
    readonly summary: "Target `owner/name` (single-repo mode only)";
    readonly shownDefault: "current repo";
  };
  readonly "settings-file": {
    readonly description: string;
    readonly default: ".github/settings.yml";
    readonly summary: "Settings file path (single-repo mode); in `mode: merge`, the ordered list of layers to fold, low to high";
    readonly list: true;
  };
  readonly mode: {
    readonly description: string;
    readonly default: "apply";
    readonly summary: string;
  };
  readonly "merged-file": {
    readonly description: string;
    readonly default: "";
    readonly summary: "`mode: merge` only (required there): where the merged document is written, exactly what `apply` would run";
  };
  readonly "snapshot-file": {
    readonly description: string;
    readonly default: "";
    readonly summary: "`mode: snapshot` only (one of the two required there): where one repository's live settings are written as a settings document";
  };
  readonly "snapshot-dir": {
    readonly description: string;
    readonly default: "";
    readonly summary: "`mode: snapshot` only (one of the two required there): directory receiving one `<owner>/<name>.yml` per multi-repo target";
  };
  readonly "on-missing-permission": {
    readonly description: "fail (default) or warn. Under warn, sections the token cannot access are skipped with a warning and the run stays green (partial success).";
    readonly default: "fail";
    readonly summary: "`warn` skips sections the token cannot access (partial success)";
  };
  readonly "required-sections": {
    readonly description: string;
    readonly default: "";
    readonly summary: "Sections that must fully apply even under `warn`";
    readonly list: true;
  };
  readonly sections: {
    readonly description: "Optional comma-separated allowlist of sections to process. apply, check, and snapshot only: mode: merge writes every section its layers declare, so the allowlist belongs on the step that runs the merged document and fails the merge when set.";
    readonly default: "";
    readonly summary: "Comma-separated allowlist of sections to process (apply, check, and snapshot; rejected in `mode: merge`)";
    readonly shownDefault: "(all declared)";
    readonly list: true;
  };
  readonly "api-version": {
    readonly description: "X-GitHub-Api-Version header value. Override to opt into a newer REST API version before this action defaults to it.";
    readonly default: "2022-11-28";
    readonly summary: "`X-GitHub-Api-Version` header; override to opt into a newer REST API version";
  };
  readonly repos: {
    readonly description: string;
    readonly default: "";
    readonly summary: "Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos";
    readonly list: true;
  };
  readonly "repos-dir": {
    readonly description: "Multi-repo central mode: a directory in the checked-out admin repository holding per-repo settings files - <name>.yml (same owner as this repository) or <owner>/<name>.yml. Requires actions/checkout.";
    readonly default: "";
    readonly summary: "Multi-repo central mode: directory of per-repo settings files in this repo";
  };
  readonly "defaults-file": {
    readonly description: string;
    readonly default: "";
    readonly summary: "YAML applied to every multi-repo target without a settings file (multi-repo mode only)";
  };
  readonly layering: {
    readonly description: string;
    readonly default: "";
    readonly summary: "`mode: merge` only: `merge` unions the keyed list sections (labels, rulesets) by key across layers, `replace` lets the higher layer's list win; a layer's `_layering` overrides it";
    readonly shownDefault: "`merge`";
  };
  readonly "private-repos": {
    readonly description: string;
    readonly default: "redact";
    readonly summary: "`redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them";
  };
  readonly "private-report": {
    readonly description: string;
    readonly default: "none";
    readonly summary: string;
  };
  readonly "report-public-key": {
    readonly description: string;
    readonly default: "";
    readonly summary: "The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise";
  };
  readonly visibility: {
    readonly description: 'Keeps only repositories of this visibility in repos: "*" discovery. One of all (default), public, private, or internal; internal is matched client-side (Enterprise only). Fails if set without repos: "*".';
    readonly default: "";
    readonly summary: "Discovery-only: keep `public`, `private`, or `internal` repositories";
    readonly shownDefault: "`all`" | "`internal`" | "`private`" | "`public`";
  };
  readonly archived: {
    readonly description: 'Archived-repository policy for repos: "*" discovery. One of skip (default; settings writes fail on archived repositories), include, or only (mostly useful with mode: check). Fails if set without repos: "*".';
    readonly default: "";
    readonly summary: "Discovery-only: `skip`, `include`, or `only` archived repositories";
    readonly shownDefault: "`include`" | "`only`" | "`skip`";
  };
  readonly forks: {
    readonly description: 'Fork policy for repos: "*" discovery. One of include (default), exclude, or only. Fails if set without repos: "*".';
    readonly default: "";
    readonly summary: "Discovery-only: `include`, `exclude`, or `only` forks";
    readonly shownDefault: "`exclude`" | "`include`" | "`only`";
  };
  readonly exclude: {
    readonly description: string;
    readonly default: "";
    readonly summary: "Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop";
    readonly list: true;
  };
  readonly topics: {
    readonly description: 'Comma- or newline-separated topics; repos: "*" discovery keeps only repositories carrying at least one of them. Unrelated to the topics settings section. Fails if set without repos: "*".';
    readonly default: "";
    readonly summary: "Discovery-only: keep repositories carrying at least one listed topic";
    readonly list: true;
  };
  readonly affiliation: {
    readonly description: string;
    readonly default: "";
    readonly summary: "Discovery-only: `owner`, `collaborator`, `organization_member` (comma list)";
    readonly shownDefault: `\`${string}\``;
    readonly list: true;
  };
};
type InputName = keyof typeof INPUT_DECLS;
/** Empty when unset; parseConfig trims, so a port need not. */
type InputReader = (name: InputName) => string;
/**
 * process.env's shape; a caller outside Actions passes what it has, or nothing.
 *   GITHUB_TOKEN                       -> the token fallback
 *   GITHUB_REPOSITORY                  -> the workflow's own repository
 *   GITHUB_SERVER_URL, GITHUB_RUN_ID   -> the run URL
 */
type ConfigEnv = Readonly<Record<string, string | undefined>>;
export declare const FILTER_INPUTS: readonly ["visibility", "archived", "forks", "exclude", "topics", "affiliation"];
export declare const MODES: readonly ["apply", "check", "merge", "snapshot"];
type Mode = (typeof MODES)[number];
/**
 * Their declared defaults are empty so "explicitly set" is detectable, as with the discovery filters; apply and check
 * reject a set one instead of silently ignoring it.
 */
export declare const MERGE_ONLY_INPUTS: readonly ["merged-file", "layering"];
export declare const SNAPSHOT_ONLY_INPUTS: readonly ["snapshot-file", "snapshot-dir"];
/** selfSlug (GITHUB_REPOSITORY) and runUrl are read from the environment once here, so the run flows stay env-free. */
interface CommonConfig extends RunFlowConfig {
  token: string;
  apiVersion: string;
}
type RunConfig = (CommonConfig & (({
  kind: "single";
} & SingleConfig) | ({
  kind: "multi";
} & MultiConfig))) | ({
  kind: "merge";
} & MergeConfig) | ({
  kind: "snapshot";
} & Pick<CommonConfig, "token" | "apiVersion"> & SnapshotConfig);
/**
 * `token` is tolerated unread (a workflow commonly sets it on every step). Every declared input NOT listed here is an
 * apply/check control, so the merge rejects it unless it holds its declared default, which the runner supplies whether
 * or not the workflow set the input.
 */
export declare const MERGE_INPUTS: readonly ["mode", "settings-file", "merged-file", "layering", "token"];
/**
 * Derived from the declarations, so a future input is rejected by the merge until listed in MERGE_INPUTS; exported so
 * the layering guide's table is pinned to the whole set.
 */
export declare const MERGE_REJECTED_INPUTS: readonly InputName[];
/**
 * Every declared input NOT listed here is an apply, check, or merge control, so the snapshot rejects it unless it
 * holds its declared default, which the runner supplies whether or not the workflow set the input.
 */
export declare const SNAPSHOT_INPUTS: readonly ["token", "repository", "mode", "snapshot-file", "snapshot-dir", "on-missing-permission", "sections", "api-version", "repos", "repos-dir", "private-repos", "visibility", "archived", "forks", "exclude", "topics", "affiliation"];
/**
 * Derived from the declarations, so a future input is rejected by the snapshot until listed in SNAPSHOT_INPUTS;
 * exported so the snapshot guide's table is pinned to the whole set.
 */
export declare const SNAPSHOT_REJECTED_INPUTS: readonly InputName[];
/** Read and validate every input through `read`; the first problem wins. */
export declare function parseConfig(read: InputReader, env: ConfigEnv): Result<RunConfig, Problem>;
//#endregion
//#region src/flows/layers.d.ts
export declare function readLayerFiles(paths: readonly string[]): Result<Layer[], ProblemOf<"settings-file-unreadable">>;
/** A layer must be a valid document before it may contribute, so the merge can never complete a broken declaration into a valid one. */
export declare function foldLayers(layers: readonly Layer[], sourceLabel: string, layering: Layering, io: Io): Result<{
  settings: ValidatedSettings;
  notices: OptOutNotice[];
}, SettingsProblem | LayerProblem>;
//#endregion
//#region src/flows/library.d.ts
export declare function validateSettings(doc: unknown, options?: {
  source?: string;
  sections?: ReadonlySet<SectionKey>;
}): Result<{
  settings: ValidatedSettings;
  warnings: string[];
}, SettingsProblem>;
type RepoRunReport = RepoRunResult & {
  log: CollectedLine[];
};
export declare function checkRepository(client: GithubClient, opts: Omit<RepoRunOptions, "mode">, io?: Io): Promise<RepoRunReport>;
export declare function applyRepository(client: GithubClient, opts: Omit<RepoRunOptions, "mode">, io?: Io): Promise<RepoRunReport>;
/** The merged document exactly as mode: merge writes it to merged-file. */
export declare function renderMergedYaml(settings: ValidatedSettings): string;
/** What a library snapshot may narrow: the selection, the denial policy, and the Io the lines go to. */
interface SnapshotLibraryOptions {
  sections?: SectionSelection;
  onMissingPermission?: "fail" | "warn";
  io?: Io;
}
/**
 * The engine's snapshot result plus the file text mode: snapshot would write
 * (absent exactly when the result is failed, which carries no document) and
 * every line the run printed when the caller brought no Io of their own.
 */
type SnapshotReport = ((RenderableSnapshot & {
  yaml: string;
}) | (Extract<SnapshotResult, {
  result: "failed";
}> & {
  yaml?: never;
})) & {
  log: CollectedLine[];
};
/** Read one repository's supported sections back as a settings document and its rendered file. */
export declare function snapshotRepository(client: GithubClient, repo: RepoRef, options?: SnapshotLibraryOptions): Promise<SnapshotReport>;
/** Snapshot several repositories in order, one report each; a failed target never stops the rest. */
export declare function snapshotRepositories(client: GithubClient, targets: readonly RepoRef[], options?: SnapshotLibraryOptions): Promise<SnapshotReport[]>;
//#endregion
//#region src/flows/settings-read.d.ts
/**
 * `logLevel: "error"` is load-bearing: at its default the parser reports a warning (an unresolved tag, an anchor ending
 * in ":") on a SUCCESSFUL parse through process.emitWarning, quoting the offending source line with its values straight
 * to stderr, which nothing here redacts. Empty and null documents become {}.
 *
 * "error"   -> warnings silent; a syntax error still throws into the error path
 * "silent"  -> would also swallow the syntax errors
 */
export declare function parseSettingsDoc(raw: string): Result<unknown, ProblemOf<"yaml-invalid">>;
export declare function readSettingsFile(path: string, role: SettingsFileRole): Result<unknown, ProblemOf<"settings-file-unreadable">>;
//#endregion
//#region src/github/repo-file.d.ts
export declare function getRepoFile(api: GithubClient, slug: string, filePath: string): Promise<{
  content: string;
} | {
  missing: true;
} | {
  unproven: string;
} | {
  error: ApiError;
}>;
//#endregion
//#region src/report/composer.d.ts
interface TranscriptLine {
  level?: AnnotationLevel;
  line: string;
}
interface OutcomeRow {
  key: string;
  status: string;
  detail: string[];
}
interface ReportInput {
  /** The target's owner/name slug, unredacted: this document is private. */
  target: string;
  adminRepo: string;
  runUrl: string;
  mode: string;
  result: string;
  timestamp: string;
  outcomes: OutcomeRow[];
  transcript: TranscriptLine[];
}
export declare function composeReport(input: ReportInput): string;
//#endregion
//#region src/report/issue-report.d.ts
/** The lookup key: one exact-titled report issue per repo, forever reused. */
export declare const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
/** Makes the lookup one indexed request; the search API is eventually consistent and separately throttled, so it is never used. */
export declare const MARKER_LABEL = "settings-as-code-report";
export declare const MARKER_LABEL_CONFIG: {
  readonly name: "settings-as-code-report";
  readonly color: "0e2a47";
  readonly description: "managed by settings-as-code private reporting - do not remove";
};
//#endregion
export type { AnnotationLevel, ApiError, ArtifactUploader, CentralFileProblem, CentralTarget, CollectedLine, ConfigEnv, DiscoveryFilters, DiscoveryProblem, EndpointDecl, FinishedMerge, FinishedSnapshot, GithubClient, GraphqlOp, GraphqlOpDecl, InputDecl, InputName, InputReader, Io, Justification, KeyedListLayering, Layer, LayerProblem, Layering, MaskPair, MergeConfig, Mode, MultiConfig, MustBeNever, OptOutNotice, OutputName, PatResource, PlannedOpBase, PrivateReportChannel, PrivateReposPolicy, Problem, ProblemOf, PublicTargetView, RemoteTarget, RenderableSnapshot, RepoRef, RepoResult, RepoRunOptions, RepoRunReport, RepoRunResult, RepoVisibility, ReportInput, ResolvedTargets, Route, RunConfig, RunFlowConfig, SectionKey, SectionMeta, SectionModule, SectionOutcome, SectionPermission, SettingsFileRole, SettingsProblem, SingleConfig, SingleOutcome, SnapshotConfig, SnapshotLibraryOptions, SnapshotReport, SnapshotResult, SnapshotRunResult, SnapshotTargetView, TaggedEndpoint, Target, TargetOutcome, TargetsConfig, Tolerance, TopLevelShape, TraceIo, UndeclaredPolicy, UndeclaredPolicyList, UndeclaredPolicySection, Unverifiable, ValidatedSettings };
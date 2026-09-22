import { Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { Endpoints } from "@octokit/types";
import "@octokit/openapi-types";
//#region src/sections/shared/schema-helpers.d.ts
declare const UndeclaredPolicySchema: z.ZodEnum<{
  delete: "delete";
  keep: "keep";
}>;
/**
 * The one value set of the `_layering` directive and the `layering` run input; engine/layers.ts acts on it and
 * re-exports it to the flows. Described in docs/sections/shared.docs.yml and docs/schema.docs.yml.
 *
 *   replace  -> the higher list replaces the whole lower list
 *   shallow  -> union by key; a same-key entry is swapped for the higher one
 *   deep     -> union by key; a same-key pair merges field by field, nested keyed lists included
 */
declare const LAYERINGS: readonly ["replace", "shallow", "deep"];
type Layering = (typeof LAYERINGS)[number];
//#endregion
//#region src/schema.d.ts
declare const SettingsFile: z.ZodObject<{
  repository: z.ZodOptional<z.ZodObject<{
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    homepage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    private: z.ZodOptional<z.ZodBoolean>;
    visibility: z.ZodOptional<z.ZodString>;
    security_and_analysis: z.ZodOptional<z.ZodNullable<z.ZodObject<{
      advanced_security: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      code_security: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_push_protection: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_ai_detection: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_non_provider_patterns: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_delegated_alert_dismissal: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_delegated_bypass: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
      secret_scanning_delegated_bypass_options: z.ZodOptional<z.ZodObject<{
        reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
          reviewer_id: z.ZodInt;
          reviewer_type: z.ZodEnum<{
            ROLE: "ROLE";
            TEAM: "TEAM";
          }>;
          mode: z.ZodOptional<z.ZodEnum<{
            ALWAYS: "ALWAYS";
            EXEMPT: "EXEMPT";
          }>>;
        }, z.core.$strict>>>;
      }, z.core.$strict>>;
      secret_scanning_validity_checks: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
          disabled: "disabled";
          enabled: "enabled";
        }>>;
      }, z.core.$strict>>;
    }, z.core.$strict>>>;
    has_issues: z.ZodOptional<z.ZodBoolean>;
    has_projects: z.ZodOptional<z.ZodBoolean>;
    has_wiki: z.ZodOptional<z.ZodBoolean>;
    has_discussions: z.ZodOptional<z.ZodBoolean>;
    has_pull_requests: z.ZodOptional<z.ZodBoolean>;
    pull_request_creation_policy: z.ZodOptional<z.ZodEnum<{
      all: "all";
      collaborators_only: "collaborators_only";
    }>>;
    is_template: z.ZodOptional<z.ZodBoolean>;
    default_branch: z.ZodOptional<z.ZodString>;
    allow_squash_merge: z.ZodOptional<z.ZodBoolean>;
    allow_merge_commit: z.ZodOptional<z.ZodBoolean>;
    allow_rebase_merge: z.ZodOptional<z.ZodBoolean>;
    allow_auto_merge: z.ZodOptional<z.ZodBoolean>;
    delete_branch_on_merge: z.ZodOptional<z.ZodBoolean>;
    allow_update_branch: z.ZodOptional<z.ZodBoolean>;
    use_squash_pr_title_as_default: z.ZodOptional<z.ZodBoolean>;
    squash_merge_commit_title: z.ZodOptional<z.ZodEnum<{
      COMMIT_OR_PR_TITLE: "COMMIT_OR_PR_TITLE";
      PR_TITLE: "PR_TITLE";
    }>>;
    squash_merge_commit_message: z.ZodOptional<z.ZodEnum<{
      BLANK: "BLANK";
      COMMIT_MESSAGES: "COMMIT_MESSAGES";
      PR_BODY: "PR_BODY";
    }>>;
    merge_commit_title: z.ZodOptional<z.ZodEnum<{
      MERGE_MESSAGE: "MERGE_MESSAGE";
      PR_TITLE: "PR_TITLE";
    }>>;
    merge_commit_message: z.ZodOptional<z.ZodEnum<{
      BLANK: "BLANK";
      PR_BODY: "PR_BODY";
      PR_TITLE: "PR_TITLE";
    }>>;
    archived: z.ZodOptional<z.ZodBoolean>;
    allow_forking: z.ZodOptional<z.ZodBoolean>;
    web_commit_signoff_required: z.ZodOptional<z.ZodBoolean>;
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
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      color: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      new_name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  rulesets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    target: z.ZodDefault<z.ZodEnum<{
      branch: "branch";
      push: "push";
      tag: "tag";
    }>>;
    enforcement: z.ZodDefault<z.ZodEnum<{
      active: "active";
      disabled: "disabled";
      evaluate: "evaluate";
    }>>;
    conditions: z.ZodOptional<z.ZodObject<{
      ref_name: z.ZodOptional<z.ZodObject<{
        include: z.ZodOptional<z.ZodArray<z.ZodString>>;
        exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>>;
    }, z.core.$strip>>;
    rules: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"creation">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"update">;
      parameters: z.ZodOptional<z.ZodObject<{
        update_allows_fetch_and_merge: z.ZodBoolean;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"deletion">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"required_linear_history">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"merge_queue">;
      parameters: z.ZodOptional<z.ZodObject<{
        check_response_timeout_minutes: z.ZodInt;
        grouping_strategy: z.ZodEnum<{
          ALLGREEN: "ALLGREEN";
          HEADGREEN: "HEADGREEN";
        }>;
        max_entries_to_build: z.ZodInt;
        max_entries_to_merge: z.ZodInt;
        merge_method: z.ZodEnum<{
          MERGE: "MERGE";
          REBASE: "REBASE";
          SQUASH: "SQUASH";
        }>;
        min_entries_to_merge: z.ZodInt;
        min_entries_to_merge_wait_minutes: z.ZodInt;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"required_deployments">;
      parameters: z.ZodOptional<z.ZodObject<{
        required_deployment_environments: z.ZodArray<z.ZodString>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"required_signatures">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"pull_request">;
      parameters: z.ZodOptional<z.ZodObject<{
        allowed_merge_methods: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          merge: "merge";
          rebase: "rebase";
          squash: "squash";
        }>>>;
        dismiss_stale_reviews_on_push: z.ZodBoolean;
        dismissal_restriction: z.ZodOptional<z.ZodObject<{
          allowed_actors: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodInt;
            type: z.ZodEnum<{
              IntegrationInstallation: "IntegrationInstallation";
              RepositoryRole: "RepositoryRole";
              Team: "Team";
              User: "User";
            }>;
          }, z.core.$loose>>>;
          enabled: z.ZodBoolean;
        }, z.core.$loose>>;
        require_code_owner_review: z.ZodBoolean;
        require_last_push_approval: z.ZodBoolean;
        required_approving_review_count: z.ZodInt;
        required_review_thread_resolution: z.ZodBoolean;
        required_reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
          file_patterns: z.ZodArray<z.ZodString>;
          minimum_approvals: z.ZodInt;
          reviewer: z.ZodObject<{
            id: z.ZodInt;
            type: z.ZodLiteral<"Team">;
          }, z.core.$loose>;
        }, z.core.$loose>>>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"required_status_checks">;
      parameters: z.ZodOptional<z.ZodObject<{
        do_not_enforce_on_create: z.ZodOptional<z.ZodBoolean>;
        required_status_checks: z.ZodArray<z.ZodObject<{
          context: z.ZodString;
          integration_id: z.ZodOptional<z.ZodInt>;
        }, z.core.$loose>>;
        strict_required_status_checks_policy: z.ZodBoolean;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"non_fast_forward">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"commit_message_pattern">;
      parameters: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        negate: z.ZodOptional<z.ZodBoolean>;
        operator: z.ZodEnum<{
          contains: "contains";
          ends_with: "ends_with";
          regex: "regex";
          starts_with: "starts_with";
        }>;
        pattern: z.ZodString;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"commit_author_email_pattern">;
      parameters: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        negate: z.ZodOptional<z.ZodBoolean>;
        operator: z.ZodEnum<{
          contains: "contains";
          ends_with: "ends_with";
          regex: "regex";
          starts_with: "starts_with";
        }>;
        pattern: z.ZodString;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"committer_email_pattern">;
      parameters: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        negate: z.ZodOptional<z.ZodBoolean>;
        operator: z.ZodEnum<{
          contains: "contains";
          ends_with: "ends_with";
          regex: "regex";
          starts_with: "starts_with";
        }>;
        pattern: z.ZodString;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"branch_name_pattern">;
      parameters: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        negate: z.ZodOptional<z.ZodBoolean>;
        operator: z.ZodEnum<{
          contains: "contains";
          ends_with: "ends_with";
          regex: "regex";
          starts_with: "starts_with";
        }>;
        pattern: z.ZodString;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"tag_name_pattern">;
      parameters: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        negate: z.ZodOptional<z.ZodBoolean>;
        operator: z.ZodEnum<{
          contains: "contains";
          ends_with: "ends_with";
          regex: "regex";
          starts_with: "starts_with";
        }>;
        pattern: z.ZodString;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"workflows">;
      parameters: z.ZodOptional<z.ZodObject<{
        do_not_enforce_on_create: z.ZodOptional<z.ZodBoolean>;
        workflows: z.ZodArray<z.ZodObject<{
          path: z.ZodString;
          ref: z.ZodOptional<z.ZodString>;
          repository_id: z.ZodInt;
          sha: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"code_scanning">;
      parameters: z.ZodOptional<z.ZodObject<{
        code_scanning_tools: z.ZodArray<z.ZodObject<{
          alerts_threshold: z.ZodEnum<{
            all: "all";
            errors: "errors";
            errors_and_warnings: "errors_and_warnings";
            none: "none";
          }>;
          security_alerts_threshold: z.ZodEnum<{
            all: "all";
            critical: "critical";
            high_or_higher: "high_or_higher";
            medium_or_higher: "medium_or_higher";
            none: "none";
          }>;
          tool: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"copilot_code_review">;
      parameters: z.ZodOptional<z.ZodObject<{
        review_draft_pull_requests: z.ZodOptional<z.ZodBoolean>;
        review_on_push: z.ZodOptional<z.ZodBoolean>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"license_compliance_scanning">;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"file_path_restriction">;
      parameters: z.ZodOptional<z.ZodObject<{
        restricted_file_paths: z.ZodArray<z.ZodString>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"max_file_path_length">;
      parameters: z.ZodOptional<z.ZodObject<{
        max_file_path_length: z.ZodInt;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"file_extension_restriction">;
      parameters: z.ZodOptional<z.ZodObject<{
        restricted_file_extensions: z.ZodArray<z.ZodString>;
      }, z.core.$loose>>;
    }, z.core.$loose>, z.ZodObject<{
      type: z.ZodLiteral<"max_file_size">;
      parameters: z.ZodOptional<z.ZodObject<{
        max_file_size: z.ZodInt;
      }, z.core.$loose>>;
    }, z.core.$loose>], "type">, z.ZodObject<{
      type: z.ZodString;
      parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$loose>]>>>;
    bypass_actors: z.ZodOptional<z.ZodArray<z.ZodObject<{
      actor_id: z.ZodOptional<z.ZodNullable<z.ZodInt>>;
      actor_type: z.ZodEnum<{
        DeployKey: "DeployKey";
        Integration: "Integration";
        OrganizationAdmin: "OrganizationAdmin";
        RepositoryRole: "RepositoryRole";
        Team: "Team";
        User: "User";
      }>;
      bypass_mode: z.ZodOptional<z.ZodEnum<{
        always: "always";
        exempt: "exempt";
        pull_request: "pull_request";
      }>>;
    }, z.core.$loose>>>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      target: z.ZodDefault<z.ZodEnum<{
        branch: "branch";
        push: "push";
        tag: "tag";
      }>>;
      enforcement: z.ZodDefault<z.ZodEnum<{
        active: "active";
        disabled: "disabled";
        evaluate: "evaluate";
      }>>;
      conditions: z.ZodOptional<z.ZodObject<{
        ref_name: z.ZodOptional<z.ZodObject<{
          include: z.ZodOptional<z.ZodArray<z.ZodString>>;
          exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>>;
      rules: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"creation">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"update">;
        parameters: z.ZodOptional<z.ZodObject<{
          update_allows_fetch_and_merge: z.ZodBoolean;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"deletion">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"required_linear_history">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"merge_queue">;
        parameters: z.ZodOptional<z.ZodObject<{
          check_response_timeout_minutes: z.ZodInt;
          grouping_strategy: z.ZodEnum<{
            ALLGREEN: "ALLGREEN";
            HEADGREEN: "HEADGREEN";
          }>;
          max_entries_to_build: z.ZodInt;
          max_entries_to_merge: z.ZodInt;
          merge_method: z.ZodEnum<{
            MERGE: "MERGE";
            REBASE: "REBASE";
            SQUASH: "SQUASH";
          }>;
          min_entries_to_merge: z.ZodInt;
          min_entries_to_merge_wait_minutes: z.ZodInt;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"required_deployments">;
        parameters: z.ZodOptional<z.ZodObject<{
          required_deployment_environments: z.ZodArray<z.ZodString>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"required_signatures">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"pull_request">;
        parameters: z.ZodOptional<z.ZodObject<{
          allowed_merge_methods: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            merge: "merge";
            rebase: "rebase";
            squash: "squash";
          }>>>;
          dismiss_stale_reviews_on_push: z.ZodBoolean;
          dismissal_restriction: z.ZodOptional<z.ZodObject<{
            allowed_actors: z.ZodOptional<z.ZodArray<z.ZodObject<{
              id: z.ZodInt;
              type: z.ZodEnum<{
                IntegrationInstallation: "IntegrationInstallation";
                RepositoryRole: "RepositoryRole";
                Team: "Team";
                User: "User";
              }>;
            }, z.core.$loose>>>;
            enabled: z.ZodBoolean;
          }, z.core.$loose>>;
          require_code_owner_review: z.ZodBoolean;
          require_last_push_approval: z.ZodBoolean;
          required_approving_review_count: z.ZodInt;
          required_review_thread_resolution: z.ZodBoolean;
          required_reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            file_patterns: z.ZodArray<z.ZodString>;
            minimum_approvals: z.ZodInt;
            reviewer: z.ZodObject<{
              id: z.ZodInt;
              type: z.ZodLiteral<"Team">;
            }, z.core.$loose>;
          }, z.core.$loose>>>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"required_status_checks">;
        parameters: z.ZodOptional<z.ZodObject<{
          do_not_enforce_on_create: z.ZodOptional<z.ZodBoolean>;
          required_status_checks: z.ZodArray<z.ZodObject<{
            context: z.ZodString;
            integration_id: z.ZodOptional<z.ZodInt>;
          }, z.core.$loose>>;
          strict_required_status_checks_policy: z.ZodBoolean;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"non_fast_forward">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"commit_message_pattern">;
        parameters: z.ZodOptional<z.ZodObject<{
          name: z.ZodOptional<z.ZodString>;
          negate: z.ZodOptional<z.ZodBoolean>;
          operator: z.ZodEnum<{
            contains: "contains";
            ends_with: "ends_with";
            regex: "regex";
            starts_with: "starts_with";
          }>;
          pattern: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"commit_author_email_pattern">;
        parameters: z.ZodOptional<z.ZodObject<{
          name: z.ZodOptional<z.ZodString>;
          negate: z.ZodOptional<z.ZodBoolean>;
          operator: z.ZodEnum<{
            contains: "contains";
            ends_with: "ends_with";
            regex: "regex";
            starts_with: "starts_with";
          }>;
          pattern: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"committer_email_pattern">;
        parameters: z.ZodOptional<z.ZodObject<{
          name: z.ZodOptional<z.ZodString>;
          negate: z.ZodOptional<z.ZodBoolean>;
          operator: z.ZodEnum<{
            contains: "contains";
            ends_with: "ends_with";
            regex: "regex";
            starts_with: "starts_with";
          }>;
          pattern: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"branch_name_pattern">;
        parameters: z.ZodOptional<z.ZodObject<{
          name: z.ZodOptional<z.ZodString>;
          negate: z.ZodOptional<z.ZodBoolean>;
          operator: z.ZodEnum<{
            contains: "contains";
            ends_with: "ends_with";
            regex: "regex";
            starts_with: "starts_with";
          }>;
          pattern: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"tag_name_pattern">;
        parameters: z.ZodOptional<z.ZodObject<{
          name: z.ZodOptional<z.ZodString>;
          negate: z.ZodOptional<z.ZodBoolean>;
          operator: z.ZodEnum<{
            contains: "contains";
            ends_with: "ends_with";
            regex: "regex";
            starts_with: "starts_with";
          }>;
          pattern: z.ZodString;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"workflows">;
        parameters: z.ZodOptional<z.ZodObject<{
          do_not_enforce_on_create: z.ZodOptional<z.ZodBoolean>;
          workflows: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            ref: z.ZodOptional<z.ZodString>;
            repository_id: z.ZodInt;
            sha: z.ZodOptional<z.ZodString>;
          }, z.core.$loose>>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"code_scanning">;
        parameters: z.ZodOptional<z.ZodObject<{
          code_scanning_tools: z.ZodArray<z.ZodObject<{
            alerts_threshold: z.ZodEnum<{
              all: "all";
              errors: "errors";
              errors_and_warnings: "errors_and_warnings";
              none: "none";
            }>;
            security_alerts_threshold: z.ZodEnum<{
              all: "all";
              critical: "critical";
              high_or_higher: "high_or_higher";
              medium_or_higher: "medium_or_higher";
              none: "none";
            }>;
            tool: z.ZodString;
          }, z.core.$loose>>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"copilot_code_review">;
        parameters: z.ZodOptional<z.ZodObject<{
          review_draft_pull_requests: z.ZodOptional<z.ZodBoolean>;
          review_on_push: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"license_compliance_scanning">;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"file_path_restriction">;
        parameters: z.ZodOptional<z.ZodObject<{
          restricted_file_paths: z.ZodArray<z.ZodString>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"max_file_path_length">;
        parameters: z.ZodOptional<z.ZodObject<{
          max_file_path_length: z.ZodInt;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"file_extension_restriction">;
        parameters: z.ZodOptional<z.ZodObject<{
          restricted_file_extensions: z.ZodArray<z.ZodString>;
        }, z.core.$loose>>;
      }, z.core.$loose>, z.ZodObject<{
        type: z.ZodLiteral<"max_file_size">;
        parameters: z.ZodOptional<z.ZodObject<{
          max_file_size: z.ZodInt;
        }, z.core.$loose>>;
      }, z.core.$loose>], "type">, z.ZodObject<{
        type: z.ZodString;
        parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$loose>]>>>;
      bypass_actors: z.ZodOptional<z.ZodArray<z.ZodObject<{
        actor_id: z.ZodOptional<z.ZodNullable<z.ZodInt>>;
        actor_type: z.ZodEnum<{
          DeployKey: "DeployKey";
          Integration: "Integration";
          OrganizationAdmin: "OrganizationAdmin";
          RepositoryRole: "RepositoryRole";
          Team: "Team";
          User: "User";
        }>;
        bypass_mode: z.ZodOptional<z.ZodEnum<{
          always: "always";
          exempt: "exempt";
          pull_request: "pull_request";
        }>>;
      }, z.core.$loose>>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  branches: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    protection: z.ZodNullable<z.ZodObject<{
      required_status_checks: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        strict: z.ZodBoolean;
        contexts: z.ZodOptional<z.ZodArray<z.ZodString>>;
        checks: z.ZodOptional<z.ZodArray<z.ZodObject<{
          context: z.ZodString;
          app_id: z.ZodOptional<z.ZodNullable<z.ZodInt>>;
        }, z.core.$strict>>>;
      }, z.core.$loose>>>;
      required_pull_request_reviews: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        required_approving_review_count: z.ZodOptional<z.ZodInt>;
        dismissal_restrictions: z.ZodOptional<z.ZodObject<{
          users: z.ZodOptional<z.ZodArray<z.ZodString>>;
          teams: z.ZodOptional<z.ZodArray<z.ZodString>>;
          apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
        bypass_pull_request_allowances: z.ZodOptional<z.ZodObject<{
          users: z.ZodOptional<z.ZodArray<z.ZodString>>;
          teams: z.ZodOptional<z.ZodArray<z.ZodString>>;
          apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>;
      }, z.core.$loose>>>;
      restrictions: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        users: z.ZodArray<z.ZodString>;
        teams: z.ZodArray<z.ZodString>;
        apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$loose>>>;
      required_signatures: z.ZodOptional<z.ZodBoolean>;
      force_push_bypassers: z.ZodOptional<z.ZodArray<z.ZodString>>;
      required_deployments: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        environments: z.ZodArray<z.ZodString>;
      }, z.core.$strict>>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>, z.ZodObject<{
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      protection: z.ZodNullable<z.ZodObject<{
        required_status_checks: z.ZodOptional<z.ZodNullable<z.ZodObject<{
          strict: z.ZodBoolean;
          contexts: z.ZodOptional<z.ZodArray<z.ZodString>>;
          checks: z.ZodOptional<z.ZodArray<z.ZodObject<{
            context: z.ZodString;
            app_id: z.ZodOptional<z.ZodNullable<z.ZodInt>>;
          }, z.core.$strict>>>;
        }, z.core.$loose>>>;
        required_pull_request_reviews: z.ZodOptional<z.ZodNullable<z.ZodObject<{
          required_approving_review_count: z.ZodOptional<z.ZodInt>;
          dismissal_restrictions: z.ZodOptional<z.ZodObject<{
            users: z.ZodOptional<z.ZodArray<z.ZodString>>;
            teams: z.ZodOptional<z.ZodArray<z.ZodString>>;
            apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
          }, z.core.$loose>>;
          bypass_pull_request_allowances: z.ZodOptional<z.ZodObject<{
            users: z.ZodOptional<z.ZodArray<z.ZodString>>;
            teams: z.ZodOptional<z.ZodArray<z.ZodString>>;
            apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
          }, z.core.$loose>>;
        }, z.core.$loose>>>;
        restrictions: z.ZodOptional<z.ZodNullable<z.ZodObject<{
          users: z.ZodArray<z.ZodString>;
          teams: z.ZodArray<z.ZodString>;
          apps: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$loose>>>;
        required_signatures: z.ZodOptional<z.ZodBoolean>;
        force_push_bypassers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        required_deployments: z.ZodOptional<z.ZodNullable<z.ZodObject<{
          environments: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
      }, z.core.$loose>>;
    }, z.core.$strip>>;
  }, z.core.$strict>]>>;
  environments: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    pinned: z.ZodOptional<z.ZodBoolean>;
    wait_timer: z.ZodOptional<z.ZodInt>;
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
      type: z.ZodOptional<z.ZodEnum<{
        branch: "branch";
        tag: "tag";
      }>>;
    }, z.core.$strip>>, z.ZodObject<{
      _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<{
          branch: "branch";
          tag: "tag";
        }>>;
      }, z.core.$strip>>;
    }, z.core.$strict>]>>;
    deployment_protection_rules: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      app: z.ZodString;
    }, z.core.$strict>>, z.ZodObject<{
      _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
      entries: z.ZodArray<z.ZodObject<{
        app: z.ZodString;
      }, z.core.$strict>>;
    }, z.core.$strict>]>>;
    variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>, z.ZodObject<{
      _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$strict>]>>;
    secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strict>>, z.ZodObject<{
      _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
      entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strict>>;
    }, z.core.$strict>]>>;
  }, z.core.$strip>>, z.ZodObject<{
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      pinned: z.ZodOptional<z.ZodBoolean>;
      wait_timer: z.ZodOptional<z.ZodInt>;
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
        type: z.ZodOptional<z.ZodEnum<{
          branch: "branch";
          tag: "tag";
        }>>;
      }, z.core.$strip>>, z.ZodObject<{
        _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
        entries: z.ZodArray<z.ZodObject<{
          name: z.ZodString;
          type: z.ZodOptional<z.ZodEnum<{
            branch: "branch";
            tag: "tag";
          }>>;
        }, z.core.$strip>>;
      }, z.core.$strict>]>>;
      deployment_protection_rules: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
        app: z.ZodString;
      }, z.core.$strict>>, z.ZodObject<{
        _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
        entries: z.ZodArray<z.ZodObject<{
          app: z.ZodString;
        }, z.core.$strict>>;
      }, z.core.$strict>]>>;
      variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strip>>, z.ZodObject<{
        _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
        entries: z.ZodArray<z.ZodObject<{
          name: z.ZodString;
          value: z.ZodString;
        }, z.core.$strip>>;
      }, z.core.$strict>]>>;
      secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
      }, z.core.$strict>>, z.ZodObject<{
        _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
        entries: z.ZodArray<z.ZodObject<{
          name: z.ZodString;
          value: z.ZodString;
        }, z.core.$strict>>;
      }, z.core.$strict>]>>;
    }, z.core.$strip>>;
  }, z.core.$strict>]>>;
  autolinks: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    key_prefix: z.ZodString;
    url_template: z.ZodString;
    is_alphanumeric: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      key_prefix: z.ZodString;
      url_template: z.ZodString;
      is_alphanumeric: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  actions: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    allowed_actions: z.ZodOptional<z.ZodEnum<{
      all: "all";
      local_only: "local_only";
      selected: "selected";
    }>>;
    sha_pinning_required: z.ZodOptional<z.ZodBoolean>;
    selected_actions: z.ZodOptional<z.ZodObject<{
      github_owned_allowed: z.ZodOptional<z.ZodBoolean>;
      verified_allowed: z.ZodOptional<z.ZodBoolean>;
      patterns_allowed: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
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
      days: z.ZodInt;
    }, z.core.$strip>>;
    cache: z.ZodOptional<z.ZodObject<{
      max_cache_retention_days: z.ZodOptional<z.ZodInt>;
      max_cache_size_gb: z.ZodOptional<z.ZodInt>;
    }, z.core.$strict>>;
    oidc_customization_sub: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
      use_default: z.ZodLiteral<true>;
      use_immutable_subject: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
      use_default: z.ZodLiteral<false>;
      include_claim_keys: z.ZodOptional<z.ZodArray<z.ZodString>>;
      use_immutable_subject: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>], "use_default">>;
    fork_pr_contributor_approval: z.ZodOptional<z.ZodObject<{
      approval_policy: z.ZodEnum<{
        all_external_contributors: "all_external_contributors";
        first_time_contributors: "first_time_contributors";
        first_time_contributors_new_to_github: "first_time_contributors_new_to_github";
      }>;
    }, z.core.$strip>>;
    fork_pr_workflows_private_repos: z.ZodOptional<z.ZodObject<{
      run_workflows_from_fork_pull_requests: z.ZodBoolean;
      send_write_tokens_to_workflows: z.ZodOptional<z.ZodBoolean>;
      send_secrets_and_variables: z.ZodOptional<z.ZodBoolean>;
      require_approval_for_fork_pr_workflows: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
  }, z.core.$strip>>;
  actions_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  dependabot_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  codespaces_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  agents_secrets: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  workflows: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    state: z.ZodEnum<{
      active: "active";
      disabled: "disabled";
    }>;
  }, z.core.$strip>>, z.ZodObject<{
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
    entries: z.ZodArray<z.ZodObject<{
      path: z.ZodString;
      state: z.ZodEnum<{
        active: "active";
        disabled: "disabled";
      }>;
    }, z.core.$strip>>;
  }, z.core.$strict>]>>;
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
      path: z.ZodOptional<z.ZodEnum<{
        "/": "/";
        "/docs": "/docs";
      }>>;
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
    languages: z.ZodOptional<z.ZodArray<z.ZodEnum<{
      actions: "actions";
      "c-cpp": "c-cpp";
      csharp: "csharp";
      go: "go";
      "java-kotlin": "java-kotlin";
      "javascript-typescript": "javascript-typescript";
      python: "python";
      ruby: "ruby";
      swift: "swift";
    }>>>;
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
    languages: z.ZodOptional<z.ZodArray<z.ZodEnum<{
      csharp: "csharp";
      go: "go";
      "java-kotlin": "java-kotlin";
      "javascript-typescript": "javascript-typescript";
      python: "python";
      ruby: "ruby";
    }>>>;
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
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      username: z.ZodString;
      permission: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  teams: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    permission: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      permission: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  milestones: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodEnum<{
      closed: "closed";
      open: "open";
    }>>;
    due_on: z.ZodOptional<z.ZodUnion<readonly [z.ZodISODate, z.ZodISODateTime]>>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      title: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      state: z.ZodOptional<z.ZodEnum<{
        closed: "closed";
        open: "open";
      }>>;
      due_on: z.ZodOptional<z.ZodUnion<readonly [z.ZodISODate, z.ZodISODateTime]>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  interaction_limits: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    limit: z.ZodOptional<z.ZodEnum<{
      collaborators_only: "collaborators_only";
      contributors_only: "contributors_only";
      existing_users: "existing_users";
    }>>;
    expiry: z.ZodOptional<z.ZodEnum<{
      one_day: "one_day";
      one_month: "one_month";
      one_week: "one_week";
      six_months: "six_months";
      three_days: "three_days";
    }>>;
    pull_request_creation_cap: z.ZodOptional<z.ZodObject<{
      enabled: z.ZodBoolean;
      max_open_pull_requests: z.ZodOptional<z.ZodInt>;
    }, z.core.$strip>>;
    pull_request_creation_bypass: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strict>>>;
  actions_variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  agents_variables: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    value: z.ZodString;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  webhooks: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    name: z.ZodOptional<z.ZodLiteral<"web">>;
    config: z.ZodObject<{
      url: z.ZodURL;
      content_type: z.ZodOptional<z.ZodEnum<{
        form: "form";
        json: "json";
      }>>;
      secret: z.ZodOptional<z.ZodString>;
      insecure_ssl: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        0: "0";
        1: "1";
      }>, z.ZodLiteral<0>, z.ZodLiteral<1>]>>;
    }, z.core.$catchall<z.ZodUnknown>>;
    events: z.ZodOptional<z.ZodArray<z.ZodEnum<{
      "*": "*";
      branch_protection_configuration: "branch_protection_configuration";
      branch_protection_rule: "branch_protection_rule";
      check_run: "check_run";
      check_suite: "check_suite";
      code_scanning_alert: "code_scanning_alert";
      commit_comment: "commit_comment";
      create: "create";
      custom_property_values: "custom_property_values";
      delete: "delete";
      dependabot_alert: "dependabot_alert";
      deploy_key: "deploy_key";
      deployment: "deployment";
      deployment_status: "deployment_status";
      discussion: "discussion";
      discussion_comment: "discussion_comment";
      fork: "fork";
      gollum: "gollum";
      issue_comment: "issue_comment";
      issue_dependencies: "issue_dependencies";
      issues: "issues";
      label: "label";
      member: "member";
      meta: "meta";
      milestone: "milestone";
      package: "package";
      page_build: "page_build";
      ping: "ping";
      project: "project";
      project_card: "project_card";
      project_column: "project_column";
      public: "public";
      pull_request: "pull_request";
      pull_request_review: "pull_request_review";
      pull_request_review_comment: "pull_request_review_comment";
      pull_request_review_thread: "pull_request_review_thread";
      push: "push";
      registry_package: "registry_package";
      release: "release";
      repository: "repository";
      repository_advisory: "repository_advisory";
      repository_import: "repository_import";
      repository_ruleset: "repository_ruleset";
      repository_vulnerability_alert: "repository_vulnerability_alert";
      secret_scanning_alert: "secret_scanning_alert";
      secret_scanning_alert_location: "secret_scanning_alert_location";
      secret_scanning_scan: "secret_scanning_scan";
      security_and_analysis: "security_and_analysis";
      star: "star";
      status: "status";
      sub_issues: "sub_issues";
      team_add: "team_add";
      watch: "watch";
      workflow_job: "workflow_job";
      workflow_run: "workflow_run";
    }>>>;
    active: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodOptional<z.ZodLiteral<"web">>;
      config: z.ZodObject<{
        url: z.ZodURL;
        content_type: z.ZodOptional<z.ZodEnum<{
          form: "form";
          json: "json";
        }>>;
        secret: z.ZodOptional<z.ZodString>;
        insecure_ssl: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
          0: "0";
          1: "1";
        }>, z.ZodLiteral<0>, z.ZodLiteral<1>]>>;
      }, z.core.$catchall<z.ZodUnknown>>;
      events: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        "*": "*";
        branch_protection_configuration: "branch_protection_configuration";
        branch_protection_rule: "branch_protection_rule";
        check_run: "check_run";
        check_suite: "check_suite";
        code_scanning_alert: "code_scanning_alert";
        commit_comment: "commit_comment";
        create: "create";
        custom_property_values: "custom_property_values";
        delete: "delete";
        dependabot_alert: "dependabot_alert";
        deploy_key: "deploy_key";
        deployment: "deployment";
        deployment_status: "deployment_status";
        discussion: "discussion";
        discussion_comment: "discussion_comment";
        fork: "fork";
        gollum: "gollum";
        issue_comment: "issue_comment";
        issue_dependencies: "issue_dependencies";
        issues: "issues";
        label: "label";
        member: "member";
        meta: "meta";
        milestone: "milestone";
        package: "package";
        page_build: "page_build";
        ping: "ping";
        project: "project";
        project_card: "project_card";
        project_column: "project_column";
        public: "public";
        pull_request: "pull_request";
        pull_request_review: "pull_request_review";
        pull_request_review_comment: "pull_request_review_comment";
        pull_request_review_thread: "pull_request_review_thread";
        push: "push";
        registry_package: "registry_package";
        release: "release";
        repository: "repository";
        repository_advisory: "repository_advisory";
        repository_import: "repository_import";
        repository_ruleset: "repository_ruleset";
        repository_vulnerability_alert: "repository_vulnerability_alert";
        secret_scanning_alert: "secret_scanning_alert";
        secret_scanning_alert_location: "secret_scanning_alert_location";
        secret_scanning_scan: "secret_scanning_scan";
        security_and_analysis: "security_and_analysis";
        star: "star";
        status: "status";
        sub_issues: "sub_issues";
        team_add: "team_add";
        watch: "watch";
        workflow_job: "workflow_job";
        workflow_run: "workflow_run";
      }>>>;
      active: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  custom_properties: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    property_name: z.ZodString;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean, z.ZodNumber, z.ZodNull]>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      property_name: z.ZodString;
      value: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>, z.ZodBoolean, z.ZodNumber, z.ZodNull]>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  deploy_keys: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodObject<{
    title: z.ZodString;
    key: z.ZodString;
    read_only: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>, z.ZodObject<{
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      title: z.ZodString;
      key: z.ZodString;
      read_only: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
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
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      pattern: z.ZodString;
      start_delimiter: z.ZodOptional<z.ZodString>;
      end_delimiter: z.ZodOptional<z.ZodString>;
      must_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
      must_not_match: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    _layering: z.ZodOptional<z.ZodEnum<{
      deep: "deep";
      replace: "replace";
      shallow: "shallow";
    }>>;
  }, z.core.$strict>]>>;
  _layering: z.ZodOptional<z.ZodEnum<{
    deep: "deep";
    replace: "replace";
    shallow: "shallow";
  }>>;
  _undeclared: z.ZodOptional<z.ZodEnum<{
    delete: "delete";
    keep: "keep";
  }>>;
}, z.core.$strip>;
type SettingsFile = z.infer<typeof SettingsFile>;
/** Every recognized top-level section, in execution order. */
declare const SECTION_KEYS: readonly ["repository", "labels", "rulesets", "environments", "branches", "autolinks", "actions", "actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets", "workflows", "check_suite_preferences", "pages", "code_scanning_default_setup", "code_quality_setup", "collaborators", "teams", "milestones", "interaction_limits", "actions_variables", "agents_variables", "webhooks", "custom_properties", "deploy_keys", "secret_scanning_custom_patterns"];
type SectionKey = (typeof SECTION_KEYS)[number];
declare const UNDECLARED_POLICY_SECTIONS: readonly ["labels", "rulesets", "autolinks", "actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets", "collaborators", "teams", "milestones", "actions_variables", "agents_variables", "webhooks", "custom_properties", "deploy_keys", "secret_scanning_custom_patterns"];
type UndeclaredPolicySection = (typeof UNDECLARED_POLICY_SECTIONS)[number];
/**
 * Every list section, in execution order: the knobbed ones and the plain lists whose wrapper takes `_layering` alone.
 * The fold (engine/layers.ts) unions each by the key its module declares; ./sections/registry.ts requires that
 * declaration of every member, so a section added here without one fails to compile.
 */
declare const LIST_SECTIONS: readonly ["labels", "rulesets", "environments", "branches", "autolinks", "actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets", "workflows", "collaborators", "teams", "milestones", "actions_variables", "agents_variables", "webhooks", "custom_properties", "deploy_keys", "secret_scanning_custom_patterns"];
type ListSection = (typeof LIST_SECTIONS)[number];
/** Sections whose plain form (no wrapper) matches the Probot Settings app schema; docs/start/migrating-from-probot.md is pinned against this list. */
declare const PROBOT_PARITY_KEYS: readonly ["repository", "labels", "branches", "collaborators", "teams", "milestones"];
/**
 * Directives to the merge, not sections: declared on the document so the published schema types them.
 * validateSectionShapes copies only SECTION_KEYS, so none of them reaches the apply path.
 */
declare const DOCUMENT_DIRECTIVE_KEYS: readonly ["_layering", "_undeclared"];
//#endregion
//#region src/problem.d.ts
/**
 * The advice appended to a transient (non-permission) API failure: a network
 * blip or a 5xx that survived the retries. One source for the discovery
 * problems rendered here and multi.ts's remote-file read failure, so the "not
 * a permission problem" wording cannot drift between them. Face-neutral: the
 * action and the command line print the same line.
 */
declare const RERUN_ADVICE = "This is not a permission problem; re-run, and retry later if it persists";
/** Names as an error message lists them: each quoted, comma-separated. */
declare function quoteList(names: readonly string[]): string;
/** The run modes that read exactly one settings file. */
type EngineMode = "apply" | "check";
/** How a non-mapping settings document's top level reads, in typeof terms. */
type TopLevelShape = "list" | "null" | "undefined" | "boolean" | "number" | "bigint" | "string" | "symbol" | "function";
/** Which input named an unreadable settings file; each role's advice names its fix. */
type SettingsFileRole = "settings-file" | "defaults-file" | "layer" | "central-file";
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
  /** The value an unset input means; null when unset means "no value" (the `undeclared` input). */
  readonly fallback: string | null;
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
  readonly code: "input-rejected-in-render";
  readonly inputs: readonly string[];
} | {
  readonly code: "input-rendered-file-missing";
} | {
  readonly code: "input-settings-file-empty";
  readonly value: string;
} | {
  readonly code: "input-render-only";
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
  /** An engine mode reading its one file, or the command line's init, which writes one. */
  readonly mode: EngineMode | "init";
} | {
  readonly code: "input-repository-not-slug";
  readonly value: string;
} | {
  readonly code: "input-artifact-unsupported";
} | {
  readonly code: "settings-not-mapping";
  readonly source: string;
  readonly shape: TopLevelShape;
} | {
  readonly code: "settings-not-plain-mapping";
  readonly source: string;
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
  readonly expected: "a mapping" | "a list of mappings or an {_undeclared, entries} wrapper" | "a list of mappings or an {_layering, entries} wrapper";
  readonly actual: unknown;
  readonly detail?: " without an entries list";
} | {
  readonly code: "layer-bad-directive";
  readonly layer: string;
  readonly site: string;
  readonly actual: unknown;
  readonly allowed: readonly string[];
} | {
  readonly code: "layer-no-key";
  readonly layer: string;
  readonly site: string;
  readonly keyField: string;
  /** The field's kind in prose; "string" when the module says nothing else. */
  readonly keyKind?: string;
  /** The other paths of a composite identity (a reviewer's `type` beside its `id`), when the module names one. */
  readonly alongside?: readonly string[];
} | {
  readonly code: "layer-duplicate-key";
  readonly layer: string;
  readonly site: string;
  readonly keyField: string;
  readonly first: number;
  readonly second: number;
} | {
  readonly code: "layer-remove-not-true";
  readonly layer: string;
  readonly site: string;
  readonly actual: unknown;
} | {
  readonly code: "layer-remove-with-fields";
  readonly layer: string;
  readonly site: string;
  /** The dotted paths a removal names its entry by: the key field's own, or a composite (`type` and `id`). */
  readonly keyPaths: readonly string[];
  /** The dotted paths riding beside the key and the marker (`color`, `config.secret`), in the entry's order. */
  readonly extra: readonly string[];
} | {
  readonly code: "layer-remove-nothing";
  readonly layer: string;
  readonly site: string;
  /** replace: the higher list already wins; swapped: the entry is copied whole; unmatched: no lower entry claims the key. */
  readonly reason: "replace" | "swapped" | "unmatched";
} | {
  readonly code: "required-sections-excluded";
  readonly excluded: readonly SectionKey[];
} | {
  readonly code: "rendered-file-is-layer";
  readonly renderedFile: string;
  /** The colliding layer's position in the settings-file list, from 0. */
  readonly index: number;
  readonly layer: string;
} | {
  readonly code: "rendered-file-unwritable";
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
type SettingsProblem = ProblemOf<"settings-not-mapping" | "settings-not-plain-mapping" | "settings-malformed-sections">;
/**
 * The ONE place a problem is worded. INVARIANT for the layer members: a
 * message names the layer as the layer list names it, the site's key path, and
 * the kind of problem - never a value from the document. mode: render has no
 * private-repos redaction context, so a value echoed there (a label name, a
 * rule type, a mis-shaped section body) could land a private repository's
 * settings in a public log. `actual` reaches the prose only through
 * describeShape; the marker test in test/engine/layers.test.ts pins this.
 */
declare function describeProblem(problem: Problem): string;
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
declare function parseRepoSlug(raw: string): Result<RepoRef, ProblemOf<"repo-slug-invalid">>;
/**
 * A central file wins over a repos-input entry for the same repository (noticed, not an error). The notice renders the
 * slug through `display`; a CENTRAL origin is a repos-dir FILE PATH that can embed the real repository name, so for a
 * redacted target it is rendered generically ("a repos-dir file") to keep the name away from its placeholder.
 */
declare function dedupeTargets(central: CentralTarget[], remote: RemoteTarget[], notice: (message: string) => void, display: (slug: string) => string, isRedacted?: (slug: string) => boolean): Target[];
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
declare function maskRegistry(sink: (value: string) => void): MaskPair;
/**
 * `text` with every occurrence of every masked value replaced by `***`: the
 * one redactor for the Ios that mask text themselves (collectingIo, the CLI's
 * streams) where the action leaves it to the runner. Occurrences are located
 * in the original text and overlapping or touching ones are merged, so two
 * values that overlap (a prefix of another, or "ABC" and "BCD" across "ABCD")
 * leave no fragment, as replacing one value after another would.
 */
declare function redactRanges(text: string, masked: ReadonlySet<string>): string;
/**
 * Only annotate and log take the prefix: the debug trace, summary, and outputs are rendered by their writers, and the
 * mask pair registers raw values, not rendered lines.
 */
declare function prefixedIo(io: Io, prefix: string): Io;
interface CollectedLine {
  level?: AnnotationLevel;
  line: string;
}
/**
 * An Io that records instead of printing. Every captured line, output, and summary block is redacted against the
 * values registered so far, as a runner masks its log, so a library caller that prints the capture cannot leak
 * a secret. The debug trace is dropped, as a runner without step debugging drops it.
 */
declare function collectingIo(): {
  io: Io;
  lines: CollectedLine[];
  outputs: Partial<Record<OutputName, string>>;
  summary: string[];
};
/** An Io that drops everything. Fresh per call, so one caller's masks never reach another's registry. */
declare function silentIo(): Io;
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
declare const DEFAULT_API_VERSION = "2022-11-28";
/**
 * `kind` is declared explicitly, NEVER derived from the POST method every GraphQL call shares. This module must not
 * import from sections/, so GraphqlOpDecl extends this shape structurally.
 */
interface GraphqlOp {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly query: string;
}
/**
 * `carriesSecret` marks a request whose payload or variables hold a resolved secret. The engine sets it from the act of
 * resolving (engine/execute.ts) and withholds the request's error on its own side of this port whatever the client
 * answers (sections/contract/requests.ts), so a caller-supplied client cannot leak an echoed value into an outcome or
 * a report; GitHubApi honors the mark too, beside its field-name scan, for its direct callers.
 */
interface RequestMark {
  carriesSecret?: boolean;
}
/**
 * What one request ends in. `error` is GitHub's answer, classified by status. `failed` is the whole line for a request
 * with no HTTP answer to classify: not sent (its payload is not plain data), the transport failed once the retries
 * were spent, or a GraphQL body broke the wire contract; its reason is already withheld where the mark or the trace
 * redaction demands. The client never throws for either.
 */
type ClientAnswer<D> = {
  data: D;
} | {
  error: ApiError;
} | {
  failed: string;
};
interface GitHubClient {
  /**
   * `redactTrace` holds the request's `/repos/<owner>/<repo>` slug redacted for the request's duration, for the
   * visibility probe, which must not leak the slug before it knows whether the repository is private.
   */
  tryRequest(method: string, path: string, payload?: unknown, options?: RequestMark & {
    accept?: string;
    raw?: boolean;
    redactTrace?: boolean;
  }): Promise<ClientAnswer<unknown>>;
  /**
   * Failures, including the errors[] GitHub delivers inside an HTTP 200, come back as the same ApiError the REST
   * classifiers read. `slug` names the owner/repo: GraphQL carries the target in the request BODY, invisible to the
   * URL-based trace redaction.
   */
  tryGraphql(op: GraphqlOp, variables: Readonly<Record<string, unknown>>, slug: string, options?: RequestMark): Promise<ClientAnswer<Record<string, unknown>>>;
}
type TraceIo = Pick<Io, "debug" | "masked">;
/**
 * A 4xx body can ECHO the rejected value inside its free-text message/errors, where no field name finds it and JSON
 * escaping defeats exact-literal masking, so nothing of the body survives.
 */
declare const SECRET_RESPONSE_WITHHELD = "response body withheld: the request carried a secret field and an error body may echo its value";
declare const SECRET_TRANSPORT_WITHHELD = "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";
interface GitHubApiOptions {
  token: string;
  /** Trace sink for redacted request lines; defaults to a silent trace with nothing masked. */
  io?: TraceIo;
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Real milliseconds in one plugin second: Retry-After units, the retry backoff step, and the write limiter's gap.
   * Undefined reads GSAC_RETRY_BASE_MS once; the plugin topology is the same at every value.
   */
  retryBaseMs?: number;
  /** The limiter the throttling plugin paces through; TIMERS_SCHEDULER unless GSAC_RETRY_BASE_MS selects the immediate one. */
  scheduler?: Scheduler;
  /** Passed to octokit verbatim; octokit-core's own agent string when omitted. */
  userAgent?: string;
}
/** The Octokit instance is built here and never injected: a consumer needing control over transport or plugins implements GitHubClient directly. */
declare class GitHubApi implements GitHubClient {
  private readonly octokit;
  private readonly trace;
  private readonly baseUrl;
  private readonly apiVersion;
  constructor(options: GitHubApiOptions);
  tryRequest(method: string, path: string, payload?: unknown, options?: RequestMark & {
    accept?: string;
    raw?: boolean;
    redactTrace?: boolean;
  }): Promise<ClientAnswer<unknown>>;
  private request;
  /**
   * The load-bearing difference from REST: GraphQL failures arrive as an HTTP 200 carrying a non-empty errors[].
   *
   * any errors[] entry, even beside partial data   -> { error }, so a section never acts on a half-answered query
   * `extensions.warnings` (legacy node-ID notices)  -> the debug trace only
   */
  tryGraphql(op: GraphqlOp, variables: Readonly<Record<string, unknown>>, slug: string, options?: RequestMark): Promise<ClientAnswer<Record<string, unknown>>>;
}
/**
 * Rate limiting in a 403 costume: primary exhaustion and secondary limits arrive as 403 once the throttling plugin gives
 * up. A withheld response has no message to read, so its `rateLimited` flag stands in, as does a GraphQL RATE_LIMITED
 * error, whose 200 the mapper rewrites to 403.
 */
declare function isRateLimitError(error: ApiError): boolean;
/**
 * True when an error means the token lacks access, as opposed to a bad payload: a status fold, blind
 * to the body. A message an endpoint declares as a definitive rejection (sections/contract/endpoints.ts)
 * is classified ahead of this in failureFor, where the endpoint is known.
 */
declare function isPermissionError(error: ApiError): boolean;
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
declare const VISIBILITY_FILTERS: readonly ["all", "public", "private", "internal"];
declare const ARCHIVED_FILTERS: readonly ["skip", "include", "only"];
declare const FORKS_FILTERS: readonly ["include", "exclude", "only"];
declare const AFFILIATIONS: readonly ["owner", "collaborator", "organization_member"];
/** Filters applied to repos: "*" discovery only, never to explicit targets. */
interface DiscoveryFilters {
  visibility: (typeof VISIBILITY_FILTERS)[number];
  archived: (typeof ARCHIVED_FILTERS)[number];
  forks: (typeof FORKS_FILTERS)[number];
  affiliation: string[];
  topics: string[];
  exclude: string[];
}
declare const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters;
interface DiscoveryResult {
  repos: DiscoveredRepoRef[];
  filtered: Array<{
    reason: string;
    repos: FilteredRepoRef[];
  }>;
}
type DiscoveryProblem = ProblemOf<"discovery-request-failed" | "discovery-transport-failed" | "discovery-response-not-a-list">;
declare function discoverRepos(api: GitHubClient, filters: DiscoveryFilters): ResultAsync<DiscoveryResult, DiscoveryProblem>;
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
 * settings; each key's meaning is published from docs/sections/shared.docs.yml, the one source the JSON Schema and the docs render from.
 */
interface UndeclaredPolicyList<E> {
  _undeclared?: UndeclaredPolicy;
  entries: E[];
  /** Only a TOP-LEVEL section's wrapper takes it (see nestedKnobbed()); the values are LAYERINGS in src/sections/shared/schema-helpers.ts, pinned there. */
  _layering?: "replace" | "shallow" | "deep";
}
type MustBeNever<T extends never> = T;
/** Readonly through every nested object and array; functions pass untouched. The type twin of a deep Object.freeze. */
type DeepReadonly<T> = T extends ((...args: never[]) => unknown) ? T : T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]>; } : T;
//#endregion
//#region src/engine/layers.d.ts
/** One settings document in the stack, named for notices and refusals. */
interface Layer {
  readonly name: string;
  readonly doc: unknown;
}
/** A lower entry a higher layer's `_remove: true` dropped; `path` names the removal entry by its index in that layer. */
interface RemovalNotice {
  readonly layer: string;
  readonly path: string;
}
/** The knobs a fold or a single document is resolved under; `undeclared` is the run input, unset unless the workflow set it. */
interface FoldOptions {
  readonly layering: Layering;
  readonly undeclared?: UndeclaredPolicy | undefined;
}
/** Value-free under the refusals' invariant: mode: render has no redaction context, so no document value may reach a log through the merge. */
declare function describeRemoval(notice: RemovalNotice): string;
declare function mergeLayers(layers: readonly Layer[], options: FoldOptions): Result<{
  settings: unknown;
  notices: RemovalNotice[];
}, LayerProblem>;
//#endregion
//#region src/upstream-gaps/index.d.ts
declare const GAPS: {
  readonly "issue-creation-policy": {
    readonly sdl: "\n    enum IssueCreationPolicy {\n      ALL\n      COLLABORATORS_ONLY\n    }\n    extend type Repository {\n      issueCreationPolicy: IssueCreationPolicy\n    }\n    extend input UpdateRepositoryInput {\n      issueCreationPolicy: IssueCreationPolicy\n    }\n  ";
  } & {
    readonly kind: "graphql-schema";
  };
  readonly lfs: {
    readonly routes: readonly ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"];
    readonly documentedInSpec: false;
  } & {
    readonly kind: "octokit";
  };
};
type GapUnion = (typeof GAPS)[keyof typeof GAPS];
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
 * The output is user-facing and parsed: .github/scripts/gen-docs.ts reads each clause by regex into the PAT column
 * of docs/reference/sections.md, so a reworded clause fails `bun run build:check` until the regex and the docs follow.
 */
declare function grantFor(permission: SectionPermission, caveat?: string, access?: "read" | "write"): string;
//#endregion
//#region src/sections/contract/endpoints.d.ts
/** `keyof Endpoints` makes a typo'd path or wrong method a compile error; SupplementalRoute covers routes octokit lags (src/upstream-gaps). */
type Route = keyof Endpoints | SupplementalRoute;
/**
 * The statuses failureFor's permission branch swallows for a granted operation. A `hints` key on one is
 * dead advice (HintableStatus excludes them); `denialHint` carries an ambiguity, and `rejections` claims
 * back the one message GitHub reserves for a definite meaning.
 */
type DenialStatus = 403 | 404;
/** A public ("none") operation's 403/404 is never a payload rejection either, so the exclusion holds for it too. */
type HintableStatus = 400 | 412 | 422;
/**
 * A response whose status a denial shares but whose exact message GitHub reserves for one definite
 * meaning: the protection PUT's 404 "Branch not found". failureFor classifies a match ahead of its
 * permission branch as a hard section error, so no on-missing-permission policy can skip it and the
 * grant advice never renders for it. The message must be one no denial body spells; the registry
 * test pins every declaration against the e2e mock's denial responses.
 */
interface DefinitiveRejection {
  readonly status: DenialStatus;
  /** Compared whole, never as a substring: "Not Found" is a fine-grained denial. */
  readonly message: string;
  /** What to fix, as a lowercase clause without a trailing period; failureFor starts a sentence with it. */
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
  /** As on a plain GET: "execution" gates the read behind a thunk's token (the Codespaces sealing key). */
  readonly phase?: "execution";
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
   * values that could go stale; failureFor appends it to the status's rejection message. Style: one or two sentences, no trailing period.
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
declare function endpointMethod(route: Route): string;
declare function endpointPath(route: Route): string;
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
//#region src/sections/contract/errors.d.ts
/**
 * What ends a section's work, as a value. `message` is the whole line the loops report; `kind` is read for policy
 * alone (a denial's partial-success handling in engine/orchestrate.ts), never to rebuild prose.
 *
 *   request kinds (failureFor and the request helpers): rate-limit, rejected, server-error, unauthorized,
 *                  validation, transport, malformed
 *   duplicate kinds (the identity checks): declared-duplicate, live-duplicate
 *   live-shape     -> GitHub's answer parsed but cannot be reconciled (an item without an id, a repeated rule type)
 *   refused        -> the section declines to proceed: the settings file conflicts with live state, an actor cannot
 *                     be resolved, a write would drop live values the file omits
 *   unverified     -> a write landed but its echo disagrees with what was set
 *   thrown         -> an exception escaped a section: the client's own throw on an unmarked request, or a BUG
 *                     invariant; the loops report its message like any other failure
 */
type SectionFailure = {
  readonly kind: PlainFailureKind;
  readonly message: string;
} | {
  readonly kind: "permission-denied";
  readonly section: string;
  readonly detail: string;
  /** The HTTP status that raised the denial, for the redacted view's safe code. */
  readonly status: number;
  readonly message: string;
};
/** Every kind but the denial, whose value carries more than a message. */
type PlainFailureKind = "rate-limit" | "rejected" | "server-error" | "unauthorized" | "validation" | "transport" | "malformed" | "declared-duplicate" | "live-duplicate" | "live-shape" | "refused" | "unverified" | "thrown";
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
 * Only a thunk holds this token, which the port's execution-phase reads demand. A resolve marks the
 * operation's request as secret-carrying (engine/execute.ts), so a plaintext is used inside the operation
 * that resolved it, never stashed for another.
 */
interface ExecTools {
  resolveSecret(reference: string): string;
}
type ReadRole<E extends EndpointDict> = { [R in keyof E & string]: E[R]["route"] extends `GET ${string}` ? R : never; }[keyof E & string];
type WriteRole<E extends EndpointDict> = Exclude<keyof E & string, ReadRole<E>>;
type GraphqlReadRole<G extends GraphqlDict> = { [R in keyof G & string]: G[R] extends {
  readonly kind: "read";
} ? R : never; }[keyof G & string];
type GraphqlWriteRole<G extends GraphqlDict> = Exclude<keyof G & string, GraphqlReadRole<G>>;
type CallOpts<E extends EndpointDecl> = OptsArg<E, {
  query?: Readonly<Record<string, string>>;
  payload?: never;
  describe?: string;
}>;
type TryCallOpts<E extends EndpointDecl> = OptsArg<E, {
  query?: Readonly<Record<string, string>>;
  payload?: never;
  tolerate?: readonly DeclaredErrorStatus<E>[];
  describe?: string;
}>;
type ProbeOpts<E extends EndpointDecl> = OptsArg<E, {
  query?: Readonly<Record<string, string>>;
  tolerate?: readonly DeclaredErrorStatus<E>[];
  accept?: string;
  describe?: string;
}>;
type ListOpts<E extends EndpointDecl> = OptsArg<E, {
  query?: Readonly<Record<string, string>>;
  describe?: string;
}>;
/**
 * What every port helper resolves to: the parsed body, or the failure as a value. A ResultAsync awaits to a
 * Result and also yields inside `safeTry(async function* () {...})`, so a plan threads its reads with `yield*`.
 */
type Read<T> = ResultAsync<T, SectionFailure>;
/**
 * The request helpers (./requests.ts) bound to ONE read endpoint, minus the declaration argument and any payload.
 * Every helper takes the zod schema of the body it returns and parses through parseLive (./live.ts) before the
 * section sees it, so an unparsed body is unrepresentable: a malformed answer is a loud "outside the documented
 * shape" failure naming the endpoint, never an undefined reaching a plan. The list helpers take the ITEM schema.
 */
interface BoundRead<E extends EndpointDecl> {
  call<T>(schema: z.ZodType<T>, ...args: CallOpts<E>): Read<T>;
  tryCall<T>(schema: z.ZodType<T>, ...args: TryCallOpts<E>): Read<{
    data: T;
  } | {
    error: ApiError;
  }>;
  probeAbsent<T>(schema: z.ZodType<T>, ...args: ProbeOpts<E>): Read<{
    data: T;
  } | {
    missing: true;
  }>;
  listAll<T>(item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
  listAllEnveloped<T>(envelopeKey: string, item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
}
/**
 * BoundRead behind the ExecTools token: a plan() body has no token, so an execution-phase read does not compile
 * there; a thunk passes the one it received. Spelled out rather than mapped from BoundRead, since a mapped type
 * erases the per-call schema generic.
 */
interface GatedBoundRead<E extends EndpointDecl> {
  call<T>(exec: ExecTools, schema: z.ZodType<T>, ...args: CallOpts<E>): Read<T>;
  tryCall<T>(exec: ExecTools, schema: z.ZodType<T>, ...args: TryCallOpts<E>): Read<{
    data: T;
  } | {
    error: ApiError;
  }>;
  probeAbsent<T>(exec: ExecTools, schema: z.ZodType<T>, ...args: ProbeOpts<E>): Read<{
    data: T;
  } | {
    missing: true;
  }>;
  listAll<T>(exec: ExecTools, item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
  listAllEnveloped<T>(exec: ExecTools, envelopeKey: string, item: z.ZodType<T>, ...args: ListOpts<E>): Read<T[]>;
}
type GraphqlTryOpts<O extends GraphqlOpDecl> = {
  tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
  describe?: string;
};
type BoundGraphqlRead<O extends GraphqlOpDecl> = {
  call<T>(schema: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>>, opts?: {
    describe?: string;
  }): Read<T>;
  tryCall<T>(schema: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>>, opts?: GraphqlTryOpts<O>): Read<{
    data: T;
  } | {
    error: ApiError;
  }>;
} & (O extends GraphqlPaginatedReadDecl ? {
  /** Every node of the declared connection (the loop owns `$cursor`), each parsed by the node schema. */
  listConnection<T>(node: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>> & {
    cursor?: never;
  }): Read<{
    items: T[];
  } | {
    error: ApiError;
  }>;
} : {
  listConnection?: never;
});
/** BoundGraphqlRead behind the ExecTools token (the GatedBoundRead twin). */
type GatedBoundGraphqlRead<O extends GraphqlOpDecl> = {
  call<T>(exec: ExecTools, schema: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>>, opts?: {
    describe?: string;
  }): Read<T>;
  tryCall<T>(exec: ExecTools, schema: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>>, opts?: GraphqlTryOpts<O>): Read<{
    data: T;
  } | {
    error: ApiError;
  }>;
} & (O extends GraphqlPaginatedReadDecl ? {
  listConnection<T>(exec: ExecTools, node: z.ZodType<T>, variables: Readonly<GraphqlVariablesOf<O>> & {
    cursor?: never;
  }): Read<{
    items: T[];
  } | {
    error: ApiError;
  }>;
} : {
  listConnection?: never;
});
/**
 * Write roles are absent from the type, so `ctx.read.<writeRole>` does not compile. A role with a
 * `primaryRead` posture exposes only the helpers that honor it; a `phase: "execution"` role exposes them gated.
 */
type BoundReads<E extends EndpointDict, G extends GraphqlDict> = { readonly [R in ReadRole<E>]: ReadPort<E[R]>; } & { readonly [R in GraphqlReadRole<G>]: GraphqlReadPort<G[R]>; };
type GraphqlReadPort<O extends GraphqlOpDecl> = O extends {
  readonly phase: "execution";
} ? GatedBoundGraphqlRead<O> : BoundGraphqlRead<O>;
/**
 * Only the helpers that honor the declaration's posture are exposed, so a handler cannot bypass an
 * advisory, denied, or absent posture by picking another helper.
 */
type ReadPort<E extends EndpointDecl> = E extends {
  readonly phase: "execution";
} ? Pick<GatedBoundRead<E>, PosturedHelpers<E>> : Pick<BoundRead<E>, PosturedHelpers<E>>;
type PosturedHelpers<E extends EndpointDecl> = E extends {
  readonly advisory: true;
} ? "tryCall" : E extends {
  readonly primaryRead: {
    notFound: "denied";
  };
} ? "call" | "listAll" | "listAllEnveloped" : E extends {
  readonly primaryRead: {
    notFound: "absent";
  };
} ? "probeAbsent" | "tryCall" : keyof BoundRead<E>;
/**
 * `K` is the section the context was built for: a module's plan() takes PlanContext<_, _, K> over its own
 * key, so labels' plan() cannot be handed branches' context once both are erased to EndpointDict
 * (sectionModule() returns the erased module). The registry refuses the same mismatch at runtime.
 */
interface PlanContext<E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict, K extends SectionKey = SectionKey> {
  readonly section: K;
  /** The target repository, parsed once at the boundary (see RepoRef). */
  readonly repo: RepoRef;
  readonly read: BoundReads<E, G>;
}
/** The run's on-missing-permission input: how a read the token is denied classifies. */
type OnMissingPermission = "fail" | "warn";
/**
 * The policy as a snapshot() sees it. Only snapshotContext() mints one: the constructor is private
 * and the class nominal, so a section cannot hand readOrNote a literal "warn" and turn a denial the
 * run should fail on into a note.
 */
declare class DenialPolicy {
  private readonly input;
  private constructor();
  /** Under warn a denied sub-read is noted and left out; under fail it propagates. */
  get notesDenials(): boolean;
}
/**
 * What snapshot() reads through: the plan port plus the run's denial policy, so a helper over one
 * sub-read (readOrNote) classifies a denial where it happens instead of noting it under both.
 */
interface SnapshotContext<E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict, K extends SectionKey = SectionKey> extends PlanContext<E, G, K> {
  readonly onMissingPermission: DenialPolicy;
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
   * A thunk when the line depends on what the server echoed (one line or several, never none); its failure
   * is the verification failure, reported beside the requests that landed.
   */
  readonly change: string | ((response: unknown) => Result<ChangeLines, SectionFailure>);
  /** The operation in settings-file terms ("arming the interaction limit"), for the failure prose; the `describe` the request helpers take. */
  readonly describe?: string;
  /**
   * For a server-assigned value (a created environment's node id) a later operation's thunk reads from
   * where the hook stores it. It must not render; its failure fails the operation.
   */
  readonly capture?: (response: unknown) => Result<void, SectionFailure>;
  /**
   * Execution-time reads before the request is sealed and issued (bypass actors' node ids, pinned ahead
   * of the first write so a bad input fails while live state is untouched). Its failure fails the
   * operation with its request never sent.
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
/** One change line or several, never none: a request that landed always renders. */
type ChangeLines = string | readonly [string, ...string[]];
/**
 * The ONLY place a plan may touch a secret; async so it can read a value an earlier operation created. Its
 * failure is the operation's, with the request never sent.
 */
type Late<T> = (exec: ExecTools) => Result<T, SectionFailure> | PromiseLike<Result<T, SectionFailure>>;
/**
 * A tolerated status means the operation did not apply: a note in place of its change line, or a
 * failure carrying the section's own advice where failureFor's generic text would mislead.
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
/** `K`, `E`, and `G` infer from the module, so a caller cannot ask for a port the section never declared. */
declare function planContext<K extends SectionKey, E extends EndpointDict, G extends GraphqlDict>(meta: SectionMeta<K, E, G>, api: GitHubClient, repo: RepoRef): PlanContext<E, G, K>;
declare function snapshotContext<K extends SectionKey, E extends EndpointDict, G extends GraphqlDict>(meta: SectionMeta<K, E, G>, api: GitHubClient, repo: RepoRef, onMissingPermission: OnMissingPermission): SnapshotContext<E, G, K>;
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
   * "org": the resources exist only under an ORGANIZATION owner. The registry wraps the module's plan() and
   * snapshot() in the owner gate (./owner.ts), which probes the `org` role (ORG_PROBE, 404 tolerated) and
   * no-ops with a note on a personal account, so no section body spells the probe; the registry's lockstep
   * type admits the flag only beside that role. The single source of owner-kind modeling: the fuzz oracle's
   * personal-account fold reads it, and test/sections/registry.test.ts pins it to the probe endpoint.
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
   * fails a coverage note that contradicts it; the wrapped `{_undeclared, entries}` form overrides it per run.
   *
   *   "delete"     -> lists live resources and DELETES undeclared ones; `_undeclared: keep` softens to notes
   *   "keep"       -> lists live resources and KEEPS undeclared ones as notes; `_undeclared: delete` hardens
   *   "untouched"  -> takes no `_undeclared` knob; the section applies no undeclared policy
   *
   * The conditional type pins the pairing: a section in UNDECLARED_POLICY_SECTIONS says "delete" or "keep", one outside it "untouched".
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
  /**
   * Read by engine/layers.ts for the layered merge. Optional on the interface for the sections that take no
   * list; ../registry.ts requires it of every list section, so a list module omitting it fails to compile.
   */
  readonly layering?: K extends ListSection ? KeyedListLayering : never;
}
/**
 * engine/layers.ts pairs two entries when their key sets intersect, the planner's own duplicate test,
 * so a merged document is always one the planner accepts; the directive (replace, shallow, deep) is the
 * layer's to choose, never the module's.
 */
interface KeyedListLayering {
  /**
   * Folded as the planner folds them (a label claims its name plus its pre-rename name); null when the
   * entry carries none, which the layer boundary refuses.
   */
  readonly keys: (entry: Readonly<Record<string, unknown>>) => readonly string[] | null;
  /** The entry field the keys come from, for refusal prose ("name", "type"). */
  readonly keyField: string;
  /** The field's kind in the same prose ("string" unless said otherwise; a reviewer's `id` is "numeric"). */
  readonly keyKind?: string;
  /**
   * Fields of a merged entry that are themselves keyed lists (rulesets' `rules`, an environment's `variables`). A
   * nested list arrives as a bare list or a nested `{_undeclared, entries}` wrapper and unions by its own key under
   * the directive its entry inherits; its wrapper takes no `_layering` (nestedKnobbed in ../shared/schema-helpers.ts).
   */
  readonly nested?: Readonly<Record<string, KeyedListLayering>>;
  /**
   * The dotted paths a `_remove: true` entry may carry beside the marker: the key field's own unless the key spans
   * several (a reviewer is its `type` and `id`). Any other path on a removal is refused at the layer boundary by name.
   */
  readonly removalPaths?: readonly string[];
  /**
   * A NESTED list's `_undeclared` default (an environment's variables), the last fallback engine/layers.ts resolves a
   * nested wrapper without a policy to; absent on a nested list that takes no knob (a ruleset's rules, reviewers).
   * test/sections/registry.test.ts pins it to the nested wrappers the schema declares.
   */
  readonly undeclaredDefault?: UndeclaredPolicy;
}
/** Used verbatim in permission errors; the Sections table on docs/reference/sections.md mirrors it in its PAT permission column. */
declare function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string;
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
declare function sectionOperations(section: SectionMeta): SectionOperation[];
/**
 * How GitHub gates a section's planning reads under a read-only grant. Read by the fuzz oracle and the docs.
 *
 *   "plain"        -> every read succeeds (also a section with no reads)
 *   "write-gated"  -> denied at the first read
 *   "mixed"        -> reads until the handler reaches a gated one
 */
type ReadGating = "plain" | "write-gated" | "mixed";
declare function readGating(section: SectionMeta): ReadGating;
interface WriteGatedRead {
  readonly route: Route;
  readonly permission: SectionPermission;
}
/** GraphQL reads are never here: a GraphQL read is gated at read (its kind IS the gate), so the REST dictionary is complete. */
declare function writeGatedReads(section: SectionMeta): WriteGatedRead[];
/** What a fine-grained 404 on a section's primary read means (see EndpointDecl.primaryRead). */
type DenialPosture = NonNullable<EndpointDecl["primaryRead"]>["notFound"];
/**
 * A section with no planning read classifies nothing before its first write, so it is "absent".
 * Read by the fuzz oracle and the e2e mock.
 */
declare function denialPosture(section: SectionMeta): DenialPosture;
/**
 * A section's declared value as the schema types it. Only `undefined` (the absent-section marker) is excluded: a
 * nullable section (interaction_limits, pages) keeps its `null`. The validate and secretValues hooks take it, since
 * they run inside validation; plan() takes ValidatedInput, the same shape carrying validation's proof.
 */
type SectionInput<K extends SectionKey> = Exclude<SettingsFile[K], undefined>;
declare const validatedInput: unique symbol;
/**
 * The brand's carrier, named so a module's declaration prints a planner's input by this name (a bundled declaration
 * cannot spell the unexported symbol). It holds the KEY the value was validated as, so a validated branches list is
 * not a labels input, whose checks it never met. An alias, not an interface: an interface has no implicit index
 * signature, so a branded mapping could no longer pass where a `Record<string, unknown>` is read.
 */
type ValidatedBrand<K extends SectionKey = SectionKey> = {
  readonly [validatedInput]: K;
};
/**
 * The proof that validateSettingsDoc (engine/orchestrate.ts) ran section K's every file-only check over the value:
 * a brand that exists at the type level only (no runtime field), minted at that one site and read off the
 * ValidatedSettings document. Every plan() takes it, so a hand-built entry list cannot reach a planner and skip the
 * checks; the unbranded shape is read back by assignment (`const declared: SectionInput<K> = desired`). A `null`
 * value stays unbranded: it carries nothing a file-only check could judge, and no brand attaches to null.
 */
type ValidatedInput<K extends SectionKey> = K extends SectionKey ? Validated<SectionInput<K>, K> : never;
type Validated<T, K extends SectionKey> = T extends null ? null : T & ValidatedBrand<K>;
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
 * A finding of a section's file-only checks (SectionModule.validate). `path` follows the section key the way a
 * zod issue's does (`[3].name`, `.entries[1].name`, "" for the whole value), so `labels[3].name: ...` reads alike
 * whichever check raised it.
 */
interface DeclaredIssue {
  readonly path: string;
  readonly message: string;
}
/**
 * Every check that reads the declared value and nothing else (no API, no environment): a duplicated identity, a
 * malformed key material, a list GitHub would fold. engine/validate.ts runs it inside document validation, in both
 * modes, before the preflight barrier and the first write, and joins the findings to the settings-malformed-sections
 * problem; the same check thrown from plan() would fire after earlier sections wrote (the preflight probe reports
 * only denials). Required on a list section, since every entry list has an identity to keep unique; a mapping
 * section may declare none. The erased view (SectionModule<SectionKey>) keeps it optional so every module erases.
 */
type ValidateFacet<K extends SectionKey> = IsUnion$1<K> extends true ? {
  validate?(declared: SectionInput<K>): readonly DeclaredIssue[];
} : [EntryOf<NonNullable<SettingsFile[K]>>] extends [never] ? {
  validate?(declared: SectionInput<K>): readonly DeclaredIssue[];
} : {
  validate(declared: SectionInput<K>): readonly DeclaredIssue[];
};
type UnionToIntersection$1<U> = (U extends unknown ? (x: U) => void : never) extends ((x: infer I) => void) ? I : never;
type IsUnion$1<T> = [T] extends [UnionToIntersection$1<T>] ? false : true;
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
 * repository, or the failure that ended it as a value (a denied read, a live state it cannot reconcile); the
 * engine renders the operations as drift in check mode and executes them in apply mode.
 * Modules register in ../registry.ts.
 *
 *   snapshot() required  -> the section declares a read (a GET or a GraphQL query), so the live state it
 *                           compares against can be read back; SnapshotFacet flags a module annotated over its
 *                           literal dictionaries without one, and ../registry.ts flags every registrant without one
 *   snapshot() absent    -> only a write-only section (no read at all), which snapshot reports unsupported
 *                           (snapshotUnsupportedNote)
 */
type SectionModule<K extends SectionKey = SectionKey, E extends EndpointDict = EndpointDict, G extends GraphqlDict = GraphqlDict> = SectionModuleBase<K, E, G> & SnapshotFacet<K, E, G> & ValidateFacet<K> & {
  plan(ctx: PlanContext<E, G, K>, desired: ValidatedInput<K>): Promise<Result<SectionPlan<PlannedOp<E, G>>, SectionFailure>>;
  /** Pinned so a non-literal object carrying a run() handler is not assignable either. */
  run?: never;
};
/** Whether a LITERAL dictionary pair declares any read; the erased pair (the engine's view) keeps snapshot optional. */
type DeclaresRead<E extends EndpointDict, G extends GraphqlDict> = string extends keyof E ? false : [{ [R in keyof E]: E[R]["route"] extends `GET ${string}` ? true : never; }[keyof E] | { [R in keyof G]: G[R] extends {
  readonly kind: "read";
} ? true : never; }[keyof G]] extends [never] ? false : true;
type SnapshotFacet<K extends SectionKey, E extends EndpointDict, G extends GraphqlDict> = DeclaresRead<E, G> extends true ? {
  snapshot(ctx: SnapshotContext<E, G, K>): Promise<Result<SectionSnapshot<K>, SectionFailure>>;
} : {
  snapshot?(ctx: SnapshotContext<E, G, K>): Promise<Result<SectionSnapshot<K>, SectionFailure>>;
};
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
//#region src/sections/repository/schema.d.ts
declare const RepositoryConfig: z.ZodObject<{
  description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  homepage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  private: z.ZodOptional<z.ZodBoolean>;
  visibility: z.ZodOptional<z.ZodString>;
  security_and_analysis: z.ZodOptional<z.ZodNullable<z.ZodObject<{
    advanced_security: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    code_security: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_push_protection: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_ai_detection: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_non_provider_patterns: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_delegated_alert_dismissal: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_delegated_bypass: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
    secret_scanning_delegated_bypass_options: z.ZodOptional<z.ZodObject<{
      reviewers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        reviewer_id: z.ZodInt;
        reviewer_type: z.ZodEnum<{
          ROLE: "ROLE";
          TEAM: "TEAM";
        }>;
        mode: z.ZodOptional<z.ZodEnum<{
          ALWAYS: "ALWAYS";
          EXEMPT: "EXEMPT";
        }>>;
      }, z.core.$strict>>>;
    }, z.core.$strict>>;
    secret_scanning_validity_checks: z.ZodOptional<z.ZodObject<{
      status: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
      }>>;
    }, z.core.$strict>>;
  }, z.core.$strict>>>;
  has_issues: z.ZodOptional<z.ZodBoolean>;
  has_projects: z.ZodOptional<z.ZodBoolean>;
  has_wiki: z.ZodOptional<z.ZodBoolean>;
  has_discussions: z.ZodOptional<z.ZodBoolean>;
  has_pull_requests: z.ZodOptional<z.ZodBoolean>;
  pull_request_creation_policy: z.ZodOptional<z.ZodEnum<{
    all: "all";
    collaborators_only: "collaborators_only";
  }>>;
  is_template: z.ZodOptional<z.ZodBoolean>;
  default_branch: z.ZodOptional<z.ZodString>;
  allow_squash_merge: z.ZodOptional<z.ZodBoolean>;
  allow_merge_commit: z.ZodOptional<z.ZodBoolean>;
  allow_rebase_merge: z.ZodOptional<z.ZodBoolean>;
  allow_auto_merge: z.ZodOptional<z.ZodBoolean>;
  delete_branch_on_merge: z.ZodOptional<z.ZodBoolean>;
  allow_update_branch: z.ZodOptional<z.ZodBoolean>;
  use_squash_pr_title_as_default: z.ZodOptional<z.ZodBoolean>;
  squash_merge_commit_title: z.ZodOptional<z.ZodEnum<{
    COMMIT_OR_PR_TITLE: "COMMIT_OR_PR_TITLE";
    PR_TITLE: "PR_TITLE";
  }>>;
  squash_merge_commit_message: z.ZodOptional<z.ZodEnum<{
    BLANK: "BLANK";
    COMMIT_MESSAGES: "COMMIT_MESSAGES";
    PR_BODY: "PR_BODY";
  }>>;
  merge_commit_title: z.ZodOptional<z.ZodEnum<{
    MERGE_MESSAGE: "MERGE_MESSAGE";
    PR_TITLE: "PR_TITLE";
  }>>;
  merge_commit_message: z.ZodOptional<z.ZodEnum<{
    BLANK: "BLANK";
    PR_BODY: "PR_BODY";
    PR_TITLE: "PR_TITLE";
  }>>;
  archived: z.ZodOptional<z.ZodBoolean>;
  allow_forking: z.ZodOptional<z.ZodBoolean>;
  web_commit_signoff_required: z.ZodOptional<z.ZodBoolean>;
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
}, z.core.$catchall<z.ZodUnknown>>;
type RepositoryConfig = z.infer<typeof RepositoryConfig>;
//#endregion
//#region src/engine/diff.d.ts
/** One field, or the fields whose values together identify an item (a bypass actor's type and id). */
type MatchKey = string | readonly string[];
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
/** The full body of one item, for a list that carries only a summary; never the primary read. */
type GetDecl = EndpointDecl & {
  readonly route: Extract<Route, `GET ${string}`>;
  readonly primaryRead?: never;
};
/**
 * `update` exists only when GitHub can edit the resource; without it a drifted item is deleted and
 * recreated. `updateConfig` sets one nested mapping field by field where the general update would
 * replace it whole (a webhook's config); `get` reads an item's full body when the list carries only a
 * summary (a ruleset). A type alias, so it keeps EndpointDict's index signature.
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
} | {
  readonly update: UpdateDecl;
  readonly remove: RemoveDecl;
  readonly updateConfig: UpdateDecl;
}) & ({} | {
  readonly get: GetDecl;
});
/** The roles every list section declares, which the derived mock fragment serves. */
type ListRoleName = "list" | "create" | "update" | "remove";
type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends ((member: infer I) => void) ? I : never;
type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;
/**
 * Pins a dictionary to the factory's roles at the declaration. An intersection, so the index signature stays.
 *
 *   a union of dictionaries          -> refused (a union hides its members' roles from keyof)
 *   a seventh role                   -> never
 *   `update` not PATCH or PUT        -> refused (a DELETE would pass the immutable arm's structural match)
 *   `updateConfig` without `update`  -> refused (the general update carries the fields outside the mapping)
 */
type OnlyListRoles<Ends> = (IsUnion<Ends> extends true ? never : unknown) & ("updateConfig" extends keyof Ends ? "update" extends keyof Ends ? unknown : never : unknown) & { readonly [R in Exclude<keyof Ends, ListRoleName | "get" | "updateConfig">]: never; } & { readonly [R in keyof Ends & "update"]: UpdateDecl; } & { readonly [R in keyof Ends & "updateConfig"]: UpdateDecl; } & { readonly [R in keyof Ends & "get"]: GetDecl; };
/**
 * The write fields a `secrets` declaration may name: a dotted path under `mapping` (the field the
 * `updateConfig` role writes), admitted only where both carriers (`create` and `updateConfig`) declare
 * `unverifiable: true`, since the value is re-sent on every run; an immutable resource admits none.
 */
type SecretPath<Ends, M extends string> = Ends extends {
  readonly create: {
    readonly unverifiable: true;
  };
  readonly updateConfig: {
    readonly unverifiable: true;
  };
} ? `${M}.${string}` : never;
type RouteOf<Ends, R extends string> = Ends extends { readonly [P in R]: {
  readonly route: infer U extends string;
}; } ? U : never;
/** Every route addressing ONE live item; they all read the same params off `address`. */
type ItemRoutes<Ends> = RouteOf<Ends, "remove"> | RouteOf<Ends, "update"> | RouteOf<Ends, "updateConfig"> | RouteOf<Ends, "get">;
type SameParamsAs<R extends string, P extends string> = R extends string ? [PathParams<R>] extends [P] ? [P] extends [PathParams<R>] ? true : false : false : never;
/**
 * One address serves every item route, so they must spell the SAME params; a dictionary whose item
 * routes disagree collapses to never.
 */
type Address<Ends extends ListEndpoints> = false extends SameParamsAs<ItemRoutes<Ends>, PathParams<ItemRoutes<Ends>>> ? never : Readonly<Record<PathParams<ItemRoutes<Ends>>, string>>;
/**
 * The identity field's home in a write: a top-level key, or a dotted path into a nested mapping (a
 * webhook's config.url), each nested level keeping the write's own index signature for its siblings.
 */
type Carrier<F extends string, Siblings> = F extends `${infer Head}.${infer Rest}` ? { readonly [P in Head]: Carrier<Rest, Siblings> & Siblings; } : { readonly [P in F]: string; };
/**
 * Declared fields only: an omitted optional stays OUT (never undefined), so it is neither written nor compared.
 * A section narrows it to pin a folded field's brand on its lens (labels' HexColor).
 */
type ListWrite<F extends string> = Carrier<F, {
  readonly [key: string]: PlainData;
}> & {
  readonly [key: string]: PlainData;
};
/** A live item in the same terms, each field normalized as GitHub stores it. */
type ListComparable<F extends string> = Carrier<F, Readonly<Record<string, unknown>>> & Readonly<Record<string, unknown>>;
/** The keep-note wording; `action` overrides `undeclaredAction` for the note alone (a milestone's closing hint). */
type NoteWording = Pick<Parameters<typeof undeclaredNote>[0], "state" | "add" | "manage"> & Partial<Pick<Parameters<typeof undeclaredNote>[0], "action">>;
type DriftWording = Pick<Parameters<typeof undeclaredDrift>[1], "state" | "add" | "keep">;
/** `unpaginated` also drives the derived mock's list handler (test/e2e/mock/list-fragment.ts). */
interface Listing {
  /** The query the list carries (milestones' state=all: the default listing omits closed items). */
  readonly query?: Readonly<Record<string, string>>;
  /** GitHub serves the whole list in one response and ignores page params (autolinks), so the page loop is skipped. */
  readonly unpaginated?: true;
}
/**
 * A declared field GitHub omits from a live item the token lacks access for (a ruleset's bypass_actors
 * under a read grant): plan() compares around it and notes it, snapshot() leaves the item out.
 */
interface ConcealedField {
  readonly field: string;
  /** Why GitHub withholds it ("GitHub returns it only to a token with write access to the ruleset"). */
  readonly reason: string;
  /** The grant that lifts it, as an imperative clause ("grant Administration write"). */
  readonly remedy: string;
}
/**
 * ONE string literal: not `string`, not `never`, not a union, not a pattern (`Lowercase<string>`, a
 * template with a `${string}` or `${any}` hole). A mapped type over one literal has a required property,
 * so the empty object is not assignable to it; over anything else it has an index signature or nothing.
 */
type IsStringLiteral<M extends string> = IsUnion<M> extends true ? false : Record<never, never> extends { [P in M]: 0; } ? false : true;
/**
 * With an `updateConfig` role, the entry field holding the mapping that endpoint sets field by field;
 * `M` is its literal, so SecretPath can demand that every secret path sit under it. ONE literal: a
 * union, `string`, or a pattern would admit a path under a mapping the declaration does not have, and
 * the planner would route that secret through the general update, so it is refused. The type catches an
 * ACCIDENTAL dotted secret path outside the declared mapping; a declaration written to defeat it (a
 * mapping cast to a type the check does not see) is deliberate and out of its scope.
 */
type MappingFacet<K extends ListSectionKey, Ends, M extends string> = Ends extends {
  readonly updateConfig: EndpointDecl;
} ? {
  readonly mapping: IsStringLiteral<M> extends true ? M & keyof Entry<K> : never;
} : {
  readonly mapping?: never;
};
interface Identity<K extends ListSectionKey, F extends string, Key extends string> {
  /** The write field naming the resource, as the live item carries it ("name", "title", "config.url"). */
  readonly field: F;
  /** Folds a name to the key GitHub matches it by; `exactName` when GitHub matches exactly. */
  readonly fold: (name: string) => Key;
  /**
   * Names an entry also answers to (a label's pre-rename `name`), so a live item under one is this
   * entry's, renamed by the update, not undeclared.
   */
  readonly aliases?: (entry: Entry<K>) => readonly string[];
}
/**
 * The update body's key for the name when GitHub renames through another one (labels' `new_name`);
 * omitted, the name travels under `field`. Only a top-level identity field renames.
 *
 *   entry declares a value under it  -> it is renaming: that value is the name it writes (the lens puts it under `field`)
 *   the entry's `field`              -> its current name
 */
type RenameFacet<F extends string> = F extends `${string}.${string}` ? {
  readonly renameKey?: never;
} : {
  readonly renameKey?: string;
};
/**
 * `Key` is the fold's output: the planner keys every live-versus-declared lookup by it, so an unfolded
 * name cannot be looked up, and a section's brand (labels' NameKey) survives to `decl`.
 */
type ListSectionDecl<K extends ListSectionKey, Ends extends ListEndpoints, Live extends object, F extends string, Key extends string, M extends string = never> = ListSectionDeclFields<K, Ends, Live, F, Key, M> & MappingFacet<K, Ends, M>;
interface ListSectionDeclFields<K extends ListSectionKey, Ends extends ListEndpoints, Live extends object, F extends string, Key extends string, M extends string> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  /** The output noun for change lines and notes ("label"). */
  readonly noun: string;
  /** The entry config slice (src/sections/<key>/schema.ts); the loose shape derives from it. */
  readonly entry: z.ZodType<Entry<K>>;
  /** The fields of a live item the section reads (a list item, and the `get` body when the role exists); extras ride along. */
  readonly live: z.ZodType<Live>;
  readonly endpoints: Ends & OnlyListRoles<Ends>;
  readonly listing?: Listing;
  readonly identity: Identity<K, F, Key> & RenameFacet<F>;
  /** The path params addressing one live item for every item role; unrepresentable when the routes disagree. */
  readonly address: [Address<Ends>] extends [never] ? never : (live: Live) => Address<Ends>;
  readonly lens: {
    /**
     * The entry in the terms the comparison runs in: what a converged live item reads back as, and the
     * request body itself unless `wire` renders it.
     */
    readonly toWrite: (entry: Entry<K>) => ListWrite<F>;
    /**
     * A live item in the same terms as toWrite, so the two compare field by field; a live item the section cannot
     * compare (a ruleset repeating a rule type) is the failure that ends the plan or snapshot.
     *
     *   identity field          -> verbatim
     *   other declared fields   -> normalized as GitHub stores them (a color lowercased without "#", a null description as "")
     *   every other live field  -> kept, so declared passthrough keys compare against what the API echoed
     */
    readonly fromLive: (live: Live) => Result<ListComparable<F>, SectionFailure>;
    /**
     * The write as the request body spells it, when that differs from the compared form (a milestone's due
     * day sent as noon UTC): applied to every body the planner sends (create, recreate, update, and the
     * updateConfig slice) and to nothing the comparison or the snapshot reads. Omitted, the write is the body.
     */
    readonly wire?: (write: ListWrite<F>) => ListWrite<F>;
    /** Per entry field holding a list, the item key to pair by (see DeltaOptions.matchBy); `{}` when none does. */
    readonly matchBy: Readonly<Partial<Record<keyof Entry<K> & string, MatchKey>>>;
  };
  /**
   * Whether the update body replaces the live item whole (a ruleset's PUT) or sets named fields only (a PATCH).
   * Under `true` a non-empty live value under a key of the entry slice that the entry omits is drift, and apply
   * refuses the write. Every declaration says which, so a replace-style section cannot inherit the declared-keys
   * comparison by leaving it out.
   */
  readonly replaces: boolean;
  /**
   * The body recreating a drifted item of a resource GitHub cannot edit (no update role), when the
   * write alone would drop a live field the file leaves undeclared (a deploy key's read_only).
   */
  readonly recreate?: "update" extends keyof Ends ? never : (live: Live, write: ListWrite<F>) => ListWrite<F>;
  /**
   * File-only checks over the entries beyond identity uniqueness (a deploy key's material must parse), one
   * issue per finding with its path (`[2].key`); they join the module's validate hook, which the engine runs
   * inside document validation, so a write with such an entry is unreachable and toWrite may treat it as a BUG.
   */
  readonly validate?: (entries: readonly Entry<K>[]) => readonly DeclaredIssue[];
  /**
   * Conflicts the identities cannot show, each naming the fix; any finding fails the section.
   *
   *   `declared`  -> sees only the writes and runs inside document validation, before ANY section writes
   *                  (a settings-file mistake costs no request); `[i]` indexes the writes as the entries
   *   `live`      -> runs after the read and before any write (a deploy key's material held by another key)
   */
  readonly conflicts?: {
    readonly declared?: (writes: readonly ListWrite<F>[]) => readonly DeclaredIssue[];
    readonly live?: (writes: readonly ListWrite<F>[], live: readonly ListComparable<F>[]) => readonly string[];
  };
  /**
   * The reason a live item is outside what the section manages (an inherited ruleset, a legacy
   * service hook), or null when it is the section's own: plan() neither matches nor removes it,
   * snapshot() leaves it out under `name` with the reason.
   */
  readonly foreign?: (live: Live) => {
    readonly name: string;
    readonly reason: string;
  } | null;
  /** Read off the full body (the `get` role's when it exists); see ConcealedField. */
  readonly concealed?: (live: Live) => readonly ConcealedField[];
  /**
   * Write fields (dotted paths) holding a `$NAME` reference to a value GitHub never echoes back (a
   * webhook's config.secret): left out of the comparison, resolved when the write executes, re-sent
   * on every run under an unverifiable facet, and read back by a snapshot as a per-item reference.
   * SecretPath admits a path only under `mapping`, and only where its carriers declare the facet; `mapping`
   * alone infers `M`, so a stray path is the error, never a re-inferred mapping.
   */
  readonly secrets?: readonly SecretPath<Ends, NoInfer<M>>[];
  readonly prose: {
    /** What apply does to an undeclared live resource, as the note and drift spell it ("DELETE it"). */
    readonly undeclaredAction: string;
    readonly undeclaredNote?: NoteWording;
    readonly undeclaredDrift?: DriftWording;
  };
  /**
   * The pairing itself is derived from `identity`, the very claims the planner's duplicate check reads, so the
   * merge and the planner cannot disagree about which entries are one; a declaration adds only the nested keyed
   * lists.
   */
  readonly layering?: Pick<KeyedListLayering, "nested">;
}
/** The module listSection() mints: SectionModule<K, Ends> at the registry, plus its declaration. */
interface ListSectionModule<K extends ListSectionKey, Ends extends ListEndpoints, Live extends object, F extends string, Key extends string, M extends string = never> {
  readonly key: K;
  readonly permission: SectionPermission;
  readonly undeclaredDefault: UndeclaredPolicy;
  readonly endpoints: Ends;
  readonly shape: z.ZodType;
  readonly secretValues?: (declared: Declared<K>) => DeclaredSecretValue[];
  readonly layering: KeyedListLayering;
  readonly validate: (declared: Declared<K>) => readonly DeclaredIssue[];
  readonly plan: (ctx: PlanContext<Ends, GraphqlDict, K>, desired: ValidatedInput<K>) => Promise<Result<SectionPlan<PlannedOp<Ends>>, SectionFailure>>;
  readonly snapshot: (ctx: SnapshotContext<Ends, GraphqlDict, K>) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
  /** The declaration, for the harness derivations (the mock's transformers, the fuzz witness). */
  readonly decl: ListSectionDecl<K, Ends, Live, F, Key, M>;
}
//#endregion
//#region src/sections/labels/index.d.ts
/** Case-insensitive matching is the section's whole contract; the brand marks a name as already folded. */
declare const labelNameKey: unique symbol;
type NameKey = string & {
  readonly [labelNameKey]: true;
};
//#endregion
//#region src/sections/environments/endpoints.d.ts
declare const ENDPOINTS$1: {
  readonly list: {
    readonly route: "GET /repos/{owner}/{repo}/environments";
    readonly statuses: {
      readonly 200: "the environment list";
    };
  };
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
    readonly phase: "execution";
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
  readonly pinsSnapshot: {
    readonly name: "EnvironmentPinsSnapshot";
    readonly kind: "read";
    readonly query: "query EnvironmentPinsSnapshot($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
    readonly connection: {
      readonly path: readonly ["repository", "pinnedEnvironments"];
    };
    readonly outcomes: {
      readonly ok: "the pinned environments with their 1-based positions, for the snapshot";
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
  readonly listProtected: {
    readonly route: "GET /repos/{owner}/{repo}/branches";
    readonly statuses: {
      readonly 200: "the protected branches";
    };
    readonly permission: {
      readonly repo: readonly ["contents"];
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
  readonly rulesSnapshot: {
    readonly name: "BranchProtectionRulesSnapshot";
    readonly kind: "read";
    readonly connection: {
      readonly path: readonly ["repository", "branchProtectionRules"];
    };
    readonly outcomes: {
      readonly ok: "the repository's classic branch protection rules, for the snapshot";
    };
    readonly query: "query BranchProtectionRulesSnapshot($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
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
//#region src/sections/actions/schema.d.ts
declare const ActionsConfig: z.ZodObject<{
  enabled: z.ZodOptional<z.ZodBoolean>;
  allowed_actions: z.ZodOptional<z.ZodEnum<{
    all: "all";
    local_only: "local_only";
    selected: "selected";
  }>>;
  sha_pinning_required: z.ZodOptional<z.ZodBoolean>;
  selected_actions: z.ZodOptional<z.ZodObject<{
    github_owned_allowed: z.ZodOptional<z.ZodBoolean>;
    verified_allowed: z.ZodOptional<z.ZodBoolean>;
    patterns_allowed: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strict>>;
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
    days: z.ZodInt;
  }, z.core.$strip>>;
  cache: z.ZodOptional<z.ZodObject<{
    max_cache_retention_days: z.ZodOptional<z.ZodInt>;
    max_cache_size_gb: z.ZodOptional<z.ZodInt>;
  }, z.core.$strict>>;
  oidc_customization_sub: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
    use_default: z.ZodLiteral<true>;
    use_immutable_subject: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>, z.ZodObject<{
    use_default: z.ZodLiteral<false>;
    include_claim_keys: z.ZodOptional<z.ZodArray<z.ZodString>>;
    use_immutable_subject: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>], "use_default">>;
  fork_pr_contributor_approval: z.ZodOptional<z.ZodObject<{
    approval_policy: z.ZodEnum<{
      all_external_contributors: "all_external_contributors";
      first_time_contributors: "first_time_contributors";
      first_time_contributors_new_to_github: "first_time_contributors_new_to_github";
    }>;
  }, z.core.$strip>>;
  fork_pr_workflows_private_repos: z.ZodOptional<z.ZodObject<{
    run_workflows_from_fork_pull_requests: z.ZodBoolean;
    send_write_tokens_to_workflows: z.ZodOptional<z.ZodBoolean>;
    send_secrets_and_variables: z.ZodOptional<z.ZodBoolean>;
    require_approval_for_fork_pr_workflows: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
}, z.core.$strip>;
type ActionsConfig = z.infer<typeof ActionsConfig>;
//#endregion
//#region src/sections/shared/secrets-engine.d.ts
interface SecretEntry {
  name: string;
  value: string;
}
/** Each value is labelled with its entry's secret NAME so a validation error can point at it. */
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
    readonly phase: "execution";
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
/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoSecretsPlan<K extends RepoSecretsKey> = { [F in RepoSecretsKey]: (ctx: PlanContext<RepoSecretsEndpoints<SecretsSegment<F>>, GraphqlDict, F>, declared: ValidatedInput<F>) => Promise<Result<SectionPlan<PlannedOp<RepoSecretsEndpoints<SecretsSegment<F>>>>, SectionFailure>>; }[K];
type WideDeclared$1 = SecretEntry[] | UndeclaredPolicyList<SecretEntry>;
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
  readonly layering: KeyedListLayering;
  readonly validate: (declared: WideDeclared$1) => readonly DeclaredIssue[];
  readonly plan: RepoSecretsPlan<K>;
  readonly snapshot: (ctx: SnapshotContext<RepoSecretsEndpoints<SecretsSegment<K>>, GraphqlDict, K>) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
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
      languages: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        actions: "actions";
        "c-cpp": "c-cpp";
        csharp: "csharp";
        go: "go";
        "java-kotlin": "java-kotlin";
        "javascript-typescript": "javascript-typescript";
        python: "python";
        ruby: "ruby";
        swift: "swift";
      }>>>;
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
    readonly languages: {
      readonly declarable: readonly ["actions", "c-cpp", "csharp", "go", "java-kotlin", "javascript-typescript", "python", "ruby", "swift"];
      readonly getOnly: {
        readonly javascript: "javascript-typescript";
        readonly typescript: "javascript-typescript";
      };
    };
    readonly read: {};
  };
  readonly code_quality_setup: {
    readonly path: "code-quality/setup";
    readonly slice: z.ZodObject<{
      state: z.ZodOptional<z.ZodEnum<{
        configured: "configured";
        "not-configured": "not-configured";
      }>>;
      languages: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        csharp: "csharp";
        go: "go";
        "java-kotlin": "java-kotlin";
        "javascript-typescript": "javascript-typescript";
        python: "python";
        ruby: "ruby";
      }>>>;
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
    readonly languages: {
      readonly declarable: readonly ["csharp", "go", "java-kotlin", "javascript-typescript", "python", "ruby"];
      readonly getOnly: {
        readonly rust: null;
      };
    };
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
/**
 * One setup's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the factory's one
 * SharedPlan serves it.
 */
type SetupPlan<K extends SetupKey> = { [F in SetupKey]: (ctx: PlanContext<SetupEndpoints<F>, GraphqlDict, F>, declared: ValidatedInput<F>) => Promise<Result<SectionPlan<PlannedOp<SetupEndpoints<F>>>, SectionFailure>>; }[K];
/** The module shape setupSection() mints (SectionModule<K> at the registry). */
interface SetupSectionModule<K extends SetupKey> {
  readonly key: K;
  readonly undeclaredDefault: "untouched";
  readonly permission: SectionPermission;
  readonly grantCaveat: string;
  readonly endpoints: SetupEndpoints<K>;
  readonly shape: z.ZodType;
  readonly plan: SetupPlan<K>;
  readonly snapshot: (ctx: SnapshotContext<SetupEndpoints<K>, GraphqlDict, K>) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
}
//#endregion
//#region src/sections/shared/variables-engine.d.ts
type PlainPayload = PlainData;
/** The index signature types the passthrough fields as plain data, so spreading them into a body needs no cast. */
interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: PlainPayload | undefined;
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
/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoVariablesPlan<K extends RepoVariablesKey> = { [F in RepoVariablesKey]: (ctx: PlanContext<RepoVariablesEndpoints<VariablesSegment<F>>, GraphqlDict, F>, declared: ValidatedInput<F>) => Promise<Result<SectionPlan<PlannedOp<RepoVariablesEndpoints<VariablesSegment<F>>>>, SectionFailure>>; }[K];
type WideDeclared = VariableEntry[] | UndeclaredPolicyList<VariableEntry>;
/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: {
    readonly repo: readonly [PatResource];
  };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  readonly layering: KeyedListLayering;
  readonly validate: (declared: WideDeclared) => readonly DeclaredIssue[];
  readonly plan: RepoVariablesPlan<K>;
  readonly snapshot: (ctx: SnapshotContext<RepoVariablesEndpoints<VariablesSegment<K>>, GraphqlDict, K>) => Promise<Result<SectionSnapshot<K>, SectionFailure>>;
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
    }, "repository">, declared: {
      [x: string]: unknown;
      description?: string | null | undefined;
      homepage?: string | null | undefined;
      private?: boolean | undefined;
      visibility?: string | undefined;
      security_and_analysis?: {
        advanced_security?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        code_security?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_push_protection?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_ai_detection?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_non_provider_patterns?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_delegated_alert_dismissal?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_delegated_bypass?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
        secret_scanning_delegated_bypass_options?: {
          reviewers?: {
            reviewer_id: number;
            reviewer_type: "ROLE" | "TEAM";
            mode?: "ALWAYS" | "EXEMPT" | undefined;
          }[] | undefined;
        } | undefined;
        secret_scanning_validity_checks?: {
          status?: "disabled" | "enabled" | undefined;
        } | undefined;
      } | null | undefined;
      has_issues?: boolean | undefined;
      has_projects?: boolean | undefined;
      has_wiki?: boolean | undefined;
      has_discussions?: boolean | undefined;
      has_pull_requests?: boolean | undefined;
      pull_request_creation_policy?: "all" | "collaborators_only" | undefined;
      is_template?: boolean | undefined;
      default_branch?: string | undefined;
      allow_squash_merge?: boolean | undefined;
      allow_merge_commit?: boolean | undefined;
      allow_rebase_merge?: boolean | undefined;
      allow_auto_merge?: boolean | undefined;
      delete_branch_on_merge?: boolean | undefined;
      allow_update_branch?: boolean | undefined;
      use_squash_pr_title_as_default?: boolean | undefined;
      squash_merge_commit_title?: "COMMIT_OR_PR_TITLE" | "PR_TITLE" | undefined;
      squash_merge_commit_message?: "BLANK" | "COMMIT_MESSAGES" | "PR_BODY" | undefined;
      merge_commit_title?: "MERGE_MESSAGE" | "PR_TITLE" | undefined;
      merge_commit_message?: "BLANK" | "PR_BODY" | "PR_TITLE" | undefined;
      archived?: boolean | undefined;
      allow_forking?: boolean | undefined;
      web_commit_signoff_required?: boolean | undefined;
      topics?: string | string[] | undefined;
      enable_vulnerability_alerts?: boolean | undefined;
      enable_automated_security_fixes?: boolean | undefined;
      enable_private_vulnerability_reporting?: boolean | undefined;
      enable_git_lfs?: boolean | undefined;
      enable_immutable_releases?: boolean | undefined;
      enable_sponsorships?: boolean | undefined;
      issue_creation_policy?: "all" | "collaborators_only" | undefined;
    } & ValidatedBrand<"repository">): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, "repository">): Promise<import("neverthrow").Result<{
      value: RepositoryConfig;
      notes: string[];
    }, SectionFailure>>;
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
  }, "name", NameKey, never>;
  rulesets: ListSectionModule<"rulesets", {
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
        readonly 422: "Usually this means a rules[].type GitHub does not recognize (a type the vendored spec does not know passes through verbatim, so a typo reaches GitHub unchanged), or \"parameters\" the live repository rejects for that rule type";
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
        readonly 422: "Usually this means a rules[].type GitHub does not recognize (a type the vendored spec does not know passes through verbatim, so a typo reaches GitHub unchanged), or \"parameters\" the live repository rejects for that rule type";
      };
    };
    readonly remove: {
      readonly route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}";
      readonly statuses: {
        readonly 204: "ruleset deleted";
      };
    };
  }, {
    [x: string]: unknown;
    id: number;
    name: string;
    source_type?: string | undefined;
    rules?: {
      [x: string]: unknown;
      type: string;
    }[] | undefined;
    bypass_actors?: {
      [x: string]: unknown;
      actor_id?: number | null | undefined;
      actor_type?: string | undefined;
      bypass_mode?: string | undefined;
    }[] | undefined;
  }, "name", string, never>;
  environments: {
    key: "environments";
    layering: KeyedListLayering;
    undeclaredDefault: "untouched";
    permission: SectionPermission;
    grantCaveat: string;
    endpoints: {
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/environments";
        readonly statuses: {
          readonly 200: "the environment list";
        };
      };
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
        readonly phase: "execution";
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
      readonly pinsSnapshot: {
        readonly name: "EnvironmentPinsSnapshot";
        readonly kind: "read";
        readonly query: "query EnvironmentPinsSnapshot($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
        readonly connection: {
          readonly path: readonly ["repository", "pinnedEnvironments"];
        };
        readonly outcomes: {
          readonly ok: "the pinned environments with their 1-based positions, for the snapshot";
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
    validate(desired: {
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
        type?: "branch" | "tag" | undefined;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          name: string;
          type?: "branch" | "tag" | undefined;
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
    }[] | {
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
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
          type?: "branch" | "tag" | undefined;
        }[] | {
          _undeclared?: "delete" | "keep" | undefined;
          entries: {
            name: string;
            type?: "branch" | "tag" | undefined;
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
      }[];
    }): DeclaredIssue[];
    plan(ctx: PlanContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/environments";
        readonly statuses: {
          readonly 200: "the environment list";
        };
      };
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
        readonly phase: "execution";
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
      readonly pinsSnapshot: {
        readonly name: "EnvironmentPinsSnapshot";
        readonly kind: "read";
        readonly query: "query EnvironmentPinsSnapshot($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
        readonly connection: {
          readonly path: readonly ["repository", "pinnedEnvironments"];
        };
        readonly outcomes: {
          readonly ok: "the pinned environments with their 1-based positions, for the snapshot";
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
    }, "environments">, desired: ({
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
        type?: "branch" | "tag" | undefined;
      }[] | {
        _undeclared?: "delete" | "keep" | undefined;
        entries: {
          name: string;
          type?: "branch" | "tag" | undefined;
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
    }[] & ValidatedBrand<"environments">) | ({
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
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
          type?: "branch" | "tag" | undefined;
        }[] | {
          _undeclared?: "delete" | "keep" | undefined;
          entries: {
            name: string;
            type?: "branch" | "tag" | undefined;
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
      }[];
    } & ValidatedBrand<"environments">)): Promise<import("neverthrow").Result<EnvironmentsPlan, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/environments";
        readonly statuses: {
          readonly 200: "the environment list";
        };
      };
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
        readonly phase: "execution";
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
      readonly pinsSnapshot: {
        readonly name: "EnvironmentPinsSnapshot";
        readonly kind: "read";
        readonly query: "query EnvironmentPinsSnapshot($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";
        readonly connection: {
          readonly path: readonly ["repository", "pinnedEnvironments"];
        };
        readonly outcomes: {
          readonly ok: "the pinned environments with their 1-based positions, for the snapshot";
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
    }, "environments">): Promise<import("neverthrow").Result<{
      value: undefined;
      notes: never[];
    } | {
      value: {
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
          type?: "branch" | "tag" | undefined;
        }[] | {
          _undeclared?: "delete" | "keep" | undefined;
          entries: {
            name: string;
            type?: "branch" | "tag" | undefined;
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
      }[];
      notes: string[];
    }, SectionFailure>>;
  };
  branches: {
    key: "branches";
    layering: KeyedListLayering;
    validate(declared: {
      name: string;
      protection: {
        [x: string]: unknown;
        required_status_checks?: {
          [x: string]: unknown;
          strict: boolean;
          contexts?: string[] | undefined;
          checks?: {
            context: string;
            app_id?: number | null | undefined;
          }[] | undefined;
        } | null | undefined;
        required_pull_request_reviews?: {
          [x: string]: unknown;
          required_approving_review_count?: number | undefined;
          dismissal_restrictions?: {
            [x: string]: unknown;
            users?: string[] | undefined;
            teams?: string[] | undefined;
            apps?: string[] | undefined;
          } | undefined;
          bypass_pull_request_allowances?: {
            [x: string]: unknown;
            users?: string[] | undefined;
            teams?: string[] | undefined;
            apps?: string[] | undefined;
          } | undefined;
        } | null | undefined;
        restrictions?: {
          [x: string]: unknown;
          users: string[];
          teams: string[];
          apps?: string[] | undefined;
        } | null | undefined;
        required_signatures?: boolean | undefined;
        force_push_bypassers?: string[] | undefined;
        required_deployments?: {
          environments: string[];
        } | null | undefined;
      } | null;
    }[] | {
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
        name: string;
        protection: {
          [x: string]: unknown;
          required_status_checks?: {
            [x: string]: unknown;
            strict: boolean;
            contexts?: string[] | undefined;
            checks?: {
              context: string;
              app_id?: number | null | undefined;
            }[] | undefined;
          } | null | undefined;
          required_pull_request_reviews?: {
            [x: string]: unknown;
            required_approving_review_count?: number | undefined;
            dismissal_restrictions?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
            bypass_pull_request_allowances?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
          } | null | undefined;
          restrictions?: {
            [x: string]: unknown;
            users: string[];
            teams: string[];
            apps?: string[] | undefined;
          } | null | undefined;
          required_signatures?: boolean | undefined;
          force_push_bypassers?: string[] | undefined;
          required_deployments?: {
            environments: string[];
          } | null | undefined;
        } | null;
      }[];
    }): DeclaredIssue[];
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
      readonly listProtected: {
        readonly route: "GET /repos/{owner}/{repo}/branches";
        readonly statuses: {
          readonly 200: "the protected branches";
        };
        readonly permission: {
          readonly repo: readonly ["contents"];
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
      readonly rulesSnapshot: {
        readonly name: "BranchProtectionRulesSnapshot";
        readonly kind: "read";
        readonly connection: {
          readonly path: readonly ["repository", "branchProtectionRules"];
        };
        readonly outcomes: {
          readonly ok: "the repository's classic branch protection rules, for the snapshot";
        };
        readonly query: "query BranchProtectionRulesSnapshot($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
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
      readonly listProtected: {
        readonly route: "GET /repos/{owner}/{repo}/branches";
        readonly statuses: {
          readonly 200: "the protected branches";
        };
        readonly permission: {
          readonly repo: readonly ["contents"];
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
      readonly rulesSnapshot: {
        readonly name: "BranchProtectionRulesSnapshot";
        readonly kind: "read";
        readonly connection: {
          readonly path: readonly ["repository", "branchProtectionRules"];
        };
        readonly outcomes: {
          readonly ok: "the repository's classic branch protection rules, for the snapshot";
        };
        readonly query: "query BranchProtectionRulesSnapshot($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
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
    }, "branches">, desired: ({
      name: string;
      protection: {
        [x: string]: unknown;
        required_status_checks?: {
          [x: string]: unknown;
          strict: boolean;
          contexts?: string[] | undefined;
          checks?: {
            context: string;
            app_id?: number | null | undefined;
          }[] | undefined;
        } | null | undefined;
        required_pull_request_reviews?: {
          [x: string]: unknown;
          required_approving_review_count?: number | undefined;
          dismissal_restrictions?: {
            [x: string]: unknown;
            users?: string[] | undefined;
            teams?: string[] | undefined;
            apps?: string[] | undefined;
          } | undefined;
          bypass_pull_request_allowances?: {
            [x: string]: unknown;
            users?: string[] | undefined;
            teams?: string[] | undefined;
            apps?: string[] | undefined;
          } | undefined;
        } | null | undefined;
        restrictions?: {
          [x: string]: unknown;
          users: string[];
          teams: string[];
          apps?: string[] | undefined;
        } | null | undefined;
        required_signatures?: boolean | undefined;
        force_push_bypassers?: string[] | undefined;
        required_deployments?: {
          environments: string[];
        } | null | undefined;
      } | null;
    }[] & ValidatedBrand<"branches">) | ({
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
        name: string;
        protection: {
          [x: string]: unknown;
          required_status_checks?: {
            [x: string]: unknown;
            strict: boolean;
            contexts?: string[] | undefined;
            checks?: {
              context: string;
              app_id?: number | null | undefined;
            }[] | undefined;
          } | null | undefined;
          required_pull_request_reviews?: {
            [x: string]: unknown;
            required_approving_review_count?: number | undefined;
            dismissal_restrictions?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
            bypass_pull_request_allowances?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
          } | null | undefined;
          restrictions?: {
            [x: string]: unknown;
            users: string[];
            teams: string[];
            apps?: string[] | undefined;
          } | null | undefined;
          required_signatures?: boolean | undefined;
          force_push_bypassers?: string[] | undefined;
          required_deployments?: {
            environments: string[];
          } | null | undefined;
        } | null;
      }[];
    } & ValidatedBrand<"branches">)): Promise<import("neverthrow").Result<BranchesPlan, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
      readonly listProtected: {
        readonly route: "GET /repos/{owner}/{repo}/branches";
        readonly statuses: {
          readonly 200: "the protected branches";
        };
        readonly permission: {
          readonly repo: readonly ["contents"];
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
      readonly rulesSnapshot: {
        readonly name: "BranchProtectionRulesSnapshot";
        readonly kind: "read";
        readonly connection: {
          readonly path: readonly ["repository", "branchProtectionRules"];
        };
        readonly outcomes: {
          readonly ok: "the repository's classic branch protection rules, for the snapshot";
        };
        readonly query: "query BranchProtectionRulesSnapshot($owner: String!, $repo: String!, $cursor: String) {\n  repository(owner: $owner, name: $repo) {\n    branchProtectionRules(first: 100, after: $cursor) {\n      nodes {\n        id\n        pattern\n        isAdminEnforced\n        requiresLinearHistory\n        allowsForcePushes\n        allowsDeletions\n        blocksCreations\n        requiresConversationResolution\n        lockBranch\n        lockAllowsFetchAndMerge\n        requiresCommitSignatures\n        requiresStatusChecks\n        requiresStrictStatusChecks\n        requiredStatusCheckContexts\n        requiresApprovingReviews\n        requiredApprovingReviewCount\n        requiresCodeOwnerReviews\n        dismissesStaleReviews\n        requireLastPushApproval\n        requiresDeployments\n        requiredDeploymentEnvironments\n        bypassForcePushAllowances(first: 100) {\n          nodes {\n            actor {\n              __typename\n              ... on User { login }\n              ... on Team { combinedSlug }\n              ... on App { slug }\n            }\n          }\n          pageInfo { hasNextPage }\n        }\n      }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}";
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
    }, "branches">): Promise<import("neverthrow").Result<{
      value: undefined;
      notes: string[];
    } | {
      value: {
        name: string;
        protection: {
          [x: string]: unknown;
          required_status_checks?: {
            [x: string]: unknown;
            strict: boolean;
            contexts?: string[] | undefined;
            checks?: {
              context: string;
              app_id?: number | null | undefined;
            }[] | undefined;
          } | null | undefined;
          required_pull_request_reviews?: {
            [x: string]: unknown;
            required_approving_review_count?: number | undefined;
            dismissal_restrictions?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
            bypass_pull_request_allowances?: {
              [x: string]: unknown;
              users?: string[] | undefined;
              teams?: string[] | undefined;
              apps?: string[] | undefined;
            } | undefined;
          } | null | undefined;
          restrictions?: {
            [x: string]: unknown;
            users: string[];
            teams: string[];
            apps?: string[] | undefined;
          } | null | undefined;
          required_signatures?: boolean | undefined;
          force_push_bypassers?: string[] | undefined;
          required_deployments?: {
            environments: string[];
          } | null | undefined;
        } | null;
      }[];
      notes: string[];
    }, SectionFailure>>;
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
    is_alphanumeric: boolean;
  }, "key_prefix", string, never>;
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "actions">, desired: {
      enabled?: boolean | undefined;
      allowed_actions?: "all" | "local_only" | "selected" | undefined;
      sha_pinning_required?: boolean | undefined;
      selected_actions?: {
        github_owned_allowed?: boolean | undefined;
        verified_allowed?: boolean | undefined;
        patterns_allowed?: string[] | undefined;
      } | undefined;
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
        use_default: true;
        use_immutable_subject?: boolean | undefined;
      } | {
        use_default: false;
        include_claim_keys?: string[] | undefined;
        use_immutable_subject?: boolean | undefined;
      } | undefined;
      fork_pr_contributor_approval?: {
        approval_policy: "all_external_contributors" | "first_time_contributors" | "first_time_contributors_new_to_github";
      } | undefined;
      fork_pr_workflows_private_repos?: {
        run_workflows_from_fork_pull_requests: boolean;
        send_write_tokens_to_workflows?: boolean | undefined;
        send_secrets_and_variables?: boolean | undefined;
        require_approval_for_fork_pr_workflows?: boolean | undefined;
      } | undefined;
    } & ValidatedBrand<"actions">): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "actions">): Promise<import("neverthrow").Result<{
      value: ActionsConfig;
      notes: string[];
    }, SectionFailure>>;
  };
  actions_secrets: RepoSecretsSectionModule<"actions_secrets">;
  dependabot_secrets: RepoSecretsSectionModule<"dependabot_secrets">;
  codespaces_secrets: RepoSecretsSectionModule<"codespaces_secrets">;
  agents_secrets: RepoSecretsSectionModule<"agents_secrets">;
  workflows: {
    key: "workflows";
    layering: KeyedListLayering;
    validate(declared: {
      path: string;
      state: "active" | "disabled";
    }[] | {
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
        path: string;
        state: "active" | "disabled";
      }[];
    }): DeclaredIssue[];
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "workflows">, desired: ({
      path: string;
      state: "active" | "disabled";
    }[] & ValidatedBrand<"workflows">) | ({
      _layering?: "deep" | "replace" | "shallow" | undefined;
      entries: {
        path: string;
        state: "active" | "disabled";
      }[];
    } & ValidatedBrand<"workflows">)): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "workflows">): Promise<import("neverthrow").Result<SectionSnapshot<"workflows">, SectionFailure>>;
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "check_suite_preferences">, desired: {
      [x: string]: unknown;
      auto_trigger_checks: {
        app_id: number;
        setting: boolean;
      }[];
    } & ValidatedBrand<"check_suite_preferences">): Promise<import("neverthrow").Ok<SectionPlan<PlannedOpBase<readonly string[]> & {
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
    }>, SectionFailure>>;
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "pages">, desired: ({
      build_type?: "legacy" | "workflow" | undefined;
      source?: {
        branch: string;
        path?: "/" | "/docs" | undefined;
      } | undefined;
      cname?: string | null | undefined;
      https_enforced?: boolean | undefined;
      public?: boolean | undefined;
    } & ValidatedBrand<"pages">) | null): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "pages">): Promise<import("neverthrow").Result<SectionSnapshot<"pages">, SectionFailure>>;
  };
  code_scanning_default_setup: SetupSectionModule<"code_scanning_default_setup">;
  code_quality_setup: SetupSectionModule<"code_quality_setup">;
  collaborators: {
    key: "collaborators";
    layering: KeyedListLayering;
    validate(declared: {
      username: string;
      permission?: string | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        username: string;
        permission?: string | undefined;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    }): DeclaredIssue[];
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "collaborators">, declared: ({
      username: string;
      permission?: string | undefined;
    }[] & ValidatedBrand<"collaborators">) | ({
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        username: string;
        permission?: string | undefined;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    } & ValidatedBrand<"collaborators">)): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "collaborators">): Promise<import("neverthrow").Result<{
      value: undefined;
      notes: string[];
    } | {
      value: UndeclaredPolicyList<{
        username: string;
        permission?: string | undefined;
      }>;
      notes: string[];
    }, SectionFailure>>;
  };
  teams: {
    key: "teams";
    layering: KeyedListLayering;
    validate(declared: {
      name: string;
      permission?: string | undefined;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name: string;
        permission?: string | undefined;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    }): DeclaredIssue[];
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
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/teams";
        readonly statuses: {
          readonly 200: "the teams with access to the repository";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly primaryRead: {
          readonly notFound: "denied";
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
      readonly revoke: {
        readonly route: "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access revoked";
        };
      };
    };
    shape: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    closedSurface: {
      known: {
        name: true;
        permission: true;
      };
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
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/teams";
        readonly statuses: {
          readonly 200: "the teams with access to the repository";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly primaryRead: {
          readonly notFound: "denied";
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
      readonly revoke: {
        readonly route: "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access revoked";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>, "teams">, declared: ({
      name: string;
      permission?: string | undefined;
    }[] & ValidatedBrand<"teams">) | ({
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name: string;
        permission?: string | undefined;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    } & ValidatedBrand<"teams">)): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    }) | (PlannedOpBase<readonly [string, ...string[]]> & {
      readonly params: Readonly<Record<"org" | "team_slug", string>>;
    } & {
      readonly role: "revoke";
      readonly query?: Readonly<Record<string, string>>;
      readonly payload?: PlainData | Late<PlainData>;
      readonly tolerate?: Tolerance<{
        readonly route: "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access revoked";
        };
      }> | undefined;
      readonly variables?: never;
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
      readonly org: {
        readonly route: "GET /orgs/{org}";
        readonly statuses: {
          readonly 200: "the organization";
          readonly 404: "not an organization (a personal account)";
        };
        readonly permission: "none";
      };
      readonly list: {
        readonly route: "GET /repos/{owner}/{repo}/teams";
        readonly statuses: {
          readonly 200: "the teams with access to the repository";
        };
        readonly permission: {
          readonly repo: readonly ["administration"];
        };
        readonly primaryRead: {
          readonly notFound: "denied";
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
      readonly revoke: {
        readonly route: "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}";
        readonly statuses: {
          readonly 204: "team access revoked";
        };
      };
    }, Readonly<Record<string, GraphqlOpDecl>>, "teams">): Promise<import("neverthrow").Result<{
      value: UndeclaredPolicyList<{
        name: string;
        permission?: string | undefined;
      }> | undefined;
      notes: string[];
    }, SectionFailure>>;
  };
  milestones: ListSectionModule<"milestones", {
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
  }, {
    [x: string]: unknown;
    number: number;
    title: string;
    due_on: string | null;
  }, "title", string, never>;
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "interaction_limits">, desired: ({
      limit?: "collaborators_only" | "contributors_only" | "existing_users" | undefined;
      expiry?: "one_day" | "one_month" | "one_week" | "six_months" | "three_days" | undefined;
      pull_request_creation_cap?: {
        enabled: boolean;
        max_open_pull_requests?: number | undefined;
      } | undefined;
      pull_request_creation_bypass?: string[] | undefined;
    } & ValidatedBrand<"interaction_limits">) | null): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "interaction_limits">): Promise<import("neverthrow").Result<{
      value: undefined;
      notes: string[];
    } | {
      value: {
        limit?: "collaborators_only" | "contributors_only" | "existing_users" | undefined;
        expiry?: "one_day" | "one_month" | "one_week" | "six_months" | "three_days" | undefined;
        pull_request_creation_cap?: {
          enabled: boolean;
          max_open_pull_requests?: number | undefined;
        } | undefined;
        pull_request_creation_bypass?: string[] | undefined;
      };
      notes: string[];
    }, SectionFailure>>;
  };
  actions_variables: RepoVariablesSectionModule<"actions_variables">;
  agents_variables: RepoVariablesSectionModule<"agents_variables">;
  webhooks: ListSectionModule<"webhooks", {
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
  }, {
    [x: string]: unknown;
    id: number;
    name?: string | undefined;
    active?: boolean | undefined;
    events?: string[] | undefined;
    config?: {
      [x: string]: unknown;
      url?: string | undefined;
      secret?: string | undefined;
    } | undefined;
  }, "config.url", string, "config">;
  custom_properties: {
    key: "custom_properties";
    layering: KeyedListLayering;
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
      consequence: string;
    };
    validate(declared: {
      property_name: string;
      value: string | number | boolean | string[] | null;
    }[] | {
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        property_name: string;
        value: string | number | boolean | string[] | null;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    }): DeclaredIssue[];
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "custom_properties">, declared: ({
      property_name: string;
      value: string | number | boolean | string[] | null;
    }[] & ValidatedBrand<"custom_properties">) | ({
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        property_name: string;
        value: string | number | boolean | string[] | null;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    } & ValidatedBrand<"custom_properties">)): Promise<import("neverthrow").Result<SectionPlan<PlannedOpBase<readonly [string, ...string[]]> & {
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
    }>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "custom_properties">): Promise<import("neverthrow").Result<SectionSnapshot<"custom_properties">, SectionFailure>>;
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
    id: number;
    title: string;
    read_only: boolean;
    key: string;
    algorithm: string;
  }, "title", string, never>;
  secret_scanning_custom_patterns: {
    key: "secret_scanning_custom_patterns";
    layering: KeyedListLayering;
    validate(declared: {
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
      _layering?: "deep" | "replace" | "shallow" | undefined;
    }): DeclaredIssue[];
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "secret_scanning_custom_patterns">, declared: ({
      name: string;
      pattern: string;
      start_delimiter?: string | undefined;
      end_delimiter?: string | undefined;
      must_match?: string[] | undefined;
      must_not_match?: string[] | undefined;
    }[] & ValidatedBrand<"secret_scanning_custom_patterns">) | ({
      _undeclared?: "delete" | "keep" | undefined;
      entries: {
        name: string;
        pattern: string;
        start_delimiter?: string | undefined;
        end_delimiter?: string | undefined;
        must_match?: string[] | undefined;
        must_not_match?: string[] | undefined;
      }[];
      _layering?: "deep" | "replace" | "shallow" | undefined;
    } & ValidatedBrand<"secret_scanning_custom_patterns">)): Promise<import("neverthrow").Result<SectionPlan<(PlannedOpBase<readonly [string, ...string[]]> & {
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
    })>, SectionFailure>>;
    snapshot(ctx: SnapshotContext<{
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
    }, Readonly<Record<string, GraphqlOpDecl>>, "secret_scanning_custom_patterns">): Promise<import("neverthrow").Result<SectionSnapshot<"secret_scanning_custom_patterns">, SectionFailure>>;
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
declare const SECTIONS: readonly SectionModule[];
/** The section module for a key (validate.ts reads shape + closedSurface). */
declare function sectionModule<K extends SectionKey>(key: K): SectionModule<K>;
type TaggedEndpoint = DeepReadonly<EndpointDecl & {
  readonly section: SectionKey;
  readonly role: string;
}>;
/**
 * The single view the e2e mock's route table and USED_PATHS iterate, keyed by the exact SectionEndpointKey
 * union so an undeclared lookup does not compile. The tagged entries are deep-frozen as they are built;
 * their source declarations were frozen at registration. `sections` is injectable so the scope-free
 * assert is testable; an injected list keeps string keys.
 */
declare function allEndpoints(): Readonly<Record<SectionEndpointKey, TaggedEndpoint>>;
declare function allEndpoints(sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints">>): Readonly<Record<string, TaggedEndpoint>>;
type TaggedGraphqlOp = DeepReadonly<GraphqlOpDecl & {
  readonly section: SectionKey;
  readonly role: string;
}>;
/**
 * The allEndpoints() sibling for the mock's dispatch table, the coverage tripwire, and the fault-key
 * universe; frozen the same way. Operation NAMES must be globally unique (the wire dispatch key),
 * and a role never collides with a REST role in the same section (fault directives share one "section.role" key space).
 */
declare function allGraphqlOps(): Readonly<Record<SectionGraphqlKey, TaggedGraphqlOp>>;
declare function allGraphqlOps(sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints" | "graphql">>): Readonly<Record<string, TaggedGraphqlOp>>;
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
declare class SectionSelection {
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
 * unvalidated document is a compile error. The value is the PARSED document zod built, never the caller's object. Each
 * section's value reads back as ValidatedInput, the per-section proof every plan() takes, so the document is the only
 * source of planner input.
 */
declare const validatedSettings: unique symbol;
type ValidatedSettings = { [K in keyof SettingsFile]: K extends SectionKey ? ValidatedInput<K> : SettingsFile[K]; } & {
  readonly [validatedSettings]: true;
};
interface RepoRunOptions {
  repo: RepoRef;
  settings: ValidatedSettings;
  mode: "apply" | "check";
  onMissingPermission: OnMissingPermission;
  sections: SectionSelection;
  secretEnv?: Record<string, string | undefined>;
}
/** What one repository's apply or check ends in; a subset of RunOutcome, pinned below. */
type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";
interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  /** Non-empty when the preflight barrier refused to write anything. */
  preflightDenied: string[];
}
/** The keys of the skipped rows, over any mode's section outcomes: only the closed status decides. */
declare function skippedSectionKeys(outcomes: ReadonlyArray<{
  key: SectionKey;
  status: string;
}>): SectionKey[];
interface ValidateOptions {
  /** The run's `undeclared` input: the fallback for a list whose wrapper and file set no policy, before the list's default. */
  readonly undeclared?: UndeclaredPolicy | undefined;
  /**
   * Who authored the document; "operator" when omitted. The multi-repo flow passes "target" for a target's own
   * settings.yml, so a secret reference in it is refused here, with the rest of the document's problems.
   */
  readonly secretSource?: SettingsSource | undefined;
}
/**
 * The ONE boundary that turns a raw parsed document into the ValidatedSettings the engine accepts. Unknown top-level
 * keys are errors, except outside a non-empty `sections` allowlist, where they downgrade to a warning; an unknown
 * underscore key is an error under every allowlist, since the underscore names this action's directives and nothing else.
 * The branded document carries every undeclared policy explicit (resolveUndeclaredPolicies), so a planner reads one
 * off its wrapper and never derives it; a rendered document arrives resolved already and passes through unchanged.
 */
declare function validateSettingsDoc(settings: unknown, sourceLabel: string, sections: SectionSelection, io: Io, options?: ValidateOptions): Result<ValidatedSettings, SettingsProblem>;
/** A plan section has no write capability, so planning IS the read-only probe; `active` is injectable for tests. */
declare function preflightProbe(api: GitHubClient, repo: RepoRef, active: typeof SECTIONS, settings: ValidatedSettings): Promise<string[]>;
declare function runForRepo(api: GitHubClient, opts: RepoRunOptions, io: Io): Promise<RepoRunResult>;
//#endregion
//#region src/engine/outcome.d.ts
/**
 * The one outcome model every mode concludes in: the result words, ranked worst first. The engine's per-repository
 * result (./orchestrate.ts) and the snapshot result (./snapshot.ts) are subsets pinned to this list, and the flows fold
 * a run's targets through worstOf(), so no mode can grow a word or a ranking of its own.
 */
/**
 * Worst-first. The healthy words never share a run (clean and drift belong to check, applied to apply, snapshot to
 * snapshot, rendered to render), so their order against each other is never exercised; skipped appears only across a fleet.
 */
declare const RUN_RESULTS: readonly ["failed", "drift", "partial", "skipped", "applied", "clean", "snapshot", "rendered"];
type RunOutcome = (typeof RUN_RESULTS)[number];
/** The worst result present. Every run has a target, so an empty fold is a caller bug, not a healthy run. */
declare function worstOf(results: ReadonlyArray<{
  result: RunOutcome;
}>): RunOutcome;
//#endregion
//#region src/engine/snapshot.d.ts
interface SnapshotRunOptions {
  /** The target repository, parsed at the caller's validated boundary. */
  repo: RepoRef;
  /**
   * The allowlist. Its required set goes unread: required-sections governs what must apply, and
   * a snapshot never writes, so a denial classifies on onMissingPermission alone.
   */
  sections: SectionSelection;
  onMissingPermission: OnMissingPermission;
}
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
 * The document exists only when the run did not fail: a failed section (a denial under the fail
 * policy, a failure of any other kind, a value its own schema rejects) withholds it, so a failed result cannot be
 * rendered by mistake. "partial" says a section was skipped under the warn policy.
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
 * The snapshot as a settings file: the language-server schema pin and every outcome line, then
 * the document in the canonical order the merge flow writes too. Nothing in the file names the
 * moment it was taken (the run summary and a notice carry that), so a snapshot of an unchanged
 * repository is byte for byte the last one. A message spanning several physical lines (an API
 * error body) is commented line by line, so no line escapes the header.
 */
declare function renderSnapshotYaml(result: RenderableSnapshot, schemaUrl: string): string;
//#endregion
//#region src/github/repo-visibility.d.ts
/** A repository's visibility as the probe established it; "unknown" means it could not. */
type RepoVisibility = "public" | "private" | "internal" | "unknown";
declare function createVisibilityResolver(api: GitHubClient): (slug: string) => Promise<RepoVisibility>;
//#endregion
//#region src/report/artifact-report.d.ts
/** For config parse: a malformed `report-public-key` is rejected before any API work. Accepts exactly what the age library accepts. */
declare function parseRecipient(recipient: string): Result<void, ProblemOf<"age-recipient-invalid">>;
/** Decrypt locally with `age -d -i key.txt private-report.md.age`. */
declare function encryptReport(recipient: string, content: string): Promise<Uint8Array>;
/**
 * The upload port: the action implements it over @actions/artifact, tests capture. `failed` is the reason the upload
 * did not happen, as prose about the artifact service, never the report content.
 */
interface ArtifactUploader {
  upload(name: string, file: {
    name: string;
    data: Uint8Array;
  }): Promise<{
    uploaded: true;
  } | {
    failed: string;
  }>;
}
type ArtifactDelivery = {
  uploaded: true;
} | {
  warning: string;
};
/**
 * Never throws: report delivery is auxiliary, so every failure is a warning and the run's result stays untouched. The
 * messages describe the artifact service or the recipient, never the report content, which leaves this module only as
 * ciphertext. An uploader that throws instead of answering is read the same way as one that answers `failed`.
 */
declare function deliverArtifactReport(uploader: ArtifactUploader, document: string, recipient: string): Promise<ArtifactDelivery>;
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
declare const PRIVATE_REPORT_CHANNELS: readonly ["none", "issue", "issue-on-failure", "artifact"];
type PrivateReportChannel = (typeof PRIVATE_REPORT_CHANNELS)[number];
/**
 * A section row as every mode closes it: the key and status are closed values, the detail lines are live, and an
 * apply or check row carries the HTTP code of its failure or skip.
 */
interface ClosedOutcome {
  key: SectionKey;
  status: SectionOutcome["status"] | SectionSnapshotOutcome["status"];
  detail: string[];
  httpStatus?: number;
}
/**
 * One target's rich end state, whatever the mode: slug, section outcomes with live detail, the note for a skip or
 * failure that produced no outcomes, and the snapshot file the target wrote (its path names the slug). Open in the
 * clear; sealed with the transcript when redacted.
 */
interface TargetDetail {
  slug: string;
  outcomes: ClosedOutcome[];
  note?: string;
  file?: string;
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
 * the caller can route it through the target's capturing sink. An injected document is a new document, so it earns
 * its brand where every document does: through validateSettingsDoc, the brand's one mint.
 */
declare function applyMarkerInjection(settings: ValidatedSettings, on: boolean): {
  settings: ValidatedSettings;
  notice?: string;
};
declare const CONCLUDED: unique symbol;
/** The brand makes runOutcome() the only constructor, so the report cannot be told a result and a verdict that disagree. */
interface RunConclusion {
  readonly result: RunOutcome;
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
 * parseConfig refuses the artifact channel for a face without an upload capability, so an artifact channel with no
 * uploader here is a face that declared a capability it does not hand in: an invariant violation, not a run outcome.
 */
declare function openReportChannel(api: GitHubClient, channel: PrivateReportChannel, meta: ReportRunMeta, reportPublicKey: string, io: Io, uploader?: ArtifactUploader): ReportChannel | null;
//#endregion
//#region src/flows/redact.d.ts
declare const PRIVATE_REPOS_POLICIES: readonly ["redact", "show"];
type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];
/** One target's end state: safe closed values plus the detail the public view projects from. */
interface TargetOutcome {
  source: Target["source"];
  result: RunOutcome;
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  detail: TargetDetail | Private<RedactedDetail>;
}
/** A leak-free section outcome: key and status survive, detail is hidden. */
type RedactedOutcome = {
  key: ClosedOutcome["key"];
  status: ClosedOutcome["status"];
  detail: string[];
};
/** The public rendering of one target's detail: the section rows, the note under its heading, and the file it wrote. */
interface PublicDetail {
  outcomes: RedactedOutcome[];
  note?: string;
  /** Where a snapshot target's file went, as the public view may show it. */
  file?: string;
}
declare function publicDetail(detail: TargetOutcome["detail"]): PublicDetail;
interface PublicTargetView extends PublicDetail {
  display: string;
  source: Target["source"];
  result: RunOutcome;
}
declare function toPublicView(target: TargetOutcome): PublicTargetView;
interface RedactionPlan {
  isRedacted(slug: string): boolean;
  display(slug: string): string;
  /** Every slug that must be masked: redacted targets plus discovery-filtered privates. */
  maskedSlugs: string[];
}
declare function planRedaction(policy: PrivateReposPolicy, orderedTargetSlugs: string[], extraPrivateSlugs: Private<string>[], isPrivateSlug: (slug: string) => boolean, selfSlug: string): RedactionPlan;
/**
 * Lets nothing textual out: annotate/log are recorded for the private report, debug/summary/output are dropped (those
 * surfaces are written from the public view), only the mask registry passes through. The lines are recorded UNMASKED so
 * the report can name the private slug; a masked secret never reaches them, because a resolved plaintext is consumed
 * only inside payload thunks and sealing, and GitHubApi withholds every error body and transport message of a
 * secret-carrying request (the e2e runner's checkReportLeaks sweeps each delivered report for the run's secrets).
 */
declare function capturingIo(io: Io): {
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
  /** The `undeclared` input: the fallback policy below a list's wrapper and the file's top-level `_undeclared`; unset by default. */
  undeclared?: UndeclaredPolicy | undefined;
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
declare function concludeRun(io: Io, run: FinishedRun): number;
/**
 * A run that failed before any target ran gets a failed target's conclusion and no summary; the one place a fatal
 * problem becomes text, in the one wording both faces print.
 */
declare function failRun(io: Io, problem: Problem): number;
interface FinishedRender {
  layers: readonly string[];
  renderedFile: string;
}
declare function concludeRender(io: Io, run: FinishedRender): number;
//#endregion
//#region src/flows/multi.d.ts
/** The single source for the action.yml `settings-file` default, the multi-repo override guard in src/flows/inputs.ts, and the prose below. */
declare const DEFAULT_SETTINGS_FILE = ".github/settings.yml";
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
declare function resolveTargets(api: GitHubClient, cfg: TargetsConfig, io: Io): ResultAsync<ResolvedTargets, Problem>;
/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) come back as the error
 * before any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
declare function runMulti(api: GitHubClient, cfg: MultiConfig, io: Io, uploader?: ArtifactUploader): ResultAsync<TargetOutcome[], Problem>;
//#endregion
//#region src/flows/render.d.ts
interface RenderConfig extends FoldOptions {
  settingsFiles: string[];
  renderedFile: string;
}
declare function runRender(cfg: RenderConfig, io: Io): Result<FinishedRender, Problem>;
//#endregion
//#region src/flows/single.d.ts
interface SingleConfig extends RunFlowConfig {
  repo: RepoRef;
  settingsFile: string;
}
type SingleOutcome = Omit<TargetOutcome, "source">;
declare function runSingle(api: GitHubClient, cfg: SingleConfig, io: Io, uploader?: ArtifactUploader): ResultAsync<SingleOutcome, Problem>;
//#endregion
//#region src/flows/snapshot.d.ts
/**
 * The schema the written file's editor hint points at: the schema of this
 * release line, spelled as the README's quick start spells it. The marker
 * lets a major release rewrite the tag here (release-please-config.json lists
 * this file); test/docs/readme.test.ts pins it to the README's hint.
 */
declare const SNAPSHOT_SCHEMA_URL = "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json";
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
/**
 * A finished mode: snapshot run as runSnapshot hands it over: every target
 * closed through its channel, so a redacted one is sealed with its transcript
 * and concludeSnapshot opens only the public view. `takenAt` is the run's one
 * moment (an ISO-8601 UTC instant), which the summary states and no file carries.
 */
type FinishedSnapshot = {
  form: "file";
  takenAt: string;
  target: Omit<TargetOutcome, "source">;
} | {
  form: "dir";
  takenAt: string;
  snapshotDir: string;
  targets: TargetOutcome[];
};
/**
 * Execute a mode: snapshot run. A destination that would overwrite an authored
 * file, or a fleet that cannot be resolved, comes back as the error before any
 * target is read; otherwise every target's closed outcome, which
 * concludeSnapshot turns into the summary, the outputs, and the exit code.
 */
declare function runSnapshot(api: GitHubClient, cfg: SnapshotConfig, io: Io): ResultAsync<FinishedSnapshot, Problem>;
/**
 * A finished mode: snapshot run: the public view is projected first, so nothing below carries a redacted slug; then
 * the summary, the outputs, the result line, and the exit code as every mode ends.
 */
declare function concludeSnapshot(io: Io, finished: FinishedSnapshot): number;
//#endregion
//#region src/flows/inputs.d.ts
/** Default `private-repos`, pinned against action.yml by the contract test. */
declare const DEFAULT_PRIVATE_REPOS = "redact";
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
declare const INPUT_DECLS: {
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
    readonly summary: "Settings file path (single-repo mode); in `mode: render`, the ordered list of layers to fold, low to high";
    readonly list: true;
  };
  readonly mode: {
    readonly description: string;
    readonly default: "apply";
    readonly summary: string;
  };
  readonly "rendered-file": {
    readonly description: string;
    readonly default: "";
    readonly summary: "`mode: render` only (required there): where the rendered document is written, exactly what `apply` would run";
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
    readonly description: "Optional comma-separated allowlist of sections to process. apply, check, and snapshot only: mode: render writes every section its layers declare, so the allowlist belongs on the step that runs the rendered document and fails the render when set.";
    readonly default: "";
    readonly summary: "Comma-separated allowlist of sections to process (apply, check, and snapshot; rejected in `mode: render`)";
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
    readonly summary: string;
    readonly shownDefault: "`deep`";
  };
  readonly undeclared: {
    readonly description: string;
    readonly default: "";
    readonly summary: string;
    readonly shownDefault: "(each list's default)";
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
declare const FILTER_INPUTS: readonly ["visibility", "archived", "forks", "exclude", "topics", "affiliation"];
declare const MODES: readonly ["apply", "check", "render", "snapshot"];
type Mode = (typeof MODES)[number];
/**
 * Their declared defaults are empty so "explicitly set" is detectable, as with the discovery filters; apply and check
 * reject a set one instead of silently ignoring it.
 */
declare const RENDER_ONLY_INPUTS: readonly ["rendered-file", "layering"];
declare const SNAPSHOT_ONLY_INPUTS: readonly ["snapshot-file", "snapshot-dir"];
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
  kind: "render";
} & RenderConfig) | ({
  kind: "snapshot";
} & Pick<CommonConfig, "token" | "apiVersion"> & SnapshotConfig);
/**
 * `token` is tolerated unread (a workflow commonly sets it on every step). Every declared input NOT listed here is an
 * apply/check control, so the merge rejects it unless it holds its declared default, which the runner supplies whether
 * or not the workflow set the input.
 */
declare const RENDER_INPUTS: readonly ["mode", "settings-file", "rendered-file", "layering", "undeclared", "token"];
/**
 * Derived from the declarations, so a future input is rejected by the merge until listed in RENDER_INPUTS; exported so
 * the layering guide's table is pinned to the whole set.
 */
declare const RENDER_REJECTED_INPUTS: readonly InputName[];
/**
 * Every declared input NOT listed here is an apply, check, or merge control, so the snapshot rejects it unless it
 * holds its declared default, which the runner supplies whether or not the workflow set the input.
 */
declare const SNAPSHOT_INPUTS: readonly ["token", "repository", "mode", "snapshot-file", "snapshot-dir", "on-missing-permission", "sections", "api-version", "repos", "repos-dir", "private-repos", "visibility", "archived", "forks", "exclude", "topics", "affiliation"];
/**
 * Derived from the declarations, so a future input is rejected by the snapshot until listed in SNAPSHOT_INPUTS;
 * exported so the snapshot guide's table is pinned to the whole set.
 */
declare const SNAPSHOT_REJECTED_INPUTS: readonly InputName[];
/** The file form of a mode: snapshot run: one repository written to snapshotFile. */
type SnapshotFileConfig = Extract<RunConfig, {
  kind: "snapshot";
  form: "file";
}>;
/**
 * The file the `settings-file` input names, or its declared default: known before any parsing, so a failure can
 * name it. The CLI's init writes that file, the one apply and check read.
 */
declare function snapshotFileDestination(read: InputReader): string;
/**
 * The file arm for the CLI's init, whose destination is the `settings-file` input
 * (refusing a list separator as apply and check do) and can never be the dir form.
 */
declare function parseSnapshotFileConfig(read: InputReader, env: ConfigEnv): Result<SnapshotFileConfig, Problem>;
/**
 * What the face running the config can do; parseConfig refuses an input that needs a capability the face lacks, so
 * the refusal has one owner and the flows never re-check it.
 */
interface RunCapabilities {
  /** The face hands the run a workflow-artifact uploader (the Actions runner); without it `private-report: artifact` is refused. */
  readonly artifactUpload: boolean;
}
/** Read and validate every input through `read`; the first problem wins. */
declare function parseConfig(read: InputReader, env: ConfigEnv, capabilities: RunCapabilities): Result<RunConfig, Problem>;
//#endregion
//#region src/flows/layers.d.ts
declare function readLayerFiles(paths: readonly string[]): Result<Layer[], ProblemOf<"settings-file-unreadable">>;
interface FoldedLayers {
  /** The fold as validation parsed it: the branded document every other verb takes. */
  settings: ValidatedSettings;
  notices: RemovalNotice[];
  /** The fold rendered in the canonical order (src/engine/canonical.ts), exactly as mode: render writes it to rendered-file. */
  yaml: string;
}
/**
 * A layer must be a valid document before it may contribute, so the merge can never complete a broken declaration into
 * a valid one. The fold, not the validated parse, is what is written: the file holds what the layers declared, and
 * validation only judges it.
 */
declare function foldLayers(layers: readonly Layer[], sourceLabel: string, options: FoldOptions, io: Io): Result<FoldedLayers, SettingsProblem | LayerProblem>;
//#endregion
export { toPublicView as $, RepoRef as $n, Tolerance as $t, SingleConfig as A, DEFAULT_API_VERSION as An, TaggedEndpoint as At, runMulti as B, isRateLimitError as Bn, ValidatedInput as Bt, parseSnapshotFileConfig as C, DiscoveryFilters as Cn, preflightProbe as Ct, SnapshotConfig as D, discoverRepos as Dn, SectionSelection as Dt, SNAPSHOT_SCHEMA_URL as E, VISIBILITY_FILTERS as En, validateSettingsDoc as Et, DEFAULT_SETTINGS_FILE as F, RequestMark as Fn, SectionInput as Ft, failRun as G, OutputName as Gn, writeGatedReads as Gt, RunFlowConfig as H, CollectedLine as Hn, readGating as Ht, MultiConfig as I, SECRET_RESPONSE_WITHHELD as In, SectionMeta as It, PublicTargetView as J, prefixedIo as Jn, OnMissingPermission as Jt, PRIVATE_REPOS_POLICIES as K, collectingIo as Kn, DenialPolicy as Kt, ResolvedTargets as L, SECRET_TRANSPORT_WITHHELD as Ln, SectionModule as Lt, runSingle as M, GitHubApiOptions as Mn, allGraphqlOps as Mt, RenderConfig as N, GitHubClient as Nn, sectionModule as Nt, concludeSnapshot as O, ApiError as On, SettingsSource as Ot, runRender as P, GraphqlOp as Pn, KeyedListLayering as Pt, publicDetail as Q, RemoteTarget as Qn, SnapshotContext as Qt, TargetsConfig as R, TraceIo as Rn, SectionSnapshot as Rt, parseConfig as S, DEFAULT_DISCOVERY_FILTERS as Sn, ValidatedSettings as St, FinishedSnapshot as T, FORKS_FILTERS as Tn, skippedSectionKeys as Tt, concludeRender as U, Io as Un, sectionGrant as Ut, FinishedRender as V, AnnotationLevel as Vn, denialPosture as Vt, concludeRun as W, MaskPair as Wn, sectionOperations as Wt, capturingIo as X, silentIo as Xn, PlannedOpBase as Xt, TargetOutcome as Y, redactRanges as Yn, PlanContext as Yt, planRedaction as Z, CentralTarget as Zn, SectionPlan as Zt, RunConfig as _, MustBeNever as _n, SettingsFile as _r, worstOf as _t, DEFAULT_PRIVATE_REPOS as a, EndpointDecl as an, Problem as ar, deliverArtifactReport as at, SNAPSHOT_REJECTED_INPUTS as b, AFFILIATIONS as bn, Layering as br, RepoRunResult as bt, InputDecl as c, endpointPath as cn, SettingsFileRole as cr, RepoVisibility as ct, MODES as d, grantFor as dn, describeProblem as dr, SectionSnapshotOutcome as dt, Unverifiable as en, Target as er, PRIVATE_REPORT_CHANNELS as et, Mode as f, FoldOptions as fn, quoteList as fr, SnapshotResult as ft, RunCapabilities as g, mergeLayers as gn, SectionKey as gr, RunOutcome as gt, RENDER_REJECTED_INPUTS as h, describeRemoval as hn, SECTION_KEYS as hr, RUN_RESULTS as ht, ConfigEnv as i, SectionFailure as in, LayerProblem as ir, ArtifactUploader as it, SingleOutcome as j, GitHubApi as jn, allEndpoints as jt, runSnapshot as k, ClientAnswer as kn, SECTIONS as kt, InputName as l, PatResource as ln, SettingsProblem as lr, createVisibilityResolver as lt, RENDER_ONLY_INPUTS as m, RemovalNotice as mn, PROBOT_PARITY_KEYS as mr, renderSnapshotYaml as mt, foldLayers as n, snapshotContext as nn, parseRepoSlug as nr, applyMarkerInjection as nt, FILTER_INPUTS as o, Route as on, ProblemOf as or, encryptReport as ot, RENDER_INPUTS as p, Layer as pn, DOCUMENT_DIRECTIVE_KEYS as pr, SnapshotRunOptions as pt, PrivateReposPolicy as q, maskRegistry as qn, Justification as qt, readLayerFiles as r, GraphqlOpDecl as rn, CentralFileProblem as rr, openReportChannel as rt, INPUT_DECLS as s, endpointMethod as sn, RERUN_ADVICE as sr, parseRecipient as st, FoldedLayers as t, planContext as tn, dedupeTargets as tr, PrivateReportChannel as tt, InputReader as u, SectionPermission as un, TopLevelShape as ur, RenderableSnapshot as ut, SNAPSHOT_INPUTS as v, UndeclaredPolicy as vn, UNDECLARED_POLICY_SECTIONS as vr, RepoResult as vt, snapshotFileDestination as w, DiscoveryProblem as wn, runForRepo as wt, SnapshotFileConfig as x, ARCHIVED_FILTERS as xn, SectionOutcome as xt, SNAPSHOT_ONLY_INPUTS as y, UndeclaredPolicyList as yn, UndeclaredPolicySection as yr, RepoRunOptions as yt, resolveTargets as z, isPermissionError as zn, ValidatedBrand as zt };
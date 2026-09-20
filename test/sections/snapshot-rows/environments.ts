import { environmentsSection } from "../../../src/sections/environments/index.js";
import type { Row } from "../snapshot-roundtrip.js";
import { STAMPS } from "./families.js";

// staging is the one pinned environment, so it LEADS the snapshot with pinned: true (the planner
// reads declaration order as pin order) and production follows without the key. staging has no
// protection rules, which the snapshot writes out as the three disabled values.
export const row: Row = {
  section: environmentsSection,
  live: {
    environments: {
      production: {
        id: 161088068,
        name: "production",
        url: "https://api.github.com/repos/o/r/environments/production",
        html_url: "https://github.com/o/r/deployments/activity_log?environments_filter=production",
        ...STAMPS,
        can_admins_bypass: true,
        protection_rules: [
          { id: 3736, node_id: "MDQ6R2F0ZTM3MzY=", type: "wait_timer", wait_timer: 30 },
          {
            id: 3755,
            node_id: "MDQ6R2F0ZTM3NTU=",
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [
              { type: "User", reviewer: { login: "octocat", id: 583231 } },
              { type: "Team", reviewer: { slug: "platform", id: 42 } },
            ],
          },
        ],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
      staging: { name: "staging", protection_rules: [], deployment_branch_policy: null },
    },
    pinned_environments: ["staging"],
    environment_variables: {
      production: [{ name: "REGION", value: "eu-west-1", ...STAMPS }],
    },
    environment_secrets: {
      production: [
        { name: "DEPLOY_TOKEN", ...STAMPS },
        { name: "RELEASE_PAT", ...STAMPS },
      ],
      staging: [{ name: "DEPLOY_TOKEN", ...STAMPS }],
    },
    environment_branch_policies: {
      production: [
        { id: 4001, name: "release/*", type: "branch" },
        { id: 4002, name: "v*", type: "tag" },
      ],
    },
    environment_protection_rules: {
      production: [
        {
          id: 7100,
          node_id: "DPR_7100",
          enabled: true,
          app: {
            id: 3516,
            slug: "region-guard",
            integration_url: "https://api.github.com/apps/region-guard",
            node_id: "MDQ6R2F0ZTM1MTY=",
          },
        },
      ],
    },
  },
  expected: {
    value: [
      {
        name: "staging",
        pinned: true,
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null,
        secrets: {
          _undeclared: "keep",
          entries: [{ name: "DEPLOY_TOKEN", value: "$SECRET_ENVIRONMENT_STAGING_DEPLOY_TOKEN" }],
        },
      },
      {
        name: "production",
        wait_timer: 30,
        prevent_self_review: true,
        reviewers: [
          { type: "User", id: 583231 },
          { type: "Team", id: 42 },
        ],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        variables: { _undeclared: "delete", entries: [{ name: "REGION", value: "eu-west-1" }] },
        secrets: {
          _undeclared: "keep",
          entries: [
            { name: "DEPLOY_TOKEN", value: "$SECRET_ENVIRONMENT_PRODUCTION_DEPLOY_TOKEN" },
            { name: "RELEASE_PAT", value: "$SECRET_ENVIRONMENT_PRODUCTION_RELEASE_PAT" },
          ],
        },
        deployment_branch_policies: {
          _undeclared: "delete",
          entries: [
            { name: "release/*", type: "branch" },
            { name: "v*", type: "tag" },
          ],
        },
        deployment_protection_rules: { _undeclared: "keep", entries: [{ app: "region-guard" }] },
      },
    ],
    notes: [
      "environments[production].secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ENVIRONMENT_PRODUCTION_DEPLOY_TOKEN before apply",
      "environments[production].secrets[RELEASE_PAT]: value of RELEASE_PAT is not readable; export it into the environment as SECRET_ENVIRONMENT_PRODUCTION_RELEASE_PAT before apply",
      "environments[staging].secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ENVIRONMENT_STAGING_DEPLOY_TOKEN before apply",
    ],
  },
};

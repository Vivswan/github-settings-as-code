/**
 * Every environment parse rule is implemented TWICE (the zod refinement or check, and its JSON Schema
 * twin, both in src/sections/environments/schema.ts); these fixtures are the one set both are tested
 * against, and an agreement test asserts the verdicts match per fixture.
 */

export type EnvironmentParseFixture =
  | {
      /** What the fixture demonstrates, used in test failure messages. */
      name: string;
      /** One environments[] entry, wrapped by each consumer as its input needs. */
      entry: Record<string, unknown>;
      /** BOTH validators must accept the entry. */
      valid: true;
    }
  | {
      name: string;
      entry: Record<string, unknown>;
      /** BOTH validators must refuse the entry. */
      valid: false;
      /** The dotted issue path the runtime reports below the entry, naming the key at fault. */
      path: string;
      /** A fragment of the runtime message, the part that names the fix. */
      refusal: string;
    };

/** The one environment name every fixture carries; the refinement wording embeds it. */
const FIXTURE_ENV_NAME = "prod";

const customPolicies = { protected_branches: false, custom_branch_policies: true };

export const ENVIRONMENT_PARSE_FIXTURES: readonly EnvironmentParseFixture[] = [
  {
    name: "patterns without the sibling flag object",
    entry: { name: FIXTURE_ENV_NAME, deployment_branch_policies: [{ name: "release/*" }] },
    valid: false,
    path: "deployment_branch_policies",
    refusal: "must also declare deployment_branch_policy with custom_branch_policies: true",
  },
  {
    name: "patterns with the flag present but false",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      deployment_branch_policies: [{ name: "release/*" }],
    },
    valid: false,
    path: "deployment_branch_policies",
    refusal: "must also declare deployment_branch_policy with custom_branch_policies: true",
  },
  {
    name: "patterns with the sibling nulled (a clear)",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: null,
      deployment_branch_policies: [{ name: "release/*" }],
    },
    valid: false,
    path: "deployment_branch_policies",
    refusal: "must also declare deployment_branch_policy with custom_branch_policies: true",
  },
  {
    name: "the wrapped form takes the same rule",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policies: { entries: [{ name: "release/*" }] },
    },
    valid: false,
    path: "deployment_branch_policies",
    refusal: "must also declare deployment_branch_policy with custom_branch_policies: true",
  },
  {
    name: "the paired form (flag true) passes",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: customPolicies,
      deployment_branch_policies: [{ name: "release/*" }, { name: "v*", type: "tag" }],
    },
    valid: true,
  },
  {
    name: "the wrapped paired form passes",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: customPolicies,
      deployment_branch_policies: { _undeclared: "keep", entries: [{ name: "main" }] },
    },
    valid: true,
  },
  {
    name: "an entry without the plural key keeps its freedom (nullable flag)",
    entry: { name: FIXTURE_ENV_NAME, deployment_branch_policy: null },
    valid: true,
  },
  {
    name: "protected_branches alone passes (the JSON Schema `then` branch's accepted side)",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    },
    valid: true,
  },
  {
    name: "both branch-policy flags false is GitHub's 422, spelled null here",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
    },
    valid: false,
    path: "deployment_branch_policy",
    refusal:
      "GitHub spells 'any branch may deploy' as deployment_branch_policy: null, so write null",
  },
  {
    name: "both branch-policy flags true is GitHub's 422, the flags being exclusive",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: true },
    },
    valid: false,
    path: "deployment_branch_policy",
    refusal: "the two flags are mutually exclusive, so set exactly one of them to true",
  },
  {
    name: "prevent_self_review without reviewers would drift forever",
    entry: { name: FIXTURE_ENV_NAME, prevent_self_review: true, reviewers: [] },
    valid: false,
    path: "prevent_self_review",
    refusal: "Declare a reviewer, or write prevent_self_review: false",
  },
  {
    name: "prevent_self_review with the reviewers key absent takes the same rule",
    entry: { name: FIXTURE_ENV_NAME, prevent_self_review: true },
    valid: false,
    path: "prevent_self_review",
    refusal: "Declare a reviewer, or write prevent_self_review: false",
  },
  {
    name: "prevent_self_review with one reviewer passes",
    entry: {
      name: FIXTURE_ENV_NAME,
      prevent_self_review: true,
      reviewers: [{ type: "User", id: 1 }],
    },
    valid: true,
  },
  {
    name: "the disabled values are declarable",
    entry: { name: FIXTURE_ENV_NAME, wait_timer: 0, prevent_self_review: false, reviewers: [] },
    valid: true,
  },
  {
    name: "wait_timer over 30 days",
    entry: { name: FIXTURE_ENV_NAME, wait_timer: 43_201 },
    valid: false,
    path: "wait_timer",
    refusal: "GitHub caps wait_timer at 43200 minutes (30 days)",
  },
  {
    name: "wait_timer at the cap passes",
    entry: { name: FIXTURE_ENV_NAME, wait_timer: 43_200 },
    valid: true,
  },
  {
    name: "a negative wait_timer",
    entry: { name: FIXTURE_ENV_NAME, wait_timer: -1 },
    valid: false,
    path: "wait_timer",
    refusal: "wait_timer cannot be negative; 0 declares the wait timer off",
  },
  {
    name: "a fractional wait_timer",
    entry: { name: FIXTURE_ENV_NAME, wait_timer: 2.5 },
    valid: false,
    path: "wait_timer",
    refusal: "wait_timer is a whole number of minutes",
  },
  {
    name: "seven reviewers",
    entry: {
      name: FIXTURE_ENV_NAME,
      reviewers: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ type: "User", id })),
    },
    valid: false,
    path: "reviewers",
    refusal: "GitHub allows at most 6 required reviewers per environment",
  },
  {
    name: "six reviewers pass",
    entry: {
      name: FIXTURE_ENV_NAME,
      reviewers: [1, 2, 3, 4, 5, 6].map((id) => ({ type: "User", id })),
    },
    valid: true,
  },
  {
    name: "a mis-cased branch-policy pattern type",
    entry: {
      name: FIXTURE_ENV_NAME,
      deployment_branch_policy: customPolicies,
      deployment_branch_policies: [{ name: "v*", type: "Tag" }],
    },
    valid: false,
    path: "deployment_branch_policies.0.type",
    refusal: '"branch"|"tag"',
  },
];

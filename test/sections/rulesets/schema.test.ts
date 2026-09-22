/**
 * GitHub's ruleset rules the platform does not enforce for us before the wire, so a wrong value would otherwise
 * ride every other section's writes and come back as a 422: the enforcement spelling, the bypass actor id and
 * mode rules, the two "~" ref-name tokens, and the parameters of the rule types the vendored spec knows (in
 * GitHub's casing, within its bounds). Parsed through the loosened document shape, so a rule that survives here
 * reaches the run; a rule type the spec does not know must keep passing through untouched.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { KNOWN_RULE_TYPES } from "../../../src/sections/rulesets/schema.js";
import { RULESET_RULE_TYPES } from "../../e2e/mock/support.js";
import { PULL_REQUEST_PARAMETERS } from "./generators.js";

type Verdict = { ok: true; parsed: unknown } | { issues: readonly string[] };

function verdict(...rulesets: Record<string, unknown>[]): Verdict {
  return validateSectionShapes({ rulesets }, "settings.yml").match(
    (parsed) => ({ ok: true, parsed: parsed.rulesets }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

const pattern = { operator: "regex", pattern: "^v\\d+", negate: false, name: "shown" };

/** Every rule type the spec knows with parameters it accepts, plus one it does not know; a passthrough key on each kind. */
const EVERY_RULE = [
  { type: "creation" },
  { type: "update", parameters: { update_allows_fetch_and_merge: true } },
  { type: "deletion", parameters: { strict: true } },
  { type: "required_linear_history" },
  {
    type: "merge_queue",
    parameters: {
      check_response_timeout_minutes: 360,
      grouping_strategy: "HEADGREEN",
      max_entries_to_build: 0,
      max_entries_to_merge: 100,
      merge_method: "REBASE",
      min_entries_to_merge: 1,
      min_entries_to_merge_wait_minutes: 0,
      future_knob: "kept",
    },
  },
  { type: "required_deployments", parameters: { required_deployment_environments: ["prod"] } },
  { type: "required_signatures" },
  {
    type: "pull_request",
    parameters: {
      ...PULL_REQUEST_PARAMETERS,
      required_approving_review_count: 10,
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismissal_restriction: { enabled: true, allowed_actors: [{ id: 5, type: "RepositoryRole" }] },
      required_reviewers: [
        { file_patterns: ["docs/**"], minimum_approvals: 0, reviewer: { id: 9, type: "Team" } },
      ],
    },
  },
  {
    type: "required_status_checks",
    parameters: {
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: "ci" }, { context: "lint", integration_id: 15368 }],
      strict_required_status_checks_policy: false,
    },
  },
  { type: "non_fast_forward" },
  { type: "commit_message_pattern", parameters: pattern },
  { type: "commit_author_email_pattern", parameters: pattern },
  { type: "committer_email_pattern", parameters: pattern },
  { type: "branch_name_pattern", parameters: { operator: "starts_with", pattern: "feat/" } },
  { type: "tag_name_pattern", parameters: { operator: "ends_with", pattern: "-rc" } },
  {
    type: "workflows",
    parameters: {
      workflows: [{ path: ".github/workflows/ci.yml", repository_id: 1, ref: "main", sha: "abc" }],
    },
  },
  {
    type: "code_scanning",
    parameters: {
      code_scanning_tools: [
        { tool: "CodeQL", alerts_threshold: "errors", security_alerts_threshold: "high_or_higher" },
      ],
    },
  },
  { type: "copilot_code_review", parameters: { review_on_push: true } },
  { type: "license_compliance_scanning" },
  { type: "file_path_restriction", parameters: { restricted_file_paths: ["secrets/**"] } },
  { type: "max_file_path_length", parameters: { max_file_path_length: 32767 } },
  { type: "file_extension_restriction", parameters: { restricted_file_extensions: [".exe"] } },
  { type: "max_file_size", parameters: { max_file_size: 1 } },
  { type: "shipped_tomorrow", parameters: { anything: ["goes"] } },
];

/** One bypass actor per form the spec allows, the OrganizationAdmin id GitHub ignores included. */
const EVERY_ACTOR = [
  { actor_type: "Integration", actor_id: 1, bypass_mode: "always" },
  { actor_type: "OrganizationAdmin", actor_id: 1 },
  { actor_type: "OrganizationAdmin" },
  { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "pull_request" },
  { actor_type: "Team", actor_id: 2, bypass_mode: "exempt" },
  { actor_type: "DeployKey", actor_id: null },
  { actor_type: "DeployKey", bypass_mode: "exempt", future_field: true },
  { actor_type: "User", actor_id: 3 },
];

describe("a ruleset the API would reject never reaches it", () => {
  test("every rule type the spec knows, an unknown one, and every bypass actor form parse and pass through whole", () => {
    const ruleset = {
      name: "main",
      target: "branch",
      enforcement: "evaluate",
      // "*", "?", and "[" are pattern syntax, not ref-name characters, so they pass with the two tokens.
      conditions: {
        ref_name: {
          include: ["~DEFAULT_BRANCH", "refs/heads/*", "feature/**", "v?.[0-9]"],
          exclude: ["~ALL"],
        },
      },
      rules: EVERY_RULE,
      bypass_actors: EVERY_ACTOR,
    };
    // A rule type GitHub ships tomorrow and a field it adds to a known rule must both survive the parse untouched.
    expect(verdict(ruleset)).toEqual({ ok: true, parsed: [ruleset] });
  });

  test("the schema knows exactly the rule types the vendored spec does, through the mock catalog the spec pins", () => {
    expect([...KNOWN_RULE_TYPES].sort()).toEqual([...RULESET_RULE_TYPES].sort());
  });

  test.each<[what: string, ruleset: Record<string, unknown>, issues: (string | RegExp)[]]>([
    [
      "an enforcement level spelled the way branch protection spells it",
      { name: "main", enforcement: "enabled" },
      [/^rulesets\[0\]\.enforcement: .*"active"\|"evaluate"\|"disabled"/],
    ],
    [
      "an enforcement level in the wrong case",
      { name: "main", enforcement: "Active" },
      [/^rulesets\[0\]\.enforcement: .*"active"\|"evaluate"\|"disabled"/],
    ],
    [
      "a Team bypass actor without the actor_id GitHub requires, and a null one",
      {
        name: "main",
        bypass_actors: [{ actor_type: "Team" }, { actor_type: "User", actor_id: null }],
      },
      [
        "rulesets[0].bypass_actors[0].actor_id: a Team bypass actor needs its numeric actor_id (the id GitHub assigns the app, role, team, or user); GitHub rejects the ruleset without it",
        "rulesets[0].bypass_actors[1].actor_id: a User bypass actor needs its numeric actor_id (the id GitHub assigns the app, role, team, or user); GitHub rejects the ruleset without it",
      ],
    ],
    [
      "a DeployKey actor carrying an id and a pull_request mode",
      {
        name: "main",
        bypass_actors: [{ actor_type: "DeployKey", actor_id: 7, bypass_mode: "pull_request" }],
      },
      [
        "rulesets[0].bypass_actors[0].actor_id: a DeployKey bypass actor takes no actor_id (GitHub documents it as null); remove the key or write null",
        'rulesets[0].bypass_actors[0].bypass_mode: bypass_mode "pull_request" does not apply to a DeployKey actor; use "always" or "exempt"',
      ],
    ],
    [
      "an actor type in the wrong case and a fractional id",
      { name: "main", bypass_actors: [{ actor_type: "team", actor_id: 1.5 }] },
      [
        /^rulesets\[0\]\.bypass_actors\[0\]\.actor_id: .*expected int/,
        /^rulesets\[0\]\.bypass_actors\[0\]\.actor_type: Invalid option/,
      ],
    ],
    [
      "a pull_request bypass mode on a tag ruleset",
      {
        name: "tags",
        target: "tag",
        bypass_actors: [{ actor_type: "Team", actor_id: 1, bypass_mode: "pull_request" }],
      },
      [
        'rulesets[0].bypass_actors[0].bypass_mode: bypass_mode "pull_request" applies to branch rulesets only, and this ruleset targets tag; use "always" or "exempt"',
      ],
    ],
    [
      "a mis-cased token in include and a made-up one in exclude",
      { name: "main", conditions: { ref_name: { include: ["~all"], exclude: ["main", "~MAIN"] } } },
      [
        'rulesets[0].conditions.ref_name.include[0]: "~all" is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH (case-sensitive), and no ref name contains "~"',
        'rulesets[0].conditions.ref_name.exclude[1]: "~MAIN" is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH (case-sensitive), and no ref name contains "~"',
      ],
    ],
    [
      "a token typo buried inside a ref name, in include and in exclude",
      {
        name: "main",
        conditions: { ref_name: { include: ["release~1"], exclude: ["~ALL", "v1~rc"] } },
      },
      [
        /^rulesets\[0\]\.conditions\.ref_name\.include\[0\]: "release~1" is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH \(case-sensitive\), and no ref name contains "~"/,
        /^rulesets\[0\]\.conditions\.ref_name\.exclude\[1\]: "v1~rc" is not a ref-name token/,
      ],
    ],
    [
      "one pattern per character git refuses in a ref name and a ruleset pattern cannot use either",
      {
        name: "main",
        conditions: {
          ref_name: { include: ["release^2", "refs/heads/a:b", "back\\slash", "hot fix"] },
        },
      },
      [
        'rulesets[0].conditions.ref_name.include[0]: "release^2" contains "^": git refuses "~", "^", ":", "\\", space, "..", "@{", and control characters in a ref name, and a ruleset pattern has no use for them',
        /^rulesets\[0\]\.conditions\.ref_name\.include\[1\]: "refs\/heads\/a:b" contains ":"/,
        /^rulesets\[0\]\.conditions\.ref_name\.include\[2\]: "back\\\\slash" contains "\\\\"/,
        /^rulesets\[0\]\.conditions\.ref_name\.include\[3\]: "hot fix" contains " "/,
      ],
    ],
    [
      "the two-character sequences git refuses, and control characters, in exclude",
      {
        name: "main",
        conditions: { ref_name: { exclude: ["a..b", "main@{1}", "tab\tbed", "del\u007fete"] } },
      },
      [
        /^rulesets\[0\]\.conditions\.ref_name\.exclude\[0\]: "a\.\.b" contains "\.\."/,
        /^rulesets\[0\]\.conditions\.ref_name\.exclude\[1\]: "main@\{1\}" contains "@\{"/,
        /^rulesets\[0\]\.conditions\.ref_name\.exclude\[2\]: "tab\\tbed" contains "\\t"/,
        /^rulesets\[0\]\.conditions\.ref_name\.exclude\[3\]: "del\\u007fete" contains "\\u007f"/,
      ],
    ],
    [
      "merge_queue parameters in the pull_request casing",
      {
        name: "main",
        rules: [
          {
            type: "merge_queue",
            parameters: {
              check_response_timeout_minutes: 60,
              grouping_strategy: "allgreen",
              max_entries_to_build: 5,
              max_entries_to_merge: 5,
              merge_method: "squash",
              min_entries_to_merge: 1,
              min_entries_to_merge_wait_minutes: 5,
            },
          },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.grouping_strategy: .*"ALLGREEN"\|"HEADGREEN"; parameters\.merge_method: .*"MERGE"\|"SQUASH"\|"REBASE"$/,
      ],
    ],
    [
      "pull_request merge methods in the merge_queue casing, and a review count over the cap",
      {
        name: "main",
        rules: [
          {
            type: "pull_request",
            parameters: {
              ...PULL_REQUEST_PARAMETERS,
              allowed_merge_methods: ["SQUASH"],
              required_approving_review_count: 11,
            },
          },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.allowed_merge_methods\[0\]: .*"merge"\|"squash"\|"rebase"; parameters\.required_approving_review_count: .*<=10$/,
      ],
    ],
    [
      "an empty allowed_merge_methods list, which the spec says must enable at least one method",
      {
        name: "main",
        rules: [
          {
            type: "pull_request",
            parameters: { ...PULL_REQUEST_PARAMETERS, allowed_merge_methods: [] },
          },
        ],
      },
      [
        'rulesets[0].rules[0]: parameters.allowed_merge_methods: allowed_merge_methods needs at least one of "merge", "squash", "rebase"; omit the key to allow all three',
      ],
    ],
    [
      "a pull_request rule missing the parameters the spec requires",
      {
        name: "main",
        rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }],
      },
      [
        new RegExp(
          "^rulesets\\[0\\]\\.rules\\[0\\]: parameters\\.dismiss_stale_reviews_on_push: .*expected boolean, received undefined; " +
            "parameters\\.require_code_owner_review: .*; parameters\\.require_last_push_approval: .*; " +
            "parameters\\.required_review_thread_resolution: .*undefined$",
        ),
      ],
    ],
    [
      "a pattern operator in camel case",
      {
        name: "main",
        rules: [
          { type: "branch_name_pattern", parameters: { operator: "startsWith", pattern: "feat/" } },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.operator: .*"starts_with"\|"ends_with"\|"contains"\|"regex"$/,
      ],
    ],
    [
      "a status check context that is not a string, and a quoted boolean beside it",
      {
        name: "main",
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "ci" }, { context: 5 }],
              strict_required_status_checks_policy: "yes",
            },
          },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.required_status_checks\[1\]\.context: .*expected string, received number; parameters\.strict_required_status_checks_policy: .*expected boolean, received string$/,
      ],
    ],
    [
      "a workflow repository_id past the safe-integer range, whose zod check would otherwise continue and render apart",
      {
        name: "main",
        rules: [
          {
            type: "workflows",
            parameters: {
              workflows: [{ path: ".github/workflows/ci.yml", repository_id: 2 ** 53 }],
            },
          },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.workflows\[0\]\.repository_id: Too big: expected int to be <=\d+$/,
      ],
    ],
    [
      "a file size over GitHub's cap and a path length under its floor",
      {
        name: "main",
        rules: [
          { type: "max_file_size", parameters: { max_file_size: 101 } },
          { type: "max_file_path_length", parameters: { max_file_path_length: 0 } },
        ],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters\.max_file_size: .*<=100$/,
        /^rulesets\[0\]\.rules\[1\]: parameters\.max_file_path_length: .*>=1$/,
      ],
    ],
    [
      "an unknown rule type whose parameters are not a mapping, and rules that are not rules",
      {
        name: "main",
        rules: [{ type: "shipped_tomorrow", parameters: "loose" }, { parameters: {} }, "deletion"],
      },
      [
        /^rulesets\[0\]\.rules\[0\]: parameters: .*expected record, received string$/,
        /^rulesets\[0\]\.rules\[1\]: type: .*expected string, received undefined$/,
        /^rulesets\[0\]\.rules\[2\]: Invalid input: expected object, received string$/,
      ],
    ],
  ])(
    "what would 422 at apply fails at parse naming the key and the fix: %s",
    (_what, ruleset, issues) => {
      expect(verdict(ruleset)).toEqual({
        issues: issues.map((issue) =>
          typeof issue === "string" ? issue : expect.stringMatching(issue),
        ),
      });
    },
  );
});

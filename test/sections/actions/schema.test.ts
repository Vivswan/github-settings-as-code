/**
 * The actions section's parse refusals, each pinned as the problem line a user reads: GitHub's GET-only fields
 * (declared, they would re-PUT forever), the OIDC claim-key rules, and an allowlist declared under a policy that
 * ignores it. Parsed through the loosened document shape, so a rule that survives here reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(actions: Record<string, unknown>): readonly string[] | null {
  return validateSectionShapes({ actions }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const REPORTED_ONLY = (field: string) =>
  `${field} is a value GitHub reports, not a setting it accepts (the GET returns it, the PUT does not take it), so a declared value could never be applied; remove it from the settings file`;

describe("an actions setting GitHub would ignore or 422 is refused at parse, naming the key and the fix", () => {
  test.each<[what: string, actions: Record<string, unknown>, expected: string[]]>([
    [
      "the GET-only allowlist link at the top level",
      { selected_actions_url: "https://api.github.com/x" },
      [`actions.selected_actions_url: ${REPORTED_ONLY("selected_actions_url")}`],
    ],
    [
      "the GET-only retention ceiling",
      { artifact_and_log_retention: { days: 30, maximum_allowed_days: 90 } },
      [
        `actions.artifact_and_log_retention.maximum_allowed_days: ${REPORTED_ONLY("maximum_allowed_days")}`,
      ],
    ],
    [
      "the GET-only subject prefix",
      { oidc_customization_sub: { use_default: true, sub_claim_prefix: "repo:" } },
      [`actions.oidc_customization_sub.sub_claim_prefix: ${REPORTED_ONLY("sub_claim_prefix")}`],
    ],
    [
      "a claim key with a character GitHub refuses",
      { oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "job-ref"] } },
      [
        'actions.oidc_customization_sub.include_claim_keys[1]: a claim key holds only letters, digits, and underscores (such as "repo" or "job_workflow_ref")',
      ],
    ],
    [
      "a repeated claim key",
      { oidc_customization_sub: { use_default: false, include_claim_keys: ["repo", "repo"] } },
      [
        'actions.oidc_customization_sub.include_claim_keys[1]: "repo" repeats an earlier claim key; GitHub requires the keys to be unique',
      ],
    ],
    [
      "a claim-key list beside the default template, which GitHub ignores",
      { oidc_customization_sub: { use_default: true, include_claim_keys: ["repo"] } },
      [
        "actions.oidc_customization_sub.include_claim_keys: GitHub ignores include_claim_keys under use_default: true, so the declared list could never take; set use_default: false for a custom template, or remove the list",
      ],
    ],
    [
      "an allowlist under a policy that allows every action",
      { allowed_actions: "all", selected_actions: { github_owned_allowed: true } },
      [
        'actions.selected_actions: selected_actions is declared together with allowed_actions: "all", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions',
      ],
    ],
    [
      "an allowlist beside a policy written as a list",
      { allowed_actions: [], selected_actions: { github_owned_allowed: true } },
      [
        'actions.allowed_actions: Invalid option: expected one of "all"|"local_only"|"selected"',
        'actions.selected_actions: selected_actions is declared together with allowed_actions: a list, but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions',
      ],
    ],
    [
      "an allowlist beside a policy written as a mapping",
      { allowed_actions: {}, selected_actions: { github_owned_allowed: true } },
      [
        'actions.allowed_actions: Invalid option: expected one of "all"|"local_only"|"selected"',
        'actions.selected_actions: selected_actions is declared together with allowed_actions: a mapping, but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions',
      ],
    ],
  ])("%s", (_what, actions, expected) => {
    expect(issues(actions)).toEqual(expected);
  });

  test("the same keys in the forms GitHub accepts parse", () => {
    expect(
      issues({
        allowed_actions: "selected",
        selected_actions: { github_owned_allowed: true, patterns_allowed: ["actions/*"] },
        artifact_and_log_retention: { days: 30 },
        oidc_customization_sub: {
          use_default: false,
          include_claim_keys: ["repo", "job_workflow_ref"],
        },
      }),
    ).toBeNull();
  });
});

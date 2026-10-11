/**
 * The environments section's parse refusals, each pinned as the problem line a user reads: the PUT body rules
 * GitHub 422s on (the wait timer, the reviewer cap, the two branch-policy flags) and the combinations GitHub accepts
 * but never reads back (a self-review flag without reviewers, patterns without the flag, a singular `secret`, more
 * pinned environments than a repository may hold).
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(entries: unknown[]): readonly string[] | null {
  return validateSectionShapes({ environments: entries }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const reviewers = (count: number) =>
  Array.from({ length: count }, (_, id) => ({ type: "User", id: id + 1 }));

describe("an environment GitHub would 422, or could never converge on, is refused at parse, naming the entry and the fix", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "both branch-policy flags on",
      {
        name: "prod",
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: true },
      },
      [
        "environments[0].deployment_branch_policy: deployment_branch_policy sets both protected_branches and custom_branch_policies to true, which GitHub rejects: the two flags are mutually exclusive, so set exactly one of them to true",
      ],
    ],
    [
      "both branch-policy flags off, which GitHub spells as null",
      {
        name: "prod",
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
      },
      [
        "environments[0].deployment_branch_policy: deployment_branch_policy sets both protected_branches and custom_branch_policies to false, which GitHub rejects: GitHub spells 'any branch may deploy' as deployment_branch_policy: null, so write null",
      ],
    ],
    [
      "a fractional wait timer",
      { name: "prod", wait_timer: 1.5 },
      ["environments[0].wait_timer: wait_timer is a whole number of minutes"],
    ],
    [
      "a negative wait timer",
      { name: "prod", wait_timer: -1 },
      ["environments[0].wait_timer: wait_timer cannot be negative; 0 declares the wait timer off"],
    ],
    [
      "a wait timer past GitHub's 30-day cap",
      { name: "prod", wait_timer: 43_201 },
      ["environments[0].wait_timer: GitHub caps wait_timer at 43200 minutes (30 days)"],
    ],
    [
      "seven reviewers",
      { name: "prod", reviewers: reviewers(7) },
      [
        "environments[0].reviewers: GitHub allows at most 6 required reviewers per environment; keep 6 or fewer entries",
      ],
    ],
    [
      "a singular secret key, which the PUT would carry verbatim",
      { name: "prod", secret: { name: "TOKEN", value: "$TOKEN" } },
      [
        "environments[0].secret: environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing",
      ],
    ],
    [
      "a self-review flag without reviewers, which GitHub drops",
      { name: "prod", prevent_self_review: true },
      [
        'environments[0].prevent_self_review: the "prod" entry declares prevent_self_review: true ' +
          "without reviewers; GitHub keeps the flag only on a required-reviewers rule, which needs at " +
          "least one reviewer. Declare a reviewer, or write prevent_self_review: false",
      ],
    ],
    [
      "branch patterns without the custom-policies flag",
      { name: "prod", deployment_branch_policies: [{ name: "release/*" }] },
      [
        'environments[0].deployment_branch_policies: the "prod" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off',
      ],
    ],
  ])("%s", (_what, entry, expected) => {
    expect(issues([entry])).toEqual(expected);
  });

  test("an eleventh pinned environment is refused at its own entry, naming GitHub's cap", () => {
    const pinned = Array.from({ length: 11 }, (_, i) => ({ name: `env-${i}`, pinned: true }));
    expect(issues(pinned)).toEqual([
      "environments[10].pinned: the settings file declares 11 environments with pinned: true, but GitHub allows at most 10 pinned environments per repository. Declare pinned: true on at most 10 entries",
    ]);
  });

  test("an entry without a string name is named as this entry, beside the name's own type issue", () => {
    expect(issues([{ name: 7, prevent_self_review: true }])).toEqual([
      expect.stringContaining("environments[0].name: "),
      "environments[0].prevent_self_review: this entry declares prevent_self_review: true without " +
        "reviewers; GitHub keeps the flag only on a required-reviewers rule, which needs at least " +
        "one reviewer. Declare a reviewer, or write prevent_self_review: false",
    ]);
  });

  test("the forms GitHub accepts parse: the caps met exactly, the flags exclusive, patterns under their flag", () => {
    expect(
      issues([
        {
          name: "prod",
          wait_timer: 43_200,
          reviewers: reviewers(6),
          prevent_self_review: true,
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          deployment_branch_policies: [{ name: "release/*" }],
          secrets: [{ name: "TOKEN", value: "$TOKEN" }],
        },
        { name: "staging", wait_timer: 0, deployment_branch_policy: null, pinned: true },
      ]),
    ).toBeNull();
  });
});

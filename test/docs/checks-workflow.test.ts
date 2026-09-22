/**
 * checks.yml against the code it runs: head_ref conditions that spell the release PR branch prefix the pipeline
 * script owns (a drifted spelling skips the anchor-check on every release PR instead of failing there).
 */

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { RELEASE_PR_BRANCH_PREFIX } from "../../.github/scripts/release-pipeline.js";
import { headRefPrefixes, headRefPrefixesIn } from "./head-ref.js";
import { type Workflow, workflowText } from "./workflow-loader.js";

/** The guard: one anchor-check step, its job gated on the constant, and no job or step condition spelling it otherwise. */
function expectReleasePrefixes(wf: Workflow): void {
  const anchorStepJobs = Object.values(wf.jobs).flatMap((job) =>
    (job.steps ?? [])
      .filter((step) => (step.run ?? "").includes("release-pipeline.ts anchor-check"))
      .map(() => job),
  );
  expect(anchorStepJobs.length, "checks.yml must run anchor-check in exactly one step").toBe(1);
  expect(headRefPrefixesIn(anchorStepJobs[0]?.if)).toEqual([RELEASE_PR_BRANCH_PREFIX]);
  for (const literal of headRefPrefixes(wf)) {
    expect(literal).toBe(RELEASE_PR_BRANCH_PREFIX);
  }
}

describe("checks.yml release PR branch spelling", () => {
  const text = workflowText("checks.yml");

  // Workflows cannot import the constant, so the head_ref conditions spell it by hand; a drifted spelling skips the anchor-check on every release PR
  // instead of failing there.
  test("the anchor-check step is gated on RELEASE_PR_BRANCH_PREFIX and nothing spells it otherwise", () => {
    expectReleasePrefixes(parseYaml(text) as Workflow);
  });

  test.each<[string, (text: string) => Workflow]>([
    [
      "a drifted spelling",
      (text) =>
        parseYaml(text.replaceAll(`'${RELEASE_PR_BRANCH_PREFIX}'`, "'release-pls--'")) as Workflow,
    ],
    [
      "a missing anchor-check step",
      (text) => {
        const wf = parseYaml(text) as Workflow;
        for (const job of Object.values(wf.jobs)) {
          job.steps = job.steps?.filter((step) => !(step.run ?? "").includes("anchor-check"));
        }
        return wf;
      },
    ],
  ])("%s fails the guard (negative control)", (_case, mutate) => {
    expect(() => expectReleasePrefixes(mutate(text))).toThrow();
  });
});

describe("headRefPrefixes", () => {
  test("collects job- and step-level literals in order and none where no condition tests head_ref", () => {
    const wf = {
      jobs: {
        gate: {
          if: "github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
          steps: [
            { if: 'startsWith(github.head_ref, "feature/")' },
            { if: "startsWith ( github . head_ref ,\n  'hotfix/' )" },
            { if: "github.actor != 'dependabot[bot]'" },
            {},
          ],
        },
        plain: { steps: [{}] },
        bare: {},
      },
    };
    expect(headRefPrefixes(wf)).toEqual(["release-please--", "feature/", "hotfix/"]);
    expect(headRefPrefixes({ jobs: {} })).toEqual([]);
  });
});

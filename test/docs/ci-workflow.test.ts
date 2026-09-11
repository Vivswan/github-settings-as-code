/**
 * CI structural contract: the single required check `all-green` must `needs:`
 * every other job in ci.yml. Branch protection points at all-green, so a new
 * job it forgets would pass CI while never being required. Jobs that need
 * all-green, directly or through another job (the release job and everything
 * that needs it), are exempt: they run downstream of the gate and cannot also
 * be inside it. Informational jobs are exempt on BOTH sides of the comparison:
 * template sync flips ci.yml independently of this test, so it must pass
 * whether the job is still in the needs list or already out of it. Schedule-only
 * jobs (a job-level if: restricting them to the schedule event) are exempt the
 * same way: they never run on a pull request, so they can never gate one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { RELEASE_PR_BRANCH_PREFIX } from "../../.github/scripts/release-pipeline.js";
import { headRefPrefixes } from "./head-ref.js";

const ROOT = join(import.meta.dir, "..", "..");

// Deliberately outside the gate: a red run flags template-convention drift
// that the next sync PR heals, and must not block unrelated merges. Mirrors
// the central CI's validator (see the platform repository's docs/all-green.md).
const INFORMATIONAL = new Set(["validate-template"]);

interface Workflow {
  jobs: Record<string, { needs?: string | string[]; if?: string; steps?: Array<{ if?: string }> }>;
}

function needsOf(job: { needs?: string | string[] } | undefined): string[] {
  const raw = job?.needs ?? [];
  return Array.isArray(raw) ? raw : [raw];
}

// The whole job-level condition, not a substring of it: a comparison joined by || to
// another event still runs on pull requests and must stay inside the gate.
const SCHEDULE_ONLY = /^\s*github\s*\.\s*event_name\s*==\s*(['"])schedule\1\s*$/;

function scheduleOnly(job: { if?: string } | undefined): boolean {
  return SCHEDULE_ONLY.test(String(job?.if ?? ""));
}

function exempt(jobs: Workflow["jobs"], name: string): boolean {
  return INFORMATIONAL.has(name) || scheduleOnly(jobs[name]);
}

/** Every job reachable from `gate` by following `needs` edges away from it, however many hops. */
function downstreamOf(jobs: Workflow["jobs"], gate: string): Set<string> {
  const downstream = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, job] of Object.entries(jobs)) {
      if (downstream.has(name)) continue;
      if (needsOf(job).some((dep) => dep === gate || downstream.has(dep))) {
        downstream.add(name);
        grew = true;
      }
    }
  }
  return downstream;
}

/** The contract: all-green.needs is exactly the non-exempt jobs that are not downstream of it. */
function expectGateCovers(wf: Workflow): void {
  const jobs = Object.keys(wf.jobs);
  expect(jobs, "ci.yml has no all-green job").toContain("all-green");
  const downstream = downstreamOf(wf.jobs, "all-green");
  const others = jobs
    .filter((name) => name !== "all-green" && !downstream.has(name) && !exempt(wf.jobs, name))
    .sort();
  const needs = needsOf(wf.jobs["all-green"])
    .filter((name) => !exempt(wf.jobs, name))
    .sort();
  expect(
    needs,
    `all-green.needs must list every job not downstream of it. Missing: [${others.filter((j) => !needs.includes(j)).join(", ")}], extra: [${needs.filter((n) => !others.includes(n)).join(", ")}]`,
  ).toEqual(others);
}

describe("ci.yml all-green gate", () => {
  const ci = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;

  test("all-green needs every job that is not downstream of it", () => {
    expectGateCovers(ci);
  });

  test("a schedule-only job passes whether or not all-green lists it", () => {
    const nightly = { if: 'github.event_name == "schedule"' };
    const gated = { checks: {}, nightly, "all-green": { needs: ["checks", "nightly"] } };
    const ungated = { checks: {}, nightly, "all-green": { needs: ["checks"] } };
    expectGateCovers({ jobs: gated });
    expectGateCovers({ jobs: ungated });
  });

  // Every forgotten job that can run on a pull request, including conditions that merely
  // mention the schedule event, fails through the same assertion the green run takes.
  test.each([
    ["no condition", {}],
    [
      "schedule joined by || to another event",
      { if: "github.event_name == 'schedule' || github.event_name == 'pull_request'" },
    ],
    ["schedule excluded", { if: "github.event_name != 'schedule'" }],
    ["schedule negated", { if: "!(github.event_name == 'schedule')" }],
  ])("a forgotten job fails the contract: %s (negative control)", (_label, extra) => {
    const forgotten = { jobs: { checks: {}, extra, "all-green": { needs: ["checks"] } } };
    expect(() => expectGateCovers(forgotten)).toThrow();
  });
});

/** The guard: every head_ref prefix in a job- or step-level if: spells the constant; none at all is fine. */
function expectReleasePrefixes(wf: Workflow): void {
  for (const literal of headRefPrefixes(wf)) {
    expect(literal).toBe(RELEASE_PR_BRANCH_PREFIX);
  }
}

describe("ci.yml release PR branch spelling", () => {
  // ci.yml is template-managed and carries no head_ref condition today; a sync
  // PR that brings one spelling the release PR branch namespace differently
  // fails here, and the fix routes to the platform repository, not this file.
  test("every startsWith(github.head_ref, ...) prefix is RELEASE_PR_BRANCH_PREFIX", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expectReleasePrefixes(parseYaml(text) as Workflow);
  });

  test("a drifted spelling fails the guard (negative control)", () => {
    const drifted = { jobs: { gate: { if: "startsWith(github.head_ref, 'release-pls--')" } } };
    expect(() => expectReleasePrefixes(drifted)).toThrow();
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

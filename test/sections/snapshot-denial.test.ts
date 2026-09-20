/**
 * The denial spine, over every section with a snapshot(): a token holding no grant meets one rule
 * everywhere the engine classifies a snapshot, the same rule plan() gets from the engine's section
 * loop. Under `warn` a denied section is skipped with the grant advice; under `fail` it fails with
 * the same advice; a public-only section reads back regardless; nothing is ever `unsupported` or a
 * crash. The table iterates SECTIONS, so a new section is judged the day it registers.
 */

import { describe, expect, test } from "bun:test";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { snapshotRepository } from "../../src/engine/snapshot.js";
import type { GitHubClient } from "../../src/github/api.js";
import {
  denialPosture,
  planningReads,
  type SectionModule,
} from "../../src/sections/contract/module.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { MASK_KEYS, type PermissionMask } from "../e2e/schema.js";
import { captureIo } from "../io/capture.js";
import { type FakeToken, type FragmentFake, registryFake } from "./fragment-fake.js";
import { REPO } from "./section-run.js";

/** No grant at all: every gated read is denied, every public one answered. */
const NO_GRANTS: PermissionMask = Object.fromEntries(MASK_KEYS.map((key) => [key, "none"]));

/** The 403 style: every denial is unambiguous, so no absent posture can read one as "nothing there". */
const DENIED_403: FakeToken = { mask: NO_GRANTS, denialStyle: 403 };

/** The fine-grained style: a denied read answers 404, which an absent posture reads as nothing to snapshot. */
const DENIED_404: FakeToken = { mask: NO_GRANTS, denialStyle: "fine_grained" };

const GRANT_ADVICE = /the token was denied .*To fix, grant/;

const reading = SECTIONS.filter((section) => section.snapshot !== undefined);

/** Whether any planning read needs a grant; a section reading only public endpoints is never denied. */
function readsBehindAGrant(section: SectionModule): boolean {
  return planningReads(section).some((operation) => operation.permission !== "none");
}

async function snapshotOne(
  section: SectionModule,
  api: GitHubClient,
  policy: "fail" | "warn",
): Promise<{ status: string; detail: string[] }> {
  const result = await snapshotRepository(
    api,
    {
      repo: REPO,
      sections: SectionSelection.of({ only: [section.key] })._unsafeUnwrap(),
      onMissingPermission: policy,
    },
    captureIo().io,
  );
  const outcome = result.outcomes.find((entry) => entry.key === section.key);
  if (outcome === undefined) {
    throw new Error(`${section.key}: the snapshot run produced no outcome for the section`);
  }
  return { status: outcome.status, detail: outcome.detail };
}

/** The one rule: a denial classifies as the policy says, with the grant advice, and nothing else fails. */
async function proveClassified(
  section: SectionModule,
  token: FakeToken,
  fake: FragmentFake = registryFake({}, token),
): Promise<void> {
  const gated = readsBehindAGrant(section);
  const warn = await snapshotOne(section, fake, "warn");
  expect(warn.status, `${section.key} under warn`).not.toBe("failed");
  expect(warn.status, `${section.key} under warn`).not.toBe("unsupported");
  if (warn.status === "skipped") {
    expect(warn.detail[0], `${section.key} under warn`).toMatch(GRANT_ADVICE);
  }
  const fail = await snapshotOne(section, fake, "fail");
  expect(fail.status, `${section.key} under fail`).not.toBe("unsupported");
  if (fail.status === "failed") {
    // A failure is a denial and nothing else: the detail is failureFor's grant advice, never a stray error.
    expect(fail.detail[0], `${section.key} under fail`).toMatch(GRANT_ADVICE);
  }
  if (token.denialStyle === 403) {
    // Unambiguous denials: a section with a gated read is denied, one without reads back.
    expect(warn.status, `${section.key} under warn`).toBe(gated ? "skipped" : "snapshot");
    expect(fail.status, `${section.key} under fail`).toBe(gated ? "failed" : "snapshot");
  } else if (gated && denialPosture(section) === "denied") {
    // A section that reads a fine-grained 404 as a denial must classify it as one, never as an empty listing.
    expect(warn.status, `${section.key} under warn`).toBe("skipped");
    expect(fail.status, `${section.key} under fail`).toBe("failed");
  }
  expect(fake.writes, `${section.key} wrote during a snapshot`).toEqual([]);
}

describe("snapshot under a token without grants", () => {
  test("only a write-only section lacks a snapshot(); the contract type makes every reading section read back", () => {
    for (const section of SECTIONS) {
      if (section.snapshot === undefined) {
        expect(planningReads(section), section.key).toEqual([]);
      }
    }
    expect(reading.length).toBeGreaterThan(0);
  });

  test.each(reading.map((section) => [section.key, section] as const))(
    "%s: a 403 denial is skipped under warn and failed under fail, with the grant advice; a public-only section reads back",
    (_key, section) => proveClassified(section, DENIED_403),
  );

  test.each(reading.map((section) => [section.key, section] as const))(
    "%s: a fine-grained 404 denial never fails as anything but a denial, and never crashes",
    (_key, section) => proveClassified(section, DENIED_404),
  );

  test("the negative control: a read failing as anything but a denial fails the proof", async () => {
    const [section] = reading;
    if (section === undefined) {
      throw new Error("no section declares snapshot()");
    }
    // The engine runs the registered modules, so the control bends the wire instead: a 500 is a failure no policy skips.
    const fake = registryFake({}, DENIED_403);
    const erroring: FragmentFake = {
      ...fake,
      tryRequest: (method, path, payload, options) =>
        method === "GET"
          ? Promise.resolve({ error: { status: 500, message: "Internal Server Error", body: "" } })
          : fake.tryRequest(method, path, payload, options),
    };
    await expect(proveClassified(section, DENIED_403, erroring)).rejects.toThrow();
  });

  test("the negative control: a denied-posture section reading a fine-grained 404 as an empty list fails the proof", async () => {
    const workflows = SECTIONS.find((section) => section.key === "workflows");
    if (workflows === undefined) {
      throw new Error("the workflows section is not registered");
    }
    const fake = registryFake({}, DENIED_404);
    const swallowing: FragmentFake = {
      ...fake,
      tryRequest: async (method, path, payload, options) => {
        const answer = await fake.tryRequest(method, path, payload, options);
        return "error" in answer &&
          answer.error.status === 404 &&
          path.includes("/actions/workflows")
          ? { data: { total_count: 0, workflows: [] } }
          : answer;
      },
    };
    await expect(proveClassified(workflows, DENIED_404, swallowing)).rejects.toThrow();
  });
});

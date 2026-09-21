/**
 * The owner gate's memo (src/sections/contract/owner.ts): one run probes an owner once, whichever gated
 * section asks first, and every gated section reads the answer; a failed probe is not kept, so the next
 * section probes again; two owners under one client are two probes with their own answers.
 */

import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../../src/discovery/targets.js";
import type { GitHubClient } from "../../src/github/api.js";
import { planContext, snapshotContext } from "../../src/sections/contract/plan.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { MockApi } from "../mock-api.js";
import { failureOf, REPO, unwrap } from "./section-run.js";
import { validatedInput } from "./validated-input.js";

const gated = SECTIONS.filter((section) => section.ownerSensitivity === "org");

const ORG = "GET /orgs/o";

/** Each gated section's primary read over o/r, empty, so a plan of nothing converges after the probe. */
const LISTS = {
  "GET /repos/o/r/teams?per_page=100&page=1": { data: [] },
  "GET /repos/o/r/properties/values": { data: [] },
};

const requests = (api: MockApi) => api.calls.map((c) => `${c.method} ${c.path}`);

const planAll = async (api: GitHubClient, repo: RepoRef = REPO): Promise<string[]> => {
  const notes: string[] = [];
  for (const section of gated) {
    const result = unwrap(
      await section.plan(planContext(section, api, repo), validatedInput(section.key, [])),
    );
    notes.push(...result.notes);
  }
  return notes;
};

describe("the owner gate's memo", () => {
  test("the gated sections share one probe per client, across plan and snapshot", async () => {
    // Every gated section has its primary read seeded below, so a plan of nothing converges after the probe.
    expect(gated).toHaveLength(Object.keys(LISTS).length);
    const api = new MockApi({ [ORG]: { data: { login: "o" } }, ...LISTS });
    expect(await planAll(api)).toEqual([]);
    for (const section of gated) {
      const read = await section.snapshot?.(snapshotContext(section, api, REPO, "fail"));
      if (read !== undefined) {
        unwrap(read);
      }
    }
    expect(requests(api).filter((request) => request === ORG)).toEqual([ORG]);
    // The lists were read, so the shared answer let every section proceed.
    for (const list of Object.keys(LISTS)) {
      expect(requests(api).filter((request) => request === list).length).toBeGreaterThan(0);
    }
  });

  test("a failed probe is not kept: the section it failed reports it, and the next section probes again", async () => {
    const inner = new MockApi({ [ORG]: { data: { login: "o" } }, ...LISTS });
    let outages = 1;
    const api: GitHubClient = {
      tryRequest: (method, path, payload, options) =>
        path === "/orgs/o" && outages-- > 0
          ? Promise.resolve({ error: { status: 500, message: "Internal Server Error", body: "" } })
          : inner.tryRequest(method, path, payload, options),
      tryGraphql: (...args) => inner.tryGraphql(...args),
    };
    const [first, second] = gated;
    if (first === undefined || second === undefined) {
      throw new Error("two gated sections are expected");
    }
    expect(
      failureOf(await first.plan(planContext(first, api, REPO), validatedInput(first.key, [])))
        .message,
    ).toMatch(/500/);
    expect(
      unwrap(await second.plan(planContext(second, api, REPO), validatedInput(second.key, [])))
        .notes,
    ).toEqual([]);
    expect(requests(inner).filter((request) => request === ORG)).toEqual([ORG]);
  });

  test("two owners under one client are two probes, each with its own answer", async () => {
    const api = new MockApi({ [ORG]: { data: { login: "o" } }, ...LISTS });
    const personal: RepoRef = { owner: "p", name: "r", slug: "p/r" };
    expect(await planAll(api)).toEqual([]);
    const notes = await planAll(api, personal);
    expect(notes).toEqual(
      gated.map(
        (section) =>
          `${section.key}: owner "p" is a personal account, not an organization, so this section does not apply; section skipped - remove the ${section.key} section from the settings file to silence this note`,
      ),
    );
    expect(requests(api).filter((request) => request.startsWith("GET /orgs/"))).toEqual([
      ORG,
      "GET /orgs/p",
    ]);
  });
});

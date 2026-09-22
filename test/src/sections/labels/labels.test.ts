import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../../src/engine/execute.js";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import { planContext } from "../../../../src/sections/contract/plan.js";
import { labelsSection } from "../../../../src/sections/labels/index.js";
import { MockApi } from "../../../mock-api.js";
import { REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";

const LIST = "GET /repos/o/r/labels?per_page=100&page=1";
const liveLabels = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "stale", color: "ffffff", description: null },
];
const plan = async (api: MockApi, desired: SectionInput<"labels">) =>
  unwrap(
    await labelsSection.plan(
      planContext(labelsSection, api, REPO),
      validatedInput("labels", desired),
    ),
  );

describe("labels", () => {
  test("plans a create per missing label, an update per drifted one, and a delete per undeclared one, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, [
      { name: "Bug", color: "#000000", description: "Something isn't working" },
      { name: "enhancement", color: "a2eeef" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { name: "stale" },
          describe: 'deleting undeclared label "stale"',
          drift: [
            "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared label "stale"',
        },
        {
          role: "update",
          params: { name: "bug" },
          payload: { new_name: "Bug", color: "000000", description: "Something isn't working" },
          describe: 'updating label "Bug"',
          drift: [
            'labels[bug]: should be named "Bug" per the settings file; apply will rename it',
            'labels[Bug].color: declared "000000" != live "d73a4a"; apply will set the declared value',
          ],
          change: 'updated label "Bug"',
        },
        {
          role: "create",
          payload: { name: "enhancement", color: "a2eeef" },
          describe: 'creating label "enhancement"',
          drift: [
            "labels[enhancement]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created label "enhancement"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a matching label plans nothing: color case and '#' fold, and a live null description reads as empty", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, {
      _undeclared: "keep",
      entries: [
        { name: "BUG", new_name: "bug", color: "#D73A4A", description: "Something isn't working" },
        { name: "stale", description: "" },
      ],
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live label lacks is drift plus a phantom note beside the update", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const result = await plan(api, [{ name: "bug", colr: "000000", description: "" } as never]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { name: "stale" },
          describe: 'deleting undeclared label "stale"',
          drift: [
            "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared label "stale"',
        },
        {
          role: "update",
          params: { name: "bug" },
          payload: { new_name: "bug", description: "", colr: "000000" },
          describe: 'updating label "bug"',
          drift: [
            'labels[bug].description: declared "" != live "Something isn\'t working"; apply will set the declared value',
            'labels[bug].colr: declared "000000" but the API response has no such field (new or write-only field?)',
          ],
          change: 'updated label "bug"',
        },
      ],
      notes: [
        'labels[bug]: declared key "colr" does not exist on the live label, so if GitHub ignores it this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      ],
      drift: [],
    });
  });

  test("executing an update addresses the live name, url-encoded", async () => {
    const api = new MockApi({
      [LIST]: { data: [{ name: "autorelease: pending", color: "ededed", description: "x" }] },
    }).allowMutations("PATCH /repos/o/r/labels/*");
    const planned = await plan(api, [{ name: "autorelease: pending", color: "ffffff" }]);
    const execution = await executePlan(planned, labelsSection, api, REPO, {
      resolveSecret: () => {
        throw new Error("no secrets");
      },
    });
    expect(execution.status).toBe("applied");
    expect(api.mutations().map((m) => m.path)).toEqual([
      "/repos/o/r/labels/autorelease%3A%20pending",
    ]);
  });

  test("two entries resolving to the same label through their rename targets are a validate issue at the later new_name, so the document fails before any API call", () => {
    expect(
      labelsSection.validate([
        { name: "bug", new_name: "triage" },
        { name: "enhancement", new_name: "Triage" },
      ]),
    ).toEqual([
      {
        path: "[1].new_name",
        message:
          '"Triage" names the same label as "triage" declared earlier; keep exactly one entry per label',
      },
    ]);
  });
});

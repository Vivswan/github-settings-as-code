/**
 * Imported through src/index.ts on purpose: this is the consumer's path, so a name the entry does not
 * export fails here and not on a consumer's machine.
 */

import { describe, expect, test } from "bun:test";
import {
  planContext,
  type RepoRef,
  type SectionModule,
  type SectionPlan,
  type SectionSnapshot,
  type SnapshotContext,
  sectionModule,
  snapshotContext,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";

const REPO: RepoRef = { owner: "octo-org", name: "api", slug: "octo-org/api" };
const LIST = "GET /repos/octo-org/api/labels?per_page=100&page=1";
const liveLabels = [{ name: "bug", color: "d73a4a", description: "Something isn't working" }];

describe("a section module called through the entry", () => {
  test("plan() over planContext() reports the drift the engine would, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const labels = sectionModule("labels");
    const plan: SectionPlan = await labels.plan(planContext(labels, api, REPO), [
      { name: "bug", color: "000000", description: "Something isn't working" },
    ]);
    expect(plan).toEqual({
      ops: [
        {
          role: "update",
          params: { name: "bug" },
          payload: { new_name: "bug", color: "000000", description: "Something isn't working" },
          describe: 'updating label "bug"',
          drift: [
            'labels[bug].color: declared "000000" != live "d73a4a"; apply will set the declared value',
          ],
          change: 'updated label "bug"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.mutations()).toEqual([]);
  });

  test("snapshot() over snapshotContext() reads the live labels back as a settings value", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const labels = sectionModule("labels");
    const ctx = snapshotContext(labels, api, REPO, "warn");
    const snapshot: SectionSnapshot<"labels"> | undefined = await labels.snapshot?.(ctx);
    expect(snapshot).toEqual({
      value: {
        _undeclared: "delete",
        entries: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
      },
      notes: [],
    });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([LIST]);
    // The control is DenialPolicy's public shape: a structural policy would let it through, only the nominal guard stops it.
    // @ts-expect-error only snapshotContext() mints a DenialPolicy
    const forged: SnapshotContext = { ...ctx, onMissingPermission: { notesDenials: true } };
    expect(forged.repo).toEqual(REPO);
  });

  test("another section's context is refused by the type, and at runtime before any read", async () => {
    const api = new MockApi({});
    const labels = sectionModule("labels");
    const branches = sectionModule("branches");
    // @ts-expect-error a context built for branches is not labels' context
    await expect(labels.plan(planContext(branches, api, REPO), [])).rejects.toThrow(
      'labels.plan() was given the context built for section "branches"; build it from this module: planContext(sectionModule("labels"), api, repo)',
    );
    // @ts-expect-error a context built for branches is not labels' context
    await expect(labels.snapshot?.(snapshotContext(branches, api, REPO, "warn"))).rejects.toThrow(
      'labels.snapshot() was given the context built for section "branches"; build it from this module: snapshotContext(sectionModule("labels"), api, repo, onMissingPermission)',
    );
    // Erased to the roster's type the brand is one SectionKey on both sides, so only the runtime refusal stands.
    const erased: SectionModule = sectionModule("repository");
    await expect(erased.plan(planContext(labels, api, REPO), [])).rejects.toThrow(
      'repository.plan() was given the context built for section "labels"',
    );
    expect(api.calls).toEqual([]);
  });
});

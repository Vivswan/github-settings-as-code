/**
 * Imported through src/index.ts on purpose: this is the consumer's path, so a name the entry does not
 * export fails here and not on a consumer's machine.
 */

import { describe, expect, test } from "bun:test";
import {
  describeProblem,
  planContext,
  type RepoRef,
  type SectionModule,
  type SectionPlan,
  type SectionSnapshot,
  type SnapshotContext,
  sectionModule,
  snapshotContext,
  validateSettings,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { unwrap } from "../sections/section-run.js";
import { validatedInput } from "../sections/validated-input.js";

const REPO: RepoRef = { owner: "octo-org", name: "api", slug: "octo-org/api" };
const LIST = "GET /repos/octo-org/api/labels?per_page=100&page=1";
const liveLabels = [{ name: "bug", color: "d73a4a", description: "Something isn't working" }];

describe("a section module called through the entry", () => {
  test("plan() over planContext() reports the drift the engine would, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const labels = sectionModule("labels");
    const plan: SectionPlan = unwrap(
      await labels.plan(
        planContext(labels, api, REPO),
        validatedInput("labels", [
          { name: "bug", color: "000000", description: "Something isn't working" },
        ]),
      ),
    );
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

  test("plan() takes only validation's output: a hand-built list does not compile, and a colliding pair is refused before any read", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const labels = sectionModule("labels");
    // Two entries GitHub folds into one label: on the wire they would be two conflicting updates on every run.
    const raw = [{ name: "bug" }, { name: "Bug" }];
    // The negative control is never called; the compile error alone is the proof, so no unvalidated plan runs.
    const _rawListRefusedByTheType = () =>
      // @ts-expect-error a hand-built entry list is not ValidatedInput<"labels">; pass a validated document's section
      labels.plan(planContext(labels, api, REPO), raw);
    // The brand names the section: a validated branches list is shaped like labels but met branches' checks, not labels'.
    const branches = validatedInput("branches", [{ name: "bug", protection: null }]);
    const _otherSectionRefusedByTheType = () =>
      // @ts-expect-error a ValidatedInput<"branches"> is not a ValidatedInput<"labels">
      labels.plan(planContext(labels, api, REPO), branches);
    const refused = validateSettings({ labels: raw });
    expect(refused.isErr() ? describeProblem(refused.error) : "accepted").toContain(
      'labels[1].name: "Bug" names the same label as "bug" declared earlier; keep exactly one entry per label',
    );
    expect(api.calls).toEqual([]);
    // The positive control: the same door, a document validation accepts, plans and reads once.
    const accepted = validateSettings({ labels: liveLabels });
    if (accepted.isErr()) {
      throw new Error(describeProblem(accepted.error));
    }
    const declared = accepted.value.settings.labels;
    if (declared === undefined) {
      throw new Error("the document declares labels");
    }
    const plan = unwrap(await labels.plan(planContext(labels, api, REPO), declared));
    expect(plan).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([LIST]);
  });

  test("snapshot() over snapshotContext() reads the live labels back as a settings value", async () => {
    const api = new MockApi({ [LIST]: { data: liveLabels } });
    const labels = sectionModule("labels");
    const ctx = snapshotContext(labels, api, REPO, "warn");
    const read = await labels.snapshot?.(ctx);
    const snapshot: SectionSnapshot<"labels"> | undefined =
      read === undefined ? undefined : unwrap(read);
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
    const none = validatedInput("labels", []);
    // @ts-expect-error a context built for branches is not labels' context
    await expect(labels.plan(planContext(branches, api, REPO), none)).rejects.toThrow(
      'labels.plan() was given the context built for section "branches"; build it from this module: planContext(sectionModule("labels"), api, repo)',
    );
    // @ts-expect-error a context built for branches is not labels' context
    await expect(labels.snapshot?.(snapshotContext(branches, api, REPO, "warn"))).rejects.toThrow(
      'labels.snapshot() was given the context built for section "branches"; build it from this module: snapshotContext(sectionModule("labels"), api, repo, onMissingPermission)',
    );
    // Erased to the roster's type the brand is one SectionKey on both sides, so only the runtime refusal stands.
    const erased: SectionModule = sectionModule("repository");
    await expect(
      erased.plan(planContext(labels, api, REPO), validatedInput("repository", {})),
    ).rejects.toThrow('repository.plan() was given the context built for section "labels"');
    expect(api.calls).toEqual([]);
  });
});

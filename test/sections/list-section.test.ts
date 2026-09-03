/**
 * The list-section factory's own controls, over variants of the labels declaration (real routes,
 * real slice): what the factory derives and how a wrong declaration fails loudly. The labels
 * suite pins the pilot's prose; this file pins the factory's rules once.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { planContext } from "../../src/sections/contract/plan.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { LABELS_MOCK } from "../../src/sections/labels/mock.js";
import { listSection } from "../../src/sections/shared/list-section.js";
import { generatorFromSlice } from "../e2e/gen-support.js";
import { mockFragmentFor } from "../e2e/mock/list-fragment.js";
import { Rng } from "../e2e/prng.js";
import { MockApi } from "../mock-api.js";
import { fragmentFake } from "./fragment-fake.js";
import { provePlanIdempotent, REPO } from "./plan-idempotence.js";

const base = labelsSection.decl;
const LIST = "GET /repos/o/r/labels?per_page=100&page=1";

/** The derived mock fake over a variant module, seeded with `live`. */
function fakeFor(section: typeof labelsSection, live: Record<string, unknown>[]) {
  return fragmentFake(section, mockFragmentFor(section, LABELS_MOCK), { labels: live });
}

describe("listSection", () => {
  test("a lens whose fromLive drops a field the write carries fails the re-plan-empty proof naming the field", async () => {
    const dropping = listSection({
      ...base,
      lens: {
        ...base.lens,
        fromLive: ({ description: _dropped, ...rest }) => ({
          ...rest,
          color: rest.color.toLowerCase(),
        }),
      },
    });
    const live = [{ name: "bug", color: "d73a4a", description: "x" }];
    const proof = provePlanIdempotent(dropping, fakeFor(dropping, live), [
      { name: "bug", color: "d73a4a", description: "y" },
    ]);
    await expect(proof).rejects.toThrow(/would not converge/);
    await expect(proof).rejects.toThrow(/labels\[bug\]\.description/);
    // The control: the shipped lens converges over the same state and declaration.
    const { second } = await provePlanIdempotent(labelsSection, fakeFor(labelsSection, live), [
      { name: "bug", color: "d73a4a", description: "y" },
    ]);
    expect(second.ops).toEqual([]);
  });

  test("without a fold or a rename key, identities match exactly and the update carries the name under its own field", async () => {
    const exact = listSection({
      ...base,
      identity: { field: "name" },
    });
    const api = fakeFor(exact, [
      { name: "Bug", color: "ffffff", description: null },
      { name: "bug", color: "000000", description: null },
    ]);
    const { changes, second } = await provePlanIdempotent(exact, api, [
      { name: "bug", color: "d73a4a" },
    ]);
    // "Bug" is a different label under exact matching: deleted as undeclared, not renamed.
    expect(changes).toEqual(['updated label "bug"', 'DELETED undeclared label "Bug"']);
    expect(second.ops).toEqual([]);
    expect(api.state.labels.map((label) => [label.name, label.color])).toEqual([["bug", "d73a4a"]]);
  });

  test("two live items one fold apart are a conflict for the entry claiming them, never silently one", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { name: "bug", color: "000000", description: null },
          { name: "BUG", color: "ffffff", description: null },
        ],
      },
    });
    await expect(
      labelsSection.plan(planContext(labelsSection, api, REPO), [{ name: "bug" }]),
    ).rejects.toThrow(/"bug" matches 2 separate live labels \("bug", "BUG"\)/);
    // Unclaimed, both are undeclared and both are removed.
    const unclaimed = await labelsSection.plan(planContext(labelsSection, api, REPO), []);
    expect(unclaimed.ops.map((op) => [op.role, op.params?.name])).toEqual([
      ["remove", "bug"],
      ["remove", "BUG"],
    ]);
  });

  test("the declaration's types close the shape: same params on both item routes, no undefined write fields, matchBy over entry fields", () => {
    listSection({
      ...base,
      endpoints: {
        ...base.endpoints,
        remove: {
          route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}",
          statuses: { 204: "x" },
        },
      },
      // @ts-expect-error update addresses {name} and remove {milestone_number}: no address is declarable, not even a throwing one
      address: (): never => {
        throw new Error("unreachable");
      },
    });
    listSection({
      ...base,
      lens: {
        ...base.lens,
        // @ts-expect-error an omitted optional stays out of the write; undefined is not a wire value
        toWrite: (label) => ({ name: label.name, color: label.color }),
      },
    });
    listSection({
      ...base,
      // @ts-expect-error matchBy names entry fields, so a misspelled list path cannot go silently unused
      lens: { ...base.lens, matchBy: { colr: "id" } },
    });
  });

  test("two entries claiming one identity are rejected before any read", async () => {
    const api = new MockApi({ [LIST]: { data: [] } });
    await expect(
      labelsSection.plan(planContext(labelsSection, api, REPO), [
        { name: "a", new_name: "b" },
        { name: "B" },
      ]),
    ).rejects.toThrow(/name the same labels entry: "b" and "B"/);
    expect(api.calls).toEqual([]);
  });

  test("the prose hooks reword the keep-note and the delete drift; nothing else is customizable", async () => {
    const worded = listSection({
      ...base,
      prose: {
        undeclaredAction: "REMOVE them",
        undeclaredNote: { state: "lingers", add: "them", manage: "their fate" },
        undeclaredDrift: { state: "a stray", add: "them", keep: "them" },
      },
    });
    const live = [{ name: "stray", color: "ffffff", description: null }];
    const plan = (declared: Parameters<typeof worded.plan>[1]) =>
      worded.plan(planContext(worded, new MockApi({ [LIST]: { data: live } }), REPO), declared);
    expect((await plan({ undeclared: "keep", entries: [] })).notes).toEqual([
      'label "stray" lingers in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their fate, or set "undeclared: delete" to have apply REMOVE them',
    ]);
    expect((await plan([])).ops.map((op) => op.drift)).toEqual([
      [
        "labels[stray]: undeclared - a stray, so apply will REMOVE them; add them to the settings file to keep them",
      ],
    ]);
    // The hook-creep gate: a third hook is an excess property and does not compile.
    listSection({
      ...base,
      // @ts-expect-error the prose surface is exactly the action and the two wording hooks
      prose: { undeclaredAction: "DELETE it", changeSuffix: " (and more)" },
    });
  });

  test("declared secret values are listed per entry in both value forms", () => {
    const secretive = listSection({
      ...base,
      secretValues: (label) =>
        label.description === undefined ? [] : [{ label: label.name, value: label.description }],
    });
    const entries = [
      { name: "a", description: "$A" },
      { name: "b" },
      { name: "c", description: "$C" },
    ];
    const listed = [
      { label: "a", value: "$A" },
      { label: "c", value: "$C" },
    ];
    expect(secretive.secretValues?.(entries)).toEqual(listed);
    expect(secretive.secretValues?.({ undeclared: "keep", entries })).toEqual(listed);
    expect(labelsSection.secretValues).toBeUndefined();
  });
});

describe("generatorFromSlice", () => {
  test("a refined field without a pool fails loudly naming its full path, never emitting an invalid entry", () => {
    const refined = z.object({ name: z.string(), color: z.string().regex(/^[0-9a-f]{6}$/) });
    expect(() => generatorFromSlice(refined)(new Rng(1))).toThrow(
      /the drawn value at "color" fails the slice .* - seed the field with a pool/,
    );
    const nested = z.object({ config: z.object({ url: z.string().url() }) });
    expect(() => generatorFromSlice(nested)(new Rng(1))).toThrow(/at "config\.url"/);
    const pooled = generatorFromSlice(refined, {
      fields: { color: (rng) => rng.pick(["d73a4a", "a2eeef"]) },
    });
    for (let i = 0; i < 50; i++) {
      expect(refined.safeParse(pooled(new Rng(i))).success).toBe(true);
    }
  });

  test("wrapped fields draw their inner type: a defaulted enum yields both members across seeds", () => {
    const wrapped = z.object({
      state: z.enum(["open", "closed"]).default("open"),
      pinned: z.boolean().catch(false),
    });
    const gen = generatorFromSlice(wrapped);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(String(gen(new Rng(i)).state));
    }
    expect([...seen].sort()).toEqual(["closed", "open"]);
  });
});

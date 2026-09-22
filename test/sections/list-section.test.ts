/**
 * The list-section factory's own controls over variants of the labels declaration; the labels suite pins the pilot's prose, this file pins the
 * factory's rules once.
 */

import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";
import type { SectionInput } from "../../src/sections/contract/module.js";
import { planContext } from "../../src/sections/contract/plan.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import {
  exactName,
  type ListEndpoints,
  type ListSectionModule,
  type ListWrite,
  listSection,
} from "../../src/sections/shared/list-section.js";
import { webhooksSection } from "../../src/sections/webhooks/index.js";
import { generatorFromSlice, uniqueBy } from "../e2e/gen-support.js";
import { mockFragmentFor } from "../e2e/mock/list-fragment.js";
import { Rng } from "../e2e/prng.js";
import { MockApi } from "../mock-api.js";
import { LABELS_MOCK } from "../src/sections/labels/mock.js";
import { fragmentFake } from "./fragment-fake.js";
import { provePlanIdempotent } from "./plan-idempotence.js";
import { failureOf, REPO, unwrap } from "./section-run.js";
import { validatedInput } from "./validated-input.js";

const base = labelsSection.decl;
const LIST = "GET /repos/o/r/labels?per_page=100&page=1";

/** The labels dictionary without its update role: a resource GitHub could not edit. */
const { update: _update, ...IMMUTABLE_ENDPOINTS } = base.endpoints;
const immutable = listSection({ ...base, endpoints: IMMUTABLE_ENDPOINTS });

/** The derived mock fake over a variant module, seeded with `live`. */
function fakeFor<Ends extends ListEndpoints, Live extends object, Key extends string>(
  section: ListSectionModule<"labels", Ends, Live, "name", Key>,
  live: Record<string, unknown>[],
) {
  return fragmentFake(section, mockFragmentFor(section, LABELS_MOCK), { labels: live });
}

describe("listSection", () => {
  test("a lens whose fromLive drops a field the write carries fails the re-plan-empty proof naming the field", async () => {
    const dropping = listSection({
      ...base,
      lens: {
        ...base.lens,
        fromLive: ({ description: _dropped, ...rest }) =>
          ok({
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

  test("under the exact fold and no rename key, identities match verbatim and the update carries the name under its own field", async () => {
    const exact = listSection({
      ...base,
      identity: { field: "name", fold: exactName },
    });
    const api = fakeFor(exact, [
      { name: "Bug", color: "ffffff", description: null },
      { name: "bug", color: "000000", description: null },
    ]);
    const { changes, second } = await provePlanIdempotent(exact, api, [
      { name: "bug", color: "d73a4a" },
    ]);
    // "Bug" is a different label under exact matching: deleted as undeclared, not renamed.
    expect(changes).toEqual(['DELETED undeclared label "Bug"', 'updated label "bug"']);
    expect(second.ops).toEqual([]);
    expect(api.state.labels.map((label) => [label.name, label.color])).toEqual([["bug", "d73a4a"]]);
  });

  test("two live items one fold apart are refused before any comparison, whether or not an entry claims them", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { name: "bug", color: "000000", description: null },
          { name: "BUG", color: "ffffff", description: null },
        ],
      },
    });
    const refusal = new Error(
      'labels: GitHub holds labels that resolve to one identity: "bug" and "BUG". This section manages one label per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again',
    );
    expect(
      failureOf(
        await labelsSection.plan(
          planContext(labelsSection, api, REPO),
          validatedInput("labels", [{ name: "bug" }]),
        ),
      ).message,
    ).toBe(refusal.message);
    // Unclaimed, the pair is still one identity the planner cannot manage.
    expect(
      failureOf(
        await labelsSection.plan(
          planContext(labelsSection, api, REPO),
          validatedInput("labels", []),
        ),
      ).message,
    ).toBe(refusal.message);
  });

  test("an entry claiming two identities that both exist live (a rename onto a taken name) is refused naming both", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { name: "bug", color: "000000", description: null },
          { name: "defect", color: "ffffff", description: null },
        ],
      },
    });
    expect(
      failureOf(
        await labelsSection.plan(
          planContext(labelsSection, api, REPO),
          validatedInput("labels", [{ name: "bug", new_name: "defect" }]),
        ),
      ).message,
    ).toBe(
      'labels: the entry "defect" matches 2 separate live labels ("defect", "bug"), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry',
    );
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
      endpoints: {
        ...base.endpoints,
        // @ts-expect-error a fifth role is not served: the factory derives handlers for exactly the four
        probe: { route: "GET /repos/{owner}/{repo}/labels/{name}", statuses: { 200: "x" } },
      },
    });
    listSection({
      ...base,
      // @ts-expect-error a DELETE cannot pose as the update role; without a PATCH or PUT the role is absent
      endpoints: { ...IMMUTABLE_ENDPOINTS, update: IMMUTABLE_ENDPOINTS.remove },
    });
    const unreachable = (): never => {
      throw new Error("unreachable");
    };
    listSection({
      ...base,
      // @ts-expect-error a dictionary widened to the union cannot say which roles it has, so it is refused outright
      endpoints: base.endpoints as ListEndpoints,
      // @ts-expect-error nor can its item routes agree on params, so no address is declarable either
      address: unreachable,
    });
    // A conditional between two literal dictionaries is a union too: keyof would hide the second arm's DELETE-as-update.
    const flag = Boolean(process.env.LIST_SECTION_NEVER_SET);
    listSection({
      ...base,
      // @ts-expect-error a union of two dictionaries is refused for the same reason
      endpoints: flag
        ? IMMUTABLE_ENDPOINTS
        : { ...IMMUTABLE_ENDPOINTS, update: IMMUTABLE_ENDPOINTS.remove },
      address: unreachable,
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

  test("two entries claiming one identity (a rename target and a current name) are one validate issue at the later claim's field, in both declared forms", () => {
    const entries = [{ name: "a", new_name: "b" }, { name: "B" }];
    const issue = {
      path: "[1].name",
      message: '"B" names the same label as "b" declared earlier; keep exactly one entry per label',
    };
    expect(labelsSection.validate(entries)).toEqual([issue]);
    expect(labelsSection.validate({ _undeclared: "keep", entries })).toEqual([
      { ...issue, path: ".entries[1].name" },
    ]);
  });

  test("the undeclared deletes are planned before the declared entries' updates and creates, whatever order the file and the live list have", async () => {
    const live = [
      { name: "bug", color: "000000", description: null },
      { name: "stray", color: "ffffff", description: null },
    ];
    const plan = unwrap(
      await labelsSection.plan(
        planContext(labelsSection, new MockApi({ [LIST]: { data: live } }), REPO),
        validatedInput("labels", [
          { name: "new", color: "d73a4a" },
          { name: "bug", color: "d73a4a" },
        ]),
      ),
    );
    expect(plan.ops.map((op) => op.describe)).toEqual([
      'deleting undeclared label "stray"',
      'creating label "new"',
      'updating label "bug"',
    ]);
  });

  test("the wire hook shapes every body the planner sends (create, update, recreate, the updateConfig slice) and nothing the comparison reads", async () => {
    const wired = listSection({
      ...base,
      lens: { ...base.lens, wire: (write) => ({ ...write, via: "wire" }) },
    });
    const live = [{ name: "bug", color: "000000", description: null }];
    const { first, second } = await provePlanIdempotent(wired, fakeFor(wired, live), [
      { name: "bug", color: "d73a4a" },
      { name: "new", color: "ffffff" },
    ]);
    expect(first.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "update",
        { new_name: "bug", color: "d73a4a", via: "wire" },
        [
          'labels[bug].color: declared "d73a4a" != live "000000"; apply will set the declared value',
        ],
      ],
      [
        "create",
        { name: "new", color: "ffffff", via: "wire" },
        [
          "labels[new]: missing - declared in the settings file but not on the repo; apply will create it",
        ],
      ],
    ]);
    expect(second.ops).toEqual([]);

    const recreating = listSection({
      ...base,
      endpoints: IMMUTABLE_ENDPOINTS,
      lens: { ...base.lens, wire: (write) => ({ ...write, via: "wire" }) },
    });
    const replaced = await provePlanIdempotent(recreating, fakeFor(recreating, live), [
      { name: "bug", color: "d73a4a" },
    ]);
    expect(replaced.first.ops.map((op) => [op.role, op.payload])).toEqual([
      ["remove", undefined],
      ["create", { name: "bug", color: "d73a4a", via: "wire" }],
    ]);

    const hooks = listSection({
      ...webhooksSection.decl,
      lens: {
        ...webhooksSection.decl.lens,
        wire: (write) => ({ ...write, config: { ...write.config, via: "wire" } }),
      },
    });
    const api = new MockApi({
      "GET /repos/o/r/hooks?per_page=100&page=1": {
        data: [
          {
            id: 8,
            name: "web",
            active: true,
            events: ["push"],
            config: { url: "https://h.test/hook", content_type: "json" },
          },
        ],
      },
    });
    const planned = unwrap(
      await hooks.plan(
        planContext(hooks, api, REPO),
        validatedInput("webhooks", [
          { config: { url: "https://h.test/hook", content_type: "form" } },
        ]),
      ),
    );
    expect(planned.ops.map((op) => [op.role, op.payload])).toEqual([
      ["updateConfig", { url: "https://h.test/hook", content_type: "form", via: "wire" }],
    ]);
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
    const plan = async (declared: SectionInput<"labels">) =>
      unwrap(
        await worded.plan(
          planContext(worded, new MockApi({ [LIST]: { data: live } }), REPO),
          validatedInput("labels", declared),
        ),
      );
    expect((await plan({ _undeclared: "keep", entries: [] })).notes).toEqual([
      'label "stray" lingers in the settings file; kept under "_undeclared: keep" - add them to the settings file to manage their fate, or set "_undeclared: delete" to have apply REMOVE them',
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

  test("secret fields demand the unverifiable facet on the roles that carry them, and a dotted path sits under the mapping", () => {
    expect(labelsSection.secretValues).toBeUndefined();
    // Without the facet the write would recur with empty drift, which the plan contract forbids: the path type admits none.
    listSection({
      ...base,
      // @ts-expect-error neither create nor updateConfig declares unverifiable: true, so no secret path is declarable
      secrets: ["description"],
    });
    listSection({
      ...base,
      endpoints: IMMUTABLE_ENDPOINTS,
      // @ts-expect-error a resource GitHub cannot edit has no carrier: a recreate would re-send the value on every run
      secrets: ["description"],
    });
    // The path type is `${mapping}.${string}`: a dotted path outside the mapping the updateConfig role writes is refused.
    const { mapping: _mapping, secrets: _secrets, ...hooks } = webhooksSection.decl;
    listSection({
      ...hooks,
      mapping: "config",
      // @ts-expect-error "events.secret" sits outside the "config" mapping, so no role carries it under the unverifiable facet
      secrets: ["events.secret"],
    });
    listSection({
      ...hooks,
      mapping: "config",
      // @ts-expect-error a top-level field is not under any mapping
      secrets: ["config"],
    });
    // The control: the shipped path under the shipped mapping compiles, and the mapping must name an entry field.
    listSection({ ...hooks, mapping: "config", secrets: ["config.secret"] });
    listSection({
      ...hooks,
      // @ts-expect-error the mapping names an ENTRY field; a nested field (config.url) is refused
      mapping: "url",
    });
    // One literal only: a union would admit a path under a mapping the declaration does not have, and
    // `string` would admit any path, so the runtime would route a secret through the general update.
    for (const mapping of ["config", "events"] as const) {
      listSection({
        ...hooks,
        // @ts-expect-error a union mapping is refused
        mapping,
        secrets: ["config.secret"],
      });
    }
    listSection({
      ...hooks,
      // @ts-expect-error a mapping widened to string is refused
      mapping: "config" as string,
      secrets: ["config.secret"],
    });
    listSection({
      ...hooks,
      // @ts-expect-error a pattern type is not one literal either: "events" would satisfy it beside a config.* path
      mapping: "config" as Lowercase<string>,
      secrets: ["config.secret"],
    });
    // The carrier facet is the type's: an updateConfig without `unverifiable: true` admits no secret path.
    const { updateConfig, ...others } = webhooksSection.decl.endpoints;
    // @ts-expect-error the config write would recur with empty drift, which the plan contract forbids
    listSection({
      ...webhooksSection.decl,
      endpoints: {
        ...others,
        updateConfig: { route: updateConfig.route, statuses: updateConfig.statuses },
      },
    });
  });

  test("the item roles close the shape: updateConfig demands update, and a nested identity keeps its siblings and cannot rename", () => {
    const { update: _update, ...withoutUpdate } = webhooksSection.decl.endpoints;
    listSection({
      ...webhooksSection.decl,
      // @ts-expect-error updateConfig without update: the general update carries the fields outside the mapping
      endpoints: withoutUpdate,
    });
    listSection({
      ...webhooksSection.decl,
      // @ts-expect-error a nested identity field cannot rename through another key
      identity: { field: "config.url", fold: exactName, renameKey: "new_url" },
    });
    // A write annotated with the nested carrier admits the mapping's other fields beside the identity.
    const write: ListWrite<"config.url"> = {
      config: { url: "https://x.test/h", secret: "$A", content_type: "json" },
      events: ["push"],
    };
    expect(write.config.url).toBe("https://x.test/h");
  });
});

describe("listSection without an update role", () => {
  test("a drifted item is deleted then recreated, in that order, and the re-plan is empty", async () => {
    const api = fakeFor(immutable, [
      { name: "bug", color: "000000", description: "keep me" },
      { name: "stale", color: "ffffff", description: null },
    ]);
    const { first, second, changes } = await provePlanIdempotent(immutable, api, [
      { name: "bug", color: "d73a4a" },
    ]);
    expect(first.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "labels[stale]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
        ],
      ],
      [
        "remove",
        [
          "labels[bug]: live settings differ from the settings file, and labels cannot be edited; apply will delete and recreate it",
        ],
      ],
      // The field line carries no remedy of its own: the generic line above named it.
      ["create", ['labels[bug].color: declared "d73a4a" != live "000000"']],
    ]);
    expect(changes).toEqual([
      'DELETED undeclared label "stale"',
      'deleted label "bug" to recreate it with the declared settings',
      'recreated label "bug"',
    ]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/labels/stale",
      "DELETE /repos/o/r/labels/bug",
      "POST /repos/o/r/labels",
    ]);
    expect(second.ops).toEqual([]);
    // Without a recreate seam the create body is the write: the undeclared description is gone.
    expect(api.state.labels.map((label) => [label.name, label.color, label.description])).toEqual([
      ["bug", "d73a4a", null],
    ]);
  });

  test("the recreate seam carries a live field the write leaves undeclared onto the create", async () => {
    const seeded = listSection({
      ...base,
      endpoints: IMMUTABLE_ENDPOINTS,
      recreate: (live, write) => ({ ...write, description: live.description ?? "" }),
    });
    const api = fakeFor(seeded, [{ name: "bug", color: "000000", description: "keep me" }]);
    const { second } = await provePlanIdempotent(seeded, api, [{ name: "bug", color: "d73a4a" }]);
    expect(second.ops).toEqual([]);
    expect(api.state.labels.map((label) => [label.color, label.description])).toEqual([
      ["d73a4a", "keep me"],
    ]);
    // The seam exists only for an immutable resource: an updatable declaration cannot carry one.
    listSection({
      ...base,
      // @ts-expect-error recreate is never on a dictionary with an update role
      recreate: (_live, write) => write,
    });
  });

  test("the derived mock fragment serves no update handler, and the record type has no such key", () => {
    const fragment = mockFragmentFor(immutable, LABELS_MOCK);
    expect(Object.keys(fragment).sort()).toEqual(["labels.create", "labels.list", "labels.remove"]);
    // @ts-expect-error no update role, no update handler key
    fragment["labels.update"];
    expect(Object.keys(mockFragmentFor(labelsSection, LABELS_MOCK)).sort()).toEqual([
      "labels.create",
      "labels.list",
      "labels.remove",
      "labels.update",
    ]);
  });

  test("the derived create rejects what the spec declares unique: the folded identity, or the declared key", async () => {
    const live = [{ name: "bug", color: "d73a4a", description: null }];
    const post = async (spec: typeof LABELS_MOCK, body: Record<string, unknown>) => {
      const api = fragmentFake(labelsSection, mockFragmentFor(labelsSection, spec), {
        labels: live,
      });
      const result = await api.tryRequest("POST", "/repos/o/r/labels", body);
      return "error" in result ? result.error.status : 201;
    };
    // "identity": the folded name is unique; another color under the same name is refused.
    expect(await post(LABELS_MOCK, { name: "BUG", color: "ffffff" })).toBe(422);
    expect(await post(LABELS_MOCK, { name: "docs", color: "d73a4a" })).toBe(201);
    // Declared: the color is unique instead, so the same name passes and the same color is refused.
    const byColor = {
      ...LABELS_MOCK,
      unique: (item: Record<string, unknown>) => String(item.color),
    };
    expect(await post(byColor, { name: "BUG", color: "ffffff" })).toBe(201);
    expect(await post(byColor, { name: "docs", color: "d73a4a" })).toBe(422);
    // The choice is explicit: a spec that names nothing unique does not compile.
    const { unique: _unique, ...silent } = LABELS_MOCK;
    // @ts-expect-error `unique` is required, so identity uniqueness is never an accidental default
    mockFragmentFor(labelsSection, silent);
  });
});

describe("listSection derived mock fragment", () => {
  test("update and remove reach a label whose live name differs only in case, as GitHub matches label names", async () => {
    const api = fakeFor(labelsSection, [
      { name: "bug", color: "d73a4a", description: null },
      { name: "docs", color: "0075ca", description: null },
    ]);
    const patched = await api.tryRequest("PATCH", "/repos/o/r/labels/Bug", { color: "ffffff" });
    expect("data" in patched ? patched.data : patched).toMatchObject({
      name: "bug",
      color: "ffffff",
    });
    expect(await api.tryRequest("DELETE", "/repos/o/r/labels/DOCS", undefined)).toEqual({
      data: null,
    });
    // The control: a name no live label folds to still answers GitHub's 404.
    const missing = await api.tryRequest("DELETE", "/repos/o/r/labels/triage", undefined);
    expect("error" in missing ? missing.error.status : missing).toBe(404);
    expect(api.state.labels.map((label) => [label.name, label.color])).toEqual([["bug", "ffffff"]]);
  });
});

describe("listSection listing", () => {
  test("the query knob rides on every page of the list read", async () => {
    const queried = listSection({ ...base, listing: { query: { state: "all" } } });
    const api = new MockApi({
      "GET /repos/o/r/labels?state=all&per_page=100&page=1": { data: [] },
    });
    unwrap(await queried.plan(planContext(queried, api, REPO), validatedInput("labels", [])));
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/labels?state=all&per_page=100&page=1",
    ]);
  });

  test("an unpaginated list is one bare GET on both sides: the section sends no page params and the derived mock ignores them", async () => {
    const whole = listSection({ ...base, listing: { unpaginated: true } });
    const api = new MockApi({ "GET /repos/o/r/labels": { data: [] } });
    unwrap(await whole.plan(planContext(whole, api, REPO), validatedInput("labels", [])));
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/o/r/labels"]);
    const live = [
      { name: "a", color: "ffffff", description: null },
      { name: "b", color: "ffffff", description: null },
    ];
    // Generic over the variant: a spread-built module infers its endpoints as `Ends & OnlyListRoles<Ends>`, which no
    // longer compares to the shipped module's type by variance alone once the declaration carries its mapping literal.
    const served = async <Ends extends ListEndpoints, Live extends object, Key extends string>(
      section: ListSectionModule<"labels", Ends, Live, "name", Key>,
    ): Promise<number> => {
      const result = await fakeFor(section, live).tryRequest("GET", "/repos/o/r/labels?per_page=1");
      return "data" in result ? (result.data as unknown[]).length : -1;
    };
    expect(await served(whole)).toBe(2);
    // The control: the paged fragment honors per_page.
    expect(await served(labelsSection)).toBe(1);
  });
});

describe("listSection conflicts", () => {
  const clashing = listSection({
    ...base,
    conflicts: {
      declared: (writes) =>
        writes.flatMap((write, index) =>
          writes.slice(0, index).some((earlier) => earlier.color === write.color)
            ? [{ path: `[${index}].color`, message: `"${write.name}" repeats a declared color` }]
            : [],
        ),
      live: (writes, live) =>
        writes.flatMap((write) => {
          const holder = live.find(
            (item) => item.name !== write.name && item.color === write.color,
          );
          return holder === undefined
            ? []
            : [`"${write.name}" reuses the color of "${holder.name}"`];
        }),
    },
  });
  const live = [
    { name: "bug", color: "d73a4a", description: null },
    { name: "docs", color: "0075ca", description: null },
  ];

  test("a declared-only conflict is a validate issue per finding, so it fails the document before any request", () => {
    expect(
      clashing.validate([
        { name: "a", color: "000000" },
        { name: "b", color: "000000" },
        { name: "c", color: "000000" },
      ]),
    ).toEqual([
      { path: "[1].color", message: '"b" repeats a declared color' },
      { path: "[2].color", message: '"c" repeats a declared color' },
    ]);
  });

  test("a live conflict fails after the one read and before any write, every line in one error", async () => {
    const api = new MockApi({ [LIST]: { data: live } });
    expect(
      failureOf(
        await clashing.plan(
          planContext(clashing, api, REPO),
          validatedInput("labels", [
            { name: "defect", color: "d73a4a" },
            { name: "flaw", color: "ffffff" },
            { name: "guide", color: "0075ca" },
          ]),
        ),
      ).message,
    ).toContain(
      'labels: the settings file conflicts with the live labels: "defect" reuses the color of "bug"; "guide" reuses the color of "docs". Resolve each conflict on GitHub, then re-run',
    );
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("no conflict reported, no interference: the plan proceeds as without the hook", async () => {
    const api = new MockApi({ [LIST]: { data: live } });
    const planned = unwrap(
      await clashing.plan(
        planContext(clashing, api, REPO),
        validatedInput("labels", [{ name: "defect", color: "000000" }]),
      ),
    );
    expect(planned.ops.map((op) => op.role)).toEqual(["remove", "remove", "create"]);
  });
});

describe("uniqueBy", () => {
  test("a repeated identity gets the entry's index appended until it is free, across the pooled fields, under the fold", () => {
    expect(
      uniqueBy(
        [
          { name: "bug", new_name: "BUG" },
          { name: "Bug", color: "x" },
          { name: "bug-1" },
          { name: 7 },
        ],
        ["name", "new_name"],
        (name) => name.toLowerCase(),
      ),
    ).toEqual([
      { name: "bug", new_name: "BUG-0" },
      { name: "Bug-1", color: "x" },
      { name: "bug-1-2" },
      { name: 7 },
    ]);
    // The control: distinct identities pass through untouched, and the input is not mutated.
    const input = [{ name: "a" }, { name: "b" }];
    expect(uniqueBy(input, ["name"])).toEqual(input);
    expect(uniqueBy([{ name: "a" }, { name: "A" }], ["name"])).toEqual([
      { name: "a" },
      { name: "A" },
    ]);
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

  test("wrapped fields draw their inner type: a defaulted enum yields both members across seeds, and is left out too, since the file may omit it", () => {
    const wrapped = z.object({
      state: z.enum(["open", "closed"]).default("open"),
      pinned: z.boolean().catch(false),
    });
    const gen = generatorFromSlice(wrapped);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(String(gen(new Rng(i)).state));
    }
    expect([...seen].sort()).toEqual(["closed", "open", "undefined"]);
  });
});

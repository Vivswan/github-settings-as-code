import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { err } from "neverthrow";

import {
  preflightProbe,
  type RepoRunOptions,
  runForRepo,
  skippedSectionKeys,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { silentIo } from "../../src/io.js";
import { describeProblem, type TopLevelShape } from "../../src/problem.js";
import { SECTION_KEYS, type SettingsFile } from "../../src/schema.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import type { SectionPlan } from "../../src/sections/contract/plan.js";
import { interactionLimitsSection } from "../../src/sections/interaction_limits/index.js";
import { pagesSection } from "../../src/sections/pages/index.js";
import { rulesetsSection } from "../../src/sections/rulesets/index.js";
import { workflowsSection } from "../../src/sections/workflows/index.js";
import { captureIo } from "../io/capture.js";
import { MockApi } from "../mock-api.js";

/** Brand fixtures through the REAL boundary: an invalid fixture fails here instead of riding a cast into runForRepo. */
function validated(doc: SettingsFile): ValidatedSettings {
  return validateSettingsDoc(doc, "test fixture", SectionSelection.ALL, silentIo()).match(
    (settings) => settings,
    (problem) => {
      throw new Error(`test fixture failed validation: ${describeProblem(problem)}`);
    },
  );
}

function opts(overrides: Partial<RepoRunOptions> = {}): RepoRunOptions {
  return {
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: validated({ repository: { has_wiki: false } }),
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    sections: SectionSelection.ALL,
    ...overrides,
  };
}

describe("runForRepo", () => {
  test("preflight denial fails with zero mutations", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, opts(), io);
    expect(result.result).toBe("failed");
    expect(result.preflightDenied).toHaveLength(1);
    expect(api.mutations()).toHaveLength(0);
    expect(annotations[0]).toContain("preflight: repository:");
  });

  test("warn policy skips the denied section and reports partial", async () => {
    const api = new MockApi({
      "PATCH /repos/o/r": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, opts({ onMissingPermission: "warn" }), io);
    expect(result.result).toBe("partial");
    expect(skippedSectionKeys(result.outcomes)).toEqual(["repository"]);
    expect(annotations.some((a) => a.startsWith("warning: repository: skipped"))).toBe(true);
  });

  const put = "PUT /repos/o/r/branches/main/protection";
  test.each([
    [
      "warn",
      "Branch not found",
      "failed",
      ["branches", "failed"],
      expect.stringMatching(/^error: branches: .*404 Branch not found\. /),
    ],
    [
      "warn",
      "Not Found",
      "partial",
      ["branches", "skipped"],
      expect.stringMatching(
        /^warning: branches: skipped - the token was denied PUT .*404 Not Found /,
      ),
    ],
  ] as const)(
    "under on-missing-permission %s a 404 answering %p on a write is classified by the endpoint's declaration, not the status",
    async (policy, message, result, outcome, annotation) => {
      // The unrouted protection GET and branch probe answer 404 "Not Found", a concealed denial, so the PUT is planned.
      const api = new MockApi({ [put]: { error: { status: 404, message, body: "" } } });
      const { io, annotations } = captureIo();
      const run = await runForRepo(
        api,
        opts({
          onMissingPermission: policy,
          settings: validated({
            branches: [{ name: "main", protection: { enforce_admins: true } }],
          }),
        }),
        io,
      );
      expect([run.result, run.outcomes.map((o) => [o.key, o.status]), annotations]).toEqual([
        result,
        [[...outcome]],
        [annotation],
      ]);
      expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([put]);
    },
  );

  async function receivedBy<S extends { plan: (ctx: never, desired: never) => Promise<unknown> }>(
    section: S,
    raw: SettingsFile,
  ): Promise<unknown[]> {
    const received: unknown[] = [];
    const stubbed = spyOn(section, "plan").mockImplementation((async (
      _ctx: never,
      desired: unknown,
    ) => {
      received.push(desired);
      return { ops: [], notes: [], drift: [] };
    }) as never);
    try {
      const result = await runForRepo(
        new MockApi({}),
        opts({ settings: validated(raw) }),
        captureIo().io,
      );
      expect(result.result).toBe("applied");
    } finally {
      stubbed.mockRestore();
    }
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(received[0]);
    return received;
  }

  const prototypeClean = (node: object): void => {
    expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
    expect(Object.hasOwn(node, "__proto__")).toBe(false);
  };

  test("a mapping section receives zod's parsed copy: own __proto__ dropped at every schema node, a passthrough subtree by reference (its own __proto__ ships verbatim)", async () => {
    // JSON.parse creates "__proto__" as an OWN key; the control proves the raw document carries it at every level.
    const raw = JSON.parse(
      '{"pages":{"source":{"branch":"main","__proto__":{"planted":1}},"__proto__":{"planted":2},"cname":"docs.example.com","extra":{"__proto__":{"planted":3},"k":1}}}',
    );
    for (const node of [raw.pages, raw.pages.source, raw.pages.extra]) {
      expect(Object.hasOwn(node, "__proto__")).toBe(true);
    }
    const [desired] = (await receivedBy(pagesSection, raw)) as [
      { source: object; cname: string; extra: object },
    ];
    expect(desired).not.toBe(raw.pages);
    expect(desired).toEqual({
      source: { branch: "main" },
      cname: "docs.example.com",
      extra: raw.pages.extra,
    });
    prototypeClean(desired);
    prototypeClean(desired.source);
    // The deliberate residual: the shape describes no node under `extra`, so the value rides by reference and reaches GitHub as written.
    expect(desired.extra).toBe(raw.pages.extra);
  });

  test("a knobbed list section receives zod's parsed copy in both forms: a fresh list or wrapper, own __proto__ dropped on each entry", async () => {
    const plain = JSON.parse('{"rulesets":[{"name":"r","__proto__":{"planted":1}}]}');
    const wrapped = JSON.parse(
      '{"rulesets":{"_undeclared":"keep","entries":[{"name":"r","__proto__":{"planted":1}}]}}',
    );
    expect(Object.hasOwn(plain.rulesets[0], "__proto__")).toBe(true);
    expect(Object.hasOwn(wrapped.rulesets.entries[0], "__proto__")).toBe(true);

    const [plainDesired] = (await receivedBy(rulesetsSection, plain)) as [object[]];
    expect(plainDesired).not.toBe(plain.rulesets);
    expect(plainDesired).toEqual([{ name: "r" }]);
    prototypeClean(plainDesired[0] as object);

    const [wrappedDesired] = (await receivedBy(rulesetsSection, wrapped)) as [
      { _undeclared: string; entries: object[] },
    ];
    expect(wrappedDesired).not.toBe(wrapped.rulesets);
    expect(wrappedDesired).toEqual({ _undeclared: "keep", entries: [{ name: "r" }] });
    prototypeClean(wrappedDesired);
    prototypeClean(wrappedDesired.entries[0] as object);
  });

  test("pages: null is an active section, not an omitted one", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      opts({ mode: "check", settings: validated({ pages: null }) }),
      io,
    );
    expect(result.result).toBe("drift");
    expect(result.outcomes.map((o) => o.key)).toEqual(["pages"]);
  });
});

describe("runForRepo secret references", () => {
  const HOOKS_LIST = "GET /repos/o/r/hooks?per_page=100&page=1";
  const webhookSettings = (secret: string): ValidatedSettings =>
    validated({
      webhooks: [{ config: { url: "https://x.test/h", secret } }],
    });

  test("apply resolves up front, masks before the first mutation, and hands handlers plaintext", async () => {
    const api = new MockApi({ [HOOKS_LIST]: { data: [] } }).allowMutations("POST /repos/o/r/hooks");
    const mutationsAtMaskTime: number[] = [];
    const { io, masks } = captureIo(() => mutationsAtMaskTime.push(api.mutations().length));
    const result = await runForRepo(
      api,
      opts({
        settings: webhookSettings("$WEBHOOK_SECRET"),
        // Spelled out, the way multi.ts runs the defaults document for a fileless target; the unset-variable test below takes the default.
        secretSource: "operator",
        secretEnv: { WEBHOOK_SECRET: "s3cret-plaintext" },
      }),
      io,
    );
    expect(result.result).toBe("applied");
    expect(masks).toEqual(["s3cret-plaintext"]);
    expect(mutationsAtMaskTime).toEqual([0]);
    const post = api.mutations()[0]?.payload as { config?: { secret?: string } };
    expect(post?.config?.secret).toBe("s3cret-plaintext");
  });

  test("an unset variable fails the repo cleanly after preflight, with zero mutations", async () => {
    const api = new MockApi({ [HOOKS_LIST]: { data: [] } });
    const { io, annotations } = captureIo();
    const result = await runForRepo(
      api,
      opts({ settings: webhookSettings("$WEBHOOK_SECRET"), secretEnv: {} }),
      io,
    );
    expect(result.result).toBe("failed");
    expect(result.outcomes).toEqual([
      { key: "webhooks", status: "failed", detail: [expect.stringContaining("is unset")] },
    ]);
    expect(api.mutations()).toEqual([]);
    // Resolution runs AFTER preflight: the read-only probe already listed hooks.
    expect(api.calls.some((c) => c.method === "GET" && c.path.startsWith("/repos/o/r/hooks"))).toBe(
      true,
    );
    expect(annotations.some((a) => a.includes("$WEBHOOK_SECRET is unset"))).toBe(true);
  });

  test("check mode validates syntax only: an unset variable passes, a literal fails", async () => {
    const api = new MockApi({ [HOOKS_LIST]: { data: [] } });
    const { io } = captureIo();
    const unset = await runForRepo(
      api,
      opts({ mode: "check", settings: webhookSettings("$NEVER_SET"), secretEnv: {} }),
      io,
    );
    expect(unset.result).toBe("drift"); // the declared hook is missing; no env was read
    const literalApi = new MockApi({});
    const literal = await runForRepo(
      literalApi,
      opts({ mode: "check", settings: webhookSettings("hunter2") }),
      io,
    );
    expect(literal.result).toBe("failed");
    expect(literal.outcomes[0]?.detail[0]).toContain("committed plaintext");
    // Syntax validation fires before any API call.
    expect(literalApi.calls).toEqual([]);
  });

  test.each(["apply", "check"] as const)(
    "a target-sourced reference is refused in %s mode, before any API call",
    async (mode) => {
      const api = new MockApi({});
      const { io, annotations } = captureIo();
      const result = await runForRepo(
        api,
        opts({
          mode,
          settings: webhookSettings("$WEBHOOK_SECRET"),
          secretSource: "target",
          secretEnv: { WEBHOOK_SECRET: "present-but-irrelevant" },
        }),
        io,
      );
      expect(result.result).toBe("failed");
      expect(result.outcomes).toEqual([
        {
          key: "webhooks",
          status: "failed",
          detail: [expect.stringContaining("target-fetched settings file")],
        },
      ]);
      expect(annotations).toEqual([
        expect.stringMatching(/^error: webhooks: .*target-fetched settings file/),
      ]);
      expect(api.calls).toEqual([]);
    },
  );

  test("a section excluded by `sections` cannot fail the run on its references", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      opts({
        settings: validated({
          ...webhookSettings("a-literal-that-would-fail"),
          repository: { has_wiki: false },
        }),
        sections: SectionSelection.of({ only: ["repository"] })._unsafeUnwrap(),
      }),
      io,
    );
    // The excluded section contributes no values, so its literal is never collected, let alone refused.
    expect(result.result).toBe("applied");
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["repository", "applied"],
      ["webhooks", "excluded"],
    ]);
  });
});

describe("validateSettingsDoc", () => {
  test("unknown top-level keys are a problem naming the source and the known sections", () => {
    const { io } = captureIo();
    expect(validateSettingsDoc({ labls: [] }, "repos/x.yml", SectionSelection.ALL, io)).toEqual(
      err({
        code: "settings-unknown-sections",
        source: "repos/x.yml",
        unknown: ["labls"],
        known: SECTION_KEYS,
      }),
    );
  });

  test("an unknown underscore key is a problem under every allowlist, and it outranks the unknown sections; the document directive passes", () => {
    const { io, annotations } = captureIo();
    const doc = { _notes: "private", _layerin: "replace", labls: [], repository: {} };
    const refused = err({
      code: "settings-unknown-directives" as const,
      source: "f.yml",
      unknown: ["_notes", "_layerin"],
    });
    expect(validateSettingsDoc(doc, "f.yml", SectionSelection.ALL, io)).toEqual(refused);
    // Outside a `sections` allowlist an unknown SECTION only warns; the underscore rule has no such downgrade.
    expect(
      validateSettingsDoc(
        doc,
        "f.yml",
        SectionSelection.of({ only: ["repository"] })._unsafeUnwrap(),
        io,
      ),
    ).toEqual(refused);
    expect(annotations).toEqual([]);
    expect(
      validateSettingsDoc(
        { _layering: "replace", repository: {} },
        "f.yml",
        SectionSelection.ALL,
        io,
      ).isOk(),
    ).toBe(true);
  });

  test.each<[what: string, doc: unknown, shape: TopLevelShape]>([
    ["a list", [], "list"],
    ["null", null, "null"],
    ["a string", "labels", "string"],
    ["a number", 7, "number"],
  ])("a non-mapping document (%s) is rejected with its shape", (_what, doc, shape) => {
    const { io } = captureIo();
    expect(validateSettingsDoc(doc, "f.yml", SectionSelection.ALL, io)).toEqual(
      err({ code: "settings-not-mapping", source: "f.yml", shape }),
    );
  });

  test.each<[what: string, doc: unknown]>([
    ["a Date", new Date(0)],
    ["a Set", new Set(["a"])],
  ])("a YAML-tagged top-level value (%s) is rejected, never branded", (_what, doc) => {
    // parse("!!timestamp ...") returns a Date, an object with no keys; branding it valid would turn the whole document into a silent green no-op.
    const { io } = captureIo();
    expect(validateSettingsDoc(doc, "f.yml", SectionSelection.ALL, io)).toEqual(
      err({ code: "settings-not-plain-mapping" as const, source: "f.yml" }),
    );
  });

  test("a valid document comes back branded, ready for runForRepo", () => {
    const { io } = captureIo();
    const doc = { repository: { has_wiki: false } };
    // The brand is compile-time only; the value is zod's parsed copy.
    const branded: unknown = validateSettingsDoc(
      doc,
      "s.yml",
      SectionSelection.ALL,
      io,
    )._unsafeUnwrap();
    expect(branded).toEqual(doc);
    expect(branded).not.toBe(doc);
  });
});

describe("preflightProbe", () => {
  test("preflight swallows an ordinary probe error, and the section loop reports it as the section's failure", async () => {
    // A section cannot write during the probe (its port binds reads only), so the only preflight-specific outcome is a denial.
    const failure = "some transient probe failure";
    const planSpy = spyOn(pagesSection, "plan").mockRejectedValue(new Error(failure));
    const api = new MockApi({});
    const repoRef = { owner: "o", name: "r", slug: "o/r" };
    const settings = validated({ pages: { build_type: "workflow" } });
    await expect(preflightProbe(api, repoRef, [pagesSection], settings)).resolves.toEqual([]);
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, opts({ settings }), io);
    expect(result.result).toBe("failed");
    expect(result.outcomes).toEqual([
      { key: "pages", status: "failed", detail: [`pages: ${failure}`] },
    ]);
    expect(annotations).toContain(`error: pages: ${failure}`);
    // The explicit probe, then runForRepo's own preflight, then the section loop.
    expect(planSpy).toHaveBeenCalledTimes(3);
    planSpy.mockRestore();
  });
});

describe("runForRepo plan sections", () => {
  const WORKFLOWS_LIST = "GET /repos/o/r/actions/workflows?per_page=100&page=1";
  const live = {
    total_count: 2,
    workflows: [
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" },
    ],
  };
  const drifting = validated({
    workflows: [
      { path: "ci.yml", state: "disabled" },
      { path: "missing.yml", state: "active" },
    ],
  });

  test("check mode renders the plan as drift and issues zero writes even with drift", async () => {
    // The fake would ACCEPT a write (unroutedMutations: succeed), so a write reaching it would be recorded, not thrown: the zero is the proof.
    const api = new MockApi({ [WORKFLOWS_LIST]: { data: live } }, { unroutedMutations: "succeed" });
    const { io, logs } = captureIo();
    const result = await runForRepo(api, opts({ mode: "check", settings: drifting }), io);
    expect(result.result).toBe("drift");
    expect(result.outcomes).toEqual([
      {
        key: "workflows",
        status: "drift",
        detail: [
          'workflows[ci.yml]: declared "disabled" != live "active"; apply will disable the workflow',
          expect.stringContaining(
            "workflows[missing.yml]: declared in the settings file but no workflow",
          ),
        ],
      },
    ]);
    expect(logs).toEqual([
      'drift: workflows[ci.yml]: declared "disabled" != live "active"; apply will disable the workflow',
      expect.stringMatching(/^drift: workflows\[missing\.yml\]: declared in the settings file/),
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("apply mode executes the plan and surfaces op-less drift as a note", async () => {
    const api = new MockApi({ [WORKFLOWS_LIST]: { data: live } }).allowMutations(
      "PUT /repos/o/r/actions/workflows/*",
    );
    const { io, annotations, logs } = captureIo();
    const result = await runForRepo(api, opts({ settings: drifting }), io);
    expect(result.result).toBe("applied");
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/actions/workflows/1/disable",
    ]);
    expect(logs).toEqual(['workflows: disabled workflow ".github/workflows/ci.yml"']);
    expect(result.outcomes).toEqual([
      {
        key: "workflows",
        status: "applied",
        detail: ['disabled workflow ".github/workflows/ci.yml"'],
      },
    ]);
    expect(annotations).toEqual([
      expect.stringMatching(
        /^notice: workflows: workflows\[missing\.yml\]: declared in the settings file/,
      ),
    ]);
  });

  test("a section's read denial arms the preflight barrier, in the concealed 404 style too", async () => {
    const api = new MockApi({
      [WORKFLOWS_LIST]: { error: { status: 404, message: "Not Found", body: "" } },
    });
    const { io } = captureIo();
    const result = await runForRepo(api, opts({ settings: drifting }), io);
    expect(result.result).toBe("failed");
    expect(result.preflightDenied).toEqual([expect.stringMatching(/^workflows: /)]);
    expect(api.mutations()).toEqual([]);
  });

  test("a failure mid-plan reports the notes and the operations that already applied", async () => {
    // The first change is real (no transactions) and, with the op-less note, must show in the log and the failed outcome instead of vanishing behind
    // the error.
    const api = new MockApi({
      [WORKFLOWS_LIST]: { data: live },
      "PUT /repos/o/r/actions/workflows/1/disable": { data: null },
      "PUT /repos/o/r/actions/workflows/2/enable": {
        error: { status: 422, message: "Unprocessable", body: "" },
      },
    });
    const { io, logs, annotations } = captureIo();
    const result = await runForRepo(
      api,
      opts({
        settings: validated({
          workflows: [
            { path: "ci.yml", state: "disabled" },
            { path: "old.yml", state: "active" },
            { path: "missing.yml", state: "active" },
          ],
        }),
      }),
      io,
    );
    expect(result.result).toBe("failed");
    expect(api.mutations()).toHaveLength(2);
    expect(logs).toEqual(['workflows: disabled workflow ".github/workflows/ci.yml"']);
    expect(annotations).toEqual([
      expect.stringMatching(/^notice: workflows: workflows\[missing\.yml\]/),
      expect.stringContaining("PUT /repos/o/r/actions/workflows/2/enable: 422"),
    ]);
    expect(result.outcomes).toEqual([
      {
        key: "workflows",
        status: "failed",
        detail: [
          expect.stringContaining("workflows[missing.yml]"),
          'disabled workflow ".github/workflows/ci.yml"',
          expect.stringContaining("PUT /repos/o/r/actions/workflows/2/enable: 422"),
        ],
      },
    ]);
  });

  describe("a stubbed plan", () => {
    // A section's plan is stubbed through the erased view so the tests can hand the orchestrator tolerate, facet, and response-rendering ops
    // directly. Declarations are frozen at registration, so a tolerance rides an endpoint that already declares the status: interaction_limits'
    // put and remove both declare 409.
    let stubbed: { mockRestore(): void } | undefined;
    afterEach(() => {
      stubbed?.mockRestore();
    });
    const stub = (section: SectionModule, ...ops: SectionPlan["ops"]) => {
      // A restored spy no longer intercepts, so each test arms its own.
      stubbed = spyOn(section, "plan").mockResolvedValue({
        ops: ops as never,
        notes: [],
        drift: [],
      });
    };
    const disabling = (workflowId: string): SectionPlan["ops"][number] => ({
      role: "disable",
      params: { workflow_id: workflowId },
      drift: [`workflows[${workflowId}]: drifted`],
      change: `disabled workflow ${workflowId}`,
    });
    const tolerating = (
      role: "put" | "remove",
      outcome: (error: { status: number }) => { note: string } | { failure: string },
    ): SectionPlan["ops"][number] => ({
      role,
      params: {},
      drift: ["interaction_limits.limit: drifted"],
      change: `${role} the interaction limit`,
      tolerate: { statuses: [409], outcome },
    });
    const limited = validated({ interaction_limits: { limit: "collaborators_only" } });
    const NOTE = "an organization limit overrides this one, so it was not set (409)";
    const FAILURE = "an organization limit holds (409); clear it first";
    const busy = () =>
      new MockApi({
        "GET /repos/o/r/interaction-limits": { data: {} },
        "PUT /repos/o/r/interaction-limits": {
          error: { status: 409, message: "Conflict", body: "" },
        },
        "DELETE /repos/o/r/interaction-limits": {
          error: { status: 409, message: "Conflict", body: "" },
        },
      });

    test("an unverifiable facet is a check-mode note beside a clean drift list, and apply renders only the change", async () => {
      const REASON = "GitHub never echoes the workflow token back, so check cannot verify it";
      stub(workflowsSection, {
        role: "disable",
        params: { workflow_id: "1" },
        drift: { unverifiable: REASON, lines: [] },
        change: "re-sent the workflow token",
      });
      const checked = captureIo();
      const check = await runForRepo(
        new MockApi({ [WORKFLOWS_LIST]: { data: live } }, { unroutedMutations: "succeed" }),
        opts({ mode: "check", settings: drifting }),
        checked.io,
      );
      expect(check.result).toBe("clean");
      expect(checked.logs).toEqual([]);
      expect(checked.annotations).toEqual([`notice: workflows: ${REASON}`]);
      expect(check.outcomes).toEqual([{ key: "workflows", status: "clean", detail: [REASON] }]);
      const applied = captureIo();
      const api = new MockApi({ [WORKFLOWS_LIST]: { data: live } }).allowMutations(
        "PUT /repos/o/r/actions/workflows/1/disable",
      );
      const apply = await runForRepo(api, opts({ settings: drifting }), applied.io);
      expect(apply.result).toBe("applied");
      expect(api.mutations().map((m) => m.path)).toEqual([
        "/repos/o/r/actions/workflows/1/disable",
      ]);
      expect(applied.annotations).toEqual([]);
      expect(applied.logs).toEqual(["workflows: re-sent the workflow token"]);
    });

    test("a tolerated note reaches the applied outcome's detail and the annotations", async () => {
      stub(
        interactionLimitsSection,
        tolerating("put", (error) => ({
          note: `an organization limit overrides this one, so it was not set (${error.status})`,
        })),
      );
      const { io, annotations, logs } = captureIo();
      const result = await runForRepo(busy(), opts({ settings: limited }), io);
      expect(result.result).toBe("applied");
      expect(logs).toEqual([]);
      expect(annotations).toEqual([`notice: interaction_limits: ${NOTE}`]);
      expect(result.outcomes).toEqual([
        { key: "interaction_limits", status: "applied", detail: [NOTE] },
      ]);
    });

    test("a tolerated note survives a failure, beside the outcome's own failure text", async () => {
      stub(
        interactionLimitsSection,
        tolerating("put", () => ({ note: NOTE })),
        tolerating("remove", () => ({ failure: FAILURE })),
      );
      const { io, annotations } = captureIo();
      const result = await runForRepo(busy(), opts({ settings: limited }), io);
      expect(result.result).toBe("failed");
      // Both requests were refused, so nothing landed and no partial-mutation suffix renders.
      expect(annotations).toEqual([
        `notice: interaction_limits: ${NOTE}`,
        `error: interaction_limits: ${FAILURE}`,
      ]);
      expect(result.outcomes).toEqual([
        {
          key: "interaction_limits",
          status: "failed",
          detail: [NOTE, `interaction_limits: ${FAILURE}`],
        },
      ]);
    });

    test("a change thunk failing after its request landed reports a partial mutation, not a clean failure", async () => {
      // The PUT landed, then the thunk threw: the repository changed, and the failure must say so instead of reading as "nothing was written".
      stub(workflowsSection, {
        ...disabling("1"),
        change: () => {
          throw new Error("the echo still reads active");
        },
      });
      const api = new MockApi({ [WORKFLOWS_LIST]: { data: live } }).allowMutations(
        "PUT /repos/o/r/actions/workflows/1/disable",
      );
      const { io, annotations, logs } = captureIo();
      const result = await runForRepo(api, opts({ settings: drifting }), io);
      expect(result.result).toBe("failed");
      expect(api.mutations()).toHaveLength(1);
      expect(logs).toEqual([]);
      const partial =
        "error: workflows: the echo still reads active (1 request landed before this failure, so the repository is partially applied)";
      expect(annotations).toEqual([partial]);
      expect(result.outcomes).toEqual([
        { key: "workflows", status: "failed", detail: [partial.slice("error: ".length)] },
      ]);
    });
  });

  test("a denial after an operation landed fails the run even under the warn policy", async () => {
    // A skip would claim the repository was left alone; it was not, so the policy cannot soften it.
    const api = new MockApi({
      [WORKFLOWS_LIST]: { data: live },
      "PUT /repos/o/r/actions/workflows/1/disable": { data: null },
      "PUT /repos/o/r/actions/workflows/2/enable": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, annotations, logs } = captureIo();
    const result = await runForRepo(
      api,
      opts({
        onMissingPermission: "warn",
        settings: validated({
          workflows: [
            { path: "ci.yml", state: "disabled" },
            { path: "old.yml", state: "active" },
          ],
        }),
      }),
      io,
    );
    expect(result.result).toBe("failed");
    expect(skippedSectionKeys(result.outcomes)).toEqual([]);
    expect(logs).toEqual(['workflows: disabled workflow ".github/workflows/ci.yml"']);
    expect(annotations).toEqual([
      expect.stringMatching(
        /^error: workflows: partially applied \(1 request landed before the denial/,
      ),
    ]);
    expect(result.outcomes).toEqual([
      {
        key: "workflows",
        status: "failed",
        detail: [
          'disabled workflow ".github/workflows/ci.yml"',
          expect.stringContaining("PUT /repos/o/r/actions/workflows/2/enable"),
        ],
        httpStatus: 403,
      },
    ]);
    // The control: the same denial with NOTHING landed is still a skip.
    const untouched = new MockApi({
      [WORKFLOWS_LIST]: { data: live },
      "PUT /repos/o/r/actions/workflows/1/disable": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const skipped = await runForRepo(
      untouched,
      opts({
        onMissingPermission: "warn",
        settings: validated({ workflows: [{ path: "ci.yml", state: "disabled" }] }),
      }),
      captureIo().io,
    );
    expect(skipped.result).toBe("partial");
    expect(skippedSectionKeys(skipped.outcomes)).toEqual(["workflows"]);
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  preflightProbe,
  type RepoRunOptions,
  runForRepo,
  skippedSectionKeys,
  type ValidatedSettings,
  validateSettingsDoc,
  worstOf,
} from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { maskRegistry, prefixedIo } from "../../src/io.js";
import type { SettingsFile } from "../../src/schema.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import type { SectionPlan } from "../../src/sections/contract/plan.js";
import { pagesSection } from "../../src/sections/pages/index.js";
import { rulesetsSection } from "../../src/sections/rulesets/index.js";
import { workflowsSection } from "../../src/sections/workflows/index.js";
import { MockApi } from "../mock-api.js";

function captureIo(): { io: Io; annotations: string[]; logs: string[]; masked: string[] } {
  const annotations: string[] = [];
  const logs: string[] = [];
  const masked: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: (line) => logs.push(line),
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry((value) => masked.push(value)),
    },
    annotations,
    logs,
    masked,
  };
}

/**
 * Brand test fixtures through the REAL boundary: an invalid fixture fails
 * here instead of riding a cast into runForRepo.
 */
function validated(doc: SettingsFile): ValidatedSettings {
  const silent: Io = {
    annotate: () => {},
    log: () => {},
    debug: () => {},
    summary: () => {},
    output: () => {},
    ...maskRegistry(() => {}),
  };
  const verdict = validateSettingsDoc(doc, "test fixture", new Set(), silent);
  if ("error" in verdict) {
    throw new Error(`test fixture failed validation: ${verdict.error}`);
  }
  return verdict.settings;
}

function opts(overrides: Partial<RepoRunOptions> = {}): RepoRunOptions {
  return {
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: validated({ repository: { has_wiki: false } }),
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    requiredSections: new Set(),
    onlySections: new Set(),
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

  test("check mode reports drift, prefixed through prefixedIo", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: { has_wiki: true } },
    });
    const { io, logs } = captureIo();
    const result = await runForRepo(api, opts({ mode: "check" }), prefixedIo(io, "o/r: "));
    expect(result.result).toBe("drift");
    expect(logs[0]).toStartWith("o/r: drift: repository.has_wiki");
  });

  /**
   * Run one section with its plan() stubbed to record the declared value it
   * receives; the recorded values are the preflight probe's and the apply
   * pass's, in that order.
   */
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
    // JSON.parse creates "__proto__" as an OWN key; the control proves the raw
    // document carries it at every level before the hand-off is tested.
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
    // The deliberate residual: the shape describes no node under `extra`, so
    // the value rides by reference and reaches GitHub as written, as it
    // always has.
    expect(desired.extra).toBe(raw.pages.extra);
  });

  test("a knobbed list section receives zod's parsed copy in both forms: own __proto__ dropped on the list and each entry, rejected on the strict wrapper", async () => {
    const plain = JSON.parse('{"rulesets":[{"name":"r","__proto__":{"planted":1}}]}');
    const wrapped = JSON.parse(
      '{"rulesets":{"undeclared":"keep","entries":[{"name":"r","__proto__":{"planted":1}}]}}',
    );
    expect(Object.hasOwn(plain.rulesets[0], "__proto__")).toBe(true);
    expect(Object.hasOwn(wrapped.rulesets.entries[0], "__proto__")).toBe(true);

    const [plainDesired] = (await receivedBy(rulesetsSection, plain)) as [object[]];
    expect(plainDesired).not.toBe(plain.rulesets);
    expect(plainDesired).toEqual([{ name: "r" }]);
    prototypeClean(plainDesired[0] as object);

    const [wrappedDesired] = (await receivedBy(rulesetsSection, wrapped)) as [
      { undeclared: string; entries: object[] },
    ];
    expect(wrappedDesired).not.toBe(wrapped.rulesets);
    expect(wrappedDesired).toEqual({ undeclared: "keep", entries: [{ name: "r" }] });
    prototypeClean(wrappedDesired);
    prototypeClean(wrappedDesired.entries[0] as object);

    // The wrapper is this action's own strict vocabulary, so an own
    // "__proto__" there is an unrecognized key and fails validation upfront.
    const polluted = JSON.parse(
      '{"rulesets":{"entries":[{"name":"r"}],"__proto__":{"planted":2}}}',
    );
    const verdict = validateSettingsDoc(polluted, "s.yml", new Set(), captureIo().io);
    expect("error" in verdict ? verdict.error : "").toContain(
      'rulesets: Unrecognized key: "__proto__"',
    );
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
    const { io, masked } = captureIo();
    const mutationsAtMaskTime: number[] = [];
    const trackingIo: Io = {
      ...io,
      ...maskRegistry((value) => {
        mutationsAtMaskTime.push(api.mutations().length);
        io.mask(value);
      }),
    };
    const result = await runForRepo(
      api,
      opts({
        settings: webhookSettings("$WEBHOOK_SECRET"),
        secretEnv: { WEBHOOK_SECRET: "s3cret-plaintext" },
      }),
      trackingIo,
    );
    expect(result.result).toBe("applied");
    // The plaintext was registered with masking BEFORE any write left the client.
    expect(masked).toEqual(["s3cret-plaintext"]);
    expect(mutationsAtMaskTime).toEqual([0]);
    // ...and the handler sent the resolved plaintext, not the reference.
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

  test("a target-sourced reference is refused in both modes", async () => {
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const result = await runForRepo(
      api,
      opts({
        settings: webhookSettings("$WEBHOOK_SECRET"),
        secretSource: () => "target",
        secretEnv: { WEBHOOK_SECRET: "present-but-irrelevant" },
      }),
      io,
    );
    expect(result.result).toBe("failed");
    expect(api.calls).toEqual([]);
    expect(annotations.some((a) => a.includes("target-fetched settings file"))).toBe(true);
  });

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
        onlySections: new Set(["repository"]),
      }),
      io,
    );
    expect(result.result).toBe("applied");
  });
});

describe("validateSettingsDoc", () => {
  const errorOf = (verdict: ReturnType<typeof validateSettingsDoc>): string =>
    "error" in verdict ? verdict.error : "";

  test("unknown top-level keys are errors naming the source", () => {
    const { io } = captureIo();
    const err = errorOf(validateSettingsDoc({ labls: [] }, "repos/x.yml", new Set(), io));
    expect(err).toContain("repos/x.yml");
    expect(err).toContain("labls");
  });

  test("non-mapping documents are rejected", () => {
    const { io } = captureIo();
    expect(errorOf(validateSettingsDoc([], "f.yml", new Set(), io))).toContain("a list");
  });

  test("a YAML-tagged top-level value (a Date) is rejected, never branded", () => {
    // parse("!!timestamp ...") returns a Date - an object with no keys - and
    // branding it valid would turn the whole document into a silent green
    // no-op. Only a plain-prototype mapping may pass the boundary.
    const { io } = captureIo();
    const err = errorOf(validateSettingsDoc(new Date(0), "f.yml", new Set(), io));
    expect(err).toContain("plain YAML mapping");
    expect(err).toContain("!!timestamp");
    expect(errorOf(validateSettingsDoc(new Set(["a"]), "f.yml", new Set(), io))).toContain(
      "plain YAML mapping",
    );
  });

  test("a valid document comes back branded, ready for runForRepo", () => {
    const { io } = captureIo();
    const doc = { repository: { has_wiki: false } };
    const verdict = validateSettingsDoc(doc, "s.yml", new Set(), io);
    if ("error" in verdict) {
      throw new Error(`expected the document to validate: ${verdict.error}`);
    }
    // The brand is compile-time only; the value is zod's parsed copy.
    const branded: unknown = verdict.settings;
    expect(branded).toEqual(doc);
    expect(branded).not.toBe(doc);
  });
});

describe("worstOf", () => {
  test("failed outranks everything; clean is the floor in check mode", () => {
    expect(worstOf([{ result: "clean" }, { result: "failed" }, { result: "drift" }], true)).toBe(
      "failed",
    );
    expect(worstOf([{ result: "clean" }, { result: "drift" }], true)).toBe("drift");
    expect(worstOf([], true)).toBe("clean");
    expect(worstOf([], false)).toBe("applied");
  });
});

describe("preflightProbe", () => {
  test("preflight swallows an ordinary probe error, and the section loop reports it as the section's failure", async () => {
    // A section cannot write during the probe (its port binds reads only), so the only
    // preflight-specific outcome is a denial; any other failure is left to the section loop.
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
  // workflows is the plan-contract section: the engine plans it in both
  // modes and only apply executes, so these are the engine-level twins of
  // the section's own plan() tests.
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
    // The fake would ACCEPT a write (unroutedMutations: succeed), so a write
    // reaching it would be recorded, not thrown: the zero below is the proof.
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
    expect(logs.filter((line) => line.startsWith("drift: "))).toHaveLength(2);
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

  test("a section's read denial arms the preflight barrier", async () => {
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
    // Two PUTs planned, the second rejected, plus an op-less finding: the
    // first change is real (no transactions) and, with the note, must show
    // in the log and the failed outcome instead of vanishing behind the error.
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
    // No registered plan section tolerates a status or renders from the
    // response yet, so the workflows plan is stubbed through the erased view.
    let stubbed: ReturnType<typeof spyOn<typeof workflowsSection, "plan">> | undefined;
    const disable = workflowsSection.endpoints.disable;
    afterEach(() => {
      stubbed?.mockRestore();
      (workflowsSection.endpoints as Record<string, EndpointDecl>).disable = disable;
    });
    const stub = (...ops: SectionPlan["ops"]) => {
      // A restored spy no longer intercepts, so each test arms its own.
      stubbed = spyOn(workflowsSection, "plan").mockResolvedValue({
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
      workflowId: string,
      outcome: (error: { status: number }) => { note: string } | { failure: string },
    ): SectionPlan["ops"][number] => {
      // The tolerance must be declared: the disable endpoint gains a 409.
      (workflowsSection.endpoints as Record<string, EndpointDecl>).disable = {
        ...disable,
        statuses: { ...disable.statuses, 409: "a run holds the workflow" },
      };
      return { ...disabling(workflowId), tolerate: { statuses: [409], outcome } };
    };
    const NOTE = "a run holds ci.yml, so it was not disabled (409)";
    const FAILURE = "old.yml is busy (409); re-run after it finishes";
    const busy = () =>
      new MockApi({
        [WORKFLOWS_LIST]: { data: live },
        "PUT /repos/o/r/actions/workflows/*": {
          error: { status: 409, message: "Conflict", body: "" },
        },
      });

    test("an unverifiable facet is a check-mode note beside a clean drift list, and apply renders only the change", async () => {
      const REASON = "GitHub never echoes the workflow token back, so check cannot verify it";
      stub({
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
        tolerating("1", (error) => ({
          note: `a run holds ci.yml, so it was not disabled (${error.status})`,
        })),
      );
      const { io, annotations, logs } = captureIo();
      const result = await runForRepo(busy(), opts({ settings: drifting }), io);
      expect(result.result).toBe("applied");
      expect(logs).toEqual([]);
      expect(annotations).toEqual([`notice: workflows: ${NOTE}`]);
      expect(result.outcomes).toEqual([{ key: "workflows", status: "applied", detail: [NOTE] }]);
    });

    test("a tolerated note survives a failure, beside the outcome's own failure text", async () => {
      stub(
        tolerating("1", () => ({ note: NOTE })),
        tolerating("2", () => ({ failure: FAILURE })),
      );
      const { io, annotations } = captureIo();
      const result = await runForRepo(busy(), opts({ settings: drifting }), io);
      expect(result.result).toBe("failed");
      // Both requests were refused, so nothing landed and no partial-mutation suffix renders.
      expect(annotations).toEqual([`notice: workflows: ${NOTE}`, `error: workflows: ${FAILURE}`]);
      expect(result.outcomes).toEqual([
        { key: "workflows", status: "failed", detail: [NOTE, `workflows: ${FAILURE}`] },
      ]);
    });

    test("a change thunk failing after its request landed reports a partial mutation, not a clean failure", async () => {
      // The first operation's PUT is accepted, then its thunk throws: no
      // change line rendered, but the repository changed, and the failure
      // must say so instead of reading as "nothing was written".
      stub({
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
        "error: workflows: the echo still reads active (1 request(s) landed before this failure, so the repository is partially applied)";
      expect(annotations).toEqual([partial]);
      expect(result.outcomes).toEqual([
        { key: "workflows", status: "failed", detail: [partial.slice("error: ".length)] },
      ]);
    });
  });

  test("a denial after an operation landed fails the run even under the warn policy", async () => {
    // The first PUT succeeds and the second is denied. A skip would claim the
    // repository was left alone; it was not, so the policy cannot soften it.
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
        /^error: workflows: partially applied \(1 request\(s\) landed before the denial/,
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

import { describe, expect, test } from "bun:test";

import {
  preflightProbe,
  readOnlyClient,
  runForRepo,
  skippedSectionKeys,
  validateSettingsDoc,
  worstOf,
} from "../../src/engine/orchestrate.js";
import type { GithubClient } from "../../src/github/api.js";
import type { Io } from "../../src/io.js";
import { prefixedIo } from "../../src/io.js";
import type { SettingsFile } from "../../src/schema.js";
import type { SECTIONS } from "../../src/sections/registry.js";
import { MockApi } from "../mock-api.js";

function captureIo(): { io: Io; annotations: string[]; logs: string[]; masked: string[] } {
  const annotations: string[] = [];
  const logs: string[] = [];
  const masked: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: (line) => logs.push(line),
      mask: (value) => masked.push(value),
    },
    annotations,
    logs,
    masked,
  };
}

function opts(overrides: Partial<Parameters<typeof runForRepo>[1]> = {}) {
  return {
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: { repository: { has_wiki: false } } as SettingsFile,
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    requiredSections: new Set<string>(),
    onlySections: new Set<string>(),
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

  test("pages: null is an active section, not an omitted one", async () => {
    const api = new MockApi({
      "GET /repos/o/r/pages": { data: { build_type: "legacy" } },
    });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      opts({ mode: "check", settings: { pages: null } as SettingsFile }),
      io,
    );
    expect(result.result).toBe("drift");
    expect(result.outcomes.map((o) => o.key)).toEqual(["pages"]);
  });
});

describe("runForRepo secret references", () => {
  const HOOKS_LIST = "GET /repos/o/r/hooks?per_page=100&page=1";
  const webhookSettings = (secret: string): SettingsFile =>
    ({
      webhooks: [{ config: { url: "https://x.test/h", secret } }],
    }) as SettingsFile;

  test("apply resolves up front, masks before the first mutation, and hands handlers plaintext", async () => {
    const api = new MockApi({ [HOOKS_LIST]: { data: [] } }).allowMutations("POST /repos/o/r/hooks");
    const { io, masked } = captureIo();
    const mutationsAtMaskTime: number[] = [];
    const trackingIo: Io = {
      ...io,
      mask: (value) => {
        mutationsAtMaskTime.push(api.mutations().length);
        io.mask(value);
      },
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
        settings: {
          ...webhookSettings("a-literal-that-would-fail"),
          repository: { has_wiki: false },
        } as SettingsFile,
        onlySections: new Set(["repository"]),
      }),
      io,
    );
    expect(result.result).toBe("applied");
  });
});

describe("validateSettingsDoc", () => {
  test("unknown top-level keys are errors naming the source", () => {
    const { io } = captureIo();
    const err = validateSettingsDoc({ labls: [] }, "repos/x.yml", new Set(), io);
    expect(err).toContain("repos/x.yml");
    expect(err).toContain("labls");
  });

  test("non-mapping documents are rejected", () => {
    const { io } = captureIo();
    expect(validateSettingsDoc([], "f.yml", new Set(), io)).toContain("a list");
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

describe("readOnlyClient", () => {
  const READ_OP = {
    name: "RepoToggles",
    kind: "read",
    query: "query RepoToggles { viewer { login } }",
  } as const;
  const WRITE_OP = {
    name: "UpdateToggles",
    kind: "write",
    query: "mutation UpdateToggles { x }",
  } as const;

  test("GETs and GraphQL reads pass through to the wrapped client", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { data: { ok: true } },
      "GRAPHQL RepoToggles": { data: { viewer: { login: "bot" } } },
    });
    const probe = readOnlyClient(api);
    expect(await probe.tryRequest("GET", "/repos/o/r")).toEqual({ data: { ok: true } });
    expect(await probe.tryGraphql(READ_OP, {}, "o/r")).toEqual({
      data: { viewer: { login: "bot" } },
    });
    expect(api.calls).toHaveLength(2);
  });

  test("a non-GET REST request throws before reaching the wire", () => {
    const api = new MockApi({}, { unroutedMutations: "succeed" });
    const probe = readOnlyClient(api);
    expect(() => probe.tryRequest("PATCH", "/repos/o/r", {})).toThrow(
      /PATCH \/repos\/o\/r was attempted in check mode.*read-only in check mode/,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("a GraphQL write throws before reaching the wire", () => {
    const api = new MockApi({}, { unroutedMutations: "succeed" });
    const probe = readOnlyClient(api);
    expect(() => probe.tryGraphql(WRITE_OP, {}, "o/r")).toThrow(
      /GRAPHQL UpdateToggles \(a write operation\) was attempted in check mode.*read-only/,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("preflight rethrows a probe write attempt instead of swallowing it", async () => {
    // A section handler that writes during the read-only probe is a bug the
    // APPLY pass can never resurface (the same write is legitimate there),
    // so preflightProbe must fail the run loudly - unlike ordinary probe
    // errors, which it ignores. Driven through a synthetic section via the
    // injectable `active` list.
    const api = new MockApi({}, { unroutedMutations: "succeed" });
    const buggySection = {
      key: "repository",
      permission: { repo: ["administration"] },
      endpoints: {},
      undeclaredDefault: "untouched",
      shape: { safeParse: () => ({ success: true }) },
      async run(ctx: { api: GithubClient }) {
        await ctx.api.tryRequest("PATCH", "/repos/o/r", { has_wiki: false });
        return { changes: [], drift: [], notes: [] };
      },
    } as unknown as (typeof SECTIONS)[number];
    const repoRef = { owner: "o", name: "r", slug: "o/r" };
    await expect(
      preflightProbe(api, repoRef, [buggySection], { repository: {} } as SettingsFile),
    ).rejects.toThrow(/preflight: repository: PATCH \/repos\/o\/r was attempted in check mode/);
    // An ordinary probe error is still swallowed (the apply pass surfaces it).
    const throwingSection = {
      ...buggySection,
      async run() {
        throw new Error("some transient probe failure");
      },
    } as unknown as (typeof SECTIONS)[number];
    await expect(
      preflightProbe(api, repoRef, [throwingSection], { repository: {} } as SettingsFile),
    ).resolves.toEqual([]);
  });

  test("runForRepo's check-mode context refuses writes end to end", async () => {
    // The real registry never writes in check mode (check-purity.test.ts),
    // so the wrap is observable only through a read still passing: the run
    // completes clean/drift with zero mutations on the wire.
    const api = new MockApi({ "GET /repos/o/r": { data: { description: "live" } } });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      opts({ mode: "check", settings: { repository: { description: "live" } } as SettingsFile }),
      io,
    );
    expect(result.result).toBe("clean");
    expect(api.mutations()).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";

import { runForRepo, validateSettingsDoc, worstOf } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { prefixedIo } from "../../src/io.js";
import type { SettingsFile } from "../../src/schema.js";
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
    repo: "o/r",
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
    expect(result.skippedSections).toEqual(["repository"]);
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

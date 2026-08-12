import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { webhooksSection } from "./index.js";
import type { WebhookConfig } from "./schema.js";

const LIST = "GET /repos/o/r/hooks?per_page=100&page=1";

/** A live hook body as the mock list returns it (GET shape, secret echoed). */
function liveHook(
  id: number,
  url: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "web",
    active: true,
    events: ["push"],
    config: { url, content_type: "json" },
    ...overrides,
  };
}

/** An apply-mode context whose resolver serves one fixed secret. */
function applyCtx(api: MockApi, resolved: Record<string, string> = {}) {
  return {
    ...ctx(api),
    resolveSecret: (reference: string): string => {
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

describe("webhooks shape", () => {
  test("an entry-level secret is rejected, pointing at config.secret", () => {
    // The misplacement would otherwise pass the loose shape, ship the raw
    // reference text verbatim, and create a silently unauthenticated hook.
    const result = webhooksSection.shape.safeParse([
      { config: { url: "https://t.test/h" }, secret: "$HOOK_SECRET" },
    ]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("config.secret");
  });

  test("a name other than 'web' is rejected upfront", () => {
    const error = validateSectionShapes(
      { webhooks: [{ name: "email", config: { url: "https://x.test/h" } }] },
      "settings.yml",
    );
    expect(error).toContain("webhooks[0].name");
  });

  test("name 'web' and an omitted name both parse, in both knob forms", () => {
    expect(
      validateSectionShapes(
        { webhooks: [{ name: "web", config: { url: "https://x.test/h" } }] },
        "s.yml",
      ),
    ).toBeNull();
    expect(
      validateSectionShapes(
        { webhooks: { undeclared: "delete", entries: [{ config: { url: "https://x.test/h" } }] } },
        "s.yml",
      ),
    ).toBeNull();
  });

  test("a missing config is rejected with its path", () => {
    const error = validateSectionShapes({ webhooks: [{ events: ["push"] }] }, "s.yml");
    expect(error).toContain("webhooks[0].config");
  });
});

describe("webhooks secretValues", () => {
  test("extracts every declared config.secret, in both knob forms", () => {
    expect(
      webhooksSection.secretValues?.([
        { config: { url: "https://a.test", secret: "$A" } },
        { config: { url: "https://b.test" } },
      ]),
    ).toEqual([{ label: 'the webhook "https://a.test" config.secret', value: "$A" }]);
    expect(
      webhooksSection.secretValues?.({
        undeclared: "keep",
        entries: [{ config: { url: "https://a.test", secret: "$B" } }],
      }),
    ).toEqual([{ label: 'the webhook "https://a.test" config.secret', value: "$B" }]);
  });

  test("malformed containers return [] and leave the error to validation", () => {
    // The extractor's contract is defensiveness: it can face any merged
    // value, so a malformed declaration must not throw here - validation is
    // where the user gets the actionable message.
    for (const malformed of [null, "hooks", 42, { undeclared: "keep" }, [null, "x"]]) {
      // The double cast feeds the extractor a PRE-VALIDATION value on purpose.
      expect(webhooksSection.secretValues?.(malformed as unknown as WebhookConfig[])).toEqual([]);
    }
  });
});

describe("webhooks apply", () => {
  test("creates a missing hook with the resolved secret in the POST config", async () => {
    const api = new MockApi({ [LIST]: { data: [] } }).allowMutations("POST /repos/o/r/hooks");
    const result = await webhooksSection.run(applyCtx(api, { $HOOK: "plain-secret" }), [
      {
        config: { url: "https://x.test/h", content_type: "json", secret: "$HOOK" },
        events: ["push"],
        active: true,
      },
    ]);
    expect(result.changes).toEqual(['created webhook "https://x.test/h"']);
    const post = api.mutations()[0];
    expect(post?.path).toBe("/repos/o/r/hooks");
    expect(post?.payload).toEqual({
      name: "web",
      config: { url: "https://x.test/h", content_type: "json", secret: "plain-secret" },
      events: ["push"],
      active: true,
    });
  });

  test("a declared secret forces the config PATCH every run, even with zero drift", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [liveHook(7, "https://x.test/h", { config: { url: "https://x.test/h" } })],
      },
    }).allowMutations("PATCH /repos/o/r/hooks/7/config");
    const result = await webhooksSection.run(applyCtx(api, { $HOOK: "rotated" }), [
      { config: { url: "https://x.test/h", secret: "$HOOK" } },
    ]);
    expect(api.mutations()).toHaveLength(1);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/hooks/7/config");
    expect(api.mutations()[0]?.payload).toEqual({ url: "https://x.test/h", secret: "rotated" });
    expect(result.changes).toEqual([
      'updated webhook "https://x.test/h" config (the declared secret is re-sent every run)',
    ]);
  });

  test("config drift without a secret goes through the config sub-endpoint only", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(3, "https://x.test/h")] }, // live content_type json
    }).allowMutations("PATCH /repos/o/r/hooks/3/config");
    const result = await webhooksSection.run(applyCtx(api), [
      { config: { url: "https://x.test/h", content_type: "form" } },
    ]);
    expect(api.mutations().map((m) => m.path)).toEqual(["/repos/o/r/hooks/3/config"]);
    expect(api.mutations()[0]?.payload).toEqual({ url: "https://x.test/h", content_type: "form" });
    expect(result.changes).toEqual(['updated webhook "https://x.test/h" config']);
  });

  test("events/active drift goes through the general PATCH with NO config key", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(4, "https://x.test/h", { active: true, events: ["push"] })] },
    }).allowMutations("PATCH /repos/o/r/hooks/4");
    const result = await webhooksSection.run(applyCtx(api), [
      {
        config: { url: "https://x.test/h", content_type: "json" },
        events: ["push", "release"],
        active: false,
      },
    ]);
    expect(api.mutations().map((m) => m.path)).toEqual(["/repos/o/r/hooks/4"]);
    const payload = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(payload).toEqual({ events: ["push", "release"], active: false });
    expect("config" in payload).toBe(false);
    expect(result.changes).toEqual(['updated webhook "https://x.test/h"']);
  });

  test("insecure_ssl number vs string never drifts", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          liveHook(6, "https://x.test/h", {
            config: { url: "https://x.test/h", content_type: "json", insecure_ssl: "0" },
          }),
        ],
      },
    });
    const result = await webhooksSection.run(applyCtx(api), [
      { config: { url: "https://x.test/h", content_type: "json", insecure_ssl: 0 } },
    ]);
    expect(api.mutations()).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  test("a changed config.url is a new identity: create plus a kept undeclared note", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(8, "https://old.test/h")] },
    }).allowMutations("POST /repos/o/r/hooks");
    const result = await webhooksSection.run(applyCtx(api), [
      { config: { url: "https://new.test/h" } },
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(["POST /repos/o/r/hooks"]);
    expect(result.changes).toEqual(['created webhook "https://new.test/h"']);
    expect(result.notes[0]).toContain('webhook "https://old.test/h" exists on the repo');
    expect(result.notes[0]).toContain('"undeclared: keep"');
  });

  test("undeclared: delete removes undeclared hooks", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(9, "https://stray.test/h")] },
    }).allowMutations("DELETE /repos/o/r/hooks/9");
    const result = await webhooksSection.run(applyCtx(api), {
      undeclared: "delete",
      entries: [],
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/hooks/9",
    ]);
    expect(result.changes).toEqual(['DELETED undeclared webhook "https://stray.test/h"']);
  });

  test("a declared url matching several live hooks fails loudly, naming their ids", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(11, "https://x.test/h"), liveHook(12, "https://x.test/h")] },
    });
    await expect(
      webhooksSection.run(applyCtx(api), [{ config: { url: "https://x.test/h" } }]),
    ).rejects.toThrow(/matches 2 live hooks \(ids 11, 12\)/);
    expect(api.mutations()).toEqual([]);
  });

  test("ambiguity fails BEFORE any write, even when an earlier entry would create", async () => {
    // The regression the pre-scan exists for: a missing url declared BEFORE
    // the ambiguous one would have been POSTed by a mid-loop error. POST is
    // permitted here so a partial write would show, and zero mutations
    // proves the scan runs first.
    const api = new MockApi({
      [LIST]: { data: [liveHook(11, "https://dup.test/h"), liveHook(12, "https://dup.test/h")] },
    }).allowMutations("POST /repos/o/r/hooks");
    await expect(
      webhooksSection.run(applyCtx(api), [
        { config: { url: "https://new.test/h" } },
        { config: { url: "https://dup.test/h" } },
      ]),
    ).rejects.toThrow(/matches 2 live hooks/);
    expect(api.mutations()).toEqual([]);
  });

  test("check mode reports the same ambiguity error, writing nothing", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(11, "https://dup.test/h"), liveHook(12, "https://dup.test/h")] },
    });
    await expect(
      webhooksSection.run(ctx(api, true), [
        { config: { url: "https://new.test/h" } },
        { config: { url: "https://dup.test/h" } },
      ]),
    ).rejects.toThrow(/matches 2 live hooks/);
    expect(api.mutations()).toEqual([]);
  });

  test("two declared entries with the same url are rejected before any call", async () => {
    const api = new MockApi({});
    await expect(
      webhooksSection.run(applyCtx(api), [
        { config: { url: "https://x.test/h" } },
        { config: { url: "https://x.test/h" } },
      ]),
    ).rejects.toThrow(/Keep exactly one entry per resource/);
    expect(api.calls).toEqual([]);
  });
});

describe("webhooks check", () => {
  test("the secret never enters the diff and yields a cannot-verify note", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          liveHook(20, "https://x.test/h", {
            config: { url: "https://x.test/h", content_type: "json", secret: "********" },
          }),
        ],
      },
    });
    const result = await webhooksSection.run(ctx(api, true), [
      { config: { url: "https://x.test/h", content_type: "json", secret: "$HOOK" } },
    ]);
    // "$HOOK" vs "********" would be drift if the secret were compared.
    expect(result.drift).toEqual([]);
    expect(result.notes).toEqual([
      `webhooks["https://x.test/h"].config.secret: GitHub never reveals a webhook secret (reads echo "********"), so the declared value cannot be verified; apply re-sends it on every run so rotations propagate`,
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("events order never drifts; a real events difference does", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [liveHook(21, "https://x.test/h", { events: ["release", "push"] })],
      },
    });
    const clean = await webhooksSection.run(ctx(api, true), [
      { config: { url: "https://x.test/h", content_type: "json" }, events: ["push", "release"] },
    ]);
    expect(clean.drift).toEqual([]);
    const drifted = await webhooksSection.run(ctx(api, true), [
      { config: { url: "https://x.test/h", content_type: "json" }, events: ["push", "issues"] },
    ]);
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift?.[0]).toContain("order-insensitively");
  });

  test("a missing declared hook is drift; an undeclared live hook under delete is drift", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveHook(22, "https://stray.test/h")] },
    });
    const result = await webhooksSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [{ config: { url: "https://x.test/h" } }],
    });
    expect(result.drift).toEqual([
      `webhooks["https://x.test/h"]: missing - declared in the settings file but not on the repo; apply will create it`,
      `webhooks["https://stray.test/h"]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it`,
    ]);
    expect(api.mutations()).toEqual([]);
  });
});

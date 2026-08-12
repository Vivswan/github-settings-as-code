import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { deployKeysSection, normalizeKeyMaterial } from "./index.js";

const LIST = "GET /repos/o/r/keys?per_page=100&page=1";

/** A live GET-shape key body; stored material carries no comment, like GitHub. */
function liveKey(id: number, title: string, key: string, read_only = false) {
  return { id, title, key, read_only, verified: true, created_at: "2026-01-01T00:00:00Z" };
}

const BOT_KEY = "ssh-ed25519 AAAAC3botblob";
const MIRROR_KEY = "ssh-ed25519 AAAAC3mirrorblob";

describe("normalizeKeyMaterial", () => {
  test("strips the trailing comment, keeping algorithm + blob", () => {
    expect(normalizeKeyMaterial("ssh-ed25519 AAAAC3blob deploy@host")).toBe(
      "ssh-ed25519 AAAAC3blob",
    );
    // A multi-word comment is stripped whole, and surrounding whitespace is
    // irrelevant to the compared material.
    expect(normalizeKeyMaterial("  ssh-rsa AAAAB3blob a b c  ")).toBe("ssh-rsa AAAAB3blob");
  });

  test("comment-free material normalizes to itself", () => {
    expect(normalizeKeyMaterial("ssh-ed25519 AAAAC3blob")).toBe("ssh-ed25519 AAAAC3blob");
  });

  test("sub-two-field material yields null, never a truncated compare", () => {
    expect(normalizeKeyMaterial("ssh-ed25519")).toBeNull();
    expect(normalizeKeyMaterial("")).toBeNull();
    expect(normalizeKeyMaterial("   ")).toBeNull();
  });
});

describe("deploy_keys validation before any write", () => {
  test("a malformed declared key is a settings-file error, before any API call", async () => {
    const api = new MockApi({});
    await expect(
      deployKeysSection.run(ctx(api), [{ title: "deploy-bot", key: "ssh-ed25519" }]),
    ).rejects.toThrow(
      /deploy_keys\[deploy-bot\]: the declared key must have at least two whitespace-separated fields/,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("duplicate declared titles are rejected upfront with zero calls", async () => {
    const api = new MockApi({});
    await expect(
      deployKeysSection.run(ctx(api), [
        { title: "deploy-bot", key: BOT_KEY },
        { title: "deploy-bot", key: MIRROR_KEY },
      ]),
    ).rejects.toThrow(/same deploy_keys entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("duplicate declared MATERIAL under different titles is rejected upfront with zero calls", async () => {
    // GitHub attaches a public key to one repository once, so the second
    // POST would 422 mid-section; the conflict is two lines apart in the
    // settings file and must be named there, before the list read.
    const api = new MockApi({});
    await expect(
      deployKeysSection.run(ctx(api), [
        { title: "deploy-bot", key: `${BOT_KEY} deploy@bot` },
        { title: "mirror-pull", key: `${BOT_KEY} mirror@other-comment` },
      ]),
    ).rejects.toThrow(/same deploy_keys entry.*"deploy-bot" and "mirror-pull"/s);
    expect(api.calls).toHaveLength(0);
  });

  test("declared material a live key holds under ANOTHER title fails loudly naming it (keep default), zero writes", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(7, "old-name", BOT_KEY)] },
    });
    await expect(
      deployKeysSection.run(ctx(api), [{ title: "new-name", key: `${BOT_KEY} deploy@renamed` }]),
    ).rejects.toThrow(
      /the entry "new-name" declares key material that live key "old-name" \(id 7\) already holds.*declare the entry under its live title "old-name"/,
    );
    expect(api.mutations()).toEqual([]);
  });

  test("the cross-title conflict also fails under wrapped undeclared:delete, zero writes", async () => {
    // Ordering cannot save this policy either: the create runs before the
    // undeclared-delete pass, so the holder would still be live at POST time.
    const api = new MockApi({
      [LIST]: { data: [liveKey(7, "old-name", BOT_KEY)] },
    });
    await expect(
      deployKeysSection.run(ctx(api), {
        undeclared: "delete",
        entries: [{ title: "new-name", key: BOT_KEY }],
      }),
    ).rejects.toThrow(/live key "old-name" \(id 7\) already holds/);
    expect(api.mutations()).toEqual([]);
  });

  test("a declared title matching SEVERAL live keys fails loudly naming their ids, zero writes", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [liveKey(11, "deploy-bot", BOT_KEY), liveKey(12, "deploy-bot", MIRROR_KEY)],
      },
    });
    await expect(
      deployKeysSection.run(ctx(api), [{ title: "deploy-bot", key: BOT_KEY }]),
    ).rejects.toThrow(/matches 2 live deploy keys \(ids 11, 12\)/);
    expect(api.mutations()).toEqual([]);
  });
});

describe("deploy_keys loud live extraction", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a non-string title", { id: 1, title: 7, key: BOT_KEY }],
    ["a non-string key", { id: 1, title: "deploy-bot", key: null }],
    ["a non-numeric id", { id: "1", title: "deploy-bot", key: BOT_KEY }],
  ];
  for (const [label, entry] of cases) {
    test(`a live entry with ${label} is a contract violation naming the endpoint`, async () => {
      const api = new MockApi({ [LIST]: { data: [entry] } });
      await expect(deployKeysSection.run(ctx(api), [])).rejects.toThrow(
        /GET \/repos\/\{owner\}\/\{repo\}\/keys returned an entry without a numeric id, a string title, and a string key/,
      );
      expect(api.mutations()).toEqual([]);
    });
  }

  test("a live key with sub-two-field material is a contract violation naming id and endpoint", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(9, "stub", "ssh-ed25519")] } });
    await expect(deployKeysSection.run(ctx(api), [])).rejects.toThrow(
      /GET \/repos\/\{owner\}\/\{repo\}\/keys returned key id 9 \("stub"\) whose material has fewer than two whitespace-separated fields/,
    );
    expect(api.mutations()).toEqual([]);
  });
});

describe("deploy_keys reconcile", () => {
  test("a matching key (declared comment vs stored comment-free) is a no-op", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(1, "deploy-bot", BOT_KEY, true)] },
    });
    const result = await deployKeysSection.run(ctx(api), [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("a missing declared key is created with the entry passed through verbatim", async () => {
    const api = new MockApi({ [LIST]: { data: [] } }).allowMutations("POST /repos/o/r/keys");
    const result = await deployKeysSection.run(ctx(api), [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result.changes).toEqual(['created deploy key "deploy-bot"']);
    expect(api.mutations()).toEqual([
      {
        method: "POST",
        path: "/repos/o/r/keys",
        payload: { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
      },
    ]);
  });

  test("a rotated blob is replaced: DELETE by id then POST, in that order", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "mirror-pull", "ssh-ed25519 AAAAC3staleblob")] },
    }).allowMutations("DELETE /repos/o/r/keys/10", "POST /repos/o/r/keys");
    const result = await deployKeysSection.run(ctx(api), [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new` },
    ]);
    expect(result.changes).toEqual(['replaced deploy key "mirror-pull"']);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/keys/10",
      "POST /repos/o/r/keys",
    ]);
  });

  test("a rotated read-only key stays read-only when the declaration omits the flag", async () => {
    // The recreate must seed the LIVE read_only: without it GitHub's
    // read/write default silently widens a rotated read-only key's access.
    // The mutation sequence is identical either way, so the assertion that
    // matters is on the POST payload itself.
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "mirror-pull", "ssh-ed25519 AAAAC3staleblob", true)] },
    }).allowMutations("DELETE /repos/o/r/keys/10", "POST /repos/o/r/keys");
    await deployKeysSection.run(ctx(api), [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new` },
    ]);
    const post = api.mutations().find((m) => m.method === "POST");
    if (post === undefined) {
      throw new Error("the replace issued no POST");
    }
    expect((post.payload as Record<string, unknown>).read_only).toBe(true);
  });

  test("a declared read_only: false beats a live true on the recreate (spread order)", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "mirror-pull", "ssh-ed25519 AAAAC3staleblob", true)] },
    }).allowMutations("DELETE /repos/o/r/keys/10", "POST /repos/o/r/keys");
    await deployKeysSection.run(ctx(api), [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new`, read_only: false },
    ]);
    const post = api.mutations().find((m) => m.method === "POST");
    if (post === undefined) {
      throw new Error("the replace issued no POST");
    }
    expect((post.payload as Record<string, unknown>).read_only).toBe(false);
  });

  test("a divergent DECLARED read_only alone forces the replace", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "deploy-bot", BOT_KEY, false)] },
    }).allowMutations("DELETE /repos/o/r/keys/10", "POST /repos/o/r/keys");
    const result = await deployKeysSection.run(ctx(api), [
      { title: "deploy-bot", key: BOT_KEY, read_only: true },
    ]);
    expect(result.changes).toEqual(['replaced deploy key "deploy-bot"']);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/keys/10",
      "POST /repos/o/r/keys",
    ]);
  });

  test("an UNDECLARED read_only is never compared: a live difference alone is a no-op", async () => {
    // read_only true on the live key, absent from the declaration: not drift,
    // no replace - only declared fields are managed.
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "deploy-bot", BOT_KEY, true)] },
    });
    const applied = await deployKeysSection.run(ctx(api), [{ title: "deploy-bot", key: BOT_KEY }]);
    expect(applied.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
    const checked = await deployKeysSection.run(ctx(api, true), [
      { title: "deploy-bot", key: BOT_KEY },
    ]);
    expect(checked.drift).toEqual([]);
  });

  test('a declared passthrough field named "material" earns the phantom-key note, diffed against the RAW api body', async () => {
    // The handler keeps its normalized material in a side map, never on the
    // object handed to subsetDiff/phantomKeys - so a user field that happens
    // to be called "material" is compared against what GitHub returns
    // (nothing) and phantomKeys names it, instead of silently colliding with
    // a synthetic field (false drift or false convergence).
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "deploy-bot", BOT_KEY)] },
    }).allowMutations("DELETE /repos/o/r/keys/10", "POST /repos/o/r/keys");
    const result = await deployKeysSection.run(ctx(api), [
      { title: "deploy-bot", key: BOT_KEY, material: "whatever" } as never,
    ]);
    expect(result.notes).toEqual([
      expect.stringMatching(
        /deploy_keys\[deploy-bot\]: declared key\(s\) "material" do not exist on the live deploy key/,
      ),
    ]);
    expect(result.changes).toEqual(['replaced deploy key "deploy-bot"']);
  });
});

describe("deploy_keys undeclared policy", () => {
  const liveKeys = [liveKey(1, "deploy-bot", BOT_KEY), liveKey(2, "retired-service", MIRROR_KEY)];

  test("the keep default notes the undeclared key, never a DELETE", async () => {
    const api = new MockApi({ [LIST]: { data: liveKeys } });
    const result = await deployKeysSection.run(ctx(api), [{ title: "deploy-bot", key: BOT_KEY }]);
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'deploy key "retired-service" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:delete removes the undeclared key", async () => {
    const api = new MockApi({ [LIST]: { data: liveKeys } }).allowMutations(
      "DELETE /repos/o/r/keys/*",
    );
    const result = await deployKeysSection.run(ctx(api), {
      undeclared: "delete",
      entries: [{ title: "deploy-bot", key: BOT_KEY }],
    });
    expect(result.changes).toEqual(['DELETED undeclared deploy key "retired-service"']);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/keys/2",
    ]);
  });

  test("wrapped undeclared:delete in check mode reports drift instead of deleting", async () => {
    const api = new MockApi({ [LIST]: { data: liveKeys } });
    const result = await deployKeysSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [{ title: "deploy-bot", key: BOT_KEY }],
    });
    expect(result.drift).toEqual([
      "deploy_keys[retired-service]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });
});

describe("deploy_keys check mode", () => {
  test("a divergent key emits the generic delete-and-recreate line plus the field lines, zero writes", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(10, "mirror-pull", "ssh-ed25519 AAAAC3staleblob", false)] },
    });
    const result = await deployKeysSection.run(ctx(api, true), [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new`, read_only: true },
    ]);
    expect(result.drift).toEqual([
      "deploy_keys[mirror-pull]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it",
      `deploy_keys[mirror-pull].key: declared material "${MIRROR_KEY}" != live "ssh-ed25519 AAAAC3staleblob" (compared as algorithm + blob, comments ignored)`,
      "deploy_keys[mirror-pull].read_only: declared true != live false",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a missing declared key is create drift, zero writes", async () => {
    const api = new MockApi({ [LIST]: { data: [] } });
    const result = await deployKeysSection.run(ctx(api, true), [
      { title: "deploy-bot", key: BOT_KEY },
    ]);
    expect(result.drift).toEqual([
      "deploy_keys[deploy-bot]: missing - declared in the settings file but not on the repo; apply will create it",
    ]);
    expect(api.mutations()).toEqual([]);
  });
});

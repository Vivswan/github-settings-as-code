/**
 * actions_secrets section tests: existence-based reconciliation (values can
 * never be read back), the ONE cannot-verify note, the keep/delete knob, the
 * unconditional re-seal-and-PUT apply path, and the no-plaintext-anywhere
 * property - a hostile resolved value must appear in no drift/note/change
 * line, no request path, and no error, only inside the sealed payload.
 */

import { describe, expect, test } from "bun:test";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../test/e2e/mock/secrets.js";
import { MockApi } from "../../../test/mock-api.js";
import type { SectionContext } from "../contract.js";
import { actionsSecretsSection } from "./index.js";

const LIST = "GET /repos/o/r/actions/secrets?per_page=100&page=1";
const PUBLIC_KEY = "GET /repos/o/r/actions/secrets/public-key";
const KEY_ROUTE = { data: { key_id: "test-key-id", key: MOCK_SECRETS_PUBLIC_KEY } };

function listOf(...names: string[]) {
  return {
    data: {
      total_count: names.length,
      secrets: names.map((name) => ({
        name,
        created_at: "2020-01-15T00:00:00Z",
        updated_at: "2020-01-15T00:00:00Z",
      })),
    },
  };
}

function ctx(api: MockApi, check: boolean, resolved?: Record<string, string>): SectionContext {
  const repo = { owner: "o", name: "r", slug: "o/r" };
  if (check) {
    return { api, repo, check: true };
  }
  return {
    api,
    repo,
    check: false,
    // Faithful to the engine: apply mode ALWAYS carries a resolver. Tests
    // that pass no `resolved` get the engine's stub posture - any lookup is
    // a loud failure, exactly like an apply over an empty inventory.
    resolveSecret: (reference: string): string => {
      const plaintext = resolved?.[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

describe("actions_secrets check mode", () => {
  test("declared-but-missing is drift; declared values get ONE cannot-verify note", async () => {
    const api = new MockApi({ [LIST]: listOf("PRESENT") });
    const result = await actionsSecretsSection.run(ctx(api, true), [
      { name: "present", value: "$PRESENT_REF" },
      { name: "MISSING_ONE", value: "$REF_A" },
      { name: "MISSING_TWO", value: "$REF_B" },
    ]);
    expect(result.drift).toEqual([
      "actions_secrets[MISSING_ONE]: missing - declared in the settings file but not on the repo; apply will create it",
      "actions_secrets[MISSING_TWO]: missing - declared in the settings file but not on the repo; apply will create it",
    ]);
    const cannotVerify = result.notes.filter((note) => note.includes("cannot be read back"));
    expect(cannotVerify).toHaveLength(1);
    expect(api.mutations()).toEqual([]);
  });

  test("an undeclared live secret is a keep-note by default, drift under undeclared: delete", async () => {
    const api = new MockApi({ [LIST]: listOf("STALE") });
    const kept = await actionsSecretsSection.run(ctx(api, true), []);
    expect(kept.drift).toEqual([]);
    expect(kept.notes.join("\n")).toContain('Actions secret "STALE" exists on the repo');

    const api2 = new MockApi({ [LIST]: listOf("STALE") });
    const deleted = await actionsSecretsSection.run(ctx(api2, true), {
      undeclared: "delete",
      entries: [],
    });
    expect(deleted.drift?.join("\n")).toContain(
      "actions_secrets[STALE]: undeclared - not in the settings file, so apply will DELETE it",
    );
    expect(api2.mutations()).toEqual([]);
  });

  test("an empty declaration earns no cannot-verify note", async () => {
    const api = new MockApi({ [LIST]: listOf() });
    const result = await actionsSecretsSection.run(ctx(api, true), []);
    expect(result.notes).toEqual([]);
    expect(result.drift).toEqual([]);
  });
});

describe("actions_secrets apply mode", () => {
  test("seals and PUTs every declared secret: create and update, case-insensitively", async () => {
    await mockSodiumReady();
    const api = new MockApi({ [LIST]: listOf("EXISTING"), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/EXISTING",
      "PUT /repos/o/r/actions/secrets/BRAND_NEW",
    );
    const result = await actionsSecretsSection.run(
      ctx(api, false, { $A: "value-a", $B: "value-b" }),
      [
        { name: "existing", value: "$A" },
        { name: "BRAND_NEW", value: "$B" },
      ],
    );
    // Existence decides the verb: the live secret is an update, the other a create.
    expect(result.changes).toEqual(['updated secret "EXISTING"', 'created secret "BRAND_NEW"']);
    const puts = api.mutations().filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.path)).toEqual([
      "/repos/o/r/actions/secrets/EXISTING",
      "/repos/o/r/actions/secrets/BRAND_NEW",
    ]);
    // The body is exactly {encrypted_value, key_id}, and the sealed value
    // unseals back to the resolved plaintext (the client-side crypto proof).
    for (const [index, expected] of [
      [0, "value-a"],
      [1, "value-b"],
    ] as const) {
      const payload = puts[index]?.payload as { encrypted_value: string; key_id: string };
      expect(Object.keys(payload).sort()).toEqual(["encrypted_value", "key_id"]);
      expect(payload.key_id).toBe("test-key-id");
      expect(unsealSecretValue(payload.encrypted_value)).toBe(expected);
    }
    // Both plaintexts were registered with masking before use.
  });

  test("re-PUTs a declared secret on every run even when the live list already has it", async () => {
    // No compare is possible (values cannot be read back), and the rewrite is
    // what propagates a rotated source value.
    const api = new MockApi({ [LIST]: listOf("ROTATED"), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/ROTATED",
    );
    const result = await actionsSecretsSection.run(ctx(api, false, { $R: "new-plaintext" }), [
      { name: "ROTATED", value: "$R" },
    ]);
    expect(result.changes).toEqual(['updated secret "ROTATED"']);
    expect(api.mutations()).toHaveLength(1);
  });

  test("undeclared secrets: kept with a note by default, DELETED under the knob", async () => {
    const api = new MockApi({ [LIST]: listOf("STALE"), [PUBLIC_KEY]: KEY_ROUTE });
    const kept = await actionsSecretsSection.run(ctx(api, false), []);
    expect(kept.changes).toEqual([]);
    expect(kept.notes.join("\n")).toContain("unrecoverable");
    expect(api.mutations()).toEqual([]);

    // The purge form: nothing declared means no references, so the engine
    // provisions NO resolver - deletion must work without one (regression:
    // an empty inventory once demanded a resolver and threw).
    const api2 = new MockApi({ [LIST]: listOf("STALE") }).allowMutations(
      "DELETE /repos/o/r/actions/secrets/STALE",
    );
    const deleted = await actionsSecretsSection.run(ctx(api2, false), {
      undeclared: "delete",
      entries: [],
    });
    expect(deleted.changes).toEqual(['DELETED undeclared secret "STALE"']);
    // Nothing declared, so the public key is never fetched.
    expect(api2.calls.some((call) => call.path.endsWith("/public-key"))).toBe(false);
  });

  test("a hostile resolved value appears nowhere: not in results, paths, or payload text", async () => {
    const hostile = 'ho"st\\ile\nvalue-with-%25-and-|pipes|';
    const fragment = "value-with-%25"; // a distinctive contiguous piece of it
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/EDGY",
    );
    const result = await actionsSecretsSection.run(ctx(api, false, { $H: hostile }), [
      { name: "EDGY", value: "$H" },
    ]);
    const rendered = [...(result.changes ?? []), ...(result.drift ?? []), ...result.notes].join(
      "\n",
    );
    expect(rendered).not.toContain(hostile);
    expect(rendered).not.toContain(fragment);
    const put = api.mutations().find((call) => call.method === "PUT");
    const payload = put?.payload as { encrypted_value: string; key_id: string };
    expect(put?.path).toBe("/repos/o/r/actions/secrets/EDGY");
    // Only the SEALED form travels; it carries no fragment of the plaintext
    // and unseals back to it exactly (round-trip fidelity, hostile chars kept).
    expect(payload.encrypted_value).not.toContain(fragment);
    expect(unsealSecretValue(payload.encrypted_value)).toBe(hostile);
  });

  test("a failing PUT throws the API error without the plaintext in the message", async () => {
    const api = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: KEY_ROUTE,
      "PUT /repos/o/r/actions/secrets/DENIED_WRITE": {
        error: { status: 422, message: "Validation Failed", body: "" },
      },
    });
    let message = "";
    try {
      await actionsSecretsSection.run(ctx(api, false, { $V: "super-plain" }), [
        { name: "DENIED_WRITE", value: "$V" },
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('writing secret "DENIED_WRITE" failed');
    expect(message).not.toContain("super-plain");
  });

  test("an unusable public key fails loudly before any PUT", async () => {
    const api = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key: 42 } },
    });
    await expect(
      actionsSecretsSection.run(ctx(api, false, { $V: "value" }), [{ name: "X", value: "$V" }]),
    ).rejects.toThrow(/no usable \{key_id, key\} pair/);
    expect(api.mutations()).toEqual([]);

    // An empty key_id is as unusable as a missing one: GitHub requires it in
    // the PUT body to route the ciphertext to the right key.
    const emptyId = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "", key: MOCK_SECRETS_PUBLIC_KEY } },
    });
    await expect(
      actionsSecretsSection.run(ctx(emptyId, false, { $V: "value" }), [{ name: "X", value: "$V" }]),
    ).rejects.toThrow(/no usable \{key_id, key\} pair/);
    expect(emptyId.mutations()).toEqual([]);
  });

  test("a key that is not base64 or not X25519-sized fails with the endpoint named", async () => {
    // Both malformations must fail in the key parse with actionable prose,
    // not deeper in the seal loop as a bare libsodium error.
    const notB64 = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "k1", key: "!!not-base64!!" } },
    });
    await expect(
      actionsSecretsSection.run(ctx(notB64, false, { $V: "value" }), [{ name: "X", value: "$V" }]),
    ).rejects.toThrow(/public key is not valid base64/);
    expect(notB64.mutations()).toEqual([]);

    const wrongLength = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "k1", key: "AAAA" } },
    });
    await expect(
      actionsSecretsSection.run(ctx(wrongLength, false, { $V: "value" }), [
        { name: "X", value: "$V" },
      ]),
    ).rejects.toThrow(/decodes to 3 bytes where an X25519 public key has 32/);
    expect(wrongLength.mutations()).toEqual([]);
  });
});

describe("actions_secrets validation", () => {
  test("case-insensitive duplicate names are rejected upfront", async () => {
    const api = new MockApi({});
    await expect(
      actionsSecretsSection.run(ctx(api, true), [
        { name: "token", value: "$A" },
        { name: "TOKEN", value: "$B" },
      ]),
    ).rejects.toThrow(/same actions_secrets entry/);
    expect(api.calls).toEqual([]);
  });

  // Reference validation (literals, embedded fragments, provenance) is the
  // ENGINE's job, run in both modes before any section: see
  // src/engine/secrets.ts and its tests in test/engine/. The section only
  // extracts its values (secretValues) and looks up resolved plaintexts.
});

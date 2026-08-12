/**
 * Unit tests for the shared secrets engine: the seal/unseal round-trip
 * against the mock's fixed keypair, reconcileSecrets' use of the apply
 * context's resolver (each entry's own value, and never on an empty
 * inventory), and duplicate-name rejection.
 */

import { describe, expect, test } from "bun:test";
import {
  beginRun,
  type SectionContext,
  type SectionMeta,
} from "../../src/sections/contract/module.js";
import {
  reconcileSecrets,
  rejectDuplicateSecretNames,
  type SealedSecretPayload,
  type SecretsScope,
  sealSecretValue,
  secretKey,
} from "../../src/sections/shared/secrets-engine.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  secretDigest,
  unsealSecretValue,
} from "../e2e/mock/secrets.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = {
  key: "actions_secrets",
  permission: { repo: ["secrets"] },
  endpoints: {},
  undeclaredDefault: "keep",
};

function applyCtx(resolved?: Record<string, string>): SectionContext {
  return {
    api: new MockApi({}),
    repo: { owner: "o", name: "r", slug: "o/r" },
    check: false,
    resolveSecret: (reference: string): string => {
      const plaintext = resolved?.[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

/**
 * A fabricated scope whose operations never touch an API: the list answers
 * `live`, the public key is the mock keypair's, and every sealed PUT is
 * recorded for the assertions.
 */
function fabricatedScope(
  live: string[],
  puts: Array<{ name: string; payload: SealedSecretPayload }>,
): SecretsScope {
  return {
    label: "actions_secrets",
    noun: "Actions secret",
    ops: {
      list: async () => live.map((name) => ({ name })),
      publicKey: async () => ({ key_id: "key-1", key: MOCK_SECRETS_PUBLIC_KEY }),
      put: async (_ctx, _section, name, payload) => {
        puts.push({ name, payload });
        return null;
      },
      remove: async () => null,
    },
  };
}

describe("sealSecretValue", () => {
  test("round-trips through the mock keypair, hostile characters included", async () => {
    await mockSodiumReady();
    const hostile = 'p@ss"word\\with\nnewline\tand unicode-éñ中';
    const sealed = await sealSecretValue(hostile, MOCK_SECRETS_PUBLIC_KEY);
    // The ciphertext is base64 and never contains the plaintext.
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sealed).not.toContain("p@ss");
    expect(unsealSecretValue(sealed)).toBe(hostile);
  });

  test("two seals of the same plaintext differ, but their digests agree", async () => {
    // Sealed boxes use a fresh ephemeral key per seal; the mock's digest is
    // what makes idempotence judgeable anyway.
    const a = await sealSecretValue("same-value", MOCK_SECRETS_PUBLIC_KEY);
    const b = await sealSecretValue("same-value", MOCK_SECRETS_PUBLIC_KEY);
    expect(a).not.toBe(b);
    await mockSodiumReady();
    expect(secretDigest(unsealSecretValue(a) ?? "")).toBe(secretDigest(unsealSecretValue(b) ?? ""));
  });
});

describe("secretKey and duplicates", () => {
  test("secretKey uppercases (GitHub stores secret names uppercase)", () => {
    expect(secretKey("npm_token")).toBe("NPM_TOKEN");
  });

  test("two entries differing only by case are rejected upfront", () => {
    expect(() =>
      rejectDuplicateSecretNames(section, [
        { name: "Deploy_Token", value: "$A" },
        { name: "DEPLOY_TOKEN", value: "$B" },
      ]),
    ).toThrow(/same actions_secrets entry.*"Deploy_Token" and "DEPLOY_TOKEN"/s);
  });
});

describe("reconcileSecrets and the apply-arm resolver", () => {
  // Reference VALIDATION (literals, provenance, unset/empty) lives in the
  // engine (src/engine/secrets.ts + secret-refs.ts) and runs before any
  // section; these tests cover only the resolver usage. The context ARMS
  // themselves are compiler-enforced: a check context cannot carry a
  // resolver, and an apply context cannot lack one.
  test("a check-mode context carrying a resolver does not compile", () => {
    // @ts-expect-error the check arm pins resolveSecret to never
    const checkCtx: SectionContext = {
      api: new MockApi({}),
      repo: { owner: "o", name: "r", slug: "o/r" },
      check: true,
      resolveSecret: (reference: string): string => reference,
    };
    expect(checkCtx.check).toBe(true);
  });

  test("an empty declaration in apply mode never touches the resolver", async () => {
    // A document with no references gets the engine's stub resolver, and
    // `actions_secrets: []` (or an entries-less `undeclared: delete` purge)
    // must still apply - nothing to seal means nothing to resolve.
    const puts: Array<{ name: string; payload: SealedSecretPayload }> = [];
    const run = beginRun(applyCtx());
    await reconcileSecrets(run, section, fabricatedScope([], puts), {
      entries: [],
      policy: "keep",
      defaultPolicy: "keep",
    });
    expect(run.result.changes).toEqual([]);
    expect(puts).toEqual([]);
  });

  test("apply seals each entry's OWN resolved value, uppercasing the name", async () => {
    await mockSodiumReady();
    const puts: Array<{ name: string; payload: SealedSecretPayload }> = [];
    await reconcileSecrets(
      beginRun(applyCtx({ $ONE: "plain-1", $TWO: "plain-2" })),
      section,
      fabricatedScope([], puts),
      {
        entries: [
          { name: "first", value: "$ONE" },
          { name: "SECOND", value: "$TWO" },
        ],
        policy: "keep",
        defaultPolicy: "keep",
      },
    );
    expect(puts.map((put) => put.name)).toEqual(["FIRST", "SECOND"]);
    expect(puts.map((put) => unsealSecretValue(put.payload.encrypted_value))).toEqual([
      "plain-1",
      "plain-2",
    ]);
  });

  test("a value the engine never resolved fails the entry loudly", async () => {
    const puts: Array<{ name: string; payload: SealedSecretPayload }> = [];
    await expect(
      reconcileSecrets(beginRun(applyCtx({})), section, fabricatedScope([], puts), {
        entries: [{ name: "A", value: "$NEVER_RESOLVED" }],
        policy: "keep",
        defaultPolicy: "keep",
      }),
    ).rejects.toThrow(/no value for \$NEVER_RESOLVED/);
    expect(puts).toEqual([]);
  });
});

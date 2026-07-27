/**
 * Unit tests for the shared secrets engine: the seal/unseal round-trip
 * against the mock's fixed keypair, the prepareSecretValues adapter over
 * ctx.resolveSecret (check and empty inventories need no resolver; apply
 * with entries demands one loudly), and duplicate-name rejection.
 */

import { describe, expect, test } from "bun:test";
import type { SectionContext, SectionMeta } from "../../src/sections/contract.js";
import {
  prepareSecretValues,
  rejectDuplicateSecretNames,
  sealSecretValue,
  secretKey,
} from "../../src/sections/secrets-engine.js";
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
  grant: "grant",
  endpoints: {},
  undeclaredDefault: "keep",
};

function resolveCtx(opts: { check: boolean; resolved?: Record<string, string> }): SectionContext {
  return {
    api: new MockApi({}),
    repo: "o/r",
    owner: "o",
    check: opts.check,
    ...(opts.resolved === undefined
      ? {}
      : {
          resolveSecret: (reference: string): string => {
            const plaintext = opts.resolved?.[reference];
            if (plaintext === undefined) {
              throw new Error(`test resolver has no value for ${reference}`);
            }
            return plaintext;
          },
        }),
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
    ).toThrow(/Deploy_Token.*DEPLOY_TOKEN.*same actions_secrets entry/s);
  });
});

describe("prepareSecretValues", () => {
  // Reference VALIDATION (literals, provenance, unset/empty) lives in the
  // engine (src/engine/secrets.ts + secret-refs.ts) and runs before any
  // section; these tests cover only the adapter over ctx.resolveSecret.
  test("check mode returns undefined and needs no resolver", () => {
    const lookup = prepareSecretValues(resolveCtx({ check: true }), section, [
      { name: "A", value: "$SOME_REF" },
    ]);
    expect(lookup).toBeUndefined();
  });

  test("an empty declaration in apply mode needs no resolver either", () => {
    // A document with no references gets NO resolver from the engine, and
    // `actions_secrets: []` (or an entries-less `undeclared: delete` purge)
    // must still apply - nothing to seal means nothing to look up.
    const lookup = prepareSecretValues(resolveCtx({ check: false }), section, []);
    expect(lookup).toBeUndefined();
  });

  test("apply maps entry names to resolved plaintexts, case-insensitively", () => {
    const lookup = prepareSecretValues(
      resolveCtx({ check: false, resolved: { $ONE: "plain-1", $TWO: "plain-2" } }),
      section,
      [
        { name: "first", value: "$ONE" },
        { name: "SECOND", value: "$TWO" },
      ],
    );
    expect(lookup?.("FIRST")).toBe("plain-1");
    expect(lookup?.("second")).toBe("plain-2");
  });

  test("apply without the engine's resolver is a loud BUG, not a silent default", () => {
    expect(() =>
      prepareSecretValues(resolveCtx({ check: false }), section, [{ name: "A", value: "$REF" }]),
    ).toThrow(/BUG: applying actions_secrets reached a sealed write with no secret resolver/);
  });

  test("looking up an entry the section never declared is a loud BUG", () => {
    const lookup = prepareSecretValues(
      resolveCtx({ check: false, resolved: { $ONE: "plain-1" } }),
      section,
      [{ name: "A", value: "$ONE" }],
    );
    expect(() => lookup?.("UNDECLARED")).toThrow(/BUG: no resolved value/);
  });
});

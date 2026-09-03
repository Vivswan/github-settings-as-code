/**
 * Secrets engine tests: the seal round-trip, planSecrets' thunks (each seals
 * its own entry only when executed), and duplicate-name rejection. The
 * context-arm pin at the end guards the SectionContext type the request
 * helpers and the executor build on.
 */

import { describe, expect, test } from "bun:test";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import type { SectionContext, SectionMeta } from "../../src/sections/contract/module.js";
import type { ExecTools, SectionPlan } from "../../src/sections/contract/plan.js";
import {
  parseSealingKey,
  planSecrets,
  rejectDuplicateSecretNames,
  type SealedSecretPayload,
  type SecretsPlanScope,
  sealSecretValue,
  secretKey,
} from "../../src/sections/shared/secrets-engine.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../e2e/mock/secrets.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = {
  key: "actions_secrets",
  permission: { repo: ["secrets"] },
  endpoints: {},
  undeclaredDefault: "keep",
};

const KEY_DATA = { key_id: "key-1", key: MOCK_SECRETS_PUBLIC_KEY };

const PUBLIC_KEY_ENDPOINT: EndpointDecl = {
  route: "GET /repos/{owner}/{repo}/actions/secrets/public-key",
  statuses: { 200: "the sealing key" },
};

function resolver(resolved?: Record<string, string>): ExecTools["resolveSecret"] {
  return (reference) => {
    const plaintext = resolved?.[reference];
    if (plaintext === undefined) {
      throw new Error(`test resolver has no value for ${reference}`);
    }
    return plaintext;
  };
}

/** An erased planned op, as the fabricated plan scope's builders return it. */
type Op = SectionPlan["ops"][number];

/** A plan scope off the API: the list answers `live`, reads are counted, builders echo facets. */
function fabricatedPlanScope(live: string[], reads: string[]): SecretsPlanScope<Op, Op> {
  return {
    label: "actions_secrets",
    noun: "Actions secret",
    list: async () => {
      reads.push("list");
      return live.map((name) => ({ name }));
    },
    publicKeyEndpoint: PUBLIC_KEY_ENDPOINT,
    publicKey: async (describe) => {
      reads.push(describe);
      return KEY_DATA;
    },
    put: (write) => ({
      role: "put",
      params: { secret_name: write.name },
      payload: write.payload,
      drift: write.drift,
      change: write.change,
    }),
    remove: (deletion) => ({
      role: "remove",
      params: { secret_name: deletion.name },
      drift: deletion.drift,
      change: deletion.change,
    }),
  };
}

describe("sealing", () => {
  test("sealSecretValue round-trips through the mock keypair, hostile characters included", async () => {
    await mockSodiumReady();
    const hostile = 'p@ss"word\\with\nnewline\tand unicode-éñ中';
    const sealed = await sealSecretValue(hostile, MOCK_SECRETS_PUBLIC_KEY);
    // The ciphertext is base64 and never contains the plaintext.
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sealed).not.toContain("p@ss");
    expect(unsealSecretValue(sealed)).toBe(hostile);
  });

  test.each([
    ["a missing key_id", { key: MOCK_SECRETS_PUBLIC_KEY }, /pair \(key_id is missing\)/],
    ["a key that is not base64", { key_id: "k", key: "not base64!" }, /is not valid base64/],
    [
      "a key of the wrong length",
      { key_id: "k", key: Buffer.from("short").toString("base64") },
      /decodes to 5 bytes where an X25519 public key has 32/,
    ],
    [
      "a right-sized key that is not a usable point",
      { key_id: "k", key: Buffer.alloc(32).toString("base64") },
      /is not a usable X25519 public key/,
    ],
  ])("parseSealingKey rejects %s, naming the scope and the defect", async (_what, body, defect) => {
    const attempt = parseSealingKey(
      section,
      { label: "actions_secrets" },
      PUBLIC_KEY_ENDPOINT,
      body,
    );
    await expect(attempt).rejects.toThrow(
      /^actions_secrets: GET \/repos\/\{owner\}\/\{repo\}\/actions\/secrets\/public-key \(the actions_secrets sealing key\) returned /,
    );
    await expect(attempt).rejects.toThrow(defect);
  });

  test("a parsed sealing key seals synchronously into the {encrypted_value, key_id} body, fresh per seal", async () => {
    // Sealed boxes use a fresh ephemeral key per seal, so the ciphertexts
    // must differ while both still carry the exact plaintext.
    const key = await parseSealingKey(
      section,
      { label: "actions_secrets" },
      PUBLIC_KEY_ENDPOINT,
      KEY_DATA,
    );
    expect(key.keyId).toBe("key-1");
    const a = key.seal("same-value");
    const b = key.seal("same-value");
    expect(Object.keys(a).sort()).toEqual(["encrypted_value", "key_id"]);
    expect(a.key_id).toBe("key-1");
    expect(a.encrypted_value).not.toBe(b.encrypted_value);
    expect(unsealSecretValue(a.encrypted_value)).toBe("same-value");
    expect(unsealSecretValue(b.encrypted_value)).toBe("same-value");
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

describe("planSecrets and the execution-time resolver", () => {
  test("each PUT's thunk seals its OWN entry's resolved value, uppercasing the name; planning resolves nothing", async () => {
    await mockSodiumReady();
    const reads: string[] = [];
    const plan = await planSecrets(section, fabricatedPlanScope([], reads), {
      entries: [
        { name: "first", value: "$ONE" },
        { name: "SECOND", value: "$TWO" },
      ],
      policy: "keep",
      defaultPolicy: "keep",
    });
    // The sealing key is read once at plan time, after the list.
    expect(reads).toEqual(["list", "reading the actions_secrets sealing key"]);
    expect(plan.ops.map((op) => op.params)).toEqual([
      { secret_name: "FIRST" },
      { secret_name: "SECOND" },
    ]);
    const lookups: string[] = [];
    const exec: ExecTools = {
      resolveSecret: (reference) => {
        lookups.push(reference);
        return resolver({ $ONE: "plain-1", $TWO: "plain-2" })(reference);
      },
    };
    const sealed = plan.ops.map((op) =>
      typeof op.payload === "function" ? (op.payload(exec) as SealedSecretPayload) : null,
    );
    expect(lookups).toEqual(["$ONE", "$TWO"]);
    expect(sealed.map((p) => p?.key_id)).toEqual(["key-1", "key-1"]);
    expect(sealed.map((p) => unsealSecretValue(p?.encrypted_value ?? ""))).toEqual([
      "plain-1",
      "plain-2",
    ]);
  });

  test("a builder can only answer with its own role's operation", () => {
    // Compile-time only: the scope's builders are typed per role, so a
    // section wiring the DELETE builder to its PUT role does not compile.
    type Put = { role: "put"; params: { secret_name: string }; drift: string[]; change: string };
    type Remove = {
      role: "remove";
      params: { secret_name: string };
      drift: string[];
      change: string;
    };
    const swapped = (deletion: { name: string; describe: string; change: string }): Put => ({
      role: "put",
      params: { secret_name: deletion.name },
      drift: [],
      change: deletion.change,
    });
    const scope: Pick<SecretsPlanScope<Put, Remove>, "remove"> = {
      // @ts-expect-error the remove builder must return the remove-role operation
      remove: swapped,
    };
    expect(typeof scope.remove).toBe("function");
  });

  test("a builder cannot demand a facet the engine never supplies", () => {
    // Compile-time only: the builders are function-valued, so a parameter
    // narrower than the engine's facet is a contravariance error rather than
    // a method-bivariance pass.
    type Put = { role: "put"; params: { secret_name: string }; drift: string[]; change: string };
    const demanding = (write: { name: string; change: string; keyId: string }): Put => ({
      role: "put",
      params: { secret_name: write.name },
      drift: [],
      change: `${write.change} ${write.keyId}`,
    });
    const scope: Pick<SecretsPlanScope<Put, Put>, "put"> = {
      // @ts-expect-error the engine supplies no keyId facet
      put: demanding,
    };
    expect(typeof scope.put).toBe("function");
  });

  test("an empty declaration plans nothing and never reads the sealing key", async () => {
    const reads: string[] = [];
    const plan = await planSecrets(section, fabricatedPlanScope([], reads), {
      entries: [],
      policy: "keep",
      defaultPolicy: "keep",
    });
    expect(plan).toEqual({ ops: [], notes: [], drift: [] });
    expect(reads).toEqual(["list"]);
  });

  test("a value the engine never resolved fails the thunk loudly", async () => {
    const plan = await planSecrets(section, fabricatedPlanScope([], []), {
      entries: [{ name: "A", value: "$NEVER_RESOLVED" }],
      policy: "keep",
      defaultPolicy: "keep",
    });
    const payload = plan.ops[0]?.payload;
    expect(typeof payload).toBe("function");
    if (typeof payload === "function") {
      expect(() => payload({ resolveSecret: resolver({}) })).toThrow(
        /no value for \$NEVER_RESOLVED/,
      );
    }
  });
});

describe("the section context arms", () => {
  // Reference VALIDATION (literals, provenance, unset/empty) lives in the
  // engine (src/engine/secrets.ts + secret-refs.ts) and runs before any
  // section. The context ARMS are compiler-enforced: a check context cannot
  // carry a resolver, and an apply context cannot lack one.
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
});

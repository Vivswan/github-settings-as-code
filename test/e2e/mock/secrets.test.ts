/**
 * The mock's secrets crypto proof, at the pipeline level: a PUT's ciphertext
 * is UNSEALED with the fixed test keypair (verifying key decode, sealed-box
 * construction, and base64 round-trip), the state stores a deterministic
 * digest and never the plaintext, create answers 201 and update 204, and a
 * re-write of the same value keeps the digest and created_at stable while
 * updated_at moves, exactly like GitHub (the idempotence snapshot excludes
 * only that volatile field).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { sealSecretValue } from "../../../src/sections/secrets-engine.js";
import { parseScenario, type Scenario } from "../schema.js";
import { newPipelineRunState, runPipeline } from "./routes.js";
import {
  MOCK_SECRETS_KEY_ID,
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  secretDigest,
  unsealSecretValue,
} from "./secrets.js";
import { buildState, type MockState } from "./state.js";

const scenario: Scenario = parseScenario(
  { name: "secrets-crypto", settings: {}, expect: { exit_code: 0 } },
  "inline",
);

function request(state: MockState, method: string, path: string, body?: unknown) {
  return runPipeline(
    {
      method,
      rawPath: path,
      query: {},
      rawQuery: "",
      headers: new Headers({ authorization: "token t", "x-github-api-version": "2022-11-28" }),
      body,
    },
    { scenario, working: { mode: "single", state }, ...newPipelineRunState(), checkMode: false },
  );
}

describe("mock secrets crypto", () => {
  beforeAll(async () => {
    await mockSodiumReady();
  });

  test("unsealSecretValue rejects garbage and non-matching ciphertext", () => {
    expect(unsealSecretValue("not-base64!!")).toBeNull();
    expect(unsealSecretValue("AAAA")).toBeNull();
  });

  test("PUT unseals, stores name + digest (never the plaintext), 201 then 204", async () => {
    const state = buildState(undefined, "org");
    const sealed = await sealSecretValue("plain-one", MOCK_SECRETS_PUBLIC_KEY);
    const path = "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN";
    const created = request(state, "PUT", path, {
      encrypted_value: sealed,
      key_id: MOCK_SECRETS_KEY_ID,
    });
    expect(created.response.status).toBe(201);
    expect(state.actions_secrets.map((s) => s.name)).toEqual(["DEPLOY_TOKEN"]);
    expect(state.actions_secret_digests.DEPLOY_TOKEN).toBe(secretDigest("plain-one"));
    expect(JSON.stringify(state)).not.toContain("plain-one");

    // A re-seal of the SAME value produces different ciphertext but the same
    // digest: 204, no new entry, created_at untouched - and updated_at MOVES,
    // exactly like GitHub (the idempotence snapshot excludes it for that
    // reason; the digest is what proves the value did not change).
    const before = state.actions_secrets[0] as Record<string, unknown>;
    const createdAt = before.created_at;
    const updatedAtFirst = before.updated_at;
    const resealed = await sealSecretValue("plain-one", MOCK_SECRETS_PUBLIC_KEY);
    expect(resealed).not.toBe(sealed);
    const updated = request(state, "PUT", path, {
      encrypted_value: resealed,
      key_id: MOCK_SECRETS_KEY_ID,
    });
    expect(updated.response.status).toBe(204);
    expect(state.actions_secrets.map((s) => s.name)).toEqual(["DEPLOY_TOKEN"]);
    expect(state.actions_secret_digests.DEPLOY_TOKEN).toBe(secretDigest("plain-one"));
    const after = state.actions_secrets[0] as Record<string, unknown>;
    expect(after.created_at).toBe(createdAt);
    expect(after.updated_at).not.toBe(updatedAtFirst);

    // A rotated value keeps the entry but moves the digest.
    const rotated = await sealSecretValue("plain-two", MOCK_SECRETS_PUBLIC_KEY);
    expect(
      request(state, "PUT", path, { encrypted_value: rotated, key_id: MOCK_SECRETS_KEY_ID })
        .response.status,
    ).toBe(204);
    expect(state.actions_secret_digests.DEPLOY_TOKEN).toBe(secretDigest("plain-two"));
  });

  test("a wrong key_id or an unopenable ciphertext is rejected with 422", async () => {
    const state = buildState(undefined, "org");
    const path = "/repos/e2e-owner/e2e-repo/actions/secrets/X";
    const sealed = await sealSecretValue("v", MOCK_SECRETS_PUBLIC_KEY);
    expect(
      request(state, "PUT", path, { encrypted_value: sealed, key_id: "wrong" }).response.status,
    ).toBe(422);
    expect(
      request(state, "PUT", path, { encrypted_value: "AAAA", key_id: MOCK_SECRETS_KEY_ID }).response
        .status,
    ).toBe(422);
    expect(state.actions_secrets).toEqual([]);
  });

  test("list envelope, public key, and delete round out the family", async () => {
    const state = buildState(
      {
        actions_secrets: [
          {
            name: "SEEDED",
            created_at: "2020-01-15T00:00:00Z",
            updated_at: "2020-01-15T00:00:00Z",
          },
        ],
      },
      "org",
    );
    const base = "/repos/e2e-owner/e2e-repo/actions/secrets";
    const list = request(state, "GET", base);
    expect(list.response.body).toEqual({
      total_count: 1,
      secrets: [
        { name: "SEEDED", created_at: "2020-01-15T00:00:00Z", updated_at: "2020-01-15T00:00:00Z" },
      ],
    });
    const key = request(state, "GET", `${base}/public-key`);
    expect(key.response.body).toEqual({
      key_id: MOCK_SECRETS_KEY_ID,
      key: MOCK_SECRETS_PUBLIC_KEY,
    });
    expect(request(state, "DELETE", `${base}/SEEDED`).response.status).toBe(204);
    expect(state.actions_secrets).toEqual([]);
    expect(request(state, "DELETE", `${base}/SEEDED`).response.status).toBe(404);
  });
});

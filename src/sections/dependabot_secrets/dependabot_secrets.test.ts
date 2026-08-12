/**
 * dependabot_secrets section tests: the engine behavior (existence
 * reconciliation, sealing, the resolver contract) is pinned by
 * secrets-engine.test.ts and the actions_secrets section tests; these tests
 * pin what is THIS section's own - its routes, its label/noun wording, and
 * its keep-by-default policy.
 */

import { describe, expect, test } from "bun:test";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../test/e2e/mock/secrets.js";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import type { SectionContext } from "../contract/module.js";
import { dependabotSecretsSection } from "./index.js";

const LIST = "GET /repos/o/r/dependabot/secrets?per_page=100&page=1";
const PUBLIC_KEY = "GET /repos/o/r/dependabot/secrets/public-key";

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

function applyCtx(api: MockApi, resolved: Record<string, string>): SectionContext {
  return { ...ctx(api), resolveSecret: (reference) => resolved[reference] ?? "" };
}

describe("dependabot_secrets", () => {
  test("check mode: drift and notes carry this section's label and noun", async () => {
    const api = new MockApi({ [LIST]: listOf("LEGACY") });
    const result = await dependabotSecretsSection.run(ctx(api, true), [
      { name: "REGISTRY_TOKEN", value: "$R" },
    ]);
    expect(result.drift).toEqual([
      "dependabot_secrets[REGISTRY_TOKEN]: missing - declared in the settings file but not on the repo; apply will create it",
    ]);
    expect(result.notes.join("\n")).toContain('Dependabot secret "LEGACY" exists on the repo');
    expect(result.notes.join("\n")).toContain("Dependabot secret values cannot be read back");
    expect(api.mutations()).toEqual([]);
  });

  test("apply seals against the Dependabot public key and PUTs this family's route", async () => {
    await mockSodiumReady();
    const api = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "dep-key", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations("PUT /repos/o/r/dependabot/secrets/REGISTRY_TOKEN");
    const result = await dependabotSecretsSection.run(applyCtx(api, { $R: "registry-plain" }), [
      { name: "REGISTRY_TOKEN", value: "$R" },
    ]);
    expect(result.changes).toEqual(['created secret "REGISTRY_TOKEN"']);
    const put = api.mutations().find((c) => c.method === "PUT");
    expect(put?.path).toBe("/repos/o/r/dependabot/secrets/REGISTRY_TOKEN");
    const payload = put?.payload as { encrypted_value: string; key_id: string };
    expect(payload.key_id).toBe("dep-key");
    expect(unsealSecretValue(payload.encrypted_value)).toBe("registry-plain");
  });

  test("undeclared secrets are kept by default and deleted only under the knob", async () => {
    expect(dependabotSecretsSection.undeclaredDefault).toBe("keep");
    const api = new MockApi({ [LIST]: listOf("STALE") }).allowMutations(
      "DELETE /repos/o/r/dependabot/secrets/STALE",
    );
    const result = await dependabotSecretsSection.run(ctx(api), {
      undeclared: "delete",
      entries: [],
    });
    expect(result.changes).toEqual(['DELETED undeclared secret "STALE"']);
  });
});

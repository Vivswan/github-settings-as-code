/**
 * codespaces_secrets section tests: the engine behavior (existence
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
import type { SectionContext } from "../contract.js";
import { codespacesSecretsSection } from "./index.js";

const LIST = "GET /repos/o/r/codespaces/secrets?per_page=100&page=1";
const PUBLIC_KEY = "GET /repos/o/r/codespaces/secrets/public-key";

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

describe("codespaces_secrets", () => {
  test("check mode: drift and notes carry this section's label and noun", async () => {
    const api = new MockApi({ [LIST]: listOf("LEGACY") });
    const result = await codespacesSecretsSection.run(ctx(api, true), [
      { name: "DOTFILES_PAT", value: "$D" },
    ]);
    expect(result.drift).toEqual([
      "codespaces_secrets[DOTFILES_PAT]: missing - declared in the settings file but not on the repo; apply will create it",
    ]);
    expect(result.notes.join("\n")).toContain('Codespaces secret "LEGACY" exists on the repo');
    expect(result.notes.join("\n")).toContain("Codespaces secret values cannot be read back");
    expect(api.mutations()).toEqual([]);
  });

  test("apply seals against the Codespaces public key and PUTs this family's route", async () => {
    await mockSodiumReady();
    const api = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "cs-key", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations("PUT /repos/o/r/codespaces/secrets/DOTFILES_PAT");
    const result = await codespacesSecretsSection.run(applyCtx(api, { $D: "dotfiles-plain" }), [
      { name: "DOTFILES_PAT", value: "$D" },
    ]);
    expect(result.changes).toEqual(['created secret "DOTFILES_PAT"']);
    const put = api.mutations().find((c) => c.method === "PUT");
    expect(put?.path).toBe("/repos/o/r/codespaces/secrets/DOTFILES_PAT");
    const payload = put?.payload as { encrypted_value: string; key_id: string };
    expect(payload.key_id).toBe("cs-key");
    expect(unsealSecretValue(payload.encrypted_value)).toBe("dotfiles-plain");
  });

  test("undeclared secrets are kept by default and deleted only under the knob", async () => {
    expect(codespacesSecretsSection.undeclaredDefault).toBe("keep");
    const api = new MockApi({ [LIST]: listOf("STALE") }).allowMutations(
      "DELETE /repos/o/r/codespaces/secrets/STALE",
    );
    const result = await codespacesSecretsSection.run(ctx(api), {
      undeclared: "delete",
      entries: [],
    });
    expect(result.changes).toEqual(['DELETED undeclared secret "STALE"']);
  });
});

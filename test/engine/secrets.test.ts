import { describe, expect, test } from "bun:test";

import { applyDefaults } from "../../src/engine/merge.js";
import {
  runForRepo,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { collectSecretValues, targetSecretSource } from "../../src/engine/secrets.js";
import { type Io, maskRegistry } from "../../src/io.js";
import type { SectionKey, SettingsFile } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { MOCK_SECRETS_KEY_ID, MOCK_SECRETS_PUBLIC_KEY } from "../e2e/mock/secrets.js";
import { MockApi } from "../mock-api.js";

/** The operator defaults under test: one fleet secret fanned out to targets. */
const FLEET_DEFAULTS = {
  actions_secrets: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
} as SettingsFile;

/** Merge a target document over defaults and collect the surviving secret values. */
function mergedValues(defaults: SettingsFile, targetDoc: SettingsFile) {
  const { settings } = applyDefaults(defaults, targetDoc);
  // The merge under test emits an unvalidated document; the collection walk
  // is what these tests exercise, so the boundary cast lives here.
  return collectSecretValues(settings as SettingsFile, SECTIONS, targetSecretSource(targetDoc));
}

function captureIo(): { io: Io; annotations: string[] } {
  const annotations: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: () => {},
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry(() => {}),
    },
    annotations,
  };
}

/** The label collectSecretValues derives for the fleet secret entry. */
const FLEET_LABEL = 'the secret entry "FLEET_TOKEN"';
/** The label webhooks derives for the test hook's config.secret. */
const HOOK_LABEL = 'the webhook "https://x.test/h" config.secret';

describe("secret provenance through the defaults merge", () => {
  // Both targets leave actions_secrets undeclared, so the same branch keeps
  // the defaults' values operator-sourced.
  test.each([
    ["a target declaring nothing", {} as SettingsFile],
    [
      "a target declaring an unrelated section",
      { labels: [{ name: "healthy", color: "00ff00" }] } as SettingsFile,
    ],
  ])("%s leaves the defaults' values operator-sourced", (_name, targetDoc) => {
    expect(mergedValues(FLEET_DEFAULTS, targetDoc)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
  });

  test("a target redeclaring the section owns the merged values, same string or not", () => {
    const targetDoc = {
      actions_secrets: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
    } as SettingsFile;
    expect(mergedValues(FLEET_DEFAULTS, targetDoc)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "target" },
    ]);
  });

  test("the same reference string in a different target section never conflates", () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    expect(
      mergedValues(FLEET_DEFAULTS, targetDoc).sort((a, b) => (a.section < b.section ? -1 : 1)),
    ).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
      { section: "webhooks", label: HOOK_LABEL, value: "$FLEET_TOKEN", source: "target" },
    ]);
  });

  test("a different reference in a target section attributes per section", () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$HOOK_SECRET" } }],
    } as SettingsFile;
    expect(
      mergedValues(FLEET_DEFAULTS, targetDoc).sort((a, b) => (a.section < b.section ? -1 : 1)),
    ).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
      { section: "webhooks", label: HOOK_LABEL, value: "$HOOK_SECRET", source: "target" },
    ]);
  });

  test("a target's null opt-out strips the section: nothing left to attribute", () => {
    const targetDoc = { actions_secrets: null } as unknown as SettingsFile;
    expect(mergedValues(FLEET_DEFAULTS, targetDoc)).toEqual([]);
  });

  test("the wrapped undeclared-policy form attributes like the plain array", () => {
    const wrappedDefaults = {
      actions_secrets: {
        undeclared: "delete",
        entries: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
      },
    } as SettingsFile;
    expect(mergedValues(wrappedDefaults, {} as SettingsFile)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
    const targetDoc = {
      actions_secrets: { entries: [{ name: "OWN_TOKEN", value: "$OWN_TOKEN" }] },
    } as SettingsFile;
    expect(mergedValues(wrappedDefaults, targetDoc)).toEqual([
      {
        section: "actions_secrets",
        label: 'the secret entry "OWN_TOKEN"',
        value: "$OWN_TOKEN",
        source: "target",
      },
    ]);
  });

  test("a malformed target wrapper evicts the defaults' section: no operator value survives", () => {
    // The merge's isMalformedWrapper guard keeps a target's broken wrapper
    // (here: no entries array) from inheriting the defaults' entries - so
    // there is no path where the operator's reference rides into a
    // target-owned section. Shape validation reports the wrapper error; this
    // pins that provenance never sees a value from the evicted section.
    const targetDoc = { actions_secrets: { undeclared: "delete" } } as unknown as SettingsFile;
    expect(mergedValues(FLEET_DEFAULTS, targetDoc)).toEqual([]);
  });

  test("no defaults-file secret value survives into a target-declared section, per section", () => {
    // The availability half of the provenance invariant, made mechanical:
    // attribution treats a target-declared section's merged values as the
    // target's, which is sound only while the merge replaces every
    // secret-bearing container wholesale. Arrays do that today; a future
    // secretValues section on a DEEP-MERGED object shape would let a
    // defaults value survive with "target" attribution and be over-refused.
    // Every secretValues-declaring section must have a factory here, so a
    // new secret family fails this test until its shape is covered.
    const factories: Partial<Record<SectionKey, (ref: string) => unknown>> = {
      actions_secrets: (ref) => [{ name: "S", value: ref }],
      dependabot_secrets: (ref) => [{ name: "S", value: ref }],
      codespaces_secrets: (ref) => [{ name: "S", value: ref }],
      agents_secrets: (ref) => [{ name: "S", value: ref }],
      webhooks: (ref) => [{ config: { url: "https://x.test/h", secret: ref } }],
      environments: (ref) => [{ name: "prod", secrets: [{ name: "S", value: ref }] }],
    };
    for (const section of SECTIONS) {
      if (section.secretValues === undefined) {
        continue;
      }
      const make = factories[section.key];
      expect(make, `no merge-invariant factory for secret section "${section.key}"`).toBeDefined();
      if (!make) {
        continue;
      }
      const defaults = { [section.key]: make("$DEFAULTS_ONLY_REF") } as SettingsFile;
      const targetDoc = { [section.key]: make("$TARGET_ONLY_REF") } as SettingsFile;
      const values = mergedValues(defaults, targetDoc);
      expect(values.length, `${section.key}: the target's value must survive`).toBeGreaterThan(0);
      for (const value of values) {
        expect(value.source, `${section.key}: target-declared section`).toBe("target");
        expect(
          value.value,
          `${section.key}: a defaults value survived into the target's section`,
        ).toBe("$TARGET_ONLY_REF");
      }
    }
  });

  test("a target's environments array replaces the defaults' wholesale, nested secrets included", () => {
    const envDefaults = {
      environments: [{ name: "prod", secrets: [{ name: "D", value: "$FLEET_TOKEN" }] }],
    } as SettingsFile;
    expect(mergedValues(envDefaults, {} as SettingsFile)).toEqual([
      {
        section: "environments",
        label: 'the secret entry "D" of environment "prod"',
        value: "$FLEET_TOKEN",
        source: "operator",
      },
    ]);
    const targetDoc = {
      environments: [{ name: "prod", secrets: [{ name: "T", value: "$ENV_SECRET" }] }],
    } as SettingsFile;
    expect(mergedValues(envDefaults, targetDoc)).toEqual([
      {
        section: "environments",
        label: 'the secret entry "T" of environment "prod"',
        value: "$ENV_SECRET",
        source: "target",
      },
    ]);
  });
});

describe("runForRepo with merged provenance", () => {
  // The merged doc is branded through the REAL boundary, exactly like the
  // run flows; an invalid merge output fails here instead of riding a cast.
  const validated = (doc: unknown): ValidatedSettings => {
    const silent: Io = {
      annotate: () => {},
      log: () => {},
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry(() => {}),
    };
    const verdict = validateSettingsDoc(doc, "merged fixture", new Set(), silent);
    if ("error" in verdict) {
      throw new Error(`merged fixture failed validation: ${verdict.error}`);
    }
    return verdict.settings;
  };
  const runOpts = (settings: unknown, targetDoc: SettingsFile) => ({
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: validated(settings),
    onMissingPermission: "fail" as const,
    requiredSections: new Set<SectionKey>(),
    onlySections: new Set<SectionKey>(),
    secretSource: targetSecretSource(targetDoc),
  });

  test("the conflation case fails only the target's own section", async () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    const { settings } = applyDefaults(FLEET_DEFAULTS, targetDoc);
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const result = await runForRepo(
      api,
      { ...runOpts(settings, targetDoc), mode: "check" as const },
      io,
    );
    expect(result.result).toBe("failed");
    // Refusal names the webhook the target declared; the operator's
    // actions_secrets section is not dragged down by string equality.
    expect(result.outcomes).toEqual([
      { key: "webhooks", status: "failed", detail: [expect.stringContaining("target-fetched")] },
    ]);
    expect(annotations.filter((a) => a.includes("actions_secrets"))).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  test("the defaults' reference resolves when the target declared only an unrelated section", async () => {
    const defaults = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    const targetDoc = { labels: [{ name: "healthy", color: "00ff00" }] } as SettingsFile;
    const { settings } = applyDefaults(defaults, targetDoc);
    const api = new MockApi({
      "GET /repos/o/r/hooks?per_page=100&page=1": { data: [] },
      "GET /repos/o/r/labels?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/r/hooks", "POST /repos/o/r/labels");
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      {
        ...runOpts(settings, targetDoc),
        mode: "apply" as const,
        secretEnv: { FLEET_TOKEN: "fleet-plaintext" },
      },
      io,
    );
    expect(result.result).toBe("applied");
    const hookPost = api.mutations().find((c) => c.path === "/repos/o/r/hooks") as unknown as {
      payload?: { config?: { secret?: string } };
    };
    expect(hookPost?.payload?.config?.secret).toBe("fleet-plaintext");
  });

  test("a target reference in a section excluded by `sections` cannot poison the defaults' fan-out", async () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    const { settings } = applyDefaults(FLEET_DEFAULTS, targetDoc);
    const api = new MockApi({
      "GET /repos/o/r/actions/secrets?per_page=100&page=1": {
        data: { total_count: 0, secrets: [] },
      },
      // The plan reads the sealing key beside the list in every mode.
      "GET /repos/o/r/actions/secrets/public-key": {
        data: { key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY },
      },
    });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      {
        ...runOpts(settings, targetDoc),
        mode: "check" as const,
        onlySections: new Set(["actions_secrets"]),
      },
      io,
    );
    // The excluded webhooks section contributes no values, and the merged
    // actions_secrets section is the operator's: check reports the missing
    // secret as drift instead of refusing the operator's own reference.
    expect(result.result).toBe("drift");
    expect(result.outcomes.find((o) => o.key === "actions_secrets")?.status).toBe("drift");
  });
});

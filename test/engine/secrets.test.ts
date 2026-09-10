import { describe, expect, test } from "bun:test";

import {
  runForRepo,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { collectSecretValues, targetSecretSource } from "../../src/engine/secrets.js";
import { type Io, maskRegistry } from "../../src/io.js";
import type { SectionKey, SettingsFile } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { MockApi } from "../mock-api.js";

/** The operator defaults under test: one fleet secret, applied whole to fileless targets. */
const FLEET_DEFAULTS = {
  actions_secrets: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
} as SettingsFile;

/**
 * The secret values of a remote target's OWN document, attributed the way
 * multi.ts attributes them: per section, from the document's own key set.
 */
function targetValues(targetDoc: SettingsFile) {
  return collectSecretValues(targetDoc, SECTIONS, targetSecretSource(targetDoc));
}

/**
 * The secret values of the defaults document applied whole to a target that
 * has no file: no provenance lookup is passed, so every value is the
 * operator's (the runForRepo default).
 */
function fallbackValues(defaults: SettingsFile) {
  return collectSecretValues(defaults, SECTIONS, () => "operator");
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

describe("secret provenance of a remote target's own document", () => {
  test.each([
    ["a target declaring nothing", {} as SettingsFile],
    [
      "a target declaring a secret-free section",
      { labels: [{ name: "healthy", color: "00ff00" }] } as SettingsFile,
    ],
  ])("%s contributes no secret values", (_name, targetDoc) => {
    expect(targetValues(targetDoc)).toEqual([]);
  });

  test("a target declaring a secret section owns its values, whatever the reference string", () => {
    const targetDoc = {
      actions_secrets: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
    } as SettingsFile;
    expect(targetValues(targetDoc)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "target" },
    ]);
  });

  test("a target's webhook secret is the target's, attributed per section", () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$HOOK_SECRET" } }],
    } as SettingsFile;
    expect(targetValues(targetDoc)).toEqual([
      { section: "webhooks", label: HOOK_LABEL, value: "$HOOK_SECRET", source: "target" },
    ]);
  });

  test("no section layers its entries by key AND carries secret values", () => {
    // Provenance attributes a target-declared section's values to the target
    // wholesale; a keyed union (engine/layers.ts) would let a lower layer's
    // secret survive into a higher-declared section under the wrong source.
    expect(
      SECTIONS.filter((s) => s.layering !== undefined && s.secretValues !== undefined).map(
        (s) => s.key,
      ),
    ).toEqual([]);
  });

  test("the wrapped undeclared-policy form attributes like the plain array", () => {
    const targetDoc = {
      actions_secrets: { entries: [{ name: "OWN_TOKEN", value: "$OWN_TOKEN" }] },
    } as SettingsFile;
    expect(targetValues(targetDoc)).toEqual([
      {
        section: "actions_secrets",
        label: 'the secret entry "OWN_TOKEN"',
        value: "$OWN_TOKEN",
        source: "target",
      },
    ]);
  });

  test("nested environment secrets are the target's", () => {
    const targetDoc = {
      environments: [{ name: "prod", secrets: [{ name: "T", value: "$ENV_SECRET" }] }],
    } as SettingsFile;
    expect(targetValues(targetDoc)).toEqual([
      {
        section: "environments",
        label: 'the secret entry "T" of environment "prod"',
        value: "$ENV_SECRET",
        source: "target",
      },
    ]);
  });

  test("every secret-declaring section attributes a target-declared section to the target", () => {
    // The availability half of the provenance invariant, made mechanical: a
    // target's document is applied as written, so every value in a section it
    // declares is the target's own. Every secretValues-declaring section must
    // have a factory here, so a new secret family fails this test until its
    // shape is covered.
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
      expect(make, `no provenance factory for secret section "${section.key}"`).toBeDefined();
      if (!make) {
        continue;
      }
      // Each factory declares exactly one secret, so exactly one value is
      // collected, and it is the target's.
      const targetDoc = { [section.key]: make("$TARGET_ONLY_REF") } as SettingsFile;
      expect(
        targetValues(targetDoc).map((value) => [value.section, value.value, value.source]),
        `${section.key}: target-declared section`,
      ).toEqual([[section.key, "$TARGET_ONLY_REF", "target"]]);
    }
  });
});

describe("secret provenance of a fallback-applied defaults document", () => {
  test("the plain array form is the operator's", () => {
    expect(fallbackValues(FLEET_DEFAULTS)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
  });

  test("the wrapped undeclared-policy form is the operator's", () => {
    const wrappedDefaults = {
      actions_secrets: {
        undeclared: "delete",
        entries: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
      },
    } as SettingsFile;
    expect(fallbackValues(wrappedDefaults)).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
  });

  test("nested environment secrets are the operator's", () => {
    const envDefaults = {
      environments: [{ name: "prod", secrets: [{ name: "D", value: "$FLEET_TOKEN" }] }],
    } as SettingsFile;
    expect(fallbackValues(envDefaults)).toEqual([
      {
        section: "environments",
        label: 'the secret entry "D" of environment "prod"',
        value: "$FLEET_TOKEN",
        source: "operator",
      },
    ]);
  });
});

describe("runForRepo provenance", () => {
  // Each document is branded through the REAL boundary, exactly like the run
  // flows; an invalid fixture fails here instead of riding a cast.
  const validated = (doc: unknown): ValidatedSettings => {
    const silent: Io = {
      annotate: () => {},
      log: () => {},
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry(() => {}),
    };
    const verdict = validateSettingsDoc(doc, "fixture", new Set(), silent);
    if ("error" in verdict) {
      throw new Error(`fixture failed validation: ${verdict.error}`);
    }
    return verdict.settings;
  };
  const baseOpts = (settings: unknown) => ({
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: validated(settings),
    onMissingPermission: "fail" as const,
    requiredSections: new Set<SectionKey>(),
    onlySections: new Set<SectionKey>(),
  });
  /** A remote target's own document: target provenance per declared section. */
  const targetOpts = (targetDoc: SettingsFile) => ({
    ...baseOpts(targetDoc),
    secretSource: targetSecretSource(targetDoc),
  });

  test("a target's own reference is refused for exactly the section that declared it", async () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const result = await runForRepo(api, { ...targetOpts(targetDoc), mode: "check" as const }, io);
    expect(result.result).toBe("failed");
    expect(result.outcomes).toEqual([
      { key: "webhooks", status: "failed", detail: [expect.stringContaining("target-fetched")] },
    ]);
    expect(annotations.filter((a) => a.includes("actions_secrets"))).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  test("a fallback-applied defaults reference resolves from the operator environment", async () => {
    // The defaults document runs without a provenance lookup (multi.ts passes
    // none for a fileless target), so its $FLEET_TOKEN is the operator's and
    // the resolved plaintext reaches the request.
    const defaults = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
    } as SettingsFile;
    const api = new MockApi({
      "GET /repos/o/r/hooks?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/r/hooks");
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      {
        ...baseOpts(defaults),
        mode: "apply" as const,
        secretEnv: { FLEET_TOKEN: "fleet-plaintext" },
      },
      io,
    );
    expect(result.result).toBe("applied");
    expect(api.mutations()).toEqual([
      {
        method: "POST",
        path: "/repos/o/r/hooks",
        payload: {
          name: "web",
          config: { url: "https://x.test/h", secret: "fleet-plaintext" },
        },
      },
    ]);
  });

  test("a target reference in a section excluded by `sections` is never refused", async () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$FLEET_TOKEN" } }],
      labels: [{ name: "healthy", color: "00ff00" }],
    } as SettingsFile;
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": {
        data: [{ name: "healthy", color: "00ff00", description: null }],
      },
    });
    const { io } = captureIo();
    const result = await runForRepo(
      api,
      {
        ...targetOpts(targetDoc),
        mode: "check" as const,
        onlySections: new Set(["labels"]),
      },
      io,
    );
    // The excluded webhooks section contributes no values, so its target
    // reference is never collected, let alone refused.
    expect(result.result).toBe("clean");
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["labels", "clean"],
      ["webhooks", "excluded"],
    ]);
  });
});

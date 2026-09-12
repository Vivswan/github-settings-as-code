import { describe, expect, test } from "bun:test";
import {
  runForRepo,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { type SettingsSource, validateSecretRef } from "../../src/engine/secret-refs.js";
import { collectSecretValues, snapshotSecretReference } from "../../src/engine/secrets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { type Io, maskRegistry } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import type { SectionKey, SettingsFile } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { MockApi } from "../mock-api.js";

/** The operator defaults under test: one fleet secret, applied whole to fileless targets. */
const FLEET_DEFAULTS = {
  actions_secrets: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
} as SettingsFile;

/** The secret values of one document under the provenance multi.ts decides for its kind. */
function valuesOf(doc: SettingsFile, source: SettingsSource) {
  return collectSecretValues(doc, SECTIONS, source);
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

/** One document shape per secret-declaring section; a new secret family fails the whole-document tests until its shape is added here. */
const SECRET_SHAPES: Partial<Record<SectionKey, (ref: string) => unknown>> = {
  actions_secrets: (ref) => [{ name: "S", value: ref }],
  dependabot_secrets: (ref) => [{ name: "S", value: ref }],
  codespaces_secrets: (ref) => [{ name: "S", value: ref }],
  agents_secrets: (ref) => [{ name: "S", value: ref }],
  webhooks: (ref) => [{ config: { url: "https://x.test/h", secret: ref } }],
  environments: (ref) => [{ name: "prod", secrets: [{ name: "S", value: ref }] }],
};

/** Every secret-declaring section paired with its one-secret document. */
function secretDocs(ref: string): Array<[SectionKey, SettingsFile]> {
  return SECTIONS.filter((section) => section.secretValues !== undefined).map((section) => {
    const make = SECRET_SHAPES[section.key];
    expect(make, `no secret shape for section "${section.key}"`).toBeDefined();
    if (!make) {
      throw new Error(`no secret shape for section "${section.key}"`);
    }
    return [section.key, { [section.key]: make(ref) } as SettingsFile];
  });
}

describe("secret provenance is one source per document", () => {
  test.each([
    ["a document declaring nothing", {} as SettingsFile],
    [
      "a document declaring a secret-free section",
      { labels: [{ name: "healthy", color: "00ff00" }] } as SettingsFile,
    ],
  ])("%s contributes no secret values under either source", (_name, doc) => {
    expect(valuesOf(doc, "target")).toEqual([]);
    expect(valuesOf(doc, "operator")).toEqual([]);
  });

  test.each<[string, SettingsSource]>([
    ["a remote target's own document is the target's", "target"],
    ["an operator document (central file or defaults fallback) is the operator's", "operator"],
  ])("every value in %s, whatever the reference string", (_name, source) => {
    // The source is the document's, never the string's: a target naming the operator's own $FLEET_TOKEN gains nothing.
    for (const [key, doc] of secretDocs("$FLEET_TOKEN")) {
      expect(
        valuesOf(doc, source).map((value) => [value.section, value.value, value.source]),
        `${key}: ${source} document`,
      ).toEqual([[key, "$FLEET_TOKEN", source]]);
    }
  });

  test("labels name the declaring entry, for a target and an operator document alike", () => {
    const targetDoc = {
      webhooks: [{ config: { url: "https://x.test/h", secret: "$HOOK_SECRET" } }],
    } as SettingsFile;
    expect(valuesOf(targetDoc, "target")).toEqual([
      { section: "webhooks", label: HOOK_LABEL, value: "$HOOK_SECRET", source: "target" },
    ]);
    expect(valuesOf(FLEET_DEFAULTS, "operator")).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
  });

  test("the wrapped undeclared-policy form carries the document's source like the plain array", () => {
    const wrapped = {
      actions_secrets: {
        _undeclared: "delete",
        entries: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
      },
    } as SettingsFile;
    expect(valuesOf(wrapped, "target")).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "target" },
    ]);
    expect(valuesOf(wrapped, "operator")).toEqual([
      { section: "actions_secrets", label: FLEET_LABEL, value: "$FLEET_TOKEN", source: "operator" },
    ]);
  });

  test.each<[SettingsSource]>([["target"], ["operator"]])(
    "a document mixing several secret sections carries the %s source throughout",
    (source) => {
      const doc = {
        actions_secrets: [{ name: "A", value: "$A" }],
        webhooks: [{ config: { url: "https://x.test/h", secret: "$H" } }],
        environments: [{ name: "prod", secrets: [{ name: "E", value: "$E" }] }],
      } as SettingsFile;
      // Registry order, so a dropped or duplicated value fails the comparison.
      expect(valuesOf(doc, source)).toEqual([
        {
          section: "environments",
          label: 'the secret entry "E" of environment "prod"',
          value: "$E",
          source,
        },
        { section: "actions_secrets", label: 'the secret entry "A"', value: "$A", source },
        { section: "webhooks", label: HOOK_LABEL, value: "$H", source },
      ]);
    },
  );
});

describe("runForRepo provenance", () => {
  // Branded through the REAL boundary, so an invalid fixture fails here instead of riding a cast.
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
    if (verdict.isErr()) {
      throw new Error(`fixture failed validation: ${describeProblem(verdict.error)}`);
    }
    return verdict.value;
  };
  const baseOpts = (settings: unknown) => ({
    repo: { owner: "o", name: "r", slug: "o/r" },
    settings: validated(settings),
    onMissingPermission: "fail" as const,
    sections: SectionSelection.ALL,
  });
  /** A remote target's own document, run the way multi.ts runs it. */
  const targetOpts = (targetDoc: SettingsFile) => ({
    ...baseOpts(targetDoc),
    secretSource: "target" as const,
  });

  test("a target document's reference is refused, naming the declaring section only", async () => {
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
    // The defaults document runs as "operator" (multi.ts decides that for a fileless target), so its $FLEET_TOKEN resolves.
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
        secretSource: "operator" as const,
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
        sections: SectionSelection.of({ only: ["labels"] })._unsafeUnwrap(),
      },
      io,
    );
    // The excluded webhooks section contributes no values, so its target reference is never collected, let alone refused.
    expect(result.result).toBe("clean");
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["labels", "clean"],
      ["webhooks", "excluded"],
    ]);
  });
});

describe("snapshotSecretReference", () => {
  test("is injective across the names one store can hold and across stores holding one name", () => {
    // INPUT_TOKEN and SECRET_INPUT_TOKEN are both legal GitHub secret names; a bare escape of the
    // reserved INPUT_ prefix would have folded them into one variable.
    const inStore = ["INPUT_TOKEN", "SECRET_INPUT_TOKEN", "GITHUB_PAT", "TOKEN"].map((name) =>
      snapshotSecretReference("actions", name),
    );
    expect(inStore).toEqual([
      { variable: "SECRET_ACTIONS_INPUT_TOKEN", reference: "$SECRET_ACTIONS_INPUT_TOKEN" },
      {
        variable: "SECRET_ACTIONS_SECRET_INPUT_TOKEN",
        reference: "$SECRET_ACTIONS_SECRET_INPUT_TOKEN",
      },
      { variable: "SECRET_ACTIONS_GITHUB_PAT", reference: "$SECRET_ACTIONS_GITHUB_PAT" },
      { variable: "SECRET_ACTIONS_TOKEN", reference: "$SECRET_ACTIONS_TOKEN" },
    ]);
    const acrossStores = ["dependabot", "codespaces", "agents"].map(
      (store) => snapshotSecretReference(store, "TOKEN").variable,
    );
    expect(new Set([...inStore.map((r) => r.variable), ...acrossStores]).size).toBe(
      inStore.length + acrossStores.length,
    );
    // Every minted reference passes the grammar the settings file enforces.
    for (const { reference } of inStore) {
      expect(validateSecretRef(reference, "operator", "x")).toEqual({
        ok: true,
        ref: { name: reference.slice(1) },
      });
    }
  });
});

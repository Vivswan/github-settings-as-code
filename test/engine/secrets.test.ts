import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { type ValidatedSettings, validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { type SettingsSource, validateSecretRef } from "../../src/engine/secret-refs.js";
import { collectSecretReferences, snapshotSecretReference } from "../../src/engine/secrets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { silentIo } from "../../src/io.js";
import type { SectionKey, SettingsFile } from "../../src/schema.js";
import { SECTIONS } from "../../src/sections/registry.js";

/** The label the actions_secrets module derives for the fleet secret entry. */
const FLEET_LABEL = 'the secret entry "FLEET_TOKEN"';

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

/** The issues validation raises for one document under the provenance multi.ts decides for its kind. */
function issuesUnder(doc: SettingsFile, source: SettingsSource): readonly string[] {
  return validateSectionShapes(doc as Record<string, unknown>, "f.yml", source).match(
    () => [],
    (problem) => problem.issues,
  );
}

/** The operator's document as the run receives it: the collector takes validation's proof, never a raw file. */
function validated(doc: SettingsFile): ValidatedSettings {
  return validateSettingsDoc(doc, "f.yml", SectionSelection.ALL, silentIo()).match(
    (settings) => settings,
    (problem) => {
      throw new Error(`fixture failed validation: ${JSON.stringify(problem)}`);
    },
  );
}

describe("secret provenance is one source per document, judged at validation", () => {
  test("every secret-declaring section's reference is refused in a target document and admitted in an operator's, whatever the string", () => {
    // The source is the document's, never the string's: a target naming the operator's own $FLEET_TOKEN gains nothing.
    for (const [key, doc] of secretDocs("$FLEET_TOKEN")) {
      expect(issuesUnder(doc, "operator"), `${key}: operator document`).toEqual([]);
      expect(issuesUnder(doc, "target"), `${key}: target document`).toEqual([
        expect.stringMatching(
          new RegExp(
            `^${key}: .* uses the secret reference \\$FLEET_TOKEN in a target-fetched settings file`,
          ),
        ),
      ]);
    }
  });

  test("the wrapped undeclared-policy form is judged and collected like the plain array", () => {
    const wrapped = {
      actions_secrets: {
        _undeclared: "delete",
        entries: [{ name: "FLEET_TOKEN", value: "$FLEET_TOKEN" }],
      },
    } as SettingsFile;
    expect(issuesUnder(wrapped, "target")).toEqual([
      expect.stringContaining(
        `actions_secrets: ${FLEET_LABEL} uses the secret reference $FLEET_TOKEN`,
      ),
    ]);
    expect(collectSecretReferences(validated(wrapped), SECTIONS)).toEqual([
      { section: "actions_secrets", name: "FLEET_TOKEN" },
    ]);
  });

  test("a document mixing several secret sections is collected throughout, in registry order", () => {
    const doc = {
      actions_secrets: [{ name: "A", value: "$A" }],
      webhooks: [{ config: { url: "https://x.test/h", secret: "$H" } }],
      environments: [{ name: "prod", secrets: [{ name: "E", value: "$E" }] }],
    } as SettingsFile;
    // Registry order, so a dropped or duplicated reference fails the comparison.
    expect(collectSecretReferences(validated(doc), SECTIONS)).toEqual([
      { section: "environments", name: "E" },
      { section: "actions_secrets", name: "A" },
      { section: "webhooks", name: "H" },
    ]);
    expect(issuesUnder(doc, "target").map((issue) => issue.split(":")[0])).toEqual([
      "environments",
      "actions_secrets",
      "webhooks",
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
      expect(validateSecretRef(reference, "operator", "x")).toEqual(
        ok({ name: reference.slice(1) }),
      );
    }
  });
});

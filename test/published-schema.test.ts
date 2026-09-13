/**
 * lib/settings.schema.json is what editors and CI linters validate settings.yml against, so where the runtime is strict the schema must be too.
 * schema-corpus.test.ts compares the two over every scenario and generated document; the documents here are the edge shapes that corpus never
 * carries (wrapper and entry typos, a bad directive value, a quoted boolean, the nested knobs' wrapped forms), each judged by both validators.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { ok } from "neverthrow";
import { validateSectionShapes } from "../src/engine/validate.js";
import { SettingsFile, UNDECLARED_POLICY_SECTIONS } from "../src/schema.js";
import { FLAG_PAIRING_FIXTURES } from "./fixtures/environment-flag-pairing.js";
import { ROOT } from "./root.js";

const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8")) as {
  definitions: Record<string, Record<string, unknown>>;
};

// strict: false because the generated schema carries draft-07 idioms AJV's strict mode complains about; validation semantics are unchanged.
const ajv = new Ajv({ strict: false, allErrors: true });
const validate: ValidateFunction = ajv.compile(schema);

const runtimeAccepts = (doc: Record<string, unknown>): boolean =>
  !("error" in validateSectionShapes(doc, "fixture"));

/** One environments[] entry named prod, the host of every nested knob. */
const prod = (entry: Record<string, unknown>) => ({ environments: [{ name: "prod", ...entry }] });
const customPolicies = { protected_branches: false, custom_branch_policies: true };

describe("published schema wrapper strictness", () => {
  test("one closed wrapper definition per knobbed section and nested knob", () => {
    const wrappers = Object.entries(schema.definitions).filter(([name]) =>
      name.startsWith("UndeclaredPolicyList<"),
    );
    // The four nested {_undeclared, entries} knobs inside an environment entry: variables, secrets, branch policies, protection rules.
    expect(wrappers.length).toBe(UNDECLARED_POLICY_SECTIONS.length + 4);
    for (const [name, definition] of wrappers) {
      expect(
        definition.additionalProperties,
        `${name} must carry additionalProperties: false (the strictObject wrapper emits it)`,
      ).toBe(false);
    }
  });
});

describe("the published schema and the runtime agree on the shapes the corpus never carries", () => {
  test.each<[string, Record<string, unknown>, boolean]>([
    [
      "a typo key inside a wrapper",
      { labels: { _undeclared: "keep", entires: [], entries: [] } },
      false,
    ],
    ["a bad policy value", { rulesets: { _undeclared: "remove", entries: [] } }, false],
    [
      "the nested variables knob, wrapped",
      prod({ variables: { _undeclared: "keep", entries: [{ name: "A", value: "1" }] } }),
      true,
    ],
    [
      "a typo key inside the nested variables wrapper",
      prod({ variables: { entires: [], entries: [] } }),
      false,
    ],
    [
      "the nested branch-policies knob, wrapped",
      prod({
        deployment_branch_policy: customPolicies,
        deployment_branch_policies: { _undeclared: "keep", entries: [{ name: "main" }] },
      }),
      true,
    ],
    [
      "the nested protection-rules knob, wrapped",
      prod({ deployment_protection_rules: { _undeclared: "delete", entries: [{ app: "gate" }] } }),
      true,
    ],
    [
      "a typo key inside the nested protection-rules wrapper",
      prod({ deployment_protection_rules: { entires: [], entries: [] } }),
      false,
    ],
    // The enable call sends only the App's resolved integration id, so the entry is closed on both sides.
    [
      "an extra key on a protection-rule entry",
      prod({ deployment_protection_rules: [{ app: "gate", extra: 1 }] }),
      false,
    ],
    // strictObject surfaces: an extra key has no passthrough destination, so a typo fails upfront instead of on the run.
    [
      "an extra key on an environment secret",
      prod({ secrets: [{ name: "A", value: "$A", extra: 1 }] }),
      false,
    ],
    ["a typo key inside actions.cache", { actions: { cache: { max_cache_size: 25 } } }, false],
    [
      "an extra key inside required_deployments",
      {
        branches: [
          {
            name: "main",
            protection: { required_deployments: { environments: ["prod"], extra: 1 } },
          },
        ],
      },
      false,
    ],
    // Typed boolean so a YAML-quoted "yes" fails upfront instead of riding the protection PUT (which drops the key) and never reaching the
    // signatures sub-endpoint.
    [
      "a quoted required_signatures",
      { branches: [{ name: "main", protection: { required_signatures: "yes" } }] },
      false,
    ],
    // Entry fields pass through to the API verbatim, so a field GitHub ships tomorrow must validate today.
    [
      "an extra field on a nested variable entry",
      prod({ variables: [{ name: "A", value: "1", extra_field: "x" }] }),
      true,
    ],
    [
      "an extra field on an actions variable entry",
      { actions_variables: [{ name: "A", value: "1", extra_field: "x" }] },
      true,
    ],
  ])("%s", (_shape, doc, accepted) => {
    expect(validate(doc), "published schema").toBe(accepted);
    expect(runtimeAccepts(doc), "runtime validateSectionShapes").toBe(accepted);
  });

  test("the branch-policy type enum is the one shape where the schema is the stricter side", () => {
    // The published schema pins the documented upstream enum; the runtime shape stays a loose string, GitHub being the authority there.
    const doc = prod({
      deployment_branch_policy: customPolicies,
      deployment_branch_policies: [{ name: "v*", type: "wildcard" }],
    });
    expect(validate(doc)).toBe(false);
    expect(runtimeAccepts(doc)).toBe(true);
  });

  test("the branch-policies flag pairing is enforced, agreeing with the runtime per fixture", () => {
    // Both verdicts must be represented, or a fixture file reduced to one side would pass here vacuously.
    expect(new Set(FLAG_PAIRING_FIXTURES.map((fixture) => fixture.valid))).toEqual(
      new Set([true, false]),
    );
    for (const { name, entry, valid } of FLAG_PAIRING_FIXTURES) {
      const doc = { environments: [entry] };
      expect(validate(doc), `published schema: ${name}`).toBe(valid);
      expect(
        runtimeAccepts(doc),
        `runtime validateSectionShapes disagrees with the published schema: ${name}`,
      ).toBe(valid);
    }
  });
});

describe("the document-level _layering directive", () => {
  test("the published schema and the zod document both accept a supported value", () => {
    const doc: SettingsFile = { _layering: "replace", labels: [{ name: "bug" }] };
    expect(validate(doc)).toBe(true);
    expect(SettingsFile.safeParse(doc)).toEqual({ success: true, data: doc });
  });

  test("both reject an unsupported value with the enum error, naming the key", () => {
    const doc = { _layering: "union", labels: [{ name: "bug" }] };
    expect(validate(doc)).toBe(false);
    expect((validate.errors ?? []).map((e) => [e.instancePath, e.keyword, e.params])).toEqual([
      ["/_layering", "enum", { allowedValues: ["merge", "replace"] }],
    ]);
    const parsed = SettingsFile.safeParse(doc);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => [i.path, i.code])).toEqual([
      [["_layering"], "invalid_value"],
    ]);
  });

  test("the apply-path shape validation copies only sections, so the directive never reaches the engine", () => {
    expect(
      validateSectionShapes({ _layering: "replace", labels: [{ name: "bug" }] }, "settings.yml"),
    ).toEqual(ok({ labels: [{ name: "bug" }] }));
  });
});

/**
 * lib/settings.schema.json is what editors and CI linters validate settings.yml against, so where the runtime is strict the schema must be too.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { ok } from "neverthrow";
import { validateSectionShapes } from "../src/engine/validate.js";
import { SettingsFile, UNDECLARED_POLICY_SECTIONS } from "../src/schema.js";
import { FLAG_PAIRING_FIXTURES } from "./fixtures/environment-flag-pairing.js";

const ROOT = join(import.meta.dir, "..");
const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8")) as {
  $id?: string;
  definitions: Record<string, Record<string, unknown>>;
};

describe("published schema identity", () => {
  test("$id is the version-free raw copy at HEAD", () => {
    // A $id naming a release ref again would tie every major bump to a schema regeneration on its release PR.
    expect(schema.$id).toBe(
      "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/HEAD/lib/settings.schema.json",
    );
  });
});

describe("published schema wrapper strictness", () => {
  const wrapperNames = Object.keys(schema.definitions).filter((name) =>
    name.startsWith("UndeclaredPolicyList<"),
  );

  /** The nested {_undeclared, entries} knobs inside an environment entry, each adding one wrapper definition beyond the knobbed sections. */
  const NESTED_WRAPPERS = [
    "UndeclaredPolicyList<EnvironmentVariableConfig>",
    "UndeclaredPolicyList<EnvironmentSecretConfig>",
    "UndeclaredPolicyList<DeploymentBranchPolicyConfig>",
    "UndeclaredPolicyList<DeploymentProtectionRuleConfig>",
  ] as const;

  test("one wrapper definition per knobbed section and nested knob, each closed", () => {
    expect(wrapperNames.length).toBe(UNDECLARED_POLICY_SECTIONS.length + NESTED_WRAPPERS.length);
    expect([...wrapperNames].sort()).toEqual([
      "UndeclaredPolicyList<ActionsSecretConfig>",
      "UndeclaredPolicyList<ActionsVariableConfig>",
      "UndeclaredPolicyList<AgentsSecretConfig>",
      "UndeclaredPolicyList<AgentsVariableConfig>",
      "UndeclaredPolicyList<AutolinkConfig>",
      "UndeclaredPolicyList<CodespacesSecretConfig>",
      "UndeclaredPolicyList<CollaboratorConfig>",
      "UndeclaredPolicyList<CustomPropertyConfig>",
      "UndeclaredPolicyList<DependabotSecretConfig>",
      "UndeclaredPolicyList<DeployKeyConfig>",
      "UndeclaredPolicyList<DeploymentBranchPolicyConfig>",
      "UndeclaredPolicyList<DeploymentProtectionRuleConfig>",
      "UndeclaredPolicyList<EnvironmentSecretConfig>",
      "UndeclaredPolicyList<EnvironmentVariableConfig>",
      "UndeclaredPolicyList<LabelConfig>",
      "UndeclaredPolicyList<MilestoneConfig>",
      "UndeclaredPolicyList<RulesetConfig>",
      "UndeclaredPolicyList<SecretScanningPatternConfig>",
      "UndeclaredPolicyList<WebhookConfig>",
    ]);
    for (const name of wrapperNames) {
      expect(
        schema.definitions[name]?.additionalProperties,
        `${name} must carry additionalProperties: false (the strictObject wrapper emits it)`,
      ).toBe(false);
    }
  });

  describe("AJV round-trip", () => {
    // strict: false because the generated schema carries draft-07 idioms AJV's strict mode complains about; validation semantics are unchanged.
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate: ValidateFunction = ajv.compile(schema);

    test("the plain array form validates", () => {
      expect(validate({ labels: [{ name: "bug", color: "d73a4a" }] })).toBe(true);
    });

    test("the wrapped form validates", () => {
      expect(
        validate({
          labels: { _undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
        }),
      ).toBe(true);
    });

    test("a typo key inside the wrapper is rejected, matching the runtime", () => {
      expect(
        validate({
          labels: { _undeclared: "keep", entires: [], entries: [] },
        }),
      ).toBe(false);
    });

    test("a bad policy value is rejected", () => {
      expect(validate({ rulesets: { _undeclared: "remove", entries: [] } })).toBe(false);
    });

    test("both forms of the nested variables knob validate", () => {
      expect(
        validate({
          environments: [{ name: "prod", variables: [{ name: "A", value: "1" }] }],
        }),
      ).toBe(true);
      expect(
        validate({
          environments: [
            {
              name: "prod",
              variables: { _undeclared: "keep", entries: [{ name: "A", value: "1" }] },
            },
          ],
        }),
      ).toBe(true);
    });

    test("a typo key inside the nested variables wrapper is rejected", () => {
      expect(
        validate({
          environments: [{ name: "prod", variables: { entires: [], entries: [] } }],
        }),
      ).toBe(false);
    });

    test("both forms of the nested branch-policies knob validate; a bad type is rejected", () => {
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              deployment_branch_policies: [{ name: "release/*" }, { name: "v*", type: "tag" }],
            },
          ],
        }),
      ).toBe(true);
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              deployment_branch_policies: { _undeclared: "keep", entries: [{ name: "main" }] },
            },
          ],
        }),
      ).toBe(true);
      // The published schema pins the documented upstream enum; the runtime shape stays a loose string, GitHub being the authority there.
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              deployment_branch_policies: [{ name: "v*", type: "wildcard" }],
            },
          ],
        }),
      ).toBe(false);
    });

    test("both forms of the nested protection-rules knob validate; the wrapper stays closed", () => {
      expect(
        validate({
          environments: [{ name: "prod", deployment_protection_rules: [{ app: "my-gate-app" }] }],
        }),
      ).toBe(true);
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_protection_rules: {
                _undeclared: "delete",
                entries: [{ app: "my-gate-app" }],
              },
            },
          ],
        }),
      ).toBe(true);
      // The entry is closed too: the enable call sends only the App's resolved integration id, so the runtime shape is strict and the schema says the
      // same.
      expect(
        validate({
          environments: [
            { name: "prod", deployment_protection_rules: { entires: [], entries: [] } },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          environments: [
            { name: "prod", deployment_protection_rules: [{ app: "my-gate-app", extra: 1 }] },
          ],
        }),
      ).toBe(false);
    });

    test("strict runtime shapes are closed in the schema too", () => {
      // These surfaces reject unknown keys at runtime (strictObject: no passthrough destination for an extra key); the old generator left them open,
      // validating typos the run then failed on.
      expect(
        validate({
          environments: [{ name: "prod", secrets: [{ name: "A", value: "$A", extra: 1 }] }],
        }),
      ).toBe(false);
      expect(validate({ actions: { cache: { max_cache_size: 25 } } })).toBe(false);
      expect(
        validate({
          branches: [
            {
              name: "main",
              protection: { required_deployments: { environments: ["prod"], extra: 1 } },
            },
          ],
        }),
      ).toBe(false);
    });

    test("branch protection required_signatures is a real boolean: true and absent accepted, a quoted string rejected", () => {
      // required_signatures is typed boolean so a YAML-quoted "yes" fails upfront instead of riding the protection PUT (which drops the key) and
      // never reaching the signatures sub-endpoint.
      expect(
        validate({ branches: [{ name: "main", protection: { required_signatures: true } }] }),
      ).toBe(true);
      expect(validate({ branches: [{ name: "main", protection: { enforce_admins: true } }] })).toBe(
        true,
      );
      expect(
        validate({ branches: [{ name: "main", protection: { required_signatures: "yes" } }] }),
      ).toBe(false);
    });

    test("the branch-policies flag pairing is enforced, agreeing with the runtime per fixture", () => {
      // The AJV verdict must agree with validateSectionShapes per fixture, so the schema copy of the invariant cannot drift from the runtime copy;
      // the [name, valid] pairs pin the SET.
      expect(FLAG_PAIRING_FIXTURES.map((f) => [f.name, f.valid])).toEqual([
        ["patterns without the sibling flag object", false],
        ["patterns with the flag present but false", false],
        ["patterns with the sibling nulled (a clear)", false],
        ["the wrapped form takes the same rule", false],
        ["the paired form (flag true) passes", true],
        ["the wrapped paired form passes", true],
        ["an entry without the plural key keeps its freedom (nullable flag)", true],
      ]);
      for (const { name, entry, valid } of FLAG_PAIRING_FIXTURES) {
        const doc = { environments: [entry] };
        expect(validate(doc), `published schema: ${name}`).toBe(valid);
        expect(
          !("error" in validateSectionShapes(doc, "fixture")),
          `runtime validateSectionShapes disagrees with the published schema: ${name}`,
        ).toBe(valid);
      }
    });

    test("an extra field on a variable entry validates - entries stay open", () => {
      // Entry fields pass through to the API verbatim, so a field GitHub ships tomorrow must validate today.
      expect(
        validate({
          environments: [
            { name: "prod", variables: [{ name: "A", value: "1", extra_field: "x" }] },
          ],
        }),
      ).toBe(true);
      expect(validate({ actions_variables: [{ name: "A", value: "1", extra_field: "x" }] })).toBe(
        true,
      );
    });
  });
});

describe("the document-level _layering directive", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate: ValidateFunction = ajv.compile(schema);

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

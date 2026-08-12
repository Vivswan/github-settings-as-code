/**
 * Published-schema contract tests: lib/settings.schema.json is what editors
 * and CI linters validate settings.yml against, so where the runtime is
 * strict the schema must be too. The wrapper keys are this action's own
 * vocabulary and the runtime rejects unknown keys in them upfront; these
 * tests pin the finalize-schema build step that closes the generated wrapper
 * definitions, and prove the closure with a real AJV round-trip.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { validateSectionShapes } from "../src/engine/validate.js";
import { UNDECLARED_POLICY_SECTIONS } from "../src/schema.js";
import { FLAG_PAIRING_FIXTURES } from "./fixtures/environment-flag-pairing.js";

const ROOT = join(import.meta.dir, "..");
const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8")) as {
  $id?: string;
  definitions: Record<string, Record<string, unknown>>;
};

describe("published schema identity", () => {
  test("$id is the raw copy at the moving major tag, majored from the release manifest", () => {
    // The identity finalize-schema stamps: the raw URL at the moving
    // v<MAJOR> tag, with the major read from the same release-please
    // manifest the script derives it from - so a major bump that
    // regenerates the schema keeps this test green, while a schema whose
    // $id lags the manifest (or names another shape entirely) fails.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const major = manifest["."]?.match(/^(\d+)\./)?.[1];
    expect(major, ".release-please-manifest.json lost its '.' version").toBeTruthy();
    expect(schema.$id).toBe(
      `https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v${major}/lib/settings.schema.json`,
    );
  });
});

describe("published schema wrapper strictness", () => {
  const wrapperNames = Object.keys(schema.definitions).filter((name) =>
    name.startsWith("UndeclaredPolicyList<"),
  );

  /**
   * The nested {undeclared, entries} knobs inside a section entry
   * (environments[].variables, environments[].secrets,
   * environments[].deployment_branch_policies, and
   * environments[].deployment_protection_rules), mirroring
   * NESTED_POLICY_LISTS in finalize-schema.ts: each adds one wrapper
   * definition beyond the knobbed sections.
   */
  const NESTED_WRAPPERS = [
    "UndeclaredPolicyList<EnvironmentVariableConfig>",
    "UndeclaredPolicyList<EnvironmentSecretConfig>",
    "UndeclaredPolicyList<DeploymentBranchPolicyConfig>",
    "UndeclaredPolicyList<DeploymentProtectionRuleConfig>",
  ] as const;

  test("one wrapper definition per knobbed section and nested knob, each closed", () => {
    expect(wrapperNames.length).toBe(UNDECLARED_POLICY_SECTIONS.length + NESTED_WRAPPERS.length);
    for (const nested of NESTED_WRAPPERS) {
      expect(wrapperNames).toContain(nested);
    }
    for (const name of wrapperNames) {
      expect(
        schema.definitions[name]?.additionalProperties,
        `${name} must carry additionalProperties: false (the finalize-schema build step sets it)`,
      ).toBe(false);
    }
  });

  describe("AJV round-trip", () => {
    // strict: false because the generated schema carries draft-07 idioms
    // AJV's strict mode complains about; validation semantics are unchanged.
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate: ValidateFunction = ajv.compile(schema);

    test("the plain array form validates", () => {
      expect(validate({ labels: [{ name: "bug", color: "d73a4a" }] })).toBe(true);
    });

    test("the wrapped form validates", () => {
      expect(
        validate({
          labels: { undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
        }),
      ).toBe(true);
    });

    test("a typo key inside the wrapper is rejected, matching the runtime", () => {
      expect(
        validate({
          labels: { undeclared: "keep", entires: [], entries: [] },
        }),
      ).toBe(false);
    });

    test("a bad policy value is rejected", () => {
      expect(validate({ rulesets: { undeclared: "remove", entries: [] } })).toBe(false);
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
              variables: { undeclared: "keep", entries: [{ name: "A", value: "1" }] },
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
              deployment_branch_policies: { undeclared: "keep", entries: [{ name: "main" }] },
            },
          ],
        }),
      ).toBe(true);
      // The declared type is the documented upstream enum in the published
      // schema (the runtime shape stays a loose string; GitHub is the
      // authority there).
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
                undeclared: "delete",
                entries: [{ app: "my-gate-app" }],
              },
            },
          ],
        }),
      ).toBe(true);
      // The wrapper is closed (this action's own vocabulary); the entry
      // strictness itself is runtime-only, like the nested secrets entries -
      // the generator opens every object for passthrough sections and
      // finalize-schema closes only the wrappers.
      expect(
        validate({
          environments: [
            { name: "prod", deployment_protection_rules: { entires: [], entries: [] } },
          ],
        }),
      ).toBe(false);
    });

    test("branch protection required_signatures is a real boolean: true and absent accepted, a quoted string rejected", () => {
      // BranchProtectionConfig is a passthrough record EXCEPT its one routed
      // key: required_signatures is typed boolean so a YAML-quoted "yes"
      // fails upfront instead of silently riding the protection PUT (which
      // drops the key) and never reaching the signatures sub-endpoint.
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
      // The if/then finalize-schema stamps onto EnvironmentConfig, run
      // against the ONE shared fixture set the zod superRefine is also
      // tested with - and, per fixture, the AJV verdict must agree with
      // validateSectionShapes (null = valid), so the schema copy of the
      // invariant cannot drift from the runtime copy. The class counts pin
      // the SET: a deleted fixture would silently weaken both consumers.
      expect(FLAG_PAIRING_FIXTURES.filter((f) => !f.valid)).toHaveLength(4);
      expect(FLAG_PAIRING_FIXTURES.filter((f) => f.valid)).toHaveLength(3);
      for (const { name, entry, valid } of FLAG_PAIRING_FIXTURES) {
        const doc = { environments: [entry] };
        expect(validate(doc), `published schema: ${name}`).toBe(valid);
        expect(
          validateSectionShapes(doc, "fixture") === null,
          `runtime validateSectionShapes disagrees with the published schema: ${name}`,
        ).toBe(valid);
      }
    });

    test("an extra field on a variable entry validates - entries stay open", () => {
      // Loose like the runtime shape: entry fields pass through to the API
      // verbatim, so a field GitHub ships tomorrow must validate today.
      expect(
        validate({
          environments: [
            { name: "prod", variables: [{ name: "A", value: "1", future_field: "x" }] },
          ],
        }),
      ).toBe(true);
      expect(validate({ actions_variables: [{ name: "A", value: "1", future_field: "x" }] })).toBe(
        true,
      );
    });
  });
});

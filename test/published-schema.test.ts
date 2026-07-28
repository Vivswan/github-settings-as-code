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
import { UNDECLARED_POLICY_SECTIONS } from "../src/schema.js";

const ROOT = join(import.meta.dir, "..");
const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8")) as {
  definitions: Record<string, Record<string, unknown>>;
};

describe("published schema wrapper strictness", () => {
  const wrapperNames = Object.keys(schema.definitions).filter((name) =>
    name.startsWith("UndeclaredPolicyList<"),
  );

  /**
   * The nested {undeclared, entries} knobs inside a section entry
   * (environments[].variables, environments[].secrets, and
   * environments[].deployment_branch_policies), mirroring
   * NESTED_POLICY_LISTS in finalize-schema.ts: each adds one wrapper
   * definition beyond the knobbed sections.
   */
  const NESTED_WRAPPERS = [
    "UndeclaredPolicyList<EnvironmentVariableConfig>",
    "UndeclaredPolicyList<EnvironmentSecretConfig>",
    "UndeclaredPolicyList<DeploymentBranchPolicyConfig>",
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

    test("the branch-policies flag pairing is enforced, matching the runtime shape", () => {
      // The if/then finalize-schema stamps onto EnvironmentConfig: declaring
      // deployment_branch_policies without the sibling flag object, with the
      // flag false, or with the sibling nulled all fail - the same documents
      // validateSettingsDoc rejects upfront.
      expect(
        validate({
          environments: [{ name: "prod", deployment_branch_policies: [{ name: "release/*" }] }],
        }),
      ).toBe(false);
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
              deployment_branch_policies: [{ name: "release/*" }],
            },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          environments: [
            {
              name: "prod",
              deployment_branch_policy: null,
              deployment_branch_policies: [{ name: "release/*" }],
            },
          ],
        }),
      ).toBe(false);
      // An entry without the plural key keeps its freedom: the flag object
      // stays optional and nullable there.
      expect(
        validate({
          environments: [{ name: "prod", deployment_branch_policy: null }],
        }),
      ).toBe(true);
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

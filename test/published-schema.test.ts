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
   * (environments[].variables today), mirroring NESTED_POLICY_LISTS in
   * finalize-schema.ts: each adds one wrapper definition beyond the knobbed
   * sections.
   */
  const NESTED_WRAPPERS = [
    "UndeclaredPolicyList<EnvironmentVariableConfig>",
    "UndeclaredPolicyList<EnvironmentSecretConfig>",
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

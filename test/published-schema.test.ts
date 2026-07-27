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

  test("one wrapper definition per knobbed section, each closed", () => {
    expect(wrapperNames.length).toBe(UNDECLARED_POLICY_SECTIONS.length);
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
  });
});

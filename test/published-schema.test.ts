/**
 * Published-schema contract tests: lib/settings.schema.json is what editors
 * and CI linters validate settings.yml against, so where the runtime is
 * strict the schema must be too. The wrapper keys are this action's own
 * vocabulary and the runtime rejects unknown keys in them upfront; these
 * tests pin the strictObject wrapper declarations in src/schema.ts that
 * close the emitted definitions, and prove the closure with a real AJV
 * round-trip.
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
  test("$id is the version-free raw copy at HEAD", () => {
    // The identity gen-settings-schema stamps, pinned as a literal: a $id
    // that names a release ref again ties every major bump to a schema
    // regeneration on its release PR.
    expect(schema.$id).toBe(
      "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/HEAD/lib/settings.schema.json",
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
   * environments[].deployment_protection_rules): each adds one wrapper
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
        `${name} must carry additionalProperties: false (the strictObject wrapper emits it)`,
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
      // The wrapper is closed (this action's own vocabulary), and so is
      // the entry itself: the enable call sends only the App's resolved
      // integration id, so the runtime shape is strict and the published
      // schema says the same (additionalProperties: false).
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
      // These four surfaces reject unknown keys at runtime (strictObject in
      // src/schema.ts: no passthrough destination exists for an extra key),
      // and the published schema must say the same - the old generator left
      // them open, validating typos the run then failed on.
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
      // The if/then the EnvironmentConfig schema's meta stamps, run
      // against the ONE shared fixture set the zod superRefine is also
      // tested with - and, per fixture, the AJV verdict must agree with
      // validateSectionShapes (no error = valid), so the schema copy of the
      // invariant cannot drift from the runtime copy. The class counts pin
      // the SET: a deleted fixture would silently weaken both consumers.
      expect(FLAG_PAIRING_FIXTURES.filter((f) => !f.valid)).toHaveLength(4);
      expect(FLAG_PAIRING_FIXTURES.filter((f) => f.valid)).toHaveLength(3);
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
      // Loose like the runtime shape: entry fields pass through to the API
      // verbatim, so a field GitHub ships tomorrow must validate today.
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

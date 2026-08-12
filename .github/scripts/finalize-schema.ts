/**
 * Post-processes the generated lib/settings.schema.json, run by build:schema
 * right after ts-json-schema-generator. Two jobs: stamp the schema's stable
 * $id, and close the wrapper definitions. The generator's
 * --additional-properties
 * flag opens every object (the passthrough-first forward-compatibility tenet:
 * GitHub-bound bodies must accept future fields), but the {undeclared, entries}
 * wrapper is this action's OWN vocabulary and the runtime rejects unknown keys
 * in it upfront - the published schema must say the same, or an editor
 * validates a typo the run then fails on. The generator has no per-type
 * strictness flag, so the wrapper definitions are closed here by name,
 * with the count pinned to UNDECLARED_POLICY_SECTIONS so a partial generator
 * rename fails the build instead of leaving some wrappers open.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";

const schemaPath = join(import.meta.dir, "..", "..", "lib", "settings.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  $id?: string;
  definitions?: Record<string, Record<string, unknown>>;
};

/**
 * The schema's stable identity: the raw copy of this file at the moving
 * v<MAJOR> tag. One raw-URL template serves every ref - the canonical
 * moving major, exact release tags, the legacy main copy - matching how the
 * action itself is pinned. The major comes from
 * .release-please-manifest.json, the version single source release-please
 * bumps on every release (package.json deliberately carries no version), so
 * a major release moves the $id automatically on the next schema build.
 */
const manifestPath = join(import.meta.dir, "..", "..", ".release-please-manifest.json");
const manifestVersion = (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>)[
  "."
];
const major = manifestVersion?.match(/^(\d+)\./)?.[1];
if (major === undefined) {
  throw new Error(
    `finalize-schema: cannot derive the major version from .release-please-manifest.json ("." is ${JSON.stringify(manifestVersion)})`,
  );
}
const SCHEMA_ID = `https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v${major}/lib/settings.schema.json`;

/**
 * The {undeclared, entries} knobs nested INSIDE a section entry rather than
 * at the top level (environments[].variables, environments[].secrets,
 * environments[].deployment_branch_policies, and
 * environments[].deployment_protection_rules), each contributing one wrapper
 * definition beyond the knobbed sections. Named by the entry type so the
 * presence check below fails loudly when the generator renames one.
 */
const NESTED_POLICY_LISTS = [
  "UndeclaredPolicyList<EnvironmentVariableConfig>",
  "UndeclaredPolicyList<EnvironmentSecretConfig>",
  "UndeclaredPolicyList<DeploymentBranchPolicyConfig>",
  "UndeclaredPolicyList<DeploymentProtectionRuleConfig>",
] as const;

const wrappers = Object.entries(schema.definitions ?? {}).filter(([name]) =>
  name.startsWith("UndeclaredPolicyList<"),
);
const expected = UNDECLARED_POLICY_SECTIONS.length + NESTED_POLICY_LISTS.length;
if (wrappers.length !== expected) {
  throw new Error(
    `finalize-schema: expected ${expected} UndeclaredPolicyList definitions (one per knobbed section plus the nested knobs), found ${wrappers.length}: ${wrappers
      .map(([name]) => name)
      .sort()
      .join(", ")} - the generator renamed or dropped some, update this script`,
  );
}
const missingNested = NESTED_POLICY_LISTS.filter(
  (nested) => !wrappers.some(([name]) => name === nested),
);
if (missingNested.length > 0) {
  throw new Error(
    `finalize-schema: nested wrapper(s) missing from the generated definitions: ${missingNested.join(", ")} (found: ${wrappers
      .map(([name]) => name)
      .sort()
      .join(", ")}) - the generator renamed them, update NESTED_POLICY_LISTS`,
  );
}
const malformedWrappers: string[] = [];
for (const [name, definition] of wrappers) {
  const properties = definition.properties as Record<string, unknown> | undefined;
  const missingProps = ["undeclared", "entries"].filter((prop) => properties?.[prop] === undefined);
  if (missingProps.length > 0) {
    malformedWrappers.push(`${name} lacks ${missingProps.join(" and ")}`);
    continue;
  }
  definition.additionalProperties = false;
}
if (malformedWrappers.length > 0) {
  throw new Error(
    `finalize-schema: wrapper definition(s) missing their {undeclared, entries} shape: ${malformedWrappers.join("; ")} - the generator changed the UndeclaredPolicyList shape, update this script`,
  );
}

// The flag-pairing invariant the runtime shape enforces (an environment
// entry declaring deployment_branch_policies must pair it with
// deployment_branch_policy setting custom_branch_policies: true) mirrored
// into the published schema, so an editor flags the broken pairing on the
// same document the run would reject. The generator cannot express a
// cross-field constraint from the TypeScript types, so it is stamped onto
// the generated EnvironmentConfig definition here, guarded loudly against a
// generator rename.
const environment = schema.definitions?.EnvironmentConfig;
if (environment === undefined) {
  throw new Error(
    "finalize-schema: the EnvironmentConfig definition is missing - the generator renamed it, update this script",
  );
}
const environmentProperties = environment.properties as Record<string, unknown> | undefined;
if (
  environmentProperties?.deployment_branch_policies === undefined ||
  environmentProperties?.deployment_branch_policy === undefined
) {
  throw new Error(
    "finalize-schema: the EnvironmentConfig definition lacks the deployment branch-policy properties - the generator renamed it, update this script",
  );
}
environment.if = { required: ["deployment_branch_policies"] };
// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword paired with `if` above, not a thenable
environment.then = {
  required: ["deployment_branch_policy"],
  properties: {
    deployment_branch_policy: {
      type: "object",
      required: ["custom_branch_policies"],
      properties: { custom_branch_policies: { const: true } },
    },
  },
};

// $id goes first in the emitted file, and any $id the generator might emit
// is dropped rather than allowed to shadow the stamped one.
const { $id: _generatedId, ...schemaBody } = schema;
writeFileSync(schemaPath, JSON.stringify({ $id: SCHEMA_ID, ...schemaBody }, null, 2));
console.log(`finalize-schema: closed ${wrappers.length} wrapper definition(s)`);

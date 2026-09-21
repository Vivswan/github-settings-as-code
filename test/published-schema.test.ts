/**
 * lib/settings.schema.json is what editors and CI linters validate settings.yml against, so where the runtime is strict the schema must be too.
 * schema-corpus.test.ts compares the two over every scenario and generated document; the documents here are the edge shapes that corpus never
 * carries (wrapper and entry typos, a bad directive value, a quoted boolean, the nested knobs' wrapped forms), each judged by both validators.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { ok } from "neverthrow";
import { validateSectionShapes } from "../src/engine/validate.js";
import { SettingsFile, UNDECLARED_POLICY_SECTIONS } from "../src/schema.js";
import { ENVIRONMENT_PARSE_FIXTURES } from "./fixtures/environment-parse-rules.js";
import { ROOT } from "./root.js";

const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8")) as {
  definitions: Record<string, Record<string, unknown>>;
};

// strict: false because the generated schema carries draft-07 idioms AJV's strict mode complains about; validation semantics are unchanged.
// The format plugin is loaded so a format keyword, should one ever be emitted, is judged here the way editors and CI linters judge it.
const ajv = new Ajv({ strict: false, allErrors: true });
const add = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
(add as typeof addFormats)(ajv);
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
    // GitHub's protection PUT requires users and teams under restrictions (apps optional) and takes every list of the two review-side
    // holders as optional, so the two validators refuse the bare restrictions mapping and accept the bare review-side one.
    [
      "a restrictions holder without its users and teams lists",
      { branches: [{ name: "main", protection: { restrictions: {} } }] },
      false,
    ],
    [
      "a restrictions holder naming only apps",
      { branches: [{ name: "main", protection: { restrictions: { apps: ["deploy-gate"] } } }] },
      false,
    ],
    [
      "an all-empty restrictions holder (nobody may push)",
      { branches: [{ name: "main", protection: { restrictions: { users: [], teams: [] } } }] },
      true,
    ],
    [
      "an empty dismissal_restrictions holder (anyone with push access may dismiss)",
      {
        branches: [
          {
            name: "main",
            protection: { required_pull_request_reviews: { dismissal_restrictions: {} } },
          },
        ],
      },
      true,
    ],
    // The status-check requirement needs a check list beside strict (the runtime's refinement has a JSON Schema twin).
    [
      "a status-check requirement without a check list",
      { branches: [{ name: "main", protection: { required_status_checks: { strict: true } } }] },
      false,
    ],
    [
      "a status-check requirement with an empty contexts list",
      {
        branches: [
          { name: "main", protection: { required_status_checks: { strict: true, contexts: [] } } },
        ],
      },
      true,
    ],
    [
      "a status-check requirement spelled as checks only",
      {
        branches: [
          {
            name: "main",
            protection: { required_status_checks: { strict: false, checks: [{ context: "ci" }] } },
          },
        ],
      },
      true,
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

  test("every environment parse rule is enforced by the published schema, agreeing with the runtime per fixture", () => {
    // Both verdicts must be represented, or a fixture file reduced to one side would pass here vacuously.
    expect(new Set(ENVIRONMENT_PARSE_FIXTURES.map((fixture) => fixture.valid))).toEqual(
      new Set([true, false]),
    );
    for (const { name, entry, valid } of ENVIRONMENT_PARSE_FIXTURES) {
      const doc = { environments: [entry] };
      expect(validate(doc), `published schema: ${name}`).toBe(valid);
      expect(
        runtimeAccepts(doc),
        `runtime validateSectionShapes disagrees with the published schema: ${name}`,
      ).toBe(valid);
    }
  });
});

describe("the published schema carries the repository topic grammar and commit-message pair rules", () => {
  // The topic pattern and the pair conditionals are read from the runtime's own tables (src/sections/repository/schema.ts), so a document
  // the refinement refuses is refused by editors too; the rows pin the verdicts on both sides.
  test.each<[string, Record<string, unknown>, boolean]>([
    ["a topic with a space", { topics: ["bad topic"] }, false],
    ["a topic with a leading hyphen, in the comma form", { topics: "ci, -lead" }, false],
    ["an empty topic entry", { topics: ["ci", ""] }, false],
    ["a 51-character topic", { topics: ["a".repeat(51)] }, false],
    // The runtime lowercases on the wire, so the published grammar accepts uppercase too: a lowercase-only pattern would be stricter.
    ["uppercase and a 50-character topic", { topics: ["Copier", "a".repeat(50), "9lives"] }, true],
    ["the comma form with spaces around the entries", { topics: " CI , GitHub-Actions " }, true],
    ["the wholesale clear", { topics: [] }, true],
    ["a squash message without its title", { squash_merge_commit_message: "PR_BODY" }, false],
    [
      "a squash pair GitHub answers 422 to",
      { squash_merge_commit_title: "COMMIT_OR_PR_TITLE", squash_merge_commit_message: "PR_BODY" },
      false,
    ],
    [
      "a legal squash pair",
      {
        squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
        squash_merge_commit_message: "COMMIT_MESSAGES",
      },
      true,
    ],
    ["a squash title alone", { squash_merge_commit_title: "PR_TITLE" }, true],
    ["a merge message without its title", { merge_commit_message: "PR_BODY" }, false],
    // GitHub documents no matrix for the merge family, so any title/message pair of the vocabularies is legal.
    [
      "a merge pair, any title with any message",
      { merge_commit_title: "MERGE_MESSAGE", merge_commit_message: "PR_TITLE" },
      true,
    ],
  ])("%s", (_shape, repository, accepted) => {
    const doc = { repository };
    expect(validate(doc), "published schema").toBe(accepted);
    expect(runtimeAccepts(doc), "runtime validateSectionShapes").toBe(accepted);
  });

  test("the 20-topic cap is the stated place where the runtime is the stricter side", () => {
    // The cap counts distinct topics after the lowercase fold, which JSON Schema cannot count: a maxItems would refuse the
    // duplicate-laden list below, which the runtime accepts. Recorded, allowed: the runtime may refuse what the schema accepts.
    const duplicates = {
      repository: { topics: [...Array.from({ length: 20 }, () => "CI"), "ci", "tooling"] },
    };
    expect(validate(duplicates)).toBe(true);
    expect(runtimeAccepts(duplicates)).toBe(true);
    const distinct = {
      repository: { topics: Array.from({ length: 21 }, (_, index) => `topic-${index}`) },
    };
    expect(validate(distinct)).toBe(true);
    expect(runtimeAccepts(distinct)).toBe(false);
  });
});

describe("format keywords stay out of the published schema", () => {
  // ajv-formats judges a format keyword by its own grammar, and two of zod's differ from the runtime's: format: "uri" refuses the
  // non-ASCII hosts, paths, and spaces the runtime's new URL() takes, and format: "date-time" rounds a long fractional second into
  // an invalid :60. The generator strips every format keyword, and this walk keeps future ones out too (zod's pattern stays and is
  // the runtime's grammar for the ISO types, so the two validators agree on every date form).
  test("no definition in the published schema carries a format keyword", () => {
    const formatted: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
          walk(item, `${path}[${index}]`);
        }
        return;
      }
      if (typeof node !== "object" || node === null) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "format") {
          formatted.push(`${path}.format=${String(value)}`);
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(schema.definitions, "definitions");
    expect(formatted).toEqual([]);
  });

  test.each([
    "https://例え.example.com/ci",
    "https://hooks.example.com/ci/例え",
    "https://hooks.example.com/ci with space",
  ])("both validators accept the webhook url %s", (url) => {
    const doc = { webhooks: [{ config: { url } }] };
    expect(validate(doc), "published schema").toBe(true);
    expect(runtimeAccepts(doc), "runtime validateSectionShapes").toBe(true);
  });

  test("a scheme with no host is the stated place where the runtime is the stricter side", () => {
    // Recorded, allowed: the runtime may refuse what the published schema accepts, never the reverse.
    const doc = { webhooks: [{ config: { url: "https://" } }] };
    expect(validate(doc)).toBe(true);
    expect(runtimeAccepts(doc)).toBe(false);
  });

  test.each([
    ["2026-02-28", "a full-date", true],
    ["2026-02-28T12:00:00Z", "a Z-designated timestamp", true],
    ["2026-02-28T12:00:59.9999999999999999Z", "a timestamp ajv-formats would round into :60", true],
    ["2026-02-28T12:00:00+02:00", "a numeric offset", false],
    ["2026-02-28t12:00:00z", "lowercase designators", false],
    ["2026-02-28T23:59:60Z", "a leap second", false],
  ])("both validators agree on the milestone due_on %s (%s): %p", (due_on, _label, accepted) => {
    const doc = { milestones: [{ title: "v1", due_on }] };
    expect(validate(doc), "published schema").toBe(accepted);
    expect(runtimeAccepts(doc), "runtime validateSectionShapes").toBe(accepted);
  });

  test.each([
    ["2026-02-28T12:00:59.9999999999999999Z", "refuses what the runtime accepts", false],
    ["2026-02-28T12:00:00+02:00", "accepts what the runtime refuses", true],
  ])(
    "ajv's date-time keyword alone %s (%s), which is why the generator strips it",
    (due_on, _label, ajvAccepts) => {
      const dateTimeOnly = ajv.compile({ type: "string", format: "date-time" });
      expect(dateTimeOnly(due_on), "ajv format keyword by itself").toBe(ajvAccepts);
      expect(runtimeAccepts({ milestones: [{ title: "v1", due_on }] })).toBe(!ajvAccepts);
    },
  );
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
      ["/_layering", "enum", { allowedValues: ["replace", "shallow", "deep"] }],
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

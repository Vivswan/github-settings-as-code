import {
  LIST_SECTIONS,
  type ListSection,
  type SectionKey,
  UNDECLARED_POLICY_SECTIONS,
} from "../../src/schema.js";
import { compileFailure } from "../../src/sections/secret_scanning_custom_patterns/compilable-form.js";
import { MAX_VARIABLE_VALUE_BYTES } from "../../src/sections/shared/schema-helpers.js";
import type { MustBeNever } from "../../src/types.js";
import { PULL_REQUEST_PARAMETERS } from "../sections/rulesets/generators.js";
import { type EntriesForm, entriesOf, type Json, UNDECLARED_KEY } from "./gen-support.js";
import { genSettings, SECRET_LIST_SECTIONS } from "./generators.js";
import type { Rng } from "./prng.js";

/**
 * Only violations validateSettingsDoc GENUINELY rejects belong here; values the loose shapes accept by design would
 * assert failures the contract does not promise, so they stay out.
 *   offendingToken  -> must appear in the rejection error: a section path ("labels[2].name"), an unknown key, or a wording fragment
 *   stays out       -> unknown nested keys under a loose shape, un-modeled enums, arbitrary types on loose keys,
 *                      `pages: null`
 */
export interface InvalidSettingsCase {
  doc: Json;
  offendingToken: string;
}

const RECORD_SECTIONS = [
  "repository",
  "actions",
  "check_suite_preferences",
  "code_scanning_default_setup",
  "code_quality_setup",
] as const satisfies readonly SectionKey[];

/** pages and interaction_limits are nullable objects with their own catalog cases; a section unclassified here fails typecheck. */
type CoveredSection =
  | ListSection
  | (typeof RECORD_SECTIONS)[number]
  | "pages"
  | "interaction_limits";
type _UnclassifiedSection = MustBeNever<Exclude<SectionKey, CoveredSection>>;

/** The required field each array section's item shape enforces: a string, except webhooks' `config` object. */
const NATURAL_KEYS: Record<ListSection, string> = {
  labels: "name",
  rulesets: "name",
  branches: "name",
  environments: "name",
  autolinks: "key_prefix",
  actions_secrets: "name",
  dependabot_secrets: "name",
  codespaces_secrets: "name",
  agents_secrets: "name",
  workflows: "path",
  collaborators: "username",
  teams: "name",
  milestones: "title",
  actions_variables: "name",
  agents_variables: "name",
  // webhooks' natural key is the nested config.url, but the required
  // entry-level field the shape enforces is `config` itself.
  webhooks: "config",
  custom_properties: "property_name",
  deploy_keys: "title",
  secret_scanning_custom_patterns: "name",
};

/** The sections whose entry `name` is a GitHub secret or variable name (the environments section nests the same two lists). */
const GITHUB_NAMED_SECTIONS = [
  ...SECRET_LIST_SECTIONS,
  "actions_variables",
  "agents_variables",
] as const satisfies readonly ListSection[];

/** A hyphen, a leading digit, and the reserved prefix in both cases; `github_token` folds to GITHUB_TOKEN once uppercased. */
const REFUSED_GITHUB_NAMES = ["my-secret", "2_TOKEN", "GITHUB_TOKEN", "github_token"] as const;

/** Entries come back by reference, so a case's mutation lands inside whichever form was drawn; itemToken spells that form's validator path. */
function validItems(
  rng: Rng,
  key: ListSection,
): { value: EntriesForm; entries: Json[]; index: number; itemToken: string } {
  const value = genSettings(rng.fork("valid"), key) as EntriesForm;
  const entries = entriesOf(value);
  const index = rng.int(entries.length);
  const itemToken = Array.isArray(value) ? `${key}[${index}]` : `${key}.entries[${index}]`;
  return { value, entries, index, itemToken };
}

export const INVALID_SETTINGS_CASES: ReadonlyArray<{
  name: string;
  build: (rng: Rng) => InvalidSettingsCase;
}> = [
  {
    name: "unknown-top-level-key",
    build: (rng) => {
      const typo = rng.pick(["labelz", "label", "milestone", "repositories", "branch"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [typo]: [] },
        offendingToken: typo,
      };
    },
  },
  {
    name: "unknown-underscore-key",
    build: (rng) => {
      // The underscore is the two directives' and nothing else's: a note or a misspelled directive is rejected, never dropped.
      const key = rng.pick(["_notes", "_owner", "_layerin", "_undeclared"]);
      return {
        doc: { labels: genSettings(rng.fork("labels"), "labels") as Json, [key]: "x" },
        offendingToken: key,
      };
    },
  },
  {
    name: "array-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      return { doc: { [key]: rng.pick([{ not: "an array" }, "oops", 7]) }, offendingToken: key };
    },
  },
  {
    name: "record-section-wrong-type",
    build: (rng) => {
      const key = rng.pick(RECORD_SECTIONS);
      return { doc: { [key]: rng.pick(["oops", 7, [1], null] as const) }, offendingToken: key };
    },
  },
  {
    // Parse refuses an id no GitHub App has or GitHub rejects; otherwise the PATCH would report it late and on every run.
    // The pair GitHub collapses is what nothing reads back, since the section has no read endpoint.
    name: "check-suite-app-id-not-positive-integer",
    build: (rng) => ({
      doc: {
        check_suite_preferences: {
          auto_trigger_checks: [{ app_id: rng.pick([0, -15368, 15368.5] as const), setting: true }],
        },
      },
      offendingToken: "check_suite_preferences.auto_trigger_checks[0].app_id",
    }),
  },
  {
    name: "check-suite-duplicate-app-id",
    build: (rng) => {
      const app_id = rng.pick([15368, 29310] as const);
      return {
        doc: {
          check_suite_preferences: {
            auto_trigger_checks: [
              { app_id, setting: rng.bool() },
              { app_id: 62410, setting: true },
              { app_id, setting: rng.bool() },
            ],
          },
        },
        offendingToken: `check_suite_preferences.auto_trigger_checks[2].app_id: repeats app_id ${app_id} from auto_trigger_checks[0]`,
      };
    },
  },
  {
    name: "pages-wrong-type",
    build: (rng) => ({
      doc: { pages: rng.pick(["gh-pages", [1]] as const) },
      offendingToken: "pages",
    }),
  },
  {
    // null is NOT in the pick list: it is a valid declared value (clear).
    name: "interaction-limits-wrong-type",
    build: (rng) => ({
      doc: { interaction_limits: rng.pick(["oops", 7, [1]] as const) },
      offendingToken: "interaction_limits",
    }),
  },
  {
    name: "interaction-limits-refused-at-parse",
    build: (rng) => {
      // What the PUT would 422, or what GitHub reports but never accepts, fails at parse; the token is the key each issue names.
      const cases: ReadonlyArray<readonly [Json, string]> = [
        [{ expiry: "one_week" }, "interaction_limits.limit"],
        [{ limit: 7 }, "interaction_limits.limit"],
        [{ limit: "collaborators" }, "interaction_limits.limit"],
        [{ limit: "existing_users", expiry: "two_weeks" }, "interaction_limits.expiry"],
        [
          { limit: "existing_users", expires_at: "2027-01-01T00:00:00Z" },
          'Unrecognized key: "expires_at"',
        ],
        [{ limit: "existing_users", origin: "repository" }, 'Unrecognized key: "origin"'],
        [
          {
            pull_request_creation_cap: {
              enabled: true,
              max_open_pull_requests: rng.pick([0, -1, 2.5, 1001]),
            },
          },
          "interaction_limits.pull_request_creation_cap.max_open_pull_requests",
        ],
      ];
      const [doc, offendingToken] = rng.pick(cases);
      return { doc: { interaction_limits: doc }, offendingToken };
    },
  },
  {
    name: "scalar-item",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries as unknown[])[index] = "oops";
      return { doc: { [key]: value }, offendingToken: itemToken };
    },
  },
  {
    name: "missing-natural-key",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      delete (entries[index] as Json)[NATURAL_KEYS[key]];
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "non-string-natural-key",
    build: (rng) => {
      const key = rng.pick(LIST_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json)[NATURAL_KEYS[key]] = 42;
      return { doc: { [key]: value }, offendingToken: `${itemToken}.${NATURAL_KEYS[key]}` };
    },
  },
  {
    name: "secret-or-variable-name-refused",
    build: (rng) => {
      const key = rng.pick(GITHUB_NAMED_SECTIONS);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json).name = rng.pick(REFUSED_GITHUB_NAMES);
      return { doc: { [key]: value }, offendingToken: `${itemToken}.name` };
    },
  },
  {
    name: "environment-nested-name-refused",
    build: (rng) => {
      const list = rng.pick(["variables", "secrets"] as const);
      const value = list === "secrets" ? "$E2E_SECRET_A" : "debug";
      const entry = { name: rng.pick(REFUSED_GITHUB_NAMES), value };
      return {
        doc: { environments: [{ name: "prod", [list]: [entry] }] },
        offendingToken: `environments[0].${list}[0].name`,
      };
    },
  },
  {
    name: "variable-value-over-cap",
    build: (rng) => {
      const key = rng.pick(["actions_variables", "agents_variables"] as const);
      const { value, entries, index, itemToken } = validItems(rng, key);
      (entries[index] as Json).value = "x".repeat(MAX_VARIABLE_VALUE_BYTES + 1);
      return { doc: { [key]: value }, offendingToken: `${itemToken}.value` };
    },
  },
  {
    name: "labels-new-name-not-a-string",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "labels");
      (entries[index] as Json).new_name = 7;
      return { doc: { labels: value }, offendingToken: `${itemToken}.new_name` };
    },
  },
  {
    // "write" converges on an existing Write collaborator and 422s on a new one; "Push" and "" 422 on both.
    name: "collaborators-permission-not-grantable",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "collaborators");
      (entries[index] as Json).permission = rng.pick([
        "read",
        "write",
        "Write",
        "Push",
        "ADMIN",
        "",
        "push\n",
      ]);
      return { doc: { collaborators: value }, offendingToken: `${itemToken}.permission` };
    },
  },
  {
    // A display name is the team_slug in the API path: the probe 404s and check reports "no access".
    name: "teams-name-not-a-slug",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "teams");
      (entries[index] as Json).name = rng.pick(["Core Team", "core/team", "@core", " core", ""]);
      return { doc: { teams: value }, offendingToken: `${itemToken}.name` };
    },
  },
  {
    name: "branches-protection-missing",
    build: (rng) => {
      // protection is REQUIRED (nullable, not optional) on every branch entry.
      const { value, entries, index, itemToken } = validItems(rng, "branches");
      delete (entries[index] as Json).protection;
      return { doc: { branches: value }, offendingToken: `${itemToken}.protection` };
    },
  },
  {
    name: "branches-checks-unknown-key",
    build: (rng) => {
      // A check item is GitHub's closed {context, app_id} shape; the entry is made literal, since a
      // wildcard rule refuses `checks` itself ahead of the item.
      const { value, entries, index, itemToken } = validItems(rng, "branches");
      const entry = entries[index] as Json;
      entry.name = "main";
      entry.protection = {
        required_status_checks: {
          strict: true,
          checks: [{ context: "ci", [rng.pick(["app", "app_slug", "name"])]: "ci-bot" }],
        },
      };
      return {
        doc: { branches: value },
        offendingToken: `${itemToken}.protection.required_status_checks.checks[0]`,
      };
    },
  },
  {
    name: "workflows-state-enum",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "workflows");
      (entries[index] as Json).state = rng.pick(["paused", "enabled", "on"]);
      return { doc: { workflows: value }, offendingToken: `${itemToken}.state` };
    },
  },
  {
    name: "rulesets-include-not-a-list",
    build: (rng) => {
      // The classic missing "-" typo the rulesets shape exists to catch.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = { ref_name: { include: "main" } };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.include`,
      };
    },
  },
  {
    name: "rulesets-enforcement-enum",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).enforcement = rng.pick(["enabled", "Active", "on"]);
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.enforcement` };
    },
  },
  {
    name: "rulesets-ref-token-typo",
    build: (rng) => {
      // normalizeRefName passes every "~" value through, so a typo'd token would reach GitHub as written.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = {
        ref_name: { include: [rng.pick(["~all", "~MAIN", "~default_branch", "release~1"])] },
      };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.include[0]`,
      };
    },
  },
  {
    name: "rulesets-ref-pattern-illegal-character",
    build: (rng) => {
      // A character git refuses in a ref name; the pattern would reach GitHub prefixed and come back as a 422.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).conditions = {
        ref_name: {
          exclude: [
            rng.pick([
              "release^2",
              "a:b",
              "back\\slash",
              "hot fix",
              "a..b",
              "main@{1}",
              "tab\tbed",
            ]),
          ],
        },
      };
      return {
        doc: { rulesets: value },
        offendingToken: `${itemToken}.conditions.ref_name.exclude[0]`,
      };
    },
  },
  {
    name: "rulesets-bypass-actor-without-id",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).bypass_actors = [
        { actor_type: rng.pick(["Team", "User", "RepositoryRole", "Integration"]) },
      ];
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.bypass_actors[0].actor_id` };
    },
  },
  {
    name: "rulesets-known-rule-parameter-case",
    build: (rng) => {
      // The casing GitHub sets on a KNOWN rule type is refused at parse; an unknown type still passes through to GitHub's own 422.
      const { value, entries, index, itemToken } = validItems(rng, "rulesets");
      (entries[index] as Json).rules = [
        rng.pick([
          { type: "branch_name_pattern", parameters: { operator: "startsWith", pattern: "feat/" } },
          {
            type: "pull_request",
            parameters: { ...PULL_REQUEST_PARAMETERS, allowed_merge_methods: ["SQUASH"] },
          },
          {
            type: "merge_queue",
            parameters: {
              check_response_timeout_minutes: 60,
              grouping_strategy: "ALLGREEN",
              max_entries_to_build: 5,
              max_entries_to_merge: 5,
              merge_method: "squash",
              min_entries_to_merge: 1,
              min_entries_to_merge_wait_minutes: 5,
            },
          },
        ]),
      ];
      return { doc: { rulesets: value }, offendingToken: `${itemToken}.rules[0]: parameters.` };
    },
  },
  {
    // The wrapper is this action's own strict vocabulary, so a typo'd wrapper key must fail upfront, named.
    name: "wrapper-unknown-key",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const typo = rng.pick(["entires", "entry", "items"]);
      return {
        doc: { [key]: { [typo]: entriesOf(genSettings(rng.fork("valid"), key)) } },
        offendingToken: typo,
      };
    },
  },
  {
    name: "wrapper-bad-policy",
    build: (rng) => {
      const key = rng.pick(UNDECLARED_POLICY_SECTIONS);
      const entries = entriesOf(genSettings(rng.fork("valid"), key));
      return {
        doc: { [key]: { [UNDECLARED_KEY]: rng.pick(["detele", "kep", true]), entries } },
        offendingToken: `${key}.${UNDECLARED_KEY}`,
      };
    },
  },
  {
    name: "secret-scanning-pattern-uncompilable",
    build: (rng) => {
      // Each field is a regex GitHub compiles as Hyperscan; the schema refuses what no dialect parses,
      // and the oracle here is the section's own check, so a pool value the check accepts fails the draw loudly.
      const { value, entries, index, itemToken } = validItems(
        rng,
        "secret_scanning_custom_patterns",
      );
      const field = rng.pick([
        "pattern",
        "start_delimiter",
        "end_delimiter",
        "must_match",
        "must_not_match",
      ]);
      // The last two are PCRE refusals a flagless RegExp alone would take: a quantified anchor, a group name declared twice.
      const broken = rng.pick([
        "([a-z",
        "*token",
        "key_[0-9]{6}\\",
        "(?P<t>key_[0-9",
        "\\A+",
        "(?<t>x)|(?<t>y)",
      ]);
      if (compileFailure(broken) === undefined) {
        throw new Error(
          `the refused draw ${JSON.stringify(broken)} passes the syntax check; pick another`,
        );
      }
      const entry = entries[index] as Json;
      const listField = field === "must_match" || field === "must_not_match";
      entry[field] = listField ? ["[0-9]", broken] : broken;
      return {
        doc: { secret_scanning_custom_patterns: value },
        offendingToken: `${itemToken}.${field}${listField ? "[1]" : ""}`,
      };
    },
  },
  {
    name: "pages-source-not-an-object",
    build: () => ({
      doc: { pages: { source: "main" } },
      offendingToken: "pages.source",
    }),
  },
  {
    name: "pages-source-branch-missing",
    build: () => ({
      doc: { pages: { source: { path: "/" } } },
      offendingToken: "pages.source.branch",
    }),
  },
  {
    // Each is a value GitHub 422s at apply time; the parser refuses it first, naming the field.
    name: "webhooks-value-github-refuses",
    build: (rng) => {
      const { value, entries, index, itemToken } = validItems(rng, "webhooks");
      const hook = entries[index] as Json;
      const config = hook.config as Json;
      const [field, mutate] = rng.pick<[string, () => void]>([
        ["events[0]", () => (hook.events = ["pushes"])],
        [
          "config.content_type",
          () => (config.content_type = rng.pick(["JSON", "application/json"])),
        ],
        ["config.insecure_ssl", () => (config.insecure_ssl = rng.pick([true, 2, "yes"]))],
        ["config.url", () => (config.url = rng.pick(["hooks.example.com/ci", "not a url"]))],
      ]);
      mutate();
      return { doc: { webhooks: value }, offendingToken: `${itemToken}.${field}` };
    },
  },
];

/** Tagged with the case name, so failures are labeled and coverage checks can prove every case is drawn. */
export function genInvalidSettings(rng: Rng): InvalidSettingsCase & { name: string } {
  const { name, build } = rng.pick(INVALID_SETTINGS_CASES);
  return { name, ...build(rng) };
}

/**
 * Bodies the yaml package GENUINELY throws on. Single-repo they hit the "cannot read settings ... valid YAML" path
 * (src/flows/single.ts), multi-repo the "cannot parse <slug>" target gate (src/flows/multi.ts); both fire before any section runs.
 */
export const UNPARSEABLE_YAML = [
  "labels: [oops, unclosed",
  "{",
  "a: b\n  c: d",
  'key: "unterminated',
  "a: [1, 2\nb: 3",
] as const;

/**
 * Bodies that parse but not to a mapping, so they fail validateSettingsDoc's top-level "must be a YAML mapping" check
 * instead of the parser; in multi mode the same wording fires with the slug as the source label.
 */
export const NON_MAPPING_YAML = ["- a\n- b", "just a string"] as const;

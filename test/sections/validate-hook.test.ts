/**
 * The validate hook is the ONE place a file-only check lives: the compiler demands it on every list section, and the
 * engine runs it inside document validation. Without these, a new list section could keep its duplicate check in
 * plan(), where it would throw only after the sections before it had written.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { SECTION_KEYS, type SectionKey, type SettingsFile } from "../../src/schema.js";
import type { EntryOf, SectionModule } from "../../src/sections/contract/module.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { repositorySection } from "../../src/sections/repository/index.js";

/**
 * One well-formed entry per list section, null for a mapping section (nothing to duplicate). The type permits null
 * only where the section value has no entries, so a list section cannot opt out of the census below, and a new
 * section must say which it is.
 */
type OneEntryPerSection = {
  [K in SectionKey]: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
    ? null
    : Record<string, unknown>;
};

const ONE_ENTRY: OneEntryPerSection = {
  repository: null,
  labels: { name: "bug" },
  rulesets: { name: "protect-main" },
  environments: { name: "prod" },
  branches: { name: "main", protection: null },
  autolinks: { key_prefix: "JIRA-", url_template: "https://example.com/<num>" },
  actions: null,
  actions_secrets: { name: "TOKEN", value: "$TOKEN" },
  dependabot_secrets: { name: "TOKEN", value: "$TOKEN" },
  codespaces_secrets: { name: "TOKEN", value: "$TOKEN" },
  agents_secrets: { name: "TOKEN", value: "$TOKEN" },
  workflows: { path: "ci.yml", state: "active" },
  check_suite_preferences: null,
  pages: null,
  code_scanning_default_setup: null,
  code_quality_setup: null,
  collaborators: { username: "octocat" },
  teams: { name: "devs" },
  milestones: { title: "v1" },
  interaction_limits: null,
  actions_variables: { name: "REGION", value: "eu" },
  agents_variables: { name: "REGION", value: "eu" },
  webhooks: { config: { url: "https://example.com/hook" }, events: ["push"] },
  custom_properties: { property_name: "team", value: "platform" },
  deploy_keys: {
    title: "ci",
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBotBotBotBotBotBotBotBotBotBotBotBotBotBotB",
  },
  secret_scanning_custom_patterns: { name: "token", pattern: "tok_[a-z]{8}" },
};

describe("every list section's validate hook reaches the engine", () => {
  const listSections = SECTION_KEYS.filter((key) => ONE_ENTRY[key] !== null);

  test.each(listSections)(
    "%s: a duplicated entry is refused at the later entry's path, and the same entry alone passes",
    (key) => {
      const entry = ONE_ENTRY[key];
      const issues = validateSectionShapes({ [key]: [entry, entry] }, "f.yml").match(
        () => null,
        (problem) => problem.issues,
      );
      expect(issues).not.toBeNull();
      expect(issues?.length).toBeGreaterThan(0);
      for (const issue of issues ?? []) {
        expect(issue).toMatch(new RegExp(`^${key}\\[1\\]\\.`));
      }
      expect(validateSectionShapes({ [key]: [entry] }, "f.yml").isOk()).toBe(true);
    },
  );
});

// The contract makes validate mandatory on a list section and optional on a mapping section; the census above pins
// the runtime half, these declarations the compile-time half. The erased roster keeps it optional, so every module
// erases into it.
const { validate: _dropped, ...withoutValidate } = labelsSection;
// @ts-expect-error labels is a list section, so registering it without validate is flagged by name
const _list: SectionModule<"labels", typeof labelsSection.endpoints> = withoutValidate;
const _mapping: SectionModule<
  "repository",
  typeof repositorySection.endpoints,
  typeof repositorySection.graphql
> = repositorySection;
const _erased: SectionModule = labelsSection;

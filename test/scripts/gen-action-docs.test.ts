// Each renderer against a fixture with an exact expected text, and the committed files against
// a fresh regeneration (the splice itself is pinned in generated-regions.test.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GENERATED_REGIONS,
  regenerateText,
  renderActionInputs,
  renderActionOutputs,
  renderCheckModeGatedReads,
  renderGatedReads,
  renderGrantSentence,
  renderPolicyCountSentence,
  renderPolicyDefaultsTable,
  renderReadmeInputsTable,
} from "../../.github/scripts/gen-action-docs.js";
import { INPUT_DECLS } from "../../src/action/inputs.js";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { sectionModule } from "../../src/sections/registry.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("action.yml renderers", () => {
  test("inputs fold long descriptions, quote every default, and parse back verbatim", () => {
    const decls = {
      "settings-file": {
        description:
          "Path to the settings YAML file. Single-repo mode only; multi-repo targets read repos-dir files or each repository's own .github/settings.yml, so overriding it fails the run.",
        default: ".github/settings.yml",
      },
      "api-version": { description: "X-GitHub-Api-Version header: a date.", default: "2022-11-28" },
      repos: { description: 'Targets, or "*" to discover.', default: "" },
    };
    const text = renderActionInputs(decls);
    expect(text).toBe(
      [
        "  settings-file:",
        "    description: >-",
        "      Path to the settings YAML file. Single-repo mode only; multi-repo",
        "      targets read repos-dir files or each repository's own",
        "      .github/settings.yml, so overriding it fails the run.",
        "    required: false",
        '    default: ".github/settings.yml"',
        "  api-version:",
        "    description: >-",
        "      X-GitHub-Api-Version header: a date.",
        "    required: false",
        '    default: "2022-11-28"',
        "  repos:",
        "    description: >-",
        '      Targets, or "*" to discover.',
        "    required: false",
        '    default: ""',
      ].join("\n"),
    );
    // The date default stays a string and every description folds back to
    // the declaration character for character.
    expect(parseYaml(`inputs:\n${text}\n`).inputs).toEqual(
      Object.fromEntries(
        Object.entries(decls).map(([name, decl]) => [name, { ...decl, required: false }]),
      ),
    );
  });

  test("a name a YAML parser would re-type is quoted, and only then", () => {
    const decls = {
      null: { description: "A null-named input.", default: "" },
      on: { description: "An on-named input.", default: "x" },
      Mixed_Case: { description: "Not a plain lowercase name.", default: "" },
    };
    const text = renderActionInputs(decls);
    // The key lines are the only ones at exactly two-space indent.
    expect(text.split("\n").filter((line) => /^ {2}\S/.test(line))).toEqual([
      '  "null":',
      '  "on":',
      '  "Mixed_Case":',
    ]);
    expect(Object.keys(parseYaml(`inputs:\n${text}\n`).inputs)).toEqual([
      "null",
      "on",
      "Mixed_Case",
    ]);
    expect(renderActionOutputs({ y: { description: "Short." } })).toBe(
      '  "y":\n    description: >-\n      Short.',
    );
  });

  test.each([
    ["a double space", "Two  spaces."],
    ["a newline", "Two\nlines."],
    ["a leading space", " Padded."],
    ["a trailing space", "Padded. "],
  ])("rejects a description with %s, which would not fold back verbatim", (_label, description) => {
    expect(() => renderActionInputs({ x: { description, default: "" } })).toThrow(
      /single-spaced prose/,
    );
  });

  test("outputs render the name and the folded description only", () => {
    expect(
      renderActionOutputs({
        result: { description: "applied | partial | clean." },
        "repos-result": {
          description:
            "Multi-repo mode only: JSON map of owner/name to {result, source, skippedSections}. Empty in single-repo mode.",
        },
      }),
    ).toBe(
      [
        "  result:",
        "    description: >-",
        "      applied | partial | clean.",
        "  repos-result:",
        "    description: >-",
        "      Multi-repo mode only: JSON map of owner/name to {result, source,",
        "      skippedSections}. Empty in single-repo mode.",
      ].join("\n"),
    );
  });
});

describe("README Inputs table renderer", () => {
  test("shows the declared default backticked, an empty one as (empty), and a shown default verbatim", () => {
    expect(
      renderReadmeInputsTable({
        token: {
          default: "an expression the runner resolves",
          shownDefault: "`github.token`",
          summary: "Token for the API calls",
        },
        mode: { default: "apply", summary: "`apply` mutates; `check` reports" },
        repos: { default: "", summary: "Multi-repo remote mode" },
        visibility: { default: "", shownDefault: "`all`", summary: "Discovery-only: a | b" },
        archived: { default: "", summary: "kept \\| as is, but \\\\| gets escaped" },
      }),
    ).toBe(
      [
        "| Input | Default | Meaning |",
        "|---|---|---|",
        "| `token` | `github.token` | Token for the API calls |",
        "| `mode` | `apply` | `apply` mutates; `check` reports |",
        "| `repos` | (empty) | Multi-repo remote mode |",
        "| `visibility` | `all` | Discovery-only: a \\| b |",
        "| `archived` | (empty) | kept \\| as is, but \\\\\\| gets escaped |",
      ].join("\n"),
    );
    for (const summary of ["two\nlines", "carriage\rreturn"]) {
      expect(() => renderReadmeInputsTable({ x: { default: "", summary } })).toThrow(
        /cannot contain a line break/,
      );
    }
  });
});

describe("undeclared-policy renderers", () => {
  const sections = [
    { key: "rulesets", undeclaredDefault: "keep" },
    { key: "labels", undeclaredDefault: "delete" },
    { key: "autolinks", undeclaredDefault: "delete" },
  ] as const;

  test("the count sentence counts in words and lists delete-by-default sections first", () => {
    expect(renderPolicyCountSentence(sections)).toBe(
      "Three sections list the live resources sitting next to the declared ones: `labels`, `autolinks`, and `rulesets`.",
    );
    expect(renderPolicyCountSentence(sections.slice(0, 2))).toBe(
      "Two sections list the live resources sitting next to the declared ones: `labels` and `rulesets`.",
    );
  });

  test("the Defaults table states each default with its caveat and names the opposite policy", () => {
    expect(
      renderPolicyDefaultsTable(sections, {
        rulesets: { override: "make the file the complete ruleset inventory" },
        labels: { caveat: "Probot parity", override: "manage a core set" },
        autolinks: { override: "declare some references" },
      }),
    ).toBe(
      [
        "| Section | Default | The override buys you |",
        "|---|---|---|",
        "| `labels` | delete (Probot parity) | `keep`: manage a core set |",
        "| `autolinks` | delete | `keep`: declare some references |",
        "| `rulesets` | keep | `delete`: make the file the complete ruleset inventory |",
      ].join("\n"),
    );
    expect(() => renderPolicyDefaultsTable(sections, {})).toThrow(
      /no Defaults-per-section prose for the "labels" section/,
    );
  });
});

describe("permissions renderers", () => {
  test("the grant sentence names each primary grant once, a read-only override at read, and the org grant", () => {
    // labels: Issues. branches: Administration, Contents probe override at
    // read. teams: Administration plus the Members org grant. actions:
    // Administration, with a writing Actions override that joins the write list.
    const sections = ["labels", "branches", "teams", "actions"].map((key) =>
      sectionModule(key as "labels" | "branches" | "teams" | "actions"),
    );
    expect(renderGrantSentence(sections)).toBe(
      "To manage everything in one PAT, grant Issues, Administration, and Actions at write, plus Contents at read and (for org repos) the Members organization permission at read.",
    );
    expect(renderGrantSentence([sectionModule("labels")])).toBe(
      "To manage everything in one PAT, grant Issues at write.",
    );
  });

  test("an endpoint restating the section's alternatives in another order adds no grant", () => {
    const section = sectionModule("code_scanning_default_setup");
    expect(section.permission.repo).toEqual(["administration", "code_scanning_alerts"]);
    const reordered: SectionMeta = {
      ...section,
      endpoints: {
        setup: {
          route: "GET /repos/{owner}/{repo}/code-scanning/default-setup",
          statuses: { 200: "the setup" },
          permission: { repo: ["code_scanning_alerts", "administration"] },
        },
      },
    };
    expect(renderGrantSentence([reordered])).toBe(
      "To manage everything in one PAT, grant Administration at write.",
    );
  });

  test("an endpoint override carrying an organization grant is asked for too", () => {
    const orgOverride: SectionMeta = {
      ...sectionModule("labels"),
      endpoints: {
        teams: {
          route: "GET /repos/{owner}/{repo}/teams",
          statuses: { 200: "the teams" },
          permission: { repo: ["administration"], org: "members" },
        },
      },
    };
    expect(renderGrantSentence([orgOverride])).toBe(
      "To manage everything in one PAT, grant Issues at write, plus Administration at read and (for org repos) the Members organization permission at read.",
    );
  });

  test("the gated-reads list names a fully write-gated section by its reads' permission", () => {
    expect(renderGatedReads([sectionModule("labels"), sectionModule("codespaces_secrets")])).toBe(
      "- GitHub gates even the Codespaces secrets reads at write, so `codespaces_secrets` needs its write grant in check mode too.",
    );
    expect(renderGatedReads([sectionModule("labels")])).toBe("");
    // The bullet names the gated reads' own permission, not the section's.
    const gatedOverride: SectionMeta = {
      ...sectionModule("labels"),
      endpoints: {
        list: {
          route: "GET /repos/{owner}/{repo}/actions/variables",
          statuses: { 200: "the variables" },
          permission: { repo: ["actions"] },
          accessGrade: "write",
        },
      },
    };
    expect(renderGatedReads([gatedOverride])).toBe(
      "- GitHub gates even the Actions reads at write, so `labels` needs the Actions write grant in check mode too.",
    );
  });

  test("a section with only some reads write-gated names those reads by route", () => {
    // GitHub gates per endpoint (the interaction-limits pull request cap GETs
    // are Administration-write beside an Administration-read base GET), so
    // the bullet cannot say "even the ... reads": it names the gated routes.
    const mixed: SectionMeta = {
      ...sectionModule("labels"),
      permission: { repo: ["administration"] },
      endpoints: {
        get: { route: "GET /repos/{owner}/{repo}/interaction-limits", statuses: { 200: "x" } },
        capGet: {
          route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
          statuses: { 200: "x" },
          accessGrade: "write",
        },
        bypassList: {
          route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
          statuses: { 200: "x" },
          accessGrade: "write",
        },
      },
    };
    expect(renderGatedReads([mixed])).toBe(
      "- GitHub gates the `GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap` and `GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list` reads at write, so `labels` needs its Administration write grant in check mode to verify what they return.",
    );
  });

  test("the check-mode caveat leads into the gated reads, or says a read-only PAT suffices", () => {
    expect(
      renderCheckModeGatedReads([sectionModule("labels"), sectionModule("codespaces_secrets")]),
    ).toBe(
      [
        "The read-only rule has exceptions, each a section to drop from the preview or grant at write:",
        "",
        "- GitHub gates even the Codespaces secrets reads at write, so `codespaces_secrets` needs its write grant in check mode too.",
      ].join("\n"),
    );
    expect(renderCheckModeGatedReads([sectionModule("labels")])).toBe(
      "A read-only PAT covers every section in check mode.",
    );
  });
});

describe("generated files", () => {
  test.each(Object.keys(GENERATED_REGIONS))("regenerating %s is a no-op", (path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    expect(regenerateText(path, text)).toBe(text);
  });

  test("action.yml parses back to the input and output declarations", () => {
    const actionYml = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")) as {
      inputs: unknown;
      outputs: unknown;
    };
    expect(actionYml.inputs).toEqual(
      Object.fromEntries(
        Object.entries(INPUT_DECLS).map(([name, decl]) => [
          name,
          { description: decl.description, required: false, default: decl.default },
        ]),
      ),
    );
    expect(actionYml.outputs).toEqual(
      Object.fromEntries(
        Object.entries(OUTPUT_DECLS).map(([name, decl]) => [
          name,
          { description: decl.description },
        ]),
      ),
    );
  });
});

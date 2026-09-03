/**
 * The generated-region toolchain: the marker splice, each renderer against a
 * fixture with an exact expected text, and the committed files against a
 * fresh regeneration (which is also the marker-integrity check).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GENERATED_REGIONS,
  regenerateText,
  renderActionInputs,
  renderActionOutputs,
  renderGatedReads,
  renderGrantSentence,
  renderPolicyCountSentence,
  renderPolicyDefaultsTable,
  renderReadmeInputsTable,
  replaceRegion,
} from "../../.github/scripts/gen-action-docs.js";
import { INPUT_DECLS } from "../../src/action/inputs.js";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { sectionModule } from "../../src/sections/registry.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("replaceRegion", () => {
  test("replaces the span between the markers in either comment syntax and keeps the rest", () => {
    const markdown =
      "keep\n<!-- BEGIN GENERATED: x (bun run build; edit y) -->\nold\n<!-- END GENERATED: x -->\ntail";
    expect(replaceRegion(markdown, "x", "\nnew\n")).toBe(
      "keep\n<!-- BEGIN GENERATED: x (bun run build; edit y) -->\nnew\n<!-- END GENERATED: x -->\ntail",
    );
    const yaml = "a: 1\n  # BEGIN GENERATED: y (edit z)\n  old: 1\n  # END GENERATED: y\nb: 2\n";
    expect(replaceRegion(yaml, "y", "\n  new: 1\n  ")).toBe(
      "a: 1\n  # BEGIN GENERATED: y (edit z)\n  new: 1\n  # END GENERATED: y\nb: 2\n",
    );
    // An inline region: the markers bound a span inside one sentence.
    expect(
      replaceRegion("Outputs: <!-- BEGIN GENERATED: o -->a<!-- END GENERATED: o -->.", "o", "b"),
    ).toBe("Outputs: <!-- BEGIN GENERATED: o -->b<!-- END GENERATED: o -->.");
    // Prose that merely mentions a marker is not one: the comment syntax is
    // required, so the real markers are still the only two found.
    expect(
      replaceRegion(
        `the BEGIN GENERATED: x line and END GENERATED: x line\n${markdown}`,
        "x",
        "\nnew\n",
      ),
    ).toContain("-->\nnew\n<!--");
  });

  test("rejects a region name outside the marker grammar before scanning", () => {
    expect(() => replaceRegion("", "Bad.Name", "")).toThrow(/region name is lowercase/);
  });

  test.each([
    [
      "a region whose name only prefixes the markers' name",
      "<!-- BEGIN GENERATED: x-long -->\n<!-- END GENERATED: x-long -->",
      /expected exactly one "BEGIN GENERATED: x" marker, found 0/,
    ],
    [
      "a missing END marker",
      "<!-- BEGIN GENERATED: x -->\nbody",
      /expected exactly one "END GENERATED: x" marker, found 0/,
    ],
    [
      "a duplicated BEGIN marker",
      "<!-- BEGIN GENERATED: x -->\n<!-- BEGIN GENERATED: x -->\n<!-- END GENERATED: x -->",
      /expected exactly one "BEGIN GENERATED: x" marker, found 2/,
    ],
    [
      "END before BEGIN",
      "<!-- END GENERATED: x -->\n<!-- BEGIN GENERATED: x -->",
      /"END GENERATED: x" marker precedes its BEGIN marker/,
    ],
    [
      "a hint spanning lines (it would swallow content)",
      "<!-- BEGIN GENERATED: x (a\nb) -->\n<!-- END GENERATED: x -->",
      /expected exactly one "BEGIN GENERATED: x" marker, found 0/,
    ],
    [
      "a # marker with trailing text",
      "# BEGIN GENERATED: x and more\n# END GENERATED: x",
      /expected exactly one "BEGIN GENERATED: x" marker, found 0/,
    ],
  ])("throws on %s", (_label, text, error) => {
    expect(() => replaceRegion(text, "x", "")).toThrow(error);
  });
});

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

  test("the gated-reads list names exactly the sections whose every read is write-gated", () => {
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
      "- GitHub gates even the Actions reads at write, so `labels` needs its write grant in check mode too.",
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

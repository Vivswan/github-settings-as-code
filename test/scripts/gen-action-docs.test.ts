import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULTS_TABLE_HEADER,
  GENERATED_REGIONS,
  type KnobbedSection,
  type PolicyRow,
  type PolicyRowProse,
  policyCells,
  policyTableFault,
  regenerateText,
  renderActionInputs,
  renderActionOutputs,
  renderCheckModeGatedReads,
  renderGatedReads,
  renderGrantSentence,
  renderPolicyCountSentence,
  renderPolicyDefaultsTable,
} from "../../.github/scripts/gen-action-docs.js";
import {
  type BodyShape,
  bodyRefusal,
  markerSyntaxFor,
  type RegionSpec,
  regionBounds,
} from "../../.github/scripts/lib/generated-regions.js";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import { INPUT_DECLS } from "../../src/flows/inputs.js";
import { tableRow } from "../../src/report/markdown.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import { sectionModule } from "../../src/sections/registry.js";
import { ROOT } from "../root.js";
import { relocatedRegion } from "./relocated-region.js";

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
    expect(parseYaml(`inputs:\n${text}\n`).inputs).toEqual(
      Object.fromEntries(
        Object.entries(decls).map(([name, decl]) => [name, { ...decl, required: false }]),
      ),
    );
  });

  test("a name a YAML 1.1 parser would re-type is quoted, and only then", () => {
    // The 1.1 schema is the generator's choice; the library's default 1.2 schema would leave every word but null,
    // true, and false bare.
    const words = ["null", "true", "false", "yes", "no", "on", "off", "y", "n"];
    const decls = {
      ...Object.fromEntries(
        words.map((word) => [word, { description: `A ${word} input.`, default: "x" }]),
      ),
      Mixed_Case: { description: "Not a plain lowercase name.", default: "" },
      plain: { description: "A plain name.", default: "" },
    };
    const text = renderActionInputs(decls);
    // The key lines are the only ones at exactly two-space indent.
    expect(text.split("\n").filter((line) => /^ {2}\S/.test(line))).toEqual([
      ...words.map((word) => `  "${word}":`),
      '  "Mixed_Case":',
      "  plain:",
    ]);
    expect(Object.keys(parseYaml(`inputs:\n${text}\n`).inputs)).toEqual(Object.keys(decls));
    expect(renderActionOutputs({ y: { description: "Short." } })).toBe(
      '  "y":\n    description: >-\n      Short.',
    );
  });

  test.each([
    ["a double space", "Two  spaces."],
    ["a trailing space", "Padded. "],
    ["quotes, a colon, and a hash", 'Targets, or "*" to discover: owner/name #1.'],
    ["a word longer than the line", "A".repeat(200)],
    ["one column over the line budget", `${"a".repeat(30)} ${"b".repeat(42)}`],
  ])("a description with %s folds back verbatim", (_label, description) => {
    const text = renderActionInputs({ x: { description, default: "" } });
    expect(parseYaml(`inputs:\n${text}\n`).inputs.x.description).toBe(description);
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
    expect(() =>
      renderPolicyDefaultsTable(sections.slice(1, 2), {
        labels: { override: "manage a core set | or two" },
      }),
    ).toThrow('row 1 of the table cell 3 is blank or contains "|" or a line break');
    // The renderer refuses at its own boundary what its guard could never read back: a blank caveat or override,
    // whatever the type said about the value, since a narrowing can hide a property.
    const labels = sections.slice(1, 2);
    const empty = 'the "labels" Defaults row has a blank caveat or override';
    expect(() =>
      renderPolicyDefaultsTable(labels, { labels: { caveat: "", override: "x" } }),
    ).toThrow(empty);
    expect(() => renderPolicyDefaultsTable(labels, { labels: { override: "" } })).toThrow(empty);
    const hidden: { readonly labels: { readonly caveat: readonly []; readonly override: "x" } } = {
      labels: { caveat: [], override: "x" },
    };
    const narrowed: { readonly labels: { readonly override: "x" } } = hidden;
    expect(() => renderPolicyDefaultsTable(labels, narrowed)).toThrow(empty);
  });
});

describe("permissions renderers", () => {
  test("the grant sentence names each primary grant once, a read-only override at read, and the org grant", () => {
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
    // GitHub gates per endpoint (the interaction-limits cap GETs are Administration-write beside an Administration-read base GET), so the bullet
    // names the gated routes.
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
      "- GitHub gates the `GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap` " +
        "and `GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list` reads at write, so " +
        "`labels` needs its Administration write grant in check mode to verify what they return.",
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
  test.each(
    Object.entries(GENERATED_REGIONS).flatMap(([path, regions]) =>
      regions.map((region): [name: string, path: string, region: RegionSpec] => [
        region.name,
        path,
        region,
      ]),
    ),
  )("refuses to regenerate %s moved away from its home in %s", (name, path, region) => {
    // Each region pasted after the file's last top-level key (YAML) or last section heading (markdown), both outside its declared home; other
    // misplacements are pinned in generated-regions.test.ts.
    const text = readFileSync(join(ROOT, path), "utf8");
    const { placement } = region;
    const anchor =
      placement.kind === "under-key" ? "\nruns:\n" : `\n${text.match(/^## .*$/gm)?.at(-1)}\n`;
    const home =
      placement.kind === "under-key"
        ? `must sit directly under the "${placement.key}:" mapping in ${path}`
        : placement.kind === "under-heading"
          ? `must sit under "${placement.heading}" in ${path}`
          : `must close ${path}`;
    expect(() =>
      regenerateText(path, relocatedRegion(text, name, markerSyntaxFor(path), anchor)),
    ).toThrow(`the ${name} region ${home}`);
  });

  const shapes = new Map<string, BodyShape>(
    Object.values(GENERATED_REGIONS)
      .flat()
      .map((region) => [region.name, region.body]),
  );
  const shapeOf = (name: string): BodyShape => shapes.get(name) ?? (() => `no ${name} region`);

  test("each region's body shape accepts its renderer's output on edge-case declarations", () => {
    const accepts = (name: string, rendered: string): void => {
      expect(bodyRefusal(shapeOf(name), `\n${rendered}\n`), name).toBeUndefined();
    };
    accepts(
      "action-inputs",
      renderActionInputs({
        'say "hi"': { description: "A quoted, escaped name.", default: 'a "quoted" default' },
        on: { description: "A".repeat(200), default: "" },
        "settings-file": { description: "Plain.", default: "" },
      }),
    );
    // An empty declaration set renders a body the shapes admit, not the `{}` the library writes for an empty mapping.
    accepts("action-inputs", renderActionInputs({}));
    accepts("action-outputs", renderActionOutputs({}));
    accepts("action-outputs", renderActionOutputs({ result: { description: "A | B." } }));
    const knobbed = [
      { key: "labels", undeclaredDefault: "delete" },
      { key: "rulesets", undeclaredDefault: "keep" },
    ] as const;
    accepts("policy-count-sentence", renderPolicyCountSentence(knobbed));
    // Parentheses, backticks, colons, and the two Unicode line separators cellFault() admits must read back as the
    // opaque prose they are.
    accepts(
      "policy-defaults-table",
      renderPolicyDefaultsTable(knobbed, {
        labels: { caveat: "Probot (parity): `delete`\u2028", override: "manage a core set" },
        rulesets: { override: "make the file (`settings.yml`): the inventory\u2029" },
      }),
    );
    accepts("policy-defaults-table", renderPolicyDefaultsTable([], {}));
    accepts("permissions-grant-sentence", renderGrantSentence([sectionModule("teams")]));
    const overrideGated: SectionMeta = {
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
    const partlyGated: SectionMeta = {
      ...sectionModule("labels"),
      permission: { repo: ["administration"] },
      endpoints: {
        get: { route: "GET /repos/{owner}/{repo}/interaction-limits", statuses: { 200: "x" } },
        capGet: {
          route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
          statuses: { 200: "x" },
          accessGrade: "write",
        },
      },
    };
    for (const sections of [
      [sectionModule("labels")],
      [sectionModule("codespaces_secrets"), overrideGated, partlyGated],
    ]) {
      accepts("permissions-gated-reads", renderGatedReads(sections));
      accepts("check-mode-gated-reads", renderCheckModeGatedReads(sections));
    }
  });

  test("each region's body shape rejects authored text and every other region's body", () => {
    // A shape loosened to accept anything would still pass the renderer test above; a sibling sharing the shape is the same table in another home,
    // which the shape accepts by design.
    const regions = Object.entries(GENERATED_REGIONS).flatMap(([path, list]) =>
      list.map((region) => ({ path, region })),
    );
    const bodies = new Map(
      regions.map(({ path, region }) => {
        const text = readFileSync(join(ROOT, path), "utf8");
        const { begin, end } = regionBounds(text, region.name, markerSyntaxFor(path));
        return [region.name, text.slice(begin[1], end[0])];
      }),
    );
    for (const { region } of regions) {
      const foreign = [
        "\nAuthored prose the generator never writes.\n",
        "\n## A heading\n",
        ...[...bodies].filter(([name]) => shapes.get(name) !== region.body).map(([, body]) => body),
      ];
      for (const body of foreign) {
        expect(
          bodyRefusal(region.body, body),
          `${region.name} accepts ${JSON.stringify(body.slice(0, 40))}`,
        ).toBeDefined();
      }
    }
  });

  // Each body is table text the renderer never writes; admitted, it would be erased on the next regeneration.
  const policyRow = "| `labels` | delete (Probot parity) | `keep`: manage a core set |";
  const policyTable = (rows: string): string =>
    `\n| Section | Default | The override buys you |\n|---|---|---|\n${rows}\n`;
  test.each<[label: string, body: string, refusal: RegExp]>([
    [
      "an override naming the default policy itself",
      policyTable("| `labels` | delete | `delete`: manage a core set |"),
      /line 3 names `delete` where the override is the opposite policy, `keep`/,
    ],
    [
      "a keep row above a delete row",
      policyTable(
        `| \`rulesets\` | keep | \`delete\`: make the file the inventory |\n${policyRow}`,
      ),
      /line 3 reads "\| `rulesets` .* where the generator writes "\| `labels` /,
    ],
    [
      "a fourth cell",
      policyTable(`${policyRow.slice(0, -2)} | authored |`),
      /line 3 has 4 cells where the table has 3/,
    ],
    [
      "a pipe in the caveat",
      policyTable(policyRow.replace("Probot parity", "a | b")),
      /line 3 has 4 cells/,
    ],
    [
      "a carriage return in the caveat",
      policyTable(policyRow.replace("Probot parity", "a\rb")),
      /line 3 cell 2 is blank or contains "\|" or a line break/,
    ],
    [
      "a blank Default cell",
      policyTable(policyRow.replace("delete (Probot parity)", "")),
      /line 3 cell 2 is blank/,
    ],
    [
      "a Section cell outside a code span",
      policyTable(policyRow.replace("`labels`", "labels")),
      /line 3 does not open with a section key/,
    ],
    [
      "a Default outside delete and keep",
      policyTable(policyRow.replace("delete (", "deleted (")),
      /line 3 states no delete or keep default/,
    ],
    [
      "an override without its policy span",
      policyTable(policyRow.replace("`keep`: ", "")),
      /line 3 names no policy span/,
    ],
    [
      "the same section twice",
      policyTable(`${policyRow}\n${policyRow}`),
      /line 4 repeats the `labels` row/,
    ],
    [
      "a blank caveat, which the renderer refuses",
      policyTable(policyRow.replace("Probot parity", "")),
      /line 3 has a blank caveat or override/,
    ],
    [
      "a blank override, which the renderer refuses",
      policyTable(policyRow.replace("manage a core set", "")),
      /line 3 has a blank caveat or override/,
    ],
    [
      "another table's header",
      "\n| Section | Default |\n|---|---|\n",
      /line 1 reads "\| Section \| Default \|" where the generator writes/,
    ],
    ["a body without its closing newline", policyTable(policyRow).slice(0, -1), /line 3 reads/],
  ])("the Defaults table guard refuses %s, which does not round-trip", (_label, body, refusal) => {
    expect(bodyRefusal(shapeOf("policy-defaults-table"), body)).toMatch(refusal);
  });

  // The equivalence the round trip promises, held to the one statement both sides consult: the renderer throws
  // exactly the fault policyTableFault() states for the rows, the guard admits what the renderer wrote, and the
  // guard refuses the same cells joined without the renderer whenever the statement faults. A check on one side
  // only turns a generated input red.
  test("the Defaults renderer and guard agree with the shared statement on every generated input", () => {
    const shape = shapeOf("policy-defaults-table");
    const outcomes = new Map<string, "written" | "faulted">();
    const hold = (
      input: string,
      sections: readonly KnobbedSection[],
      prose: Readonly<Record<string, PolicyRowProse>>,
    ): void => {
      // The renderer's delete-first order, so a fault names the same row on both sides.
      const rows = ["delete", "keep"].flatMap((policy) =>
        sections
          .filter((section) => section.undeclaredDefault === policy)
          .map(
            (section): PolicyRow => ({ section, prose: prose[section.key] ?? { override: "" } }),
          ),
      );
      const fault = policyTableFault(rows);
      let rendered: string | undefined;
      let thrown: string | undefined;
      try {
        rendered = renderPolicyDefaultsTable(sections, prose);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      expect(thrown, input).toBe(fault);
      if (rendered !== undefined) {
        expect(bodyRefusal(shape, `\n${rendered}\n`), input).toBeUndefined();
        outcomes.set(input, "written");
      } else {
        const joined = [DEFAULTS_TABLE_HEADER, ...rows.map(policyCells).map(tableRow)].join("\n");
        expect(bodyRefusal(shape, `\n${joined}\n`), input).toBeDefined();
        outcomes.set(input, "faulted");
      }
    };
    const policies = ["delete", "keep"] as const;
    const caveats = [
      undefined,
      "Probot parity",
      "",
      "  ",
      " padded ",
      "(nested) `x`",
      "a | b",
      "a\rb",
    ];
    const overrides = ["x", "", "   ", " padded ", "`keep`: y", "a | b", "y\u2028z"];
    for (const key of ["labels", "Labels", "secret_scanning_custom_patterns"]) {
      for (const undeclaredDefault of policies) {
        for (const caveat of caveats) {
          for (const override of overrides) {
            const prose = caveat === undefined ? { override } : { caveat, override };
            hold(
              `${key} ${undeclaredDefault} ${JSON.stringify(prose)}`,
              [{ key, undeclaredDefault }],
              {
                [key]: prose,
              },
            );
          }
        }
      }
    }
    const labels: KnobbedSection = { key: "labels", undeclaredDefault: "delete" };
    const rulesets: KnobbedSection = { key: "rulesets", undeclaredDefault: "keep" };
    const prose = { labels: { override: "x" }, rulesets: { caveat: "c", override: "y" } };
    hold("labels twice", [labels, labels], prose);
    hold("keep before delete", [rulesets, labels], prose);
    hold("whitespace override", [labels], { labels: { override: "   " } });
    expect(outcomes.get("labels twice")).toBe("faulted");
    expect(outcomes.get("keep before delete")).toBe("written");
    expect(outcomes.get("whitespace override")).toBe("faulted");
    const written = [...outcomes.values()].filter((outcome) => outcome === "written").length;
    expect(written).toBeGreaterThan(0);
    expect(outcomes.size - written).toBeGreaterThan(0);
  });

  test("a region that renders a table carries a round trip, never a hand-written grammar", () => {
    // A table region's guard and its renderer share one grammar only through the round trip, so a RegExp body on a
    // table region is a second grammar.
    for (const region of Object.values(GENERATED_REGIONS).flat()) {
      if (region.render().startsWith("\n|")) {
        expect(region.body, region.name).not.toBeInstanceOf(RegExp);
      }
    }
  });

  // Each row is YAML the emitter never writes; admitted, it would be replaced on the next regeneration. The tab inside
  // the quoted timestamp is literal, and the two-line description folds to one line.
  const inputEntry = (
    key: string,
    defaultValue: string,
    description = "      D.\n",
    header = ">-",
  ) =>
    `\n  ${key}:\n    description: ${header}\n${description}    required: false\n    default: ${defaultValue}\n`;
  test.each<[label: string, body: string, refusal: RegExp]>([
    ["a bare YAML word as a key", inputEntry("on", '"x"'), /line 1 reads " {2}on:"/],
    ["a quoted plain name", inputEntry('"ordinary"', '"x"'), /line 1 reads/],
    [
      "a quoted timestamp holding a literal tab",
      inputEntry('"2000-01-01\t0:0:0"', '"x"'),
      /line 1 reads/,
    ],
    ["an escaped surrogate pair as a default", inputEntry("x", '"\\ud83d\\ude00"'), /line 5 reads/],
    ["a \\u0009 default the emitter spells \\t", inputEntry("x", '"\\u0009"'), /line 5 reads/],
    ["a two-line description", inputEntry("x", '"x"', "      One\n      two.\n"), /line 3 reads/],
    ["a number as a default", inputEntry("x", "42"), /x\.default: .*received number/],
    [
      "a leading-space description",
      inputEntry("x", '"x"', "       Padded.\n", ">2-"),
      /x\.description/,
    ],
    ["an input entry under the outputs markers", inputEntry("x", '"x"'), /x: Unrecognized key/],
    ["text that is not YAML", "\n  x: [\n", /does not parse as YAML/],
    ["an alias without its anchor", "\n  x: *missing\n", /does not convert from YAML/],
  ])("the guard refuses %s, which does not round-trip", (label, body, refusal) => {
    const shape = shapeOf(label.includes("outputs") ? "action-outputs" : "action-inputs");
    expect(bodyRefusal(shape, body)).toMatch(refusal);
  });

  test.each<[label: string, name: string, decl: { description: string; default: string }]>([
    ["a lone low surrogate in a default", "x", { description: "D.", default: "\udc00" }],
    ["a description beginning with a hash", "x", { description: "# not a comment", default: "" }],
    ["a description beginning with a dash", "x", { description: "- not a list item", default: "" }],
    ["a NUL default", "x", { description: "D.", default: "\u0000" }],
    ["a __proto__ name", "__proto__", { description: "D.", default: "" }],
    [
      "the merge-key spelling as name, description, and default",
      "<<",
      { description: "<<", default: "<<" },
    ],
  ])("legitimate emitter output with %s round-trips through the guard", (_label, name, decl) => {
    const text = renderActionInputs(Object.fromEntries([[name, decl]]));
    expect(bodyRefusal(shapeOf("action-inputs"), `\n${text}\n`)).toBeUndefined();
    expect(Object.entries(parseYaml(`inputs:\n${text}\n`).inputs)).toEqual([
      [name, { ...decl, required: false }],
    ]);
  });

  test.each([
    ["a line feed", "One\nTwo"],
    ["a carriage return", "One\rTwo"],
  ])(
    "the renderer refuses a description broken by %s, naming the declaration",
    (_label, description) => {
      expect(() => renderActionInputs({ x: { description, default: "" } })).toThrow(
        /the inputs declarations: x\.description/,
      );
      expect(() => renderActionOutputs({ x: { description } })).toThrow(
        /the outputs declarations: x\.description/,
      );
    },
  );

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

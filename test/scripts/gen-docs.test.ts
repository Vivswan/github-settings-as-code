import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageData } from "../../.github/scripts/coverage-data.js";
import type { EndpointAnchors } from "../../.github/scripts/endpoint-docs.js";
import {
  type CoverageSection,
  FACT_WORD_CAP,
  PAGE_REGIONS,
  patFormParameters,
  renderCoverage,
  renderCoverageFile,
  renderPage,
  renderPatCell,
  renderPatFormUrl,
  renderSectionsTable,
  SECTIONS_TABLE_HEADER,
  type SectionsTableRow,
  sectionsCells,
} from "../../.github/scripts/gen-docs.js";
import { bodyRefusal } from "../../.github/scripts/lib/generated-regions.js";
import { tableFault, tableRow } from "../../src/report/markdown.js";
import type { SectionDocs } from "../../src/sections/contract/docs.js";
import { ROOT } from "../root.js";

describe("renderSectionsTable", () => {
  test("renders one row per section, derived cells around the authored ones", () => {
    const table = renderSectionsTable(
      [
        { key: "labels", permission: { repo: ["issues"] }, undeclaredDefault: "delete" },
        {
          key: "teams",
          permission: { repo: ["administration"], org: "members" },
          undeclaredDefault: "untouched",
        },
        {
          key: "environments",
          permission: { repo: ["environments"] },
          grantCaveat:
            'declared "deployment_branch_policies" keys additionally need "Actions" (read) and "Administration" (read and write)',
          undeclaredDefault: "untouched",
        },
      ],
      {
        labels: { sections_table: { endpoints: "labels CRUD", notes: "upsert by name" } },
        teams: {
          sections_table: { endpoints: "org team repo permissions", notes: "org repos only" },
        },
        environments: { sections_table: { endpoints: "PUT environments", notes: "reviewers" } },
      },
    );
    expect(table).toBe(
      [
        "| Section | Endpoints | PAT permission | Undeclared default | Notes |",
        "|---|---|---|---|---|",
        "| `labels` | labels CRUD | Issues: write | deleted (settable) | upsert by name |",
        "| `teams` | org team repo permissions | Members: read (org permission) + Administration: write | untouched | org repos only |",
        "| `environments` | PUT environments | Environments: write; declared `deployment_branch_policies` keys additionally need Actions: read and Administration: write | untouched | reviewers |",
      ].join("\n"),
    );
  });

  test("refuses a section without docs and a cell that would split its row", () => {
    const row = {
      key: "labels",
      permission: { repo: ["issues"] },
      undeclaredDefault: "delete",
    } as const;
    expect(() => renderSectionsTable([row], {})).toThrow('section "labels" has no docs entry');
    expect(() =>
      renderSectionsTable([row], {
        labels: { sections_table: { endpoints: "labels | CRUD", notes: "" } },
      }),
    ).toThrow('row 1 of the table cell 2 is blank or contains "|" or a line break');
    expect(() =>
      renderSectionsTable([row], {
        labels: { sections_table: { endpoints: "labels CRUD", notes: "upsert\nby name" } },
      }),
    ).toThrow('row 1 of the table cell 5 is blank or contains "|" or a line break');
  });
});

describe("the Sections table guard", () => {
  const shape =
    PAGE_REGIONS["docs/reference/sections.md"]?.find((region) => region.name === "sections-table")
      ?.body ?? (() => "no sections-table region");
  const sectionsRow =
    "| `labels` | labels CRUD | Issues: write | deleted (settable) | upsert by name |";
  const sectionsTable = (rows: string): string =>
    `\n| Section | Endpoints | PAT permission | Undeclared default | Notes |\n|---|---|---|---|---|\n${rows}\n`;

  test("admits the renderer's output, padded and punctuated cells included", () => {
    // Surrounding blanks, parentheses, backticks, and colons are all cells cellFault() admits and read back byte for byte.
    const rendered = renderSectionsTable(
      [
        { key: "labels", permission: { repo: ["issues"] }, undeclaredDefault: "delete" },
        { key: "rulesets", permission: { repo: ["administration"] }, undeclaredDefault: "keep" },
      ],
      {
        labels: { sections_table: { endpoints: " labels (CRUD): `x` ", notes: "a: (b) `c`" } },
        rulesets: { sections_table: { endpoints: "rulesets CRUD", notes: "n" } },
      },
    );
    expect(rendered).toContain("|  labels (CRUD): `x`  |");
    expect(bodyRefusal(shape, `\n${rendered}\n`)).toBeUndefined();
    expect(bodyRefusal(shape, sectionsTable("").slice(0, -1))).toBeUndefined();
    expect(bodyRefusal(shape, "\n")).toBeUndefined();
  });

  // Each body is table text the renderer never writes; admitted, it would be erased on the next regeneration.
  test.each<[label: string, body: string, refusal: RegExp]>([
    [
      "a pipe in the Notes cell",
      sectionsTable(sectionsRow.replace("upsert by name", "upsert | rename")),
      /line 3 has 6 cells where the table has 5/,
    ],
    [
      "a carriage return in the Notes cell",
      sectionsTable(sectionsRow.replace("upsert by name", "upsert\rby name")),
      /line 3 cell 5 is blank or contains "\|" or a line break/,
    ],
    [
      "a sixth cell",
      sectionsTable(`${sectionsRow.slice(0, -2)} | authored |`),
      /line 3 has 6 cells where the table has 5/,
    ],
    [
      "a blank Endpoints cell",
      sectionsTable(sectionsRow.replace("labels CRUD", "")),
      /line 3 cell 2 is blank/,
    ],
    [
      "a row without its outer pipes",
      sectionsTable(sectionsRow.slice(2, -2)),
      /line 3 has 3 cells where the table has 5/,
    ],
    [
      "an Undeclared default outside the three displays",
      sectionsTable(sectionsRow.replace("deleted (settable)", "deleted")),
      /line 3 shows an Undeclared default the renderer has no display for/,
    ],
    [
      "a Section cell outside a code span",
      sectionsTable(sectionsRow.replace("`labels`", "labels")),
      /line 3 does not open with a section key in a code span/,
    ],
    [
      "a second row for the same section with other prose",
      sectionsTable(`${sectionsRow}\n${sectionsRow.replace("upsert by name", "other notes")}`),
      /line 4 repeats the `labels` row/,
    ],
    [
      "the page's column table",
      "\n| Value | Meaning |\n|---|---|\n| `untouched` | never read |\n",
      /line 1 reads "\| Value \| Meaning \|" where the generator writes "\| Section \| Endpoints/,
    ],
    ["a blank line after the last row", sectionsTable(`${sectionsRow}\n`), /line 4 has 0 cells/],
  ])("refuses %s, which does not round-trip", (_label, body, refusal) => {
    expect(bodyRefusal(shape, body)).toMatch(refusal);
  });

  // The equivalence the round trip promises, held to the one statement both sides consult: the renderer throws
  // exactly the fault tableFault() states for the cells, the guard admits what the renderer wrote, and the guard
  // refuses the same cells joined without the renderer whenever the statement faults. A check on one side only
  // turns a generated input red.
  test("the Sections renderer and guard agree with the shared statement on every generated input", () => {
    const displays = ["delete", "keep", "untouched"] as const;
    const row = (key: "labels" | "rulesets", undeclaredDefault: (typeof displays)[number]) =>
      ({ key, permission: { repo: ["issues"] }, undeclaredDefault }) as const;
    const outcomes = new Map<string, "written" | "faulted">();
    const hold = (
      input: string,
      sections: readonly SectionsTableRow[],
      text: { endpoints: string; notes: string },
    ): void => {
      const docs = { labels: { sections_table: text }, rulesets: { sections_table: text } };
      const cells = sectionsCells(sections, docs);
      const fault = tableFault(SECTIONS_TABLE_HEADER, cells, "keyed");
      let rendered: string | undefined;
      let thrown: string | undefined;
      try {
        rendered = renderSectionsTable(sections, docs);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      expect(thrown, input).toBe(fault);
      if (rendered !== undefined) {
        expect(bodyRefusal(shape, `\n${rendered}\n`), input).toBeUndefined();
        outcomes.set(input, "written");
      } else {
        const joined = [SECTIONS_TABLE_HEADER, ...cells.map(tableRow)].join("\n");
        expect(bodyRefusal(shape, `\n${joined}\n`), input).toBeDefined();
        outcomes.set(input, "faulted");
      }
    };
    const texts = ["x", "", "  ", "a | b", "a\rb", " padded ", "`code`: (p)", "y\u2028z"];
    for (const display of displays) {
      const lists = {
        one: [row("labels", display)],
        two: [row("labels", display), row("rulesets", display)],
        twice: [row("labels", display), row("labels", display)],
      };
      for (const [name, sections] of Object.entries(lists)) {
        for (const endpoints of texts) {
          for (const notes of texts) {
            const input = `${display} ${name} ${JSON.stringify({ endpoints, notes })}`;
            hold(input, sections, { endpoints, notes });
          }
        }
      }
    }
    expect(outcomes.get('delete twice {"endpoints":"x","notes":"x"}')).toBe("faulted");
    expect(outcomes.get('untouched one {"endpoints":"x","notes":" padded "}')).toBe("written");
    const written = [...outcomes.values()].filter((outcome) => outcome === "written").length;
    expect(written).toBeGreaterThan(0);
    expect(outcomes.size - written).toBeGreaterThan(0);
  });

  test("a region that renders a table carries a round trip, never a hand-written grammar", () => {
    // A table region's guard and its renderer share one grammar only through the round trip, so a RegExp body on a
    // table region is a second grammar.
    for (const region of Object.values(PAGE_REGIONS).flat()) {
      if (region.render().startsWith("\n|")) {
        expect(region.body, region.name).not.toBeInstanceOf(RegExp);
      }
    }
  });
});

describe("renderCoverage", () => {
  const sections: CoverageSection[] = [
    {
      key: "repository",
      endpoints: {
        get: { route: "GET /repos/{owner}/{repo}" },
        update: { route: "PATCH /repos/{owner}/{repo}" },
        topics: { route: "PUT /repos/{owner}/{repo}/topics" },
      },
      graphql: { features: { name: "RepositoryFeatures" } },
    },
    { key: "labels", endpoints: { list: { route: "GET /repos/{owner}/{repo}/labels" } } },
  ];
  const docs = {
    repository: {
      coverage: [
        {
          area: "[Core](https://x/repos)",
          endpoints: ["get", "update", "features"],
          notes: ["PATCH passthrough.", "GET-only fields are refused."],
        },
        { area: "Forking", keys: "allow_forking", endpoints: [], notes: ["Rides the PATCH."] },
        {
          area: "[Topics](https://x/topics)",
          keys: "topics",
          endpoints: ["topics"],
          notes: ["PUT topics."],
        },
      ],
    },
    labels: {
      coverage: [{ area: "Labels", endpoints: ["list"], notes: ["CRUD; deleted by default."] }],
    },
  } as const;
  const anchors: EndpointAnchors = {
    rest: {
      "GET /repos/{owner}/{repo}": "https://docs.github.com/en/rest/repos/repos#get",
      "PATCH /repos/{owner}/{repo}": "https://docs.github.com/en/rest/repos/repos#update",
      "PUT /repos/{owner}/{repo}/topics": "https://docs.github.com/en/rest/repos/repos#topics",
      "GET /repos/{owner}/{repo}/labels": "https://docs.github.com/en/rest/issues/labels#list",
    },
    graphql: {
      RepositoryFeatures: "https://docs.github.com/en/graphql/reference/repos#object-repository",
    },
  };
  const data: CoverageData = {
    intro: ["The tenet.", "The inventory."],
    supportedOrder: ["labels", "repository"],
    gaps: { emptyNote: "No gaps." },
    noPublicApi: { intro: "UI-only:", items: ["Social preview.", "Wiki editing."] },
    outOfScope: { items: ["User surface."] },
  };
  const render = (
    overrides: {
      sections?: CoverageSection[];
      docs?: Readonly<Record<string, Pick<SectionDocs, "coverage">>>;
      data?: Partial<CoverageData>;
      anchors?: EndpointAnchors;
    } = {},
  ) =>
    renderCoverage(
      overrides.sections ?? sections,
      overrides.docs ?? docs,
      { ...data, ...overrides.data },
      overrides.anchors ?? anchors,
    );

  test("renders the intro, one row per area with one link per call, the notes by row, then the authored sections", () => {
    expect(render()).toBe(
      [
        "The tenet.",
        "",
        "The inventory.",
        "",
        "## Supported",
        "",
        "| Area | Key in settings.yml | Endpoints |",
        "|---|---|---|",
        "| Labels | [`labels`](sections.md) | [GET /repos/{owner}/{repo}/labels](https://docs.github.com/en/rest/issues/labels#list) |",
        [
          "| [Core](https://x/repos) | [`repository`](sections.md) | ",
          "[GET /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos#get)<br>",
          "[PATCH /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos#update)<br>",
          "[GraphQL RepositoryFeatures](https://docs.github.com/en/graphql/reference/repos#object-repository) |",
        ].join(""),
        "| Forking | [`repository`](sections.md) (`allow_forking`) | shares the calls of the Core row |",
        "| [Topics](https://x/topics) | [`repository`](sections.md) (`topics`) | [PUT /repos/{owner}/{repo}/topics](https://docs.github.com/en/rest/repos/repos#topics) |",
        "",
        "### Notes",
        "",
        "**Labels** (`labels`)",
        "",
        "- CRUD; deleted by default.",
        "",
        "**Core** (`repository`)",
        "",
        "- PATCH passthrough.",
        "- GET-only fields are refused.",
        "",
        "**Forking** (`repository`)",
        "",
        "- Rides the PATCH.",
        "",
        "**Topics** (`repository`)",
        "",
        "- PUT topics.",
        "",
        "## Repo-scoped gaps (not built yet)",
        "",
        "No gaps.",
        "",
        "| Area | Endpoints | Why it matters |",
        "|---|---|---|",
        "",
        "## No public API (cannot be built)",
        "",
        "UI-only:",
        "",
        "- Social preview.",
        "- Wiki editing.",
        "",
        "## Out of scope (user or org account surface)",
        "",
        "- User surface.",
      ].join("\n"),
    );
  });

  // Prose may repeat a structural line word for word, and keys may hold the two Unicode line separators the cell
  // rule admits; the guard reads the structure from the lines around a line, never from one line alone, or a page
  // the generator wrote would be refused as authored.
  test("a page whose prose repeats the Supported heading or the gaps header line, or whose keys hold a line separator, still reads back as the generator's", () => {
    const rendered = render({
      docs: {
        ...docs,
        labels: {
          coverage: [{ area: "Labels", keys: "x\u2028y", endpoints: ["list"], notes: ["CRUD."] }],
        },
      },
      data: {
        intro: ["Intro.", "## Supported"],
        gaps: { emptyNote: "| Area | Endpoints | Why it matters |" },
      },
    });
    const file = `---\norder: 115\n---\n\n# Coverage\n\n<!-- BEGIN GENERATED: coverage -->\n${rendered}\n<!-- END GENERATED: coverage -->\n`;
    expect(() => renderCoverageFile(file)).not.toThrow();
  });

  test("a known gap renders as a table row and drops the empty-state note", () => {
    const rendered = render({
      data: {
        gaps: {
          rows: [
            {
              area: "Widgets",
              endpoints: ["GET /repos/{owner}/{repo}/widgets", "PUT /repos/{owner}/{repo}/widgets"],
              why: "Widgets matter.",
            },
          ],
        },
      },
    });
    expect(rendered).toContain(
      [
        "## Repo-scoped gaps (not built yet)",
        "",
        "| Area | Endpoints | Why it matters |",
        "|---|---|---|",
        "| Widgets | GET /repos/{owner}/{repo}/widgets, PUT /repos/{owner}/{repo}/widgets | Widgets matter. |",
        "",
        "## No public API",
      ].join("\n"),
    );
    expect(rendered).not.toContain("No gaps.");
  });

  test("refuses a display order that skips, repeats, or invents a section", () => {
    const order = (supportedOrder: CoverageData["supportedOrder"]) => () =>
      render({ data: { supportedOrder } });
    expect(order(["labels"])).toThrow("missing [repository], unknown or repeated []");
    expect(order(["labels", "repository", "labels"])).toThrow(
      "missing [], unknown or repeated [labels]",
    );
    expect(order(["labels", "repository", "teams"])).toThrow(
      "missing [], unknown or repeated [teams]",
    );
  });

  test("refuses a section without docs", () => {
    expect(() =>
      render({
        sections: [sections[1] as CoverageSection],
        docs: {},
        data: { supportedOrder: ["labels"] },
      }),
    ).toThrow('section "labels" has no docs entry');
  });

  /** The labels fixture with its one row replaced. */
  const labelsRows = (...rows: SectionDocs["coverage"][number][]) => ({
    sections: [sections[1] as CoverageSection],
    docs: { labels: { coverage: rows as unknown as SectionDocs["coverage"] } },
    data: { supportedOrder: ["labels"] as CoverageData["supportedOrder"] },
  });
  const row = (
    overrides: Partial<SectionDocs["coverage"][number]>,
  ): SectionDocs["coverage"][number] => ({
    area: "Labels",
    endpoints: ["list"],
    notes: ["CRUD."],
    ...overrides,
  });

  test("every declared call is listed at least once, a shared call on each row, and a row lists only declared roles", () => {
    // Control: the fixture's own rows render.
    expect(() => render(labelsRows(row({})))).not.toThrow();
    expect(() => render(labelsRows(row({ endpoints: [] })))).toThrow(
      'the "Labels" row of labels lists no calls, and no row above it in the section does either',
    );
    expect(() => render(labelsRows(row({ endpoints: ["list", "list"] })))).toThrow(
      'the "Labels" row of labels lists the role "list" twice',
    );
    // A call that serves two areas renders on both rows.
    const shared = render(labelsRows(row({}), row({ area: "Again", endpoints: ["list"] })));
    expect(shared.match(/\[GET \/repos\/\{owner\}\/\{repo\}\/labels\]/g)).toHaveLength(2);
    expect(() => render(labelsRows(row({ endpoints: ["remove"] })))).toThrow(
      'the "Labels" row of labels lists the role "remove", which the section declares neither as an endpoint nor as a GraphQL operation',
    );
    const wider: CoverageSection = {
      key: "labels",
      endpoints: {
        ...sections[1]?.endpoints,
        remove: { route: "DELETE /repos/{owner}/{repo}/labels/{name}" },
      },
    };
    expect(() => render({ ...labelsRows(row({})), sections: [wider] })).toThrow(
      "the coverage rows of labels list none of its roles [remove]; every declared call is listed on at least one row",
    );
  });

  test("anchors built over other sections fail on the first call they lack", () => {
    expect(() => render({ anchors: { rest: {}, graphql: anchors.graphql } })).toThrow(
      'no page was resolved for "GET /repos/{owner}/{repo}/labels"; the anchors handed to the renderer must come from resolveAnchors()',
    );
    expect(() => render({ anchors: { rest: anchors.rest, graphql: {} } })).toThrow(
      'no page was resolved for "RepositoryFeatures"',
    );
  });

  test.each([
    [
      "a pipe in the Area cell",
      { area: "A | B" },
      'a labels coverage row\'s Area cell is blank or contains "|" or a line break',
    ],
    ["a blank Area cell", { area: " " }, "a labels coverage row's Area cell is blank"],
    ["blank keys", { keys: "" }, "a labels coverage row's keys is blank"],
    [
      "a line break in the keys",
      { keys: "x\ny" },
      "a labels coverage row's keys is blank or contains",
    ],
    ["a backtick in the keys", { keys: "x`y" }, "a labels coverage row's keys contains a backtick"],
    [
      "an Area cell that cannot label the notes",
      { area: "**Bold**" },
      "a labels coverage row's Area cell cannot label its notes",
    ],
    [
      "a note with a line break",
      { notes: ["one\ntwo"] },
      'a note under the "Labels" row of labels is blank or spans several lines',
    ],
    ["a blank note", { notes: [" "] }, 'a note under the "Labels" row of labels is blank'],
    [
      "a note over the word cap",
      { notes: [Array.from({ length: FACT_WORD_CAP + 1 }, (_, i) => `w${i}`).join(" ")] },
      `a note under the "Labels" row of labels runs to ${FACT_WORD_CAP + 1} words, over the cap of ${FACT_WORD_CAP}; split it into two`,
    ],
  ] as const)("refuses a coverage row with %s", (_, overrides, message) => {
    expect(() => render(labelsRows(row(overrides)))).toThrow(message);
  });

  test("a note of exactly the word cap renders", () => {
    const capped = Array.from({ length: FACT_WORD_CAP }, (_, i) => `w${i}`).join(" ");
    expect(render(labelsRows(row({ notes: [capped] })))).toContain(`- ${capped}`);
  });

  test.each([
    [
      "a bullet with a line break",
      { outOfScope: { items: ["one\ntwo"] } },
      "an out-of-scope item is blank or spans several lines",
    ],
    [
      "a blank bullet",
      { noPublicApi: { intro: "UI-only:", items: [" "] } },
      "a no-public-API item is blank or spans several lines",
    ],
    [
      "a blank gaps empty-state note",
      { gaps: { emptyNote: "  " } },
      "the gaps section's empty-state note is blank",
    ],
    [
      "a multi-line intro paragraph",
      { intro: ["one\ntwo"] },
      "intro paragraph 1 is blank or spans several lines",
    ],
    [
      "a blank no-public-API intro",
      { noPublicApi: { intro: "", items: ["x"] } },
      "the no-public-API intro is blank",
    ],
    [
      "an out-of-scope item over the word cap",
      { outOfScope: { items: [Array.from({ length: FACT_WORD_CAP + 1 }, () => "w").join(" ")] } },
      `an out-of-scope item runs to ${FACT_WORD_CAP + 1} words, over the cap of ${FACT_WORD_CAP}`,
    ],
  ] as const)("refuses %s", (_, override, message) => {
    expect(() => render({ data: override })).toThrow(message);
  });
});

describe("renderPatCell", () => {
  test("paraphrases the grant clauses and keeps only a caveat that names extra grants", () => {
    expect(
      renderPatCell(
        `grant "Administration" or "Code scanning alerts" (read and write) under the PAT's Repository permissions; a 403 on this endpoint can also mean the repository is archived`,
      ),
    ).toBe("Administration or Code scanning alerts: write");
    expect(
      renderPatCell(
        `grant "Administration" (read and write) under the PAT's Repository permissions; the "oidc_customization_sub" key alone instead needs "Actions" (read and write)`,
      ),
    ).toBe(
      "Administration: write; the `oidc_customization_sub` key alone instead needs Actions: write",
    );
  });

  test("throws on prose it cannot fully account for instead of dropping part of it", () => {
    expect(() => renderPatCell("grant nothing in particular")).toThrow(
      "does not parse as grant clauses",
    );
    // A quoted token the clause grammar did not consume.
    expect(() =>
      renderPatCell(
        `grant "Pages" (read and write) under the PAT's Repository permissions plus "Contents"`,
      ),
    ).toThrow("does not parse as grant clauses");
    // A caveat quoting a grant in a form the token grammar does not read.
    expect(() =>
      renderPatCell(
        `grant "Pages" (read and write) under the PAT's Repository permissions; read access to "Actions" too`,
      ),
    ).toThrow("quotes tokens but names no grant");
    expect(() =>
      renderPatCell(
        `grant "Pages" (read and write) under the PAT's Repository permissions; also "Something Else" (write) and "Actions" (read)`,
      ),
    ).toThrow("neither a grant nor a settings key");
  });
});

describe("patFormParameters and renderPatFormUrl", () => {
  const slugs = {
    administration: "administration",
    issues: "issues",
    pages: "pages",
    contents: "contents",
    code_scanning_alerts: null,
  };

  test("one parameter per consumed resource with a slug, in slug order, write when any operation writes", () => {
    const parameters = patFormParameters(
      [
        { section: "branches", role: "probe", grade: "read", permission: { repo: ["contents"] } },
        { section: "labels", role: "list", grade: "read", permission: { repo: ["issues"] } },
        { section: "labels", role: "create", grade: "write", permission: { repo: ["issues"] } },
        {
          section: "code_scanning_default_setup",
          role: "update",
          grade: "write",
          permission: { repo: ["administration", "code_scanning_alerts"] },
        },
        { section: "custom_properties", role: "orgProbe", grade: "read", permission: "none" },
      ],
      slugs,
    );
    expect(parameters).toEqual([
      ["administration", "write"],
      ["issues", "write"],
      ["contents", "read"],
    ]);
    expect(renderPatFormUrl({ name: "x", description: "Token for A/x" }, parameters)).toBe(
      "https://github.com/settings/personal-access-tokens/new?name=x&description=Token+for+A%2Fx&administration=write&issues=write&contents=read",
    );
  });

  test("throws when an operation needs only resources the form cannot grant", () => {
    expect(() =>
      patFormParameters(
        [
          {
            section: "code_scanning_default_setup",
            role: "update",
            grade: "write",
            permission: { repo: ["code_scanning_alerts"] },
          },
        ],
        slugs,
      ),
    ).toThrow("code_scanning_default_setup.update needs one of [code_scanning_alerts]");
  });
});

describe("the committed pages", () => {
  test("a page without registered regions is refused", () => {
    expect(() => renderPage("docs/README.md", "")).toThrow(
      "gen-docs: no generated regions are registered for docs/README.md",
    );
  });

  test.each(["README.md", "docs/start/getting-started.md"])(
    "%s must reference the token-form label exactly once and define it exactly once",
    (path) => {
      // Negative controls, each a page that renders wrong yet regenerates as a no-op.
      const page = readFileSync(join(ROOT, path), "utf8");
      expect(page).toContain("][pat-form]");
      const lastHeading = page.match(/^## .*$/gm)?.at(-1) ?? "";
      expect(lastHeading).not.toBe("");
      const before = (text: string): string =>
        page.replace(`\n${lastHeading}\n`, `\n${text}\n\n${lastHeading}\n`);
      expect(() => renderPage(path, page.replace("][pat-form]", "][token-form]"))).toThrow(
        "at most once; found 0 and 1",
      );
      expect(() => renderPage(path, before("see the [form][pat-form] again"))).toThrow(
        "found 2 and 1",
      );
      expect(() => renderPage(path, before("see the [form][ Pat-Form ] again"))).toThrow(
        "found 2 and 1",
      );
      expect(() => renderPage(path, before("see [pat-form] and [pat-form][] too"))).toThrow(
        "found 3 and 1",
      );
      expect(() => renderPage(path, `[Pat-Form]: https://example.com\n\n${page}`)).toThrow(
        "found 1 and 2",
      );
      const definition = page.split("\n").find((line) => line.startsWith("[pat-form]: "));
      expect(definition).toBeDefined();
      const moved = page
        .replace(`${definition}\n`, "")
        .replace(`\n${lastHeading}\n`, `\n${definition}\n\n${lastHeading}\n`);
      expect(() => renderPage(path, moved)).toThrow("found 1 and 2");
    },
  );

  test.each<[label: string, path: string, mutate: (page: string) => string, error: string]>([
    [
      // A `[...][pat-form]` reference on a page whose tail carries no generated definition would render as literal brackets.
      "a reference to the token-form label on a page without its region",
      "docs/reference/sections.md",
      (page) => `${page}\nsee the [form][pat-form]\n`,
      "at most once; found 1 and 0",
    ],
    [
      "the link markers around another definition",
      "README.md",
      (page) => page.replace(/^\[pat-form\]: /m, "[other]: "),
      "the readme-pat-url region in README.md encloses content the generator would not write",
    ],
    [
      "the link markers around another definition",
      "docs/start/getting-started.md",
      (page) => page.replace(/^\[pat-form\]: /m, "[other]: "),
      "the pat-url region in docs/start/getting-started.md encloses content the generator would not write",
    ],
    [
      "the Sections table markers around the column table",
      "docs/reference/sections.md",
      (page) => {
        const columnTable = page.match(/\| Value \| Meaning \|\n[\s\S]*?\n\n/)?.[0] ?? "";
        expect(columnTable).not.toBe("");
        return page.replace(
          /(<!-- BEGIN GENERATED: sections-table[^\n]*\n)[\s\S]*?(<!-- END GENERATED: sections-table -->)/,
          `$1${columnTable.trimEnd()}\n$2`,
        );
      },
      "the sections-table region in docs/reference/sections.md encloses content the generator would not write",
    ],
    [
      "the outputs list markers around the bullet's prose",
      "docs/reference/inputs.md",
      (page) => {
        const begin = page.match(/<!-- BEGIN GENERATED: outputs-list[^\n]*?-->/)?.[0] ?? "";
        const end = "<!-- END GENERATED: outputs-list -->";
        expect(begin).not.toBe("");
        return page
          .replace(begin, "")
          .replace(end, "")
          .replace("- `skipped-sections`: the", `- ${begin}\`skipped-sections\`: the${end}`);
      },
      "the outputs-list region in docs/reference/inputs.md encloses content the generator would not write",
    ],
  ])("refuses to regenerate %s in %s", (_label, path, mutate, error) => {
    // Each page reads wrong while its markers still pair up: the enclosed text is not the generator's, or a token-form reference
    // has no tail definition. A region moved away from its home is refused by the placement checks generated-regions.test.ts pins.
    const page = readFileSync(join(ROOT, path), "utf8");
    expect(() => renderPage(path, mutate(page))).toThrow(error);
  });
});

describe("the committed coverage page", () => {
  const coverage = readFileSync(join(ROOT, "docs/reference/coverage.md"), "utf8");

  test("must keep the region spanning everything below the title", () => {
    // Prose left outside the region would drift from the generator's while regeneration stayed a no-op.
    const begin = coverage.match(/<!-- BEGIN GENERATED: coverage[^\n]*\n/)?.[0] ?? "";
    expect(begin).not.toBe("");
    const exact =
      'docs/reference/coverage.md must be the frontmatter, the "# Coverage" title, the coverage region, and one final newline';
    expect(() => renderCoverageFile(coverage.replace(begin, `Intro prose.\n\n${begin}`))).toThrow(
      exact,
    );
    expect(() => renderCoverageFile(coverage.replace("# Coverage\n", "# Inventory\n"))).toThrow(
      exact,
    );
    // Whitespace past the END marker regenerates as a no-op, so it is refused too; so is the final newline missing.
    expect(() => renderCoverageFile(coverage.trimEnd())).toThrow(exact);
    expect(() => renderCoverageFile(`${coverage}\n`)).toThrow(exact);
    expect(() => renderCoverageFile(`${coverage}\nTrailing prose.\n`)).toThrow(exact);
    // A pipe-wrapped line that is not a three-cell row of the table it sits in is authored prose.
    const shape =
      "the coverage region in docs/reference/coverage.md encloses content the generator would not write";
    expect(() =>
      renderCoverageFile(coverage.replace("\n\n### Notes", "\n| Authored prose |\n\n### Notes")),
    ).toThrow(shape);
    const topics = "[`repository`](sections.md) (`topics`)";
    expect(coverage).toContain(topics);
    expect(() =>
      renderCoverageFile(coverage.replace(topics, "[`repository`](sections.md) (`top | ics`)")),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(coverage.replace(topics, "[`repository`](sections.md) (`top `ics`)")),
    ).toThrow(shape);
    // A key cell that links anywhere but the Sections page is not the generator's.
    expect(() =>
      renderCoverageFile(coverage.replace(topics, "[`repository`](semantics.md) (`topics`)")),
    ).toThrow(shape);
    // A parenthesized qualifier is what supportedRowFault() lets through, so the guard admits it.
    expect(() =>
      renderCoverageFile(
        coverage.replace(topics, "[`repository`](sections.md) (`topics (legacy)`)"),
      ),
    ).not.toThrow();
    // A notes group is a bold label naming its section, a blank, and bullets; anything else between groups is authored.
    const label = "**Topics** (`repository`)\n\n";
    expect(coverage).toContain(label);
    expect(() =>
      renderCoverageFile(coverage.replace(label, `Authored aside.\n\n${label}`)),
    ).toThrow(shape);
    expect(() => renderCoverageFile(coverage.replace(label, "**Topics**\n\n"))).toThrow(shape);
    expect(() => renderCoverageFile(coverage.replace(label, `${label}- extra bullet\n\n`))).toThrow(
      shape,
    );
    const gapsHeader = "| Area | Endpoints | Why it matters |\n|---|---|---|\n";
    expect(coverage).toContain(gapsHeader);
    expect(() =>
      renderCoverageFile(coverage.replace(gapsHeader, `${gapsHeader}| a | b | c |\n`)),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(coverage.replace(/\nThe table is EMPTY right now[^\n]*\n\n/, "\n")),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(
        coverage
          .replace(/\nThe table is EMPTY right now[^\n]*\n\n/, "\n")
          .replace(gapsHeader, `${gapsHeader}| a | b | c |\n`),
      ),
    ).not.toThrow();
    // A label the authoring side refuses (a star inside the double stars) is no label the printer writes, even
    // when the Area cell and the label agree with each other.
    expect(() =>
      renderCoverageFile(
        coverage
          .replace("[Labels](", "[*Labels*](")
          .replace("**Labels** (`labels`)", "***Labels*** (`labels`)"),
      ),
    ).toThrow(shape);
    // A carriage return is not something any validator lets through, so the shape refuses it too.
    expect(coverage).toContain("[Labels](");
    expect(() => renderCoverageFile(coverage.replace("[Labels](", "[Labels]\r("))).toThrow(shape);
    expect(() =>
      renderCoverageFile(
        coverage.replace(
          "|---|---|---|\n\n## No public API",
          "|---|---|---|\n| a | b |\n\n## No public API",
        ),
      ),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(
        coverage.replace(
          "\n<!-- END GENERATED: coverage -->",
          "\nAuthored afterword.\n\n<!-- END GENERATED: coverage -->",
        ),
      ),
    ).toThrow(shape);
  });
});

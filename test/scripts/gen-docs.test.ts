// Unit tests for the docs generator (.github/scripts/gen-docs.ts): each renderer pinned on a small
// synthetic input, the loud failures, and the whole-file regeneration over the committed README and
// COVERAGE, which must be a no-op (build:check's contract, so drift fails here with a diff first).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageData } from "../../.github/scripts/coverage-data.js";
import {
  patFormParameters,
  renderCoverage,
  renderCoverageFile,
  renderOutputsList,
  renderPatCell,
  renderPatFormUrl,
  renderReadme,
  renderSectionsTable,
} from "../../.github/scripts/gen-docs.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";
import { relocatedRegion } from "./relocated-region.js";

const ROOT = join(import.meta.dir, "..", "..");

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
        labels: { readme: { endpoints: "labels CRUD", notes: "upsert by name" } },
        teams: { readme: { endpoints: "org team repo permissions", notes: "org repos only" } },
        environments: { readme: { endpoints: "PUT environments", notes: "reviewers" } },
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

  test("the Undeclared default column is rendered from undeclaredDefault for every policy", () => {
    // The single source the docs derive deletion claims from: each policy value has exactly one
    // display form, and the column never comes from authored prose.
    const docs = { readme: { endpoints: "e", notes: "n" } };
    const column = (undeclaredDefault: "delete" | "keep" | "untouched"): string | undefined =>
      renderSectionsTable(
        [{ key: "labels", permission: { repo: ["issues"] }, undeclaredDefault }],
        { labels: docs },
      )
        .split("\n")[2]
        ?.split(" | ")[3];
    expect(column("delete")).toBe("deleted (settable)");
    expect(column("keep")).toBe("kept (settable)");
    expect(column("untouched")).toBe("untouched");
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
        labels: { readme: { endpoints: "labels | CRUD", notes: "" } },
      }),
    ).toThrow('the labels Endpoints cell is blank or contains "|" or a line break');
    expect(() =>
      renderSectionsTable([row], {
        labels: { readme: { endpoints: "labels CRUD", notes: "upsert\nby name" } },
      }),
    ).toThrow('the labels Notes cell is blank or contains "|" or a line break');
  });
});

describe("renderCoverage", () => {
  const sections = [{ key: "repository" }, { key: "labels" }] as const;
  const docs = {
    repository: {
      coverage: [
        { area: "[Core](https://x/repos)", notes: "PATCH passthrough." },
        { area: "Topics", keys: "topics key", notes: "PUT topics." },
      ],
    },
    labels: { coverage: [{ area: "Labels", notes: "CRUD; deleted by default." }] },
  } as const;
  const data: CoverageData = {
    intro: "The tenet.",
    supportedOrder: ["labels", "repository"],
    gaps: { emptyNote: "No gaps." },
    noPublicApi: { intro: "UI-only:", items: ["Social preview.", "Wiki editing."] },
    outOfScope: { items: ["User surface."] },
  };

  test("renders the Supported rows in the data's display order, then the authored sections", () => {
    expect(renderCoverage(sections, docs, data)).toBe(
      [
        "The tenet.",
        "",
        "## Supported",
        "",
        "| Area | Section | Notes |",
        "|---|---|---|",
        "| Labels | `labels` | CRUD; deleted by default. |",
        "| [Core](https://x/repos) | `repository` | PATCH passthrough. |",
        "| Topics | `repository (topics key)` | PUT topics. |",
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

  test("a known gap renders as a table row and drops the empty-state note", () => {
    const withGap: CoverageData = {
      ...data,
      gaps: {
        rows: [
          {
            area: "Widgets",
            endpoints: ["GET /repos/{owner}/{repo}/widgets", "PUT /repos/{owner}/{repo}/widgets"],
            why: "Widgets matter.",
          },
        ],
      },
    };
    const rendered = renderCoverage(sections, docs, withGap);
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
      renderCoverage(sections, docs, { ...data, supportedOrder });
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
      renderCoverage([{ key: "labels" }], {}, { ...data, supportedOrder: ["labels"] }),
    ).toThrow('section "labels" has no docs entry');
  });

  test.each([
    [
      "a pipe in a table cell",
      { area: "A | B", notes: "n" },
      'Area cell is blank or contains "|" or a line break',
    ],
    ["a blank table cell", { area: " ", notes: "n" }, "Area cell is blank"],
    ["blank keys", { area: "A", keys: "", notes: "n" }, "keys is blank"],
    [
      "a line break in the keys",
      { area: "A", keys: "x\ny", notes: "n" },
      "keys is blank or contains",
    ],
    ["a backtick in the keys", { area: "A", keys: "x`y", notes: "n" }, "keys contains a backtick"],
  ])("refuses a coverage row with %s", (_, row, message) => {
    expect(() =>
      renderCoverage(
        [{ key: "labels" }],
        { labels: { coverage: [row] } },
        { ...data, supportedOrder: ["labels"] },
      ),
    ).toThrow(`a labels coverage row's ${message}`);
  });

  test.each([
    [
      "a bullet with a line break",
      { outOfScope: { items: ["one\ntwo"] } },
      "an out-of-scope item is blank or contains a line break",
    ],
    [
      "a blank bullet",
      { noPublicApi: { intro: "UI-only:", items: [" "] } },
      "a no-public-API item is blank or contains a line break",
    ],
    [
      "a blank gaps empty-state note",
      { gaps: { emptyNote: "  " } },
      "the gaps section's empty-state note is blank",
    ],
    ["a multi-line intro", { intro: "one\ntwo" }, "the page intro is blank or spans several lines"],
    [
      "a blank no-public-API intro",
      { noPublicApi: { intro: "", items: ["x"] } },
      "the no-public-API intro is blank",
    ],
  ] as const)("refuses %s", (_, override, message) => {
    expect(() => renderCoverage(sections, docs, { ...data, ...override })).toThrow(message);
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

describe("renderOutputsList", () => {
  test("lists the any-mode values in display order, then the multi-repo-only ones", () => {
    expect(renderOutputsList(REPO_RESULTS)).toBe(
      "`applied` / `partial` / `clean` / `drift` / `failed`; worst-of across targets in multi-repo mode, where `skipped` can also appear",
    );
    expect(renderOutputsList(["failed", "applied"])).toBe(
      "`applied` / `failed`; worst-of across targets in multi-repo mode",
    );
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
    // pages is unconsumed; code_scanning_alerts has no slug but every operation
    // naming it also accepts administration.
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

describe("the committed README", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  test("is exactly what the generator renders from the declarations", () => {
    // The strongest pin: every generated region is fresh (build:check's
    // contract), which also proves each renderer parses every real grant
    // prose and every real permission has a form parameter.
    expect(renderReadme(readme)).toBe(readme);
  });

  test("must end up with exactly one reference to and one definition of the token-form label", () => {
    // Negative controls, each a page that renders wrong yet regenerates as a no-op: a renamed
    // reference, a second reference in any CommonMark form or spelling, a stale definition ahead
    // of the generated one (it wins), and the sole definition moved outside the region.
    expect(readme).toContain("][pat-form]");
    const before = (text: string): string =>
      readme.replace("\n## Contributing\n", `\n${text}\n\n## Contributing\n`);
    expect(() => renderReadme(readme.replace("][pat-form]", "][token-form]"))).toThrow(
      "exactly once, found 0 and 1",
    );
    expect(() => renderReadme(before("see the [form][pat-form] again"))).toThrow("found 2 and 1");
    expect(() => renderReadme(before("see the [form][ Pat-Form ] again"))).toThrow("found 2 and 1");
    expect(() => renderReadme(before("see [pat-form] and [pat-form][] too"))).toThrow(
      "found 3 and 1",
    );
    expect(() => renderReadme(`[Pat-Form]: https://example.com\n\n${readme}`)).toThrow(
      "found 1 and 2",
    );
    const definition = readme.split("\n").find((line) => line.startsWith("[pat-form]: "));
    expect(definition).toBeDefined();
    const moved = readme
      .replace(`${definition}\n`, "")
      .replace("\n## Contributing\n", `\n${definition}\n\n## Contributing\n`);
    expect(() => renderReadme(moved)).toThrow("found 1 and 2");
  });

  test.each<[label: string, mutate: (readme: string) => string, error: string]>([
    [
      "the Sections table moved under Inputs",
      (readme) => relocatedRegion(readme, "readme-sections-table", "html", "\n## Inputs\n\n"),
      'the readme-sections-table region must sit under "## Sections" in README.md; "## Inputs" is the heading above its BEGIN marker',
    ],
    [
      "the Outputs sentence moved under Sections",
      (readme) => relocatedRegion(readme, "readme-outputs", "html", "\n## Sections\n\n"),
      'the readme-outputs region must sit under "## Inputs" in README.md; "## Sections" is the heading above its BEGIN marker',
    ],
    [
      "the Outputs sentence quoted",
      (readme) => readme.replace("\nOutputs: `result` (", "\n> Outputs: `result` ("),
      "the readme-outputs region sits inside a blockquote in README.md",
    ],
    [
      "prose after the link definitions",
      (readme) => `${readme}\ntrailing prose\n`,
      "the readme-pat-url region must close README.md",
    ],
    [
      "the Sections table markers around the Inputs table",
      (readme) => {
        const inputsTable =
          readme.match(/\| Input \| Default \| Meaning \|\n[\s\S]*?\n\n/)?.[0] ?? "";
        expect(inputsTable).not.toBe("");
        return readme.replace(
          /(<!-- BEGIN GENERATED: readme-sections-table[^\n]*\n)[\s\S]*?(<!-- END GENERATED: readme-sections-table -->)/,
          `$1${inputsTable.trimEnd()}\n$2`,
        );
      },
      "the readme-sections-table region in README.md encloses content the generator would not write",
    ],
    [
      "the Outputs markers around the Inputs table header",
      (readme) => {
        const begin = readme.match(/<!-- BEGIN GENERATED: readme-outputs[^\n]*?-->/)?.[0] ?? "";
        const end = "<!-- END GENERATED: readme-outputs -->";
        expect(begin).not.toBe("");
        return readme
          .replace(begin, "")
          .replace(end, "")
          .replace("| Input | Default | Meaning |", `| ${begin}Input | Default | Meaning${end} |`);
      },
      "the readme-outputs region in README.md encloses content the generator would not write",
    ],
    [
      "the link markers around another definition",
      (readme) => readme.replace(/^\[pat-form\]: /m, "[other]: "),
      "the readme-pat-url region in README.md encloses content the generator would not write",
    ],
  ])("refuses to regenerate with %s", (_label, mutate, error) => {
    // Each page regenerates cleanly without the placement check and reads wrong with it skipped,
    // so the committed README's specs are pinned here (the mechanics in generated-regions.test.ts).
    expect(() => renderReadme(mutate(readme))).toThrow(error);
  });
});

describe("the committed COVERAGE.md", () => {
  const coverage = readFileSync(join(ROOT, "COVERAGE.md"), "utf8");

  // Each Supported row as (Section cell, Area link text), in page order.
  const supportedRows = (page: string): Array<[string, string]> =>
    [...page.matchAll(/^\| \[([^\]]+)\][^|]*\| `([^`]+)`/gm)].map((m) => [m[2] ?? "", m[1] ?? ""]);

  test("keeps every Supported row in the order the hand-written page had", () => {
    // Display order is a documentation decision, pinned row by row to the page as it read before
    // generation; the registry's run order (environments before branches) is an engine constraint.
    expect(supportedRows(coverage)).toEqual([
      ["repository", "Repository core settings"],
      ["repository", "security_and_analysis"],
      ["repository (topics key)", "Topics"],
      ["repository (enable_vulnerability_alerts)", "Dependabot alerts"],
      ["repository (enable_automated_security_fixes)", "Dependabot security updates"],
      ["repository (enable_private_vulnerability_reporting)", "Private vulnerability reporting"],
      ["repository (enable_git_lfs)", "Git LFS enable/disable"],
      ["repository (enable_immutable_releases)", "Immutable releases"],
      ["repository (enable_sponsorships)", "Sponsor button"],
      ["repository (issue_creation_policy)", "Issue creation policy"],
      ["repository (allow_forking, fork-related PATCH fields)", "Forking policy"],
      ["labels", "Labels"],
      ["rulesets", "Rulesets"],
      ["rulesets", "Merge queue"],
      ["rulesets", "Tag protection (modern)"],
      ["branches", "Classic branch protection"],
      ["environments", "Environments"],
      ["autolinks", "Autolinks"],
      ["actions", "Actions permissions"],
      ["actions_secrets", "Actions secrets"],
      ["dependabot_secrets", "Dependabot secrets"],
      ["codespaces_secrets", "Codespaces repository secrets"],
      ["agents_secrets", "Copilot agents secrets"],
      ["workflows", "Workflow enable/disable state"],
      ["check_suite_preferences", "Check suite preferences"],
      ["pages", "GitHub Pages"],
      ["code_scanning_default_setup", "Code scanning default setup"],
      ["code_quality_setup", "Code quality setup"],
      ["collaborators", "Collaborators"],
      ["teams", "Team repository permissions"],
      ["milestones", "Milestones"],
      ["interaction_limits", "Interaction limits"],
      ["actions_variables", "Actions variables"],
      ["agents_variables", "Copilot agents variables"],
      ["webhooks", "Webhooks"],
      ["custom_properties", "Custom property values"],
      ["deploy_keys", "Deploy keys"],
      ["secret_scanning_custom_patterns", "Secret scanning custom patterns"],
    ]);
  });

  test("the row pin sees a swap of two rows within one section", () => {
    // Negative control: swapping the repository section's first two rows changes the sequence.
    const rows = coverage.split("\n").filter((line) => /^\| \[/.test(line));
    const [first, second] = rows;
    if (first === undefined || second === undefined) {
      throw new Error("the page has fewer than two Supported rows");
    }
    const swapped = coverage.replace(`${first}\n${second}`, `${second}\n${first}`);
    expect(swapped).not.toBe(coverage);
    expect(supportedRows(swapped)).not.toEqual(supportedRows(coverage));
    expect(supportedRows(swapped).slice(0, 2)).toEqual(
      supportedRows(coverage).slice(0, 2).reverse(),
    );
  });

  test("is exactly what the generator renders from the declarations and the authored data", () => {
    expect(renderCoverageFile(coverage)).toBe(coverage);
  });

  test("must keep the region spanning everything below the title", () => {
    // Prose left outside the region would drift from the generator's while
    // regeneration stayed a no-op: a paragraph before BEGIN, one after END,
    // a changed title, and a missing END marker.
    const begin = coverage.match(/<!-- BEGIN GENERATED: coverage[^\n]*\n/)?.[0] ?? "";
    expect(begin).not.toBe("");
    const exact =
      'COVERAGE.md must be the "# Coverage" title, the coverage region, and one final newline';
    expect(() => renderCoverageFile(coverage.replace(begin, `Intro prose.\n\n${begin}`))).toThrow(
      exact,
    );
    expect(() => renderCoverageFile(coverage.replace("# Coverage\n", "# Inventory\n"))).toThrow(
      exact,
    );
    // Whitespace past the END marker regenerates as a no-op, so it is refused too: no final
    // newline, an extra blank line, trailing spaces.
    expect(() => renderCoverageFile(coverage.trimEnd())).toThrow(exact);
    expect(() => renderCoverageFile(`${coverage}\n`)).toThrow(exact);
    expect(() => renderCoverageFile(`${coverage.trimEnd()}  \n`)).toThrow(exact);
    expect(() => renderCoverageFile(`${coverage}\nTrailing prose.\n`)).toThrow(exact);
    // A pipe-wrapped line that is not a three-cell row of the table it sits in is authored prose.
    const shape =
      "the coverage region in COVERAGE.md encloses content the generator would not write";
    expect(() =>
      renderCoverageFile(
        coverage.replace("\n\n## Repo-scoped gaps", "\n| Authored prose |\n\n## Repo-scoped gaps"),
      ),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(
        coverage.replace("`repository (topics key)`", "`repository (topics | key)`"),
      ),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(
        coverage.replace("`repository (topics key)`", "`repository (topics `key`)`"),
      ),
    ).toThrow(shape);
    // A parenthesized qualifier is what codeSpan() lets through, so the shape accepts it.
    expect(() =>
      renderCoverageFile(
        coverage.replace("`repository (topics key)`", "`repository (topics (legacy) key)`"),
      ),
    ).not.toThrow();
    // The gaps section is one of its two forms: a note above an empty table, or rows below the
    // table header; a note with rows, or neither, is not a rendering.
    const gapsHeader = "| Area | Endpoints | Why it matters |\n|---|---|---|\n";
    expect(coverage).toContain(gapsHeader);
    expect(() =>
      renderCoverageFile(coverage.replace(gapsHeader, `${gapsHeader}| a | b | c |\n`)),
    ).toThrow(shape);
    expect(() =>
      renderCoverageFile(coverage.replace(/\nThe table is EMPTY right now[^\n]*\n\n/, "\n")),
    ).toThrow(shape);
    // The rows arm accepts a page whose gaps table has rows and no note.
    expect(() =>
      renderCoverageFile(
        coverage
          .replace(/\nThe table is EMPTY right now[^\n]*\n\n/, "\n")
          .replace(gapsHeader, `${gapsHeader}| a | b | c |\n`),
      ),
    ).not.toThrow();
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
    // Authored prose inside the region, after the last list: not a body the generator writes.
    expect(() =>
      renderCoverageFile(
        coverage.replace(
          "\n<!-- END GENERATED: coverage -->",
          "\nAuthored afterword.\n\n<!-- END GENERATED: coverage -->",
        ),
      ),
    ).toThrow("the coverage region in COVERAGE.md encloses content the generator would not write");
    expect(() =>
      renderCoverageFile(coverage.replace("<!-- END GENERATED: coverage -->\n", "")),
    ).toThrow('region "coverage" needs exactly one BEGIN and one END marker, found 1 and 0');
  });
});

describe("marker-shaped text on a Markdown page", () => {
  const coverage = readFileSync(join(ROOT, "COVERAGE.md"), "utf8");
  const begin = "<!-- BEGIN GENERATED: coverage -->";

  test("a # marker line is never a marker on a Markdown page, so the YAML form leaves the region unclosed", () => {
    // The page's language picks the marker syntax (lib/generated-regions.ts), so the `# BEGIN`
    // form, which would render as a heading, is plain text here: the region loses its BEGIN.
    const yamlForm = coverage.replace(/<!-- (BEGIN GENERATED: coverage[^\n]*?) -->/, "# $1");
    expect(() => renderCoverageFile(yamlForm)).toThrow(
      'region "coverage" needs exactly one BEGIN and one END marker, found 0 and 1',
    );
  });

  test("a marker inside backticks in a paragraph is still a marker, loudly", () => {
    // Generated pages never quote a marker, so no code-span masking exists on purpose: a loud
    // false positive here beats a masker whose CommonMark corner cases silently hide a real marker.
    const quoted = coverage.replace(
      /(<!-- BEGIN GENERATED: coverage[^\n]*-->\n)/,
      `$1see \`${begin}\` here\n`,
    );
    expect(() => renderCoverageFile(quoted)).toThrow(
      'region "coverage" needs exactly one BEGIN and one END marker, found 2 and 1',
    );
  });
});

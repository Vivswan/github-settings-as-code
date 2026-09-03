// Unit tests for the README generator (.github/scripts/gen-docs.ts): each renderer pinned on a
// small synthetic input, the loud failures, and the whole-file regeneration over the committed
// README, which must be a no-op (build:check's contract, so drift fails here with a diff first).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  patFormParameters,
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
    ).toThrow('the labels Endpoints cell contains "|" or a line break');
    expect(() =>
      renderSectionsTable([row], {
        labels: { readme: { endpoints: "labels CRUD", notes: "upsert\nby name" } },
      }),
    ).toThrow('the labels Notes cell contains "|" or a line break');
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

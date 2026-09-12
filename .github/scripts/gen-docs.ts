import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_RESULTS, type RepoResult } from "../../src/engine/orchestrate.js";
import { MERGE_RESULT } from "../../src/flows/deliver.js";
import type { SectionDocs } from "../../src/sections/contract/docs.js";
import {
  type SectionMeta,
  type SectionOperation,
  sectionGrant,
  sectionOperations,
} from "../../src/sections/contract/module.js";
import { RESOURCE_SLUGS } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { SECTIONS } from "../../src/sections/registry.js";
import type { UndeclaredPolicy } from "../../src/types.js";
import { readArchitecture, renderArchitectureMermaid } from "./arch-lint.js";
import { COVERAGE_DATA, type CoverageData } from "./coverage-data.js";
import {
  escapeRe,
  type GeneratedRegion,
  regenerateRegions,
  regionBounds,
} from "./lib/generated-regions.js";

const ROOT = join(import.meta.dir, "..", "..");
const COVERAGE_PATH = "COVERAGE.md";

/** The repository these pages document; the token form's name and description derive from it. */
const REPO_SLUG = "Vivswan/github-settings-as-code";

const UNDECLARED_DEFAULT_DISPLAY: Record<UndeclaredPolicy | "untouched", string> = {
  delete: "deleted (settable)",
  keep: "kept (settable)",
  untouched: "untouched",
};

export type SectionsTableRow = Pick<
  SectionMeta,
  "key" | "permission" | "grantCaveat" | "undeclaredDefault"
>;

/** One grantFor() clause: the quoted label chain ("A" or "B"), its level, and its permission family. */
const GRANT_CLAUSE =
  /"([^"]+(?:" or "[^"]+)*)" \((read and write|read)\) under (?:the PAT's|its) (Repository|Organization) permissions/g;

/** A grant token inside a caveat: `"Label" (read and write)` or `"Label" (read)`. */
const CAVEAT_GRANT_TOKEN = /"([^"]+)" \((read and write|read)\)/g;

function shortLevel(level: string): "read" | "write" {
  return level === "read and write" ? "write" : "read";
}

// The PAT cell paraphrases sectionGrant(). Every quoted token must be consumed, so a reworded grant or caveat throws
// instead of dropping out of the cell.
export function renderPatCell(grant: string): string {
  const semicolon = grant.indexOf("; ");
  const advice = semicolon === -1 ? grant : grant.slice(0, semicolon);
  const caveat = semicolon === -1 ? "" : grant.slice(semicolon + 2);
  const quoted = (text: string): number => [...text.matchAll(/"[^"]*"/g)].length;
  let consumed = 0;
  const clauses = [...advice.matchAll(GRANT_CLAUSE)].map((clause) => {
    const labels = (clause[1] ?? "").split('" or "');
    consumed += labels.length;
    const org = clause[3] === "Organization" ? " (org permission)" : "";
    return `${labels.join(" or ")}: ${shortLevel(clause[2] ?? "")}${org}`;
  });
  if (clauses.length === 0 || consumed !== quoted(advice)) {
    throw new Error(`gen-docs: the grant prose "${grant}" does not parse as grant clauses`);
  }
  const cell = clauses.join(" + ");
  if (quoted(caveat) === 0) {
    return cell;
  }
  if ([...caveat.matchAll(CAVEAT_GRANT_TOKEN)].length === 0) {
    throw new Error(
      `gen-docs: the grant caveat "${caveat}" quotes tokens but names no grant; either name one as "Label" (level) or quote nothing`,
    );
  }
  const rendered = caveat
    .replace(
      CAVEAT_GRANT_TOKEN,
      (_, label: string, level: string) => `${label}: ${shortLevel(level)}`,
    )
    .replace(/"([a-z_]+)"/g, "`$1`");
  if (rendered.includes('"')) {
    throw new Error(
      `gen-docs: the grant caveat "${caveat}" quotes a token that is neither a grant nor a settings key`,
    );
  }
  return `${cell}; ${rendered}`;
}

/** A markdown table cell; a pipe or a line break would split the row, so both are refused. */
function cell(text: string, where: string): string {
  if (text.trim() === "" || /[|\r\n]/.test(text)) {
    throw new Error(
      `gen-docs: ${where} is blank or contains "|" or a line break, which would break its table row: "${text}"`,
    );
  }
  return text;
}

const TABLE_HEADER =
  "| Section | Endpoints | PAT permission | Undeclared default | Notes |\n|---|---|---|---|---|";

export function renderSectionsTable(
  sections: readonly SectionsTableRow[],
  docs: Readonly<Record<string, Pick<SectionDocs, "sections_table">>>,
): string {
  const rows = sections.map((section) => {
    const doc = docs[section.key];
    if (doc === undefined) {
      throw new Error(`gen-docs: section "${section.key}" has no docs entry`);
    }
    return [
      `\`${section.key}\``,
      cell(doc.sections_table.endpoints, `the ${section.key} Endpoints cell`),
      cell(renderPatCell(sectionGrant(section)), `the ${section.key} PAT permission cell`),
      UNDECLARED_DEFAULT_DISPLAY[section.undeclaredDefault],
      cell(doc.sections_table.notes, `the ${section.key} Notes cell`),
    ];
  });
  return [TABLE_HEADER, ...rows.map((cells) => `| ${cells.join(" | ")} |`)].join("\n");
}

/** Text for inside a markdown code span: a cell, and a backtick would close the span early. */
function codeSpan(text: string, where: string): string {
  if (text.includes("`")) {
    throw new Error(
      `gen-docs: ${where} contains a backtick, which would close its code span: ${text}`,
    );
  }
  return cell(text, where);
}

/** A paragraph of authored prose: a blank one would leave its heading unexplained, so it is refused. */
function paragraph(text: string, where: string): string {
  if (text.trim() === "" || /[\r\n]/.test(text)) {
    throw new Error(`gen-docs: ${where} is blank or spans several lines: "${text}"`);
  }
  return text;
}

/** A markdown list item's text; a line break would end the bullet early, so it is refused. */
function bullet(text: string, where: string): string {
  if (text.trim() === "" || /[\r\n]/.test(text)) {
    throw new Error(`gen-docs: ${where} is blank or contains a line break: "${text}"`);
  }
  return `- ${text}`;
}

const SUPPORTED_HEADING = "## Supported";
const GAPS_HEADING = "## Repo-scoped gaps (not built yet)";
const NO_API_HEADING = "## No public API (cannot be built)";
const OUT_OF_SCOPE_HEADING = "## Out of scope (user or org account surface)";

const SUPPORTED_HEADER = "| Area | Section | Notes |\n|---|---|---|";
const GAPS_HEADER = "| Area | Endpoints | Why it matters |\n|---|---|---|";

export function renderCoverage(
  sections: ReadonlyArray<Pick<SectionMeta, "key">>,
  docs: Readonly<Record<string, Pick<SectionDocs, "coverage">>>,
  data: CoverageData,
): string {
  const registered = new Set(sections.map((section) => section.key));
  const ordered = new Set(data.supportedOrder);
  const missing = [...registered].filter((key) => !ordered.has(key));
  const stray = data.supportedOrder.filter(
    (key, i) => !registered.has(key) || data.supportedOrder.indexOf(key) !== i,
  );
  if (missing.length > 0 || stray.length > 0) {
    throw new Error(
      `gen-docs: supportedOrder must list every section exactly once; missing [${missing.join(", ")}], unknown or repeated [${stray.join(", ")}]`,
    );
  }
  const supported = data.supportedOrder.flatMap((key) => {
    const doc = docs[key];
    if (doc === undefined) {
      throw new Error(`gen-docs: section "${key}" has no docs entry`);
    }
    return doc.coverage.map((row) => {
      const where = `a ${key} coverage row`;
      const keys = row.keys === undefined ? "" : ` (${codeSpan(row.keys, `${where}'s keys`)})`;
      const cells = [
        cell(row.area, `${where}'s Area cell`),
        `\`${key}${keys}\``,
        cell(row.notes, `${where}'s Notes cell`),
      ];
      return `| ${cells.join(" | ")} |`;
    });
  });
  const gaps =
    data.gaps.rows === undefined
      ? [paragraph(data.gaps.emptyNote, "the gaps section's empty-state note"), "", GAPS_HEADER]
      : [
          GAPS_HEADER,
          ...data.gaps.rows.map((row) => {
            const where = `the "${row.area}" gap row`;
            const cells = [
              cell(row.area, `${where}'s Area cell`),
              cell(row.endpoints.join(", "), `${where}'s Endpoints cell`),
              cell(row.why, `${where}'s Why cell`),
            ];
            return `| ${cells.join(" | ")} |`;
          }),
        ];
  return [
    paragraph(data.intro, "the page intro"),
    "",
    SUPPORTED_HEADING,
    "",
    SUPPORTED_HEADER,
    ...supported,
    "",
    GAPS_HEADING,
    "",
    ...gaps,
    "",
    NO_API_HEADING,
    "",
    paragraph(data.noPublicApi.intro, "the no-public-API intro"),
    "",
    ...data.noPublicApi.items.map((item) => bullet(item, "a no-public-API item")),
    "",
    OUT_OF_SCOPE_HEADING,
    "",
    ...data.outOfScope.items.map((item) => bullet(item, "an out-of-scope item")),
  ].join("\n");
}

const RESULT_DISPLAY: Record<RepoResult, "any mode" | "multi-repo only"> = {
  applied: "any mode",
  partial: "any mode",
  clean: "any mode",
  drift: "any mode",
  failed: "any mode",
  skipped: "multi-repo only",
};

const WORST_OF = "; worst-of across targets in multi-repo mode";
const CAN_ALSO_APPEAR = " can also appear";
/** The merge-mode result, a value outside RepoResult, closes the enumeration. */
const MERGE_ONLY = `; \`${MERGE_RESULT}\` in mode: merge`;

export function renderOutputsList(results: readonly RepoResult[]): string {
  const ordered = (Object.keys(RESULT_DISPLAY) as RepoResult[]).filter((value) =>
    results.includes(value),
  );
  const code = (value: RepoResult): string => `\`${value}\``;
  const anyMode = ordered.filter((value) => RESULT_DISPLAY[value] === "any mode").map(code);
  const multiOnly = ordered
    .filter((value) => RESULT_DISPLAY[value] === "multi-repo only")
    .map(code);
  const lead = `${anyMode.join(" / ")}${WORST_OF}`;
  const withMulti =
    multiOnly.length === 0 ? lead : `${lead}, where ${multiOnly.join(" and ")}${CAN_ALSO_APPEAR}`;
  return `${withMulti}${MERGE_ONLY}`;
}

export type TaggedOperation = Pick<SectionOperation, "role" | "grade" | "permission"> & {
  readonly section: string;
};

export function patFormParameters(
  operations: readonly TaggedOperation[],
  slugs: Readonly<Record<string, string | null>>,
): Array<readonly [slug: string, level: "read" | "write"]> {
  const levels = new Map<string, "read" | "write">();
  for (const operation of operations) {
    if (operation.permission === "none") {
      continue;
    }
    if (!operation.permission.repo.some((resource) => slugs[resource] != null)) {
      throw new Error(
        `gen-docs: ${operation.section}.${operation.role} needs one of [${operation.permission.repo.join(", ")}], none of which has a token-form parameter in RESOURCE_SLUGS`,
      );
    }
    for (const resource of operation.permission.repo) {
      if (operation.grade === "write" || !levels.has(resource)) {
        levels.set(resource, operation.grade);
      }
    }
  }
  const parameters: Array<readonly [string, "read" | "write"]> = [];
  for (const [resource, slug] of Object.entries(slugs)) {
    const level = levels.get(resource);
    if (slug !== null && level !== undefined) {
      parameters.push([slug, level]);
    }
  }
  return parameters;
}

export function renderPatFormUrl(
  form: { readonly name: string; readonly description: string },
  parameters: ReadonlyArray<readonly [slug: string, level: "read" | "write"]>,
): string {
  const query = new URLSearchParams([
    ["name", form.name],
    ["description", form.description],
    ...parameters.map(([slug, level]): [string, string] => [slug, level]),
  ]);
  return `https://github.com/settings/personal-access-tokens/new?${query}`;
}

/** The reference label a page's token-form link resolves through; the generated definition carries it. */
const PAT_FORM_LABEL = "pat-form";

function patFormUrl(): string {
  const operations = SECTIONS.flatMap((section) =>
    sectionOperations(section).map((operation) => ({ ...operation, section: section.key })),
  );
  const repoName = REPO_SLUG.split("/")[1] ?? REPO_SLUG;
  return renderPatFormUrl(
    { name: repoName, description: `Token for ${REPO_SLUG}` },
    patFormParameters(operations, RESOURCE_SLUGS),
  );
}

// The body shape is this generator's own output (or an empty body), built from the renderer constants, so a marker
// moved over authored prose or another table fails instead of erasing it.
function sectionsTableRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    body: new RegExp(
      String.raw`^\n(?:${escapeRe(TABLE_HEADER)}\n(?:\| \x60[a-z_]+\x60 \| [^\n]* \|\n)*)?$`,
    ),
    render: () => `\n${renderSectionsTable(SECTIONS, DOCS)}\n`,
  };
}

function outputsListRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    body: new RegExp(
      String.raw`^(?:\x60[a-z]+\x60(?: / \x60[a-z]+\x60)*${escapeRe(WORST_OF)}(?:, where ` +
        String.raw`\x60[a-z]+\x60(?: and ` +
        String.raw`\x60[a-z]+\x60)*${escapeRe(CAN_ALSO_APPEAR)})?(?:${escapeRe(MERGE_ONLY)})?)?$`,
    ),
    render: () => renderOutputsList(REPO_RESULTS),
  };
}

/** The page's `[...][pat-form]` reference resolves through this tail definition. */
function patUrlRegion(name: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "tail" },
    body: new RegExp(String.raw`^\n(?:\[${escapeRe(PAT_FORM_LABEL)}\]: \S+\n)?$`),
    render: () => `\n[${PAT_FORM_LABEL}]: ${patFormUrl()}\n`,
  };
}

// Rendered from architecture.yml, which the lint keeps equal to the tree.
function architectureMapRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    body: /^\n(?:\x60{3}mermaid\n(?:[^\x60\n][^\n]*\n)*\x60{3}\n)?$/,
    render: () =>
      `\n\x60\x60\x60mermaid\n${renderArchitectureMermaid(readArchitecture(ROOT))}\n\x60\x60\x60\n`,
  };
}

export const PAGE_REGIONS: Readonly<Record<string, readonly GeneratedRegion[]>> = {
  "README.md": [patUrlRegion("readme-pat-url")],
  "docs/start/getting-started.md": [patUrlRegion("pat-url")],
  "docs/reference/sections.md": [sectionsTableRegion("sections-table", "# Sections")],
  "docs/reference/inputs.md": [outputsListRegion("outputs-list", "## Outputs")],
  "docs/reference/architecture.md": [
    architectureMapRegion("architecture-map", "## The module map"),
  ],
};

// The result must reference the token-form label exactly as often as it defines it, at most once: a renamed
// reference, a second one, or a stale definition ahead of the generated one (it wins) would leave the page wrong
// while regeneration stays a no-op.
export function renderPage(path: string, text: string): string {
  const regions = PAGE_REGIONS[path];
  if (regions === undefined) {
    throw new Error(`gen-docs: no generated regions are registered for ${path}`);
  }
  const out = regenerateRegions(text, regions, path);
  // CommonMark trims and case-folds labels and lets the first definition win, so every spelling counts: a mention
  // opening a line and ending in ":" is a definition, any other bracketed mention is a reference.
  const mentions = [...out.matchAll(/^ {0,3}\[([^\]]+)\]:|\[([^\]]+)\]/gm)].filter(
    (match) => (match[1] ?? match[2] ?? "").trim().toLowerCase() === PAT_FORM_LABEL,
  );
  const definitions = mentions.filter((match) => match[1] !== undefined).length;
  const references = mentions.length - definitions;
  if (references !== definitions || definitions > 1) {
    throw new Error(
      `gen-docs: ${path} must reference [${PAT_FORM_LABEL}] exactly as often as it defines it, at most once; found ${references} and ${definitions}`,
    );
  }
  return out;
}

// nonBlank is unambiguous on purpose: overlapping parts would backtrack exponentially over a 38-row table.
const nonBlank = (excluded: string): string =>
  String.raw`[ \t]*[^${excluded}\s][^${excluded}\r\n]*`;
const PROSE_LINE = `${nonBlank("")}\n`;
const CELL = nonBlank("|");
const SUPPORTED_ROWS = String.raw`(?:\| ${CELL} \| \x60[a-z_]+(?: \(${nonBlank("|\x60")}\))?\x60 \| ${CELL} \|\n)+`;
const GAP_ROWS = String.raw`(?:\| ${CELL} \| ${CELL} \| ${CELL} \|\n)+`;
const GAPS_BODY = String.raw`(?:${PROSE_LINE}\n${escapeRe(GAPS_HEADER)}\n|${escapeRe(GAPS_HEADER)}\n${GAP_ROWS})`;
const BULLETS = `(?:- ${PROSE_LINE})+`;

// The one region closes the file and holds everything below the title (or an empty body between fresh markers), so
// a marker moved over authored prose fails instead of erasing it.
const COVERAGE_REGIONS: readonly GeneratedRegion[] = [
  {
    name: "coverage",
    placement: { kind: "tail" },
    body: new RegExp(
      String.raw`^\n(?:${PROSE_LINE}\n${escapeRe(SUPPORTED_HEADING)}\n\n${escapeRe(SUPPORTED_HEADER)}\n` +
        String.raw`${SUPPORTED_ROWS}\n${escapeRe(GAPS_HEADING)}\n\n${GAPS_BODY}\n${escapeRe(NO_API_HEADING)}\n\n` +
        String.raw`${PROSE_LINE}\n${BULLETS}\n${escapeRe(OUT_OF_SCOPE_HEADING)}\n\n${BULLETS})?$`,
    ),
    render: () => `\n${renderCoverage(SECTIONS, DOCS, COVERAGE_DATA)}\n`,
  },
];

const COVERAGE_TITLE = "# Coverage\n\n";

// Beyond the shared placement checks, the page must be exactly the title, the region, and one final newline, or
// prose left outside could drift from the generator's.
export function renderCoverageFile(coverage: string): string {
  const { begin, end } = regionBounds(coverage, "coverage", "html");
  if (coverage.slice(0, begin[0]) !== COVERAGE_TITLE || coverage.slice(end[1]) !== "\n") {
    throw new Error(
      `gen-docs: ${COVERAGE_PATH} must be the "# Coverage" title, the coverage region, and one final newline`,
    );
  }
  return regenerateRegions(coverage, COVERAGE_REGIONS, COVERAGE_PATH);
}

if (import.meta.main) {
  const pages: ReadonlyArray<readonly [string, (text: string) => string]> = [
    [COVERAGE_PATH, renderCoverageFile],
    ...Object.keys(PAGE_REGIONS).map(
      (path) => [path, (text: string) => renderPage(path, text)] as const,
    ),
  ];
  for (const [file, render] of pages) {
    const path = join(ROOT, file);
    const before = readFileSync(path, "utf8");
    const after = render(before);
    writeFileSync(path, after);
    console.log(`gen-docs: wrote ${path}${after === before ? " (unchanged)" : ""}`);
  }
}

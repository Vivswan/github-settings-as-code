/**
 * The generated regions of the docs pages (bun run build:docs): the whole coverage page, the Sections table, the
 * pre-filled token-form link in the README and the getting-started page, the outputs list, and the module map.
 *
 * Each is overwritten, unread, on every run. Authored prose that would break a table row stops the build, and so
 * does a coverage paragraph or bullet past the word cap.
 */

import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { visitParents } from "unist-util-visit-parents";
import { RUN_RESULTS } from "../../src/engine/outcome.js";
import { cellFault, renderTable, tableFault } from "../../src/report/markdown.js";
import type { CoverageRow, SectionDocs } from "../../src/sections/contract/docs.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import {
  type SectionOperation,
  sectionGrant,
  sectionOperations,
} from "../../src/sections/contract/operations.js";
import { RESOURCE_SLUGS } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { SECTIONS } from "../../src/sections/registry.js";
import type { UndeclaredPolicy } from "../../src/types.js";
import { readArchitecture, renderArchitectureMermaid } from "./arch-lint.js";
import { COVERAGE_DATA, type CoverageData } from "./coverage-data.js";
import { ENDPOINT_ANCHORS, type EndpointAnchors } from "./endpoint-docs.js";
import { runMain } from "./lib/entry.js";
import { type GeneratedRegion, markdownBlock, regionBounds } from "./lib/generated-regions.js";
import { type GeneratedFile, type GeneratedFiles, regenerateFiles } from "./lib/region-driver.js";

/** The repository root, two levels above this script. */
const ROOT = join(import.meta.dir, "..", "..");

/** The repository these pages document; the token form's name and description derive from it. */
const REPO_SLUG = "Vivswan/github-settings-as-code";

/** The Undeclared default cell by policy. */
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

const SECTIONS_TABLE_HEADER =
  "| Section | Endpoints | PAT permission | Undeclared default | Notes |\n|---|---|---|---|---|";

/** The cells of each section's row, as the renderer writes them; the table rule judges them. */
function sectionsCells(
  sections: readonly SectionsTableRow[],
  docs: Readonly<Record<string, Pick<SectionDocs, "sections_table">>>,
): ReadonlyArray<readonly string[]> {
  return sections.map((section) => {
    const doc = docs[section.key];
    if (doc === undefined) {
      throw new Error(`gen-docs: section "${section.key}" has no docs entry`);
    }
    return [
      `\`${section.key}\``,
      doc.sections_table.endpoints,
      renderPatCell(sectionGrant(section)),
      UNDECLARED_DEFAULT_DISPLAY[section.undeclaredDefault],
      doc.sections_table.notes,
    ];
  });
}

// The generator's boundary: the table rule is the author's to meet, so a faulty row stops the build naming it.
function renderSectionsRows(cells: ReadonlyArray<readonly string[]>): string {
  const fault = tableFault(SECTIONS_TABLE_HEADER, cells, "keyed");
  if (fault !== undefined) {
    throw new Error(fault);
  }
  return renderTable(SECTIONS_TABLE_HEADER, cells);
}

export function renderSectionsTable(
  sections: readonly SectionsTableRow[],
  docs: Readonly<Record<string, Pick<SectionDocs, "sections_table">>>,
): string {
  return renderSectionsRows(sectionsCells(sections, docs));
}

/**
 * A cell of authored prose, refused rather than escaped: an escape would silently change the rendered text.
 * `where` names the cell as its author knows it.
 */
function cell(text: string, where: string): string {
  const fault = cellFault(text);
  if (fault !== undefined) {
    throw new Error(`${where} ${fault}, which would break its table row: "${text}"`);
  }
  return text;
}

/** The longest paragraph or bullet the page carries; a fact past it is two facts. */
export const FACT_WORD_CAP = 70;

/** Why `text` is not one paragraph or bullet of the page: the printer writes each as one line, so a blank or a line break is no line of its. */
function proseFault(text: string): string | undefined {
  return text.trim() === "" || /[\r\n]/.test(text) ? "is blank or spans several lines" : undefined;
}

/**
 * A paragraph or bullet of authored prose: one line, at most FACT_WORD_CAP words. A blank one would leave its
 * heading unexplained, and a long one is a blob the page exists to avoid, so both are refused.
 */
function paragraph(text: string, where: string): string {
  const fault = proseFault(text);
  if (fault !== undefined) {
    throw new Error(`gen-docs: ${where} ${fault}: "${text}"`);
  }
  const words = text.trim().split(/\s+/).length;
  if (words > FACT_WORD_CAP) {
    throw new Error(
      `gen-docs: ${where} runs to ${words} words, over the cap of ${FACT_WORD_CAP}; split it into two: "${text}"`,
    );
  }
  return text;
}

const SUPPORTED_HEADING = "## Supported";
const NOTES_HEADING = "### Notes";
const GAPS_HEADING = "## Repo-scoped gaps (not built yet)";
const NO_API_HEADING = "## No public API (cannot be built)";
const OUT_OF_SCOPE_HEADING = "## Out of scope (user or org account surface)";

const SUPPORTED_HEADER = "| Area | Key in settings.yml | Endpoints |\n|---|---|---|";
const GAPS_HEADER = "| Area | Endpoints | Why it matters |\n|---|---|---|";

const SECTIONS_PAGE = "sections.md";

/** The Endpoints cell of a row that lists no calls of its own, naming the row whose calls it rides. */
function sharedCalls(label: string): string {
  return `shares the calls of the ${label} row`;
}

const CALL_SEPARATOR = "<br>";

/** What the coverage page reads off a section module: its key and the routes and operations it declares. */
export interface CoverageSection {
  readonly key: string;
  readonly endpoints: Readonly<Record<string, { readonly route: string }>>;
  readonly graphql?: Readonly<Record<string, { readonly name: string }>>;
}

/** The label of a row's notes group: the Area cell with its link unwrapped, so the text stands alone. */
function areaLabel(area: string): string {
  return area.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** The resolved page of one call; resolveAnchors() admits every declared call, so a miss is anchors built over other sections. */
function anchor(pages: Readonly<Record<string, string>>, call: string): string {
  const url = pages[call];
  if (url === undefined) {
    throw new Error(
      `gen-docs: no page was resolved for "${call}"; the anchors handed to the renderer must come from resolveAnchors() over the same sections`,
    );
  }
  return url;
}

// Each role is looked up in the section's own declarations, so the cell can only name a call the code makes, and
// the claimed set is compared with the declared set afterwards, so a call the rows forget fails the build. A call
// that serves several areas is listed on each of their rows; within one row a role is listed once.
function renderCalls(
  section: CoverageSection,
  row: CoverageRow,
  claimed: Set<string>,
  carrier: { label?: string },
  anchors: EndpointAnchors,
): string {
  const label = areaLabel(row.area);
  const where = `the "${label}" row of ${section.key}`;
  const seen = new Set<string>();
  const links = row.endpoints.map((role) => {
    if (seen.has(role)) {
      throw new Error(`gen-docs: ${where} lists the role "${role}" twice`);
    }
    seen.add(role);
    claimed.add(role);
    const endpoint = section.endpoints[role];
    if (endpoint !== undefined) {
      return `[${endpoint.route}](${anchor(anchors.rest, endpoint.route)})`;
    }
    const op = section.graphql?.[role];
    if (op !== undefined) {
      return `[GraphQL ${op.name}](${anchor(anchors.graphql, op.name)})`;
    }
    throw new Error(
      `gen-docs: ${where} lists the role "${role}", which the section declares neither as an endpoint nor as a GraphQL operation`,
    );
  });
  if (links.length > 0) {
    carrier.label = label;
    return links.join(CALL_SEPARATOR);
  }
  if (carrier.label === undefined) {
    throw new Error(
      `gen-docs: ${where} lists no calls, and no row above it in the section does either; a section's first row carries its calls`,
    );
  }
  return sharedCalls(carrier.label);
}

/** One Supported row with the notes group it carries: the printer writes both from it. */
interface SupportedRow {
  readonly area: string;
  readonly key: string;
  readonly keys?: string;
  readonly endpoints: string;
  readonly notes: readonly string[];
}

/** The one statement of what a Supported row may hold, as the field and its fault: the authoring side throws it. */
function supportedRowFault(
  row: Omit<SupportedRow, "notes">,
): { readonly field: string; readonly fault: string } | undefined {
  const broken = (text: string, fault: string): string =>
    `${fault}, which would break its table row: "${text}"`;
  const area = cellFault(row.area);
  if (area !== undefined) {
    return { field: "Area cell", fault: broken(row.area, area) };
  }
  if (row.keys !== undefined) {
    if (row.keys.includes("`")) {
      return {
        field: "keys",
        fault: `contains a backtick, which would close its code span: ${row.keys}`,
      };
    }
    const keys = cellFault(row.keys);
    if (keys !== undefined) {
      return { field: "keys", fault: broken(row.keys, keys) };
    }
  }
  const endpoints = cellFault(row.endpoints);
  if (endpoints !== undefined) {
    return { field: "Endpoints cell", fault: broken(row.endpoints, endpoints) };
  }
  const label = areaLabel(row.area);
  if (/[*\r\n]/.test(label) || label.trim() === "") {
    return {
      field: "Area cell",
      fault: 'cannot label its notes (blank, or holding "*" or a line break)',
    };
  }
  return undefined;
}

/** The gaps section: the empty-state note over a bare header, or the rows. */
type Gaps = { readonly emptyNote: string } | { readonly rows: ReadonlyArray<readonly string[]> };

/** The page as renderCoveragePage() prints it; coveragePage() derives it from the declarations and the authored data. */
interface CoveragePage {
  readonly intro: readonly string[];
  readonly supported: readonly SupportedRow[];
  readonly gaps: Gaps;
  readonly noPublicApi: { readonly intro: string; readonly items: readonly string[] };
  readonly outOfScope: readonly string[];
}

function supportedRows(
  section: CoverageSection,
  rows: readonly CoverageRow[],
  anchors: EndpointAnchors,
): SupportedRow[] {
  const claimed = new Set<string>();
  /** The nearest row above that listed calls, whose calls a call-less row rides. */
  const carrier: { label?: string } = {};
  const supported = rows.map((row): SupportedRow => {
    const fields = {
      area: row.area,
      key: section.key,
      ...(row.keys === undefined ? {} : { keys: row.keys }),
      endpoints: renderCalls(section, row, claimed, carrier, anchors),
    };
    const faulty = supportedRowFault(fields);
    if (faulty !== undefined) {
      throw new Error(`gen-docs: a ${section.key} coverage row's ${faulty.field} ${faulty.fault}`);
    }
    const label = areaLabel(row.area);
    const notes = row.notes.map((note) =>
      paragraph(note, `a note under the "${label}" row of ${section.key}`),
    );
    return { ...fields, notes };
  });
  const declared = [...Object.keys(section.endpoints), ...Object.keys(section.graphql ?? {})];
  const unclaimed = declared.filter((role) => !claimed.has(role));
  if (unclaimed.length > 0) {
    throw new Error(
      `gen-docs: the coverage rows of ${section.key} list none of its roles [${unclaimed.join(", ")}]; every declared call is listed on at least one row`,
    );
  }
  return supported;
}

function coveragePage(
  sections: readonly CoverageSection[],
  docs: Readonly<Record<string, Pick<SectionDocs, "coverage">>>,
  data: CoverageData,
  anchors: EndpointAnchors,
): CoveragePage {
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const ordered = new Set<string>(data.supportedOrder);
  const missing = [...byKey.keys()].filter((key) => !ordered.has(key));
  const stray = data.supportedOrder.filter(
    (key, i) => !byKey.has(key) || data.supportedOrder.indexOf(key) !== i,
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
    const section = byKey.get(key);
    if (section === undefined) {
      throw new Error(`gen-docs: section "${key}" is not registered`);
    }
    return supportedRows(section, doc.coverage, anchors);
  });
  const gaps: Gaps =
    data.gaps.rows === undefined
      ? { emptyNote: paragraph(data.gaps.emptyNote, "the gaps section's empty-state note") }
      : {
          rows: data.gaps.rows.map((row) => {
            const where = `the "${row.area}" gap row`;
            return [
              cell(row.area, `${where}'s Area cell`),
              cell(row.endpoints.join(", "), `${where}'s Endpoints cell`),
              cell(row.why, `${where}'s Why cell`),
            ];
          }),
        };
  return {
    intro: data.intro.map((line, i) => paragraph(line, `intro paragraph ${i + 1}`)),
    supported,
    gaps,
    noPublicApi: {
      intro: paragraph(data.noPublicApi.intro, "the no-public-API intro"),
      items: data.noPublicApi.items.map((item) => paragraph(item, "a no-public-API item")),
    },
    outOfScope: data.outOfScope.items.map((item) => paragraph(item, "an out-of-scope item")),
  };
}

/** The key cell of a Supported row: the section key linking to the Sections page (the one reference page a settings key has; the coverage page sits beside it), then the row's keys in a code span. */
function keyCell(row: Pick<SupportedRow, "key" | "keys">): string {
  return `[\`${row.key}\`](${SECTIONS_PAGE})${row.keys === undefined ? "" : ` (\`${row.keys}\`)`}`;
}

/** The label of a row's notes group: the Area cell with its link unwrapped, and the section key. */
function notesLabel(row: Pick<SupportedRow, "area" | "key">): string {
  return `**${areaLabel(row.area)}** (\`${row.key}\`)`;
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function renderCoveragePage(page: CoveragePage): string {
  return [
    ...page.intro.flatMap((line) => [line, ""]),
    SUPPORTED_HEADING,
    "",
    renderTable(
      SUPPORTED_HEADER,
      page.supported.map((row) => [row.area, keyCell(row), row.endpoints]),
    ),
    "",
    NOTES_HEADING,
    "",
    ...page.supported.flatMap((row) => [notesLabel(row), "", ...bullets(row.notes), ""]),
    GAPS_HEADING,
    "",
    ...("rows" in page.gaps
      ? [renderTable(GAPS_HEADER, page.gaps.rows)]
      : [page.gaps.emptyNote, "", GAPS_HEADER]),
    "",
    NO_API_HEADING,
    "",
    page.noPublicApi.intro,
    "",
    ...bullets(page.noPublicApi.items),
    "",
    OUT_OF_SCOPE_HEADING,
    "",
    ...bullets(page.outOfScope),
  ].join("\n");
}

export function renderCoverage(
  sections: readonly CoverageSection[],
  docs: Readonly<Record<string, Pick<SectionDocs, "coverage">>>,
  data: CoverageData,
  anchors: EndpointAnchors,
): string {
  return renderCoveragePage(coveragePage(sections, docs, data, anchors));
}

/** The prose after the enumeration. */
const RESULT_TAIL =
  ", worst first across the run's targets; the exit code is 1 exactly when it is `failed`, or `drift` in mode: check";

function renderOutputsList(results: readonly string[]): string {
  return `${results.map((value) => `\`${value}\``).join(" / ")}${RESULT_TAIL}`;
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

function sectionsTableRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    render: () => markdownBlock(renderSectionsTable(SECTIONS, DOCS)),
  };
}

/** The list sits inline, on the BEGIN marker's own line. */
function outputsListRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    render: () => renderOutputsList(RUN_RESULTS),
  };
}

/** The page's `[...][pat-form]` reference resolves through this tail definition. */
function patUrlRegion(name: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "tail" },
    render: () => markdownBlock(`[${PAT_FORM_LABEL}]: ${patFormUrl()}`),
  };
}

// Rendered from architecture.yml, which the lint keeps equal to the tree.
function architectureMapRegion(name: string, heading: string): GeneratedRegion {
  return {
    name,
    placement: { kind: "under-heading", heading },
    render: () =>
      markdownBlock(
        `\`\`\`mermaid\n${renderArchitectureMermaid({ ...readArchitecture(ROOT), exclude: [] })}\n\`\`\``,
      ),
  };
}

// A rendered page must reference the token-form label exactly as often as it defines it, at most once: a renamed
// reference, a second one, or a stale definition ahead of the generated one (it wins) would leave the page wrong
// while regeneration stays a no-op.
function patFormFault(page: string, path: string): string | undefined {
  // CommonMark trims and case-folds labels, and a bracketed mention with no definition is plain text. The probe
  // definition ahead of the page makes every mention a reference node even on a page that defines none; it is
  // the one definition subtracted. A mention in a code span, a code block, or an HTML block is no node at all.
  let definitions = -1;
  let references = 0;
  // Tables are split as GitHub splits them, cells first: a code span cannot hide a "|" there.
  const tree = fromMarkdown(`[${PAT_FORM_LABEL}]: <probe>\n\n${page}`, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  visitParents(tree, (node) => {
    if (node.type === "definition" && node.identifier === PAT_FORM_LABEL) {
      definitions += 1;
    } else if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      node.identifier === PAT_FORM_LABEL
    ) {
      references += 1;
    }
  });
  if (references !== definitions || definitions > 1) {
    return (
      `gen-docs: ${path} must reference [${PAT_FORM_LABEL}] exactly as often as it defines it, ` +
      `at most once; found ${references} and ${definitions}`
    );
  }
  return undefined;
}

/** A page with regions, held to the token-form rule once rendered. */
function page(...regions: GeneratedRegion[]): GeneratedFile {
  return { regions, rendered: patFormFault };
}

/** The page's frontmatter and title; the sidebar reads `order`, and 115 sits the page right after the Sections table (110). */
const COVERAGE_TITLE = "---\norder: 115\n---\n\n# Coverage\n\n";

// Beyond the shared placement checks, the page must be exactly the title, the region, and one final newline, or
// prose left outside could drift from the generator's.
function coverageShapeFault(coverage: string, path: string): string | undefined {
  const { begin, end } = regionBounds(coverage, "coverage", "html");
  if (coverage.slice(0, begin[0]) !== COVERAGE_TITLE || coverage.slice(end[1]) !== "\n") {
    return `gen-docs: ${path} must be the frontmatter, the "# Coverage" title, the coverage region, and one final newline`;
  }
  return undefined;
}

export const PAGES: GeneratedFiles = {
  "docs/reference/coverage.md": {
    // The one region closes the file and holds everything below the title.
    regions: [
      {
        name: "coverage",
        placement: { kind: "tail" },
        render: () =>
          markdownBlock(renderCoverage(SECTIONS, DOCS, COVERAGE_DATA, ENDPOINT_ANCHORS)),
      },
    ],
    shape: coverageShapeFault,
  },
  "README.md": page(patUrlRegion("readme-pat-url")),
  "docs/start/getting-started.md": page(patUrlRegion("pat-url")),
  "docs/reference/sections.md": page(sectionsTableRegion("sections-table", "# Sections")),
  "docs/reference/inputs.md": page(outputsListRegion("outputs-list", "## Outputs")),
  "docs/reference/architecture.md": page(
    architectureMapRegion("architecture-map", "## The module map"),
  ),
};

if (import.meta.main) {
  await runMain("gen-docs", () => regenerateFiles("gen-docs", PAGES, ROOT));
}

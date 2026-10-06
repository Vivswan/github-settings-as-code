import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result, safeTry } from "neverthrow";
import { RUN_RESULTS } from "../../src/engine/outcome.js";
import {
  cellFault,
  renderTable,
  tableBody,
  tableFault,
  tableRows,
} from "../../src/report/markdown.js";
import type { CoverageRow, SectionDocs } from "../../src/sections/contract/docs.js";
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
import { type Architecture, readArchitecture, renderArchitectureMermaid } from "./arch-lint.js";
import { COVERAGE_DATA, type CoverageData } from "./coverage-data.js";
import { ENDPOINT_ANCHORS, type EndpointAnchors } from "./endpoint-docs.js";
import {
  block,
  blockLine,
  blockLines,
  GeneratedRegion,
  regenerateRegions,
  regionBounds,
} from "./lib/generated-regions.js";

const ROOT = join(import.meta.dir, "..", "..");
export const COVERAGE_PATH = "docs/reference/coverage.md";

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

export const SECTIONS_TABLE_HEADER =
  "| Section | Endpoints | PAT permission | Undeclared default | Notes |\n|---|---|---|---|---|";

/**
 * The cells of each section's row, as the renderer writes them and the guard reads them back; the table rule
 * judges them.
 */
export function sectionsCells(
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
export function renderSectionsRows(cells: ReadonlyArray<readonly string[]>): string {
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

/** The Sections table's page, the one reference page a settings key has; the coverage page sits beside it. */
const SECTIONS_PAGE = "sections.md";
/** The Endpoints cell of a row that lists no calls of its own, naming the row whose calls it rides. */
function sharedCalls(label: string): string {
  return `shares the calls of the ${label} row`;
}
/** The calls in a cell, one per rendered line. */
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

/** One Supported row with the notes group it carries: the printer writes both from it, the guard reads both back into it. */
interface SupportedRow {
  readonly area: string;
  readonly key: string;
  readonly keys?: string;
  readonly endpoints: string;
  readonly notes: readonly string[];
}

/**
 * The one statement of what a Supported row may hold, as the field and its fault: the authoring side throws it
 * and the parse refuses by it, so a row the generator refuses is no row the guard admits.
 */
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

/**
 * The page as renderCoveragePage() prints it. coveragePage() derives it from the declarations and the authored
 * data, parseCoveragePage() reads a committed page back into it, and the two meet in the byte compare.
 */
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

/** The key cell of a Supported row: the section key linking to the Sections page, then the row's keys in a code span. */
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

/**
 * The key cell as keyCell() writes it, read back.
 * The dotAll flag is for the two Unicode line separators cellFault() admits inside the keys: without it `.` would not match them.
 */
const KEY_CELL = new RegExp(
  String.raw`^\[\x60([a-z_]+)\x60\]\(${RegExp.escape(SECTIONS_PAGE)}\)(?: \(\x60(.*)\x60\))?$`,
  "s",
);

/** A Supported row's cells read back and held to the row statement, its notes still to come from the group under the table. */
function supportedRow(cells: readonly string[]): Result<Omit<SupportedRow, "notes">, string> {
  const [area = "", key = "", endpoints = ""] = cells;
  const match = KEY_CELL.exec(key);
  if (match === null) {
    return err(`names no section key linking to ${SECTIONS_PAGE} in its second cell`);
  }
  const keys = match[2];
  const row = { area, key: match[1] ?? "", ...(keys === undefined ? {} : { keys }), endpoints };
  const faulty = supportedRowFault(row);
  return faulty === undefined ? ok(row) : err(`${faulty.field} ${faulty.fault}`);
}

/**
 * A committed page read back into the shape renderCoveragePage() prints from, or why it is not one the printer
 * wrote, naming the line as renderedMismatch() numbers it. Prose slots (a paragraph, a bullet, an Area or an
 * Endpoints cell) are opaque and kept, so what the guard refuses here is structure the printer never writes.
 */
function parseCoveragePage(body: string): Result<CoveragePage, string> {
  const lines = body.split("\n");
  let at = 0;
  /** The line under the cursor, or "" past the end: the printer never writes past the body. */
  const current = (): string => lines[at] ?? "";
  const refusal = (what: string): Result<never, string> => err(`line ${at} ${what}`);
  const literal = (text: string, what: string): Result<void, string> => {
    if (current() !== text) {
      return refusal(what);
    }
    at += 1;
    return ok();
  };
  const blank = (): Result<void, string> =>
    literal("", "is not the blank line the generator writes there");
  const heading = (text: string): Result<void, string> =>
    literal(text, `is not the "${text}" heading`);
  const prose = (what: string): Result<string, string> => {
    const line = current();
    const fault = proseFault(line);
    if (fault !== undefined) {
      return refusal(`should hold ${what} but ${fault}`);
    }
    at += 1;
    return ok(line);
  };
  /** The `- ` bullets up to the next blank line, at least one. */
  const items = (what: string): Result<string[], string> => {
    const found: string[] = [];
    while (current().startsWith("- ")) {
      const text = current().slice(2);
      const fault = proseFault(text);
      if (fault !== undefined) {
        return refusal(`should hold ${what} bullet but ${fault}`);
      }
      found.push(text);
      at += 1;
    }
    return found.length === 0 ? refusal(`is not the first ${what} bullet`) : ok(found);
  };
  /** `header`'s lines, then the rows up to the next blank line under the cell rule, each through `parseRow`. */
  const table = <Row>(
    header: string,
    what: string,
    parseRow: (cells: readonly string[]) => Result<Row, string>,
  ): Result<Row[], string> => {
    for (const line of header.split("\n")) {
      if (current() !== line) {
        return refusal(`is not the ${what} table's header`);
      }
      at += 1;
    }
    const start = at;
    while (current() !== "") {
      at += 1;
    }
    const line = (row: number): string => `line ${start + row}`;
    return tableRows(header, lines.slice(start, at), "cells")
      .mapErr((faulty) => `${line(faulty.row)} ${faulty.fault}`)
      .andThen((rows) =>
        Result.combine(
          rows.map((cells, row) => parseRow(cells).mapErr((fault) => `${line(row)} ${fault}`)),
        ),
      );
  };
  /** Whether `texts` sit at the cursor, line for line: a paragraph may repeat one structural line, never a run of them. */
  const ahead = (...texts: string[]): boolean =>
    texts.every((text, offset) => lines[at + offset] === text);
  const [gapsHeaderLine, gapsSeparator] = GAPS_HEADER.split("\n");
  return safeTry(function* () {
    yield* blank();
    const intro: string[] = [];
    do {
      intro.push(yield* prose("an intro paragraph"));
      yield* blank();
    } while (!ahead(SUPPORTED_HEADING, "", ...SUPPORTED_HEADER.split("\n")));
    yield* heading(SUPPORTED_HEADING);
    yield* blank();
    const rows = yield* table(SUPPORTED_HEADER, "Supported", supportedRow);
    if (rows.length === 0) {
      return refusal("is not the first Supported row");
    }
    yield* blank();
    yield* heading(NOTES_HEADING);
    yield* blank();
    const supported: SupportedRow[] = [];
    for (const row of rows) {
      yield* literal(
        notesLabel(row),
        `is not the notes label of the "${areaLabel(row.area)}" Supported row`,
      );
      yield* blank();
      const notes = yield* items("a note");
      yield* blank();
      supported.push({ ...row, notes });
    }
    yield* heading(GAPS_HEADING);
    yield* blank();
    let gaps: Gaps;
    if (ahead(gapsHeaderLine ?? "", gapsSeparator ?? "")) {
      const gapRows = yield* table(GAPS_HEADER, "gaps", (cells) => ok(cells));
      if (gapRows.length === 0) {
        return refusal("is not the first gap row, and no empty-state note precedes the table");
      }
      gaps = { rows: gapRows };
    } else {
      gaps = { emptyNote: yield* prose("the gaps section's empty-state note") };
      yield* blank();
      yield* table(GAPS_HEADER, "gaps", () =>
        err("is a gap row under the empty-state note, which stands only over an empty table"),
      );
    }
    yield* blank();
    yield* heading(NO_API_HEADING);
    yield* blank();
    const noApiIntro = yield* prose("the no-public-API intro");
    yield* blank();
    const noApiItems = yield* items("a no-public-API");
    yield* blank();
    yield* heading(OUT_OF_SCOPE_HEADING);
    yield* blank();
    const outOfScope = yield* items("an out-of-scope");
    if (at !== lines.length - 1 || current() !== "") {
      return refusal("is not the line break that closes the body");
    }
    return ok({
      intro,
      supported,
      gaps,
      noPublicApi: { intro: noApiIntro, items: noApiItems },
      outOfScope,
    });
  });
}

/** The prose after the enumeration, read back as the one tail the guard admits. */
const RESULT_TAIL =
  ", worst first across the run's targets; the exit code is 1 exactly when it is `failed`, or `drift` in mode: check";

export function renderOutputsList(results: readonly string[]): string {
  return `${results.map((value) => `\`${value}\``).join(" / ")}${RESULT_TAIL}`;
}

const OUTPUTS_LIST = new RegExp(
  String.raw`^(\x60[a-z]+\x60(?: / \x60[a-z]+\x60)*)${RegExp.escape(RESULT_TAIL)}$`,
);

/** The outcome words of an inline outputs list, which sits on the BEGIN marker's own line. */
function parseOutputsList(body: string): Result<readonly string[], string> {
  const list = OUTPUTS_LIST.exec(body)?.[1];
  return list === undefined
    ? err("line 0 is not the outcome words in code spans followed by the tail")
    : ok(list.split(" / ").map((span) => span.slice(1, -1)));
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

// The three prose cells are opaque; a row is this table's when its Undeclared default cell is one of the displays,
// the one cell the table rule does not judge.
function sectionsRow(cells: readonly string[]): Result<readonly string[], string> {
  if (!Object.values(UNDECLARED_DEFAULT_DISPLAY).includes(cells[3] ?? "")) {
    return err("shows an Undeclared default the renderer has no display for");
  }
  return ok(cells);
}

function sectionsTableRegion(name: string, heading: string): GeneratedRegion {
  return GeneratedRegion.of({
    name,
    placement: { kind: "under-heading", heading },
    data: () => sectionsCells(SECTIONS, DOCS),
    render: block(renderSectionsRows),
    parse: tableBody(SECTIONS_TABLE_HEADER, "keyed", sectionsRow),
  });
}

function outputsListRegion(name: string, heading: string): GeneratedRegion {
  return GeneratedRegion.of<readonly string[]>({
    name,
    placement: { kind: "under-heading", heading },
    data: () => RUN_RESULTS,
    render: renderOutputsList,
    parse: parseOutputsList,
  });
}

const PAT_FORM_DEFINITION = new RegExp(String.raw`^\[${RegExp.escape(PAT_FORM_LABEL)}\]: (\S+)$`);

/** The page's `[...][pat-form]` reference resolves through this tail definition. */
function patUrlRegion(name: string): GeneratedRegion {
  return GeneratedRegion.of({
    name,
    placement: { kind: "tail" },
    data: patFormUrl,
    render: block((url: string) => `[${PAT_FORM_LABEL}]: ${url}`),
    parse: (body) =>
      blockLine(body).andThen((line) => {
        const url = PAT_FORM_DEFINITION.exec(line)?.[1];
        return url === undefined
          ? err(`line 1 is not the [${PAT_FORM_LABEL}] definition`)
          : ok(url);
      }),
  });
}

const MERMAID_OPEN = "```mermaid";
const FENCE = "```";
const GRAPH_LINE = "graph TD";
// A node id is whatever the renderer makes of a layer name (only "-" is rewritten), so the byte compare judges it.
const NODE_LINE = /^ {2}(\S+)\["([^"]*)"\]$/;
const EDGE_LINE = /^ {2}(\S+) --> (\S+)$/;

/** What the module map draws: the layers with their paths and the import edges; the lint's exclusions are not drawn. */
type ArchitectureMap = Pick<Architecture, "layers" | "edges">;

/**
 * The diagram read back into the layers and edges it draws, under the node ids the renderer writes; a line that is
 * neither a node nor an edge is authored. Entries are collected before the records are built, so an id such as
 * `__proto__` is a key and not a prototype write.
 */
function parseArchitectureMap(body: string): Result<ArchitectureMap, string> {
  return blockLines(body).andThen((lines) => {
    if (lines[0] !== MERMAID_OPEN) {
      return err("line 1 does not open the mermaid fence");
    }
    if (lines[1] !== GRAPH_LINE) {
      return err(`line 2 is not the "${GRAPH_LINE}" line`);
    }
    if (lines.length < 3 || lines.at(-1) !== FENCE) {
      return err(`line ${lines.length} does not close the mermaid fence`);
    }
    const layers: Array<[string, readonly string[]]> = [];
    const edges = new Map<string, string[]>();
    for (const [index, line] of lines.slice(2, -1).entries()) {
      const node = NODE_LINE.exec(line);
      const edge = EDGE_LINE.exec(line);
      if (node !== null) {
        layers.push([node[1] ?? "", (node[2] ?? "").split("<br>")]);
      } else if (edge !== null) {
        const from = edge[1] ?? "";
        edges.set(from, [...(edges.get(from) ?? []), edge[2] ?? ""]);
      } else {
        return err(`line ${index + 3} is neither a layer node nor an import edge`);
      }
    }
    return ok({ layers: Object.fromEntries(layers), edges: Object.fromEntries(edges) });
  });
}

// Rendered from architecture.yml, which the lint keeps equal to the tree.
function architectureMapRegion(name: string, heading: string): GeneratedRegion {
  return GeneratedRegion.of<ArchitectureMap>({
    name,
    placement: { kind: "under-heading", heading },
    data: () => readArchitecture(ROOT),
    render: block(
      (map) => `${MERMAID_OPEN}\n${renderArchitectureMermaid({ ...map, exclude: [] })}\n${FENCE}`,
    ),
    parse: parseArchitectureMap,
  });
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

// The one region closes the file and holds everything below the title (or an empty body between fresh markers), so
// a marker moved over authored prose fails instead of erasing it.
const COVERAGE_REGIONS: readonly GeneratedRegion[] = [
  GeneratedRegion.of({
    name: "coverage",
    placement: { kind: "tail" },
    data: () => coveragePage(SECTIONS, DOCS, COVERAGE_DATA, ENDPOINT_ANCHORS),
    render: block(renderCoveragePage),
    parse: parseCoveragePage,
  }),
];

/** The page's frontmatter and title; the sidebar reads `order`, and 115 sits the page right after the Sections table (110). */
const COVERAGE_TITLE = "---\norder: 115\n---\n\n# Coverage\n\n";

// Beyond the shared placement checks, the page must be exactly the title, the region, and one final newline, or
// prose left outside could drift from the generator's.
export function renderCoverageFile(coverage: string): string {
  const { begin, end } = regionBounds(coverage, "coverage", "html");
  if (coverage.slice(0, begin[0]) !== COVERAGE_TITLE || coverage.slice(end[1]) !== "\n") {
    throw new Error(
      `gen-docs: ${COVERAGE_PATH} must be the frontmatter, the "# Coverage" title, the coverage region, and one final newline`,
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

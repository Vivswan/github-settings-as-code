// Emits README.md's generated regions (build:docs): the Sections table, the `result` value
// list, and the token-form link, each between `<!-- BEGIN/END GENERATED: <name> -->` markers.
// Authored cells come from the docs registry, everything else from the section declarations.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_RESULTS, type RepoResult } from "../../src/engine/orchestrate.js";
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
import { escapeRe, type GeneratedRegion, regenerateRegions } from "./lib/generated-regions.js";

const ROOT = join(import.meta.dir, "..", "..");
const README_PATH = "README.md";

/** The repository the README documents; the token form's name and description derive from it. */
const REPO_SLUG = "Vivswan/github-settings-as-code";

/** The Undeclared default column's display form of each undeclaredDefault. */
const UNDECLARED_DEFAULT_DISPLAY: Record<UndeclaredPolicy | "untouched", string> = {
  delete: "deleted (settable)",
  keep: "kept (settable)",
  untouched: "untouched",
};

/** The section declarations the Sections table reads. */
export type SectionsTableRow = Pick<
  SectionMeta,
  "key" | "permission" | "grantCaveat" | "undeclaredDefault"
>;

/** One grantFor() clause: the quoted label chain ("A" or "B"), its level, and its permission family. */
const GRANT_CLAUSE =
  /"([^"]+(?:" or "[^"]+)*)" \((read and write|read)\) under (?:the PAT's|its) (Repository|Organization) permissions/g;

/** A grant token inside a caveat: `"Label" (read and write)` or `"Label" (read)`. */
const CAVEAT_GRANT_TOKEN = /"([^"]+)" \((read and write|read)\)/g;

/** The table's short access level: "write" for read-and-write, else "read". */
function shortLevel(level: string): "read" | "write" {
  return level === "read and write" ? "write" : "read";
}

// The PAT cell paraphrased from sectionGrant(): `Label: level` per clause (org clauses gain
// "(org permission)"), then a caveat only if it names extra grants. Every quoted token must be
// consumed, so a reworded grant or caveat throws instead of dropping out of the cell.
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
  if (/[|\r\n]/.test(text)) {
    throw new Error(
      `gen-docs: ${where} contains "|" or a line break, which would split its table row: ${text}`,
    );
  }
  return text;
}

/** The Sections table's header and rule lines, as rendered and as the region shape expects them. */
const TABLE_HEADER =
  "| Section | Endpoints | PAT permission | Undeclared default | Notes |\n|---|---|---|---|---|";

/** The README Sections table, one row per section in the given order; a section without docs throws. */
export function renderSectionsTable(
  sections: readonly SectionsTableRow[],
  docs: Readonly<Record<string, SectionDocs>>,
): string {
  const rows = sections.map((section) => {
    const doc = docs[section.key];
    if (doc === undefined) {
      throw new Error(`gen-docs: section "${section.key}" has no docs entry`);
    }
    return [
      `\`${section.key}\``,
      cell(doc.readme.endpoints, `the ${section.key} Endpoints cell`),
      cell(renderPatCell(sectionGrant(section)), `the ${section.key} PAT permission cell`),
      UNDECLARED_DEFAULT_DISPLAY[section.undeclaredDefault],
      cell(doc.readme.notes, `the ${section.key} Notes cell`),
    ];
  });
  return [TABLE_HEADER, ...rows.map((cells) => `| ${cells.join(" | ")} |`)].join("\n");
}

/** Where each `result` value can appear, in display order; total over RepoResult. */
const RESULT_DISPLAY: Record<RepoResult, "any mode" | "multi-repo only"> = {
  applied: "any mode",
  partial: "any mode",
  clean: "any mode",
  drift: "any mode",
  failed: "any mode",
  skipped: "multi-repo only",
};

/** The outputs enumeration's fixed phrases, as rendered and as the region shape expects them. */
const WORST_OF = "; worst-of across targets in multi-repo mode";
const CAN_ALSO_APPEAR = " can also appear";

/** The `result` output's value enumeration: the any-mode values, then the multi-repo-only ones. */
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
  return multiOnly.length === 0
    ? lead
    : `${lead}, where ${multiOnly.join(" and ")}${CAN_ALSO_APPEAR}`;
}

/** A section operation tagged with its section, as patFormParameters reads it. */
export type TaggedOperation = Pick<SectionOperation, "role" | "grade" | "permission"> & {
  readonly section: string;
};

// The token form's permission parameters in `slugs` order: write if any operation naming the
// resource is write-gated, else read. A null slug is skipped only while every operation naming it
// also names a resource the form grants; otherwise this throws.
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

/** The pre-filled fine-grained-token form link for the given name, description, and permission parameters. */
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

/** The reference label the README's token-form link resolves through; the generated definition carries it. */
const PAT_FORM_LABEL = "pat-form";

/** The pre-filled token-form link for this repository over every section operation's permission. */
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

// Each README region: its home, its renderer, and the shape of this generator's own output for
// it (or an empty body), built from the renderer constants, so a marker moved over authored
// prose, another table, or another link definition fails instead of erasing it.
const README_REGIONS: readonly GeneratedRegion[] = [
  {
    name: "readme-sections-table",
    placement: { kind: "under-heading", heading: "## Sections" },
    body: new RegExp(
      String.raw`^\n(?:${escapeRe(TABLE_HEADER)}\n(?:\| \x60[a-z_]+\x60 \| [^\n]* \|\n)*)?$`,
    ),
    render: () => `\n${renderSectionsTable(SECTIONS, DOCS)}\n`,
  },
  {
    name: "readme-outputs",
    placement: { kind: "under-heading", heading: "## Inputs" },
    body: new RegExp(
      String.raw`^(?:\x60[a-z]+\x60(?: / \x60[a-z]+\x60)*${escapeRe(WORST_OF)}(?:, where \x60[a-z]+\x60(?: and \x60[a-z]+\x60)*${escapeRe(CAN_ALSO_APPEAR)})?)?$`,
    ),
    render: () => renderOutputsList(REPO_RESULTS),
  },
  {
    name: "readme-pat-url",
    placement: { kind: "tail" },
    body: new RegExp(String.raw`^\n(?:\[${escapeRe(PAT_FORM_LABEL)}\]: \S+\n)?$`),
    render: () => `\n[${PAT_FORM_LABEL}]: ${patFormUrl()}\n`,
  },
];

// The README with every generated region rendered. The result must define the token-form label
// exactly once and reference it exactly once (full, collapsed, or shortcut form), or a stale
// definition or renamed reference would leave the page wrong while regeneration stays a no-op.
export function renderReadme(readme: string): string {
  const out = regenerateRegions(readme, README_REGIONS, README_PATH);
  // CommonMark trims and case-folds labels and lets the first definition
  // win, so every spelling counts: a mention opening a line and ending in
  // ":" is a definition, any other bracketed mention is a reference.
  const mentions = [...out.matchAll(/^ {0,3}\[([^\]]+)\]:|\[([^\]]+)\]/gm)].filter(
    (match) => (match[1] ?? match[2] ?? "").trim().toLowerCase() === PAT_FORM_LABEL,
  );
  const definitions = mentions.filter((match) => match[1] !== undefined).length;
  const references = mentions.length - definitions;
  if (references !== 1 || definitions !== 1) {
    throw new Error(
      `gen-docs: README.md must reference [${PAT_FORM_LABEL}] exactly once and define it exactly once, found ${references} and ${definitions}`,
    );
  }
  return out;
}

if (import.meta.main) {
  const path = join(ROOT, README_PATH);
  const before = readFileSync(path, "utf8");
  const after = renderReadme(before);
  writeFileSync(path, after);
  console.log(
    `gen-docs: wrote ${path} (${SECTIONS.length} section rows${after === before ? ", unchanged" : ""})`,
  );
}

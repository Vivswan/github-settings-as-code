/**
 * Regenerate the declaration-derived regions of action.yml, the README, the
 * policy and permissions references, and the check-mode guide between their
 * BEGIN/END GENERATED markers: pure renderers plus a CLI (`bun run build:action-docs`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InputDecl } from "../../src/action/inputs.js";
import { INPUT_DECLS } from "../../src/action/inputs.js";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import { UNDECLARED_POLICY_SECTIONS, type UndeclaredPolicySection } from "../../src/schema.js";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import {
  readGating,
  sectionOperations,
  writeGatedReads,
} from "../../src/sections/contract/module.js";
import {
  RESOURCE_LABEL,
  RESOURCE_LABEL_ORG,
  type SectionPermission,
  samePermission,
} from "../../src/sections/contract/permissions.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { countWord } from "./lib/count-word.js";
import { escapeRe, type GeneratedRegion, regenerateRegions } from "./lib/generated-regions.js";

const ROOT = join(import.meta.dir, "..", "..");

/** Column budget for a folded description line, indent included. */
const YAML_WIDTH = 78;

/** Greedy word wrap of a single-line string to `width` columns. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current !== "" && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  return current === "" ? lines : [...lines, current];
}

/**
 * A `description: >-` folded block scalar at `indent` spaces. Folding turns
 * each line break back into one space, so only single-spaced prose without
 * edge spaces parses back to the declaration verbatim; anything else is rejected.
 */
function foldedDescription(text: string, indent: number): string {
  if (text === "" || /^ | $|[^ \S]| {2}/.test(text)) {
    throw new Error(`a description must be single-spaced prose to fold losslessly: ${text}`);
  }
  const pad = " ".repeat(indent);
  return [
    `${pad}description: >-`,
    ...wrap(text, YAML_WIDTH - indent - 2).map((line) => `${pad}  ${line}`),
  ].join("\n");
}

/** Words a YAML 1.1 parser would re-type if left as a plain key. */
const YAML_WORDS = new Set(["null", "true", "false", "yes", "no", "on", "off", "y", "n"]);

/** A mapping key: plain when it round-trips as itself, double-quoted otherwise. */
function yamlKey(name: string): string {
  return /^[a-z][a-z0-9-]*$/.test(name) && !YAML_WORDS.has(name) ? name : JSON.stringify(name);
}

/** The action.yml `inputs` entries, one per declaration, in declaration order. */
export function renderActionInputs(
  decls: Readonly<Record<string, Pick<InputDecl, "description" | "default">>>,
): string {
  return Object.entries(decls)
    .map(([name, decl]) =>
      [
        `  ${yamlKey(name)}:`,
        foldedDescription(decl.description, 4),
        "    required: false",
        // Always double-quoted: a bare default could otherwise re-type itself
        // (2022-11-28 is a YAML timestamp, "" needs its quotes to exist).
        `    default: ${JSON.stringify(decl.default)}`,
      ].join("\n"),
    )
    .join("\n");
}

/** The action.yml `outputs` entries, one per declaration, in declaration order. */
export function renderActionOutputs(
  decls: Readonly<Record<string, { readonly description: string }>>,
): string {
  return Object.entries(decls)
    .map(([name, decl]) =>
      [`  ${yamlKey(name)}:`, foldedDescription(decl.description, 4)].join("\n"),
    )
    .join("\n");
}

/** A markdown table cell: an unescaped pipe gets its backslash; a line break is rejected (it would end the row). */
function cell(text: string): string {
  if (/[\r\n]/.test(text)) {
    throw new Error(`a table cell cannot contain a line break: ${text}`);
  }
  // A pipe behind an odd run of backslashes is already escaped.
  return text.replace(/(\\*)\|/g, (match, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\|` : match,
  );
}

/** One markdown table row over already-rendered cell texts. */
function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

/** The README Default cell: the shown default, else the raw one (empty reads "(empty)"). */
function shownDefault(decl: Pick<InputDecl, "default" | "shownDefault">): string {
  if (decl.shownDefault !== undefined) {
    return decl.shownDefault;
  }
  return decl.default === "" ? "(empty)" : `\`${decl.default}\``;
}

/** The README Inputs table's header and rule lines, as rendered and as the region shape expects them. */
const INPUTS_TABLE_HEADER = "| Input | Default | Meaning |\n|---|---|---|";

/** The README Inputs table, header included. */
export function renderReadmeInputsTable(
  decls: Readonly<Record<string, Pick<InputDecl, "default" | "shownDefault" | "summary">>>,
): string {
  return [
    INPUTS_TABLE_HEADER,
    ...Object.entries(decls).map(([name, decl]) =>
      row([`\`${name}\``, shownDefault(decl), decl.summary]),
    ),
  ].join("\n");
}

/** "a, b, and c" (Oxford comma), "a and b", or "a". */
function proseList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** A knobbed section as the policy page renders it. */
export interface KnobbedSection {
  readonly key: string;
  readonly undeclaredDefault: "delete" | "keep";
}

/** Delete-by-default sections first, each group in the given order. */
function deleteFirst(sections: readonly KnobbedSection[]): KnobbedSection[] {
  return [
    ...sections.filter((section) => section.undeclaredDefault === "delete"),
    ...sections.filter((section) => section.undeclaredDefault === "keep"),
  ];
}

/** The count sentence between its count word and its section list, as rendered and as the region shape expects it. */
const COUNT_SENTENCE_LEAD = " sections list the live resources sitting next to the declared ones: ";

/** The policy page's opening sentence: the count and every knobbed section. */
export function renderPolicyCountSentence(sections: readonly KnobbedSection[]): string {
  const word = countWord(sections.length);
  const keys = deleteFirst(sections).map((section) => `\`${section.key}\``);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}${COUNT_SENTENCE_LEAD}${proseList(keys)}.`;
}

/** A Defaults-per-section row's prose: the default's parenthesized `caveat`, and what the opposite policy (`override`) buys. */
export interface PolicyRowProse {
  readonly caveat?: string;
  readonly override: string;
}

/** The Defaults table's header and rule lines, as rendered and as the region shape expects them. */
const DEFAULTS_TABLE_HEADER = "| Section | Default | The override buys you |\n|---|---|---|";

/** The `## Defaults per section` table, header included. */
export function renderPolicyDefaultsTable(
  sections: readonly KnobbedSection[],
  prose: Readonly<Record<string, PolicyRowProse>>,
): string {
  const rows = deleteFirst(sections).map((section) => {
    const text = prose[section.key];
    if (text === undefined) {
      throw new Error(`no Defaults-per-section prose for the "${section.key}" section`);
    }
    const caveat = text.caveat === undefined ? "" : ` (${text.caveat})`;
    const opposite = section.undeclaredDefault === "delete" ? "keep" : "delete";
    return row([
      `\`${section.key}\``,
      `${section.undeclaredDefault}${caveat}`,
      `\`${opposite}\`: ${text.override}`,
    ]);
  });
  return [DEFAULTS_TABLE_HEADER, ...rows].join("\n");
}

/**
 * The per-section prose of the Defaults table. Total over the knobbed
 * sections by type, so a new knob fails to compile until its row is written.
 */
export const POLICY_ROW_PROSE: Record<UndeclaredPolicySection, PolicyRowProse> = {
  labels: {
    caveat: "Probot parity",
    override: "manage a core set without deleting ad-hoc labels",
  },
  autolinks: { override: "declare some references, tolerate the rest" },
  collaborators: {
    caveat: "owner always exempt",
    override: "manage listed people without removing others",
  },
  actions_variables: { override: "declare the managed variables, tolerate the rest" },
  agents_variables: { override: "declare the managed variables, tolerate the rest" },
  rulesets: { override: "make the file the complete ruleset inventory" },
  milestones: { override: "prune stale milestones, with the caveat below" },
  webhooks: {
    caveat: "integrations create their own hooks",
    override: "make the file the complete hook inventory",
  },
  deploy_keys: {
    caveat:
      "deployment tooling installs its own keys, and deleting a live key breaks whatever authenticates with it",
    override: "make the file the complete key inventory",
  },
  actions_secrets: {
    override: "prune stale secrets - a deleted secret's value is unrecoverable",
  },
  dependabot_secrets: {
    override: "prune stale secrets - a deleted secret's value is unrecoverable",
  },
  codespaces_secrets: {
    override: "prune stale secrets - a deleted secret's value is unrecoverable",
  },
  agents_secrets: {
    override: "prune stale secrets - a deleted secret's value is unrecoverable",
  },
  custom_properties: {
    caveat: "an unset can revert to an org default the file does not model",
    override: "make the file the complete property-value inventory, unsetting the rest",
  },
  secret_scanning_custom_patterns: {
    override:
      "prune stale patterns - the pattern's alerts are resolved (never deleted), keeping the audit trail",
  },
};

/** The token-UI label of a permission's primary resource (ANY one grants access; the first is the one to ask for). */
function primaryLabel(permission: SectionPermission): string {
  return RESOURCE_LABEL[permission.repo[0]];
}

/** Insertion-ordered dedupe. */
function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** The token-UI label of a permission's organization grant, if it has one. */
function orgLabel(permission: SectionPermission): string[] {
  return permission.org === undefined ? [] : [RESOURCE_LABEL_ORG[permission.org]];
}

/** The grant sentence's opening words, as rendered and as the region shape expects them. */
const GRANT_SENTENCE_LEAD = "To manage everything in one PAT, grant ";

/**
 * The manage-everything sentence: each section's primary resource at write,
 * each endpoint override at its advised level (write joins the write list),
 * and every organization grant (section or override) at read.
 */
export function renderGrantSentence(sections: readonly SectionMeta[]): string {
  const writes: string[] = [];
  const reads: string[] = [];
  const orgs: string[] = [];
  for (const section of sections) {
    writes.push(primaryLabel(section.permission));
    orgs.push(...orgLabel(section.permission));
    for (const operation of sectionOperations(section)) {
      if (
        operation.permission === "none" ||
        samePermission(operation.permission, section.permission)
      ) {
        continue;
      }
      orgs.push(...orgLabel(operation.permission));
      const label = primaryLabel(operation.permission);
      (overrideAdviceLevel(section, operation.permission) === "write" ? writes : reads).push(label);
    }
  }
  const writeList = unique(writes);
  const readList = unique(reads).filter((label) => !writeList.includes(label));
  const orgList = unique(orgs);
  const extras = [
    ...(readList.length > 0 ? [`${proseList(readList)} at read`] : []),
    ...(orgList.length > 0
      ? [
          `(for org repos) the ${proseList(orgList)} organization permission${orgList.length === 1 ? "" : "s"} at read`,
        ]
      : []),
  ];
  const plus = extras.length > 0 ? `, plus ${extras.join(" and ")}` : "";
  return `${GRANT_SENTENCE_LEAD}${proseList(writeList)} at write${plus}.`;
}

/**
 * One bullet per section with a write-gated read, naming the gated reads' own
 * permissions; a partly gated section names the gated routes. Empty when none.
 */
export function renderGatedReads(sections: readonly SectionMeta[]): string {
  return sections
    .flatMap((section) => {
      const gated = writeGatedReads(section);
      if (gated.length === 0) {
        return [];
      }
      const labels = unique(gated.map((read) => primaryLabel(read.permission)));
      if (readGating(section) === "write-gated") {
        // "its" grant only for the section's own permission; an override is named.
        const grant = gated.every((read) => samePermission(read.permission, section.permission))
          ? "its write grant"
          : `the ${proseList(labels)} write grant`;
        return [
          `- GitHub gates even the ${proseList(labels)} reads at write, so \`${section.key}\` needs ${grant} in check mode too.`,
        ];
      }
      const routes = gated.map((read) => `\`${read.route}\``);
      return [
        `- GitHub gates the ${proseList(routes)} reads at write, so \`${section.key}\` needs its ${proseList(labels)} write grant in check mode to verify what they return.`,
      ];
    })
    .join("\n");
}

/** The check-mode caveat's two fixed texts, as rendered and as the region shape expects them. */
const NO_GATED_READS = "A read-only PAT covers every section in check mode.";
const GATED_READS_LEAD_IN =
  "The read-only rule has exceptions, each a section to drop from the preview or grant at write:";

/** The check-mode guide's read-only-PAT caveat: the gated reads under their lead-in, or the plain sentence when none is write-gated. */
export function renderCheckModeGatedReads(sections: readonly SectionMeta[]): string {
  const bullets = renderGatedReads(sections);
  if (bullets === "") {
    return NO_GATED_READS;
  }
  return `${GATED_READS_LEAD_IN}\n\n${bullets}`;
}

/** The knobbed sections with their declared defaults, in UNDECLARED_POLICY_SECTIONS order. */
function knobbedSections(): KnobbedSection[] {
  const byKey = new Map(SECTIONS.map((section) => [section.key, section]));
  return UNDECLARED_POLICY_SECTIONS.map((key) => {
    const section = byKey.get(key);
    if (section === undefined || section.undeclaredDefault === "untouched") {
      throw new Error(`the "${key}" section is knobbed but declares no undeclaredDefault`);
    }
    return { key, undeclaredDefault: section.undeclaredDefault };
  });
}

/** A block body's shape: its opening newline, then `lines` (a source over newline-terminated lines), an empty rendering's second newline, or nothing (a freshly placed region). */
function blockShape(lines: string): RegExp {
  return new RegExp(String.raw`^\n(?:${lines}|\n)?$`);
}

/** The shape of a markdown table body under `header`: the header, then rows of `cells` (a source over the cells between the outer pipes). */
function tableShape(header: string, cells: string): RegExp {
  return blockShape(String.raw`${escapeRe(header)}\n(?:\| ${cells} \|\n)*`);
}

/** A JSON string literal as JSON.stringify() emits it: its own escapes only, bare quotes never. */
const JSON_STRING = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;

/** The key forms yamlKey() writes: a plain name that is no YAML word, or a JSON string holding a YAML word or a name that is not plain-shaped. */
const YAML_WORD = [...YAML_WORDS].join("|");
const PLAIN_KEY = `(?!(?:${YAML_WORD}):)[a-z][a-z0-9-]*`;
const QUOTED_KEY = `(?:"(?:${YAML_WORD})"|(?!"[a-z][a-z0-9-]*")${JSON_STRING})`;

/** An action.yml mapping key line at two spaces, as yamlKey() renders it. */
const YAML_ENTRY_KEY = String.raw`  (?:${PLAIN_KEY}|${QUOTED_KEY}):\n`;

/** A folded `description: >-` block at four spaces with its six-space lines, each starting on a word. */
const YAML_DESCRIPTION = String.raw`    description: >-\n(?:      \S[^\n]*\n)+`;

/** One gated-reads bullet in any form renderGatedReads() writes: a wholly gated section ("even the ... reads", its own or a named grant) or a partly gated one (routes named, "to verify what they return"). */
const GATED_READ_BULLET = String.raw`- GitHub gates (?:even )?the [^\n]+ reads at write, so \x60[a-z_]+\x60 needs (?:its|the)(?: [^\n]+)? write grant in check mode (?:too|to verify what they return)\.\n`;

/** A block region's renderer: the rendered lines on lines of their own between the markers. */
function block(render: () => string): () => string {
  return () => `\n${render()}\n`;
}

/**
 * Every generated region, keyed by file, with where it sits and the shape of every body this
 * generator could have written for it, so a marker moved elsewhere fails instead of regenerating
 * in the wrong place or erasing authored text.
 */
export const GENERATED_REGIONS: Readonly<Record<string, readonly GeneratedRegion[]>> = {
  "action.yml": [
    {
      name: "action-inputs",
      placement: { kind: "under-key", key: "inputs" },
      body: blockShape(
        String.raw`(?:${YAML_ENTRY_KEY}${YAML_DESCRIPTION}    required: false\n    default: ${JSON_STRING}\n)+`,
      ),
      render: block(() => renderActionInputs(INPUT_DECLS)),
    },
    {
      name: "action-outputs",
      placement: { kind: "under-key", key: "outputs" },
      body: blockShape(`(?:${YAML_ENTRY_KEY}${YAML_DESCRIPTION})+`),
      render: block(() => renderActionOutputs(OUTPUT_DECLS)),
    },
  ],
  "README.md": [
    {
      name: "readme-inputs-table",
      placement: { kind: "under-heading", heading: "## Inputs" },
      body: tableShape(INPUTS_TABLE_HEADER, String.raw`\x60[^\x60\n]+\x60 \| [^\n]* \| [^\n]*`),
      render: block(() => renderReadmeInputsTable(INPUT_DECLS)),
    },
  ],
  "docs/reference/undeclared-policy.md": [
    {
      name: "policy-count-sentence",
      placement: { kind: "under-heading", heading: "# The undeclared policy" },
      body: blockShape(String.raw`[A-Z][a-z-]*${escapeRe(COUNT_SENTENCE_LEAD)}[^\n]+\.\n`),
      render: block(() => renderPolicyCountSentence(knobbedSections())),
    },
    {
      name: "policy-defaults-table",
      placement: { kind: "under-heading", heading: "## Defaults per section" },
      body: tableShape(
        DEFAULTS_TABLE_HEADER,
        String.raw`\x60[a-z_]+\x60 \| (?:delete|keep)(?: \([^\n]+\))? \| \x60(?:delete|keep)\x60: [^\n]+`,
      ),
      render: block(() => renderPolicyDefaultsTable(knobbedSections(), POLICY_ROW_PROSE)),
    },
  ],
  "docs/reference/permissions.md": [
    {
      name: "permissions-grant-sentence",
      placement: { kind: "under-heading", heading: "## What to grant" },
      body: blockShape(String.raw`${escapeRe(GRANT_SENTENCE_LEAD)}[^\n]+\.\n`),
      render: block(() => renderGrantSentence(SECTIONS)),
    },
    {
      name: "permissions-gated-reads",
      placement: { kind: "under-heading", heading: "## How a denial surfaces" },
      body: blockShape(`(?:${GATED_READ_BULLET})+`),
      render: block(() => renderGatedReads(SECTIONS)),
    },
  ],
  "docs/operate/check-mode.md": [
    {
      name: "check-mode-gated-reads",
      placement: {
        kind: "under-heading",
        heading: "## Checking settings changes on pull requests",
      },
      body: blockShape(
        String.raw`${escapeRe(NO_GATED_READS)}\n|${escapeRe(GATED_READS_LEAD_IN)}\n\n(?:${GATED_READ_BULLET})+`,
      ),
      render: block(() => renderCheckModeGatedReads(SECTIONS)),
    },
  ],
};

/** `text` with every one of `path`'s registered regions checked for placement, then regenerated. */
export function regenerateText(path: string, text: string): string {
  const regions = GENERATED_REGIONS[path];
  if (regions === undefined) {
    throw new Error(`no generated regions are registered for ${path}`);
  }
  return regenerateRegions(text, regions, path);
}

/** Rewrite every registered file in place; returns the paths whose bytes changed. */
export function regenerateAll(): string[] {
  const changed: string[] = [];
  for (const path of Object.keys(GENERATED_REGIONS)) {
    const file = join(ROOT, path);
    const before = readFileSync(file, "utf8");
    const after = regenerateText(path, before);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(path);
    }
  }
  return changed;
}

if (import.meta.main) {
  const changed = regenerateAll();
  console.log(
    changed.length === 0
      ? "generated regions already up to date"
      : `regenerated ${changed.join(", ")}`,
  );
}

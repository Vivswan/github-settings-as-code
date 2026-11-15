/**
 * The generated regions of action.yml (the inputs and outputs, from their declarations under src/) and of three
 * docs pages: the undeclared-policy count sentence and Defaults table, the permissions grant sentence and gated
 * reads, and check mode's gated reads (bun run build:action-docs). Each region is overwritten, unread, on every run.
 */

import { join } from "node:path";
import {
  Document,
  type DocumentOptions,
  type ParseOptions,
  Scalar,
  type SchemaOptions,
  type ToStringOptions,
  YAMLMap,
} from "yaml";
import { z } from "zod";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import type { InputDecl } from "../../src/flows/inputs.js";
import { INPUT_DECLS } from "../../src/flows/inputs.js";
import { renderTable, tableFault } from "../../src/report/markdown.js";
import { UNDECLARED_POLICY_SECTIONS, type UndeclaredPolicySection } from "../../src/schema.js";
import { overrideAdviceLevel } from "../../src/sections/contract/errors.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import {
  readGating,
  sectionOperations,
  writeGatedReads,
} from "../../src/sections/contract/operations.js";
import {
  RESOURCE_LABEL,
  RESOURCE_LABEL_ORG,
  type SectionPermission,
  samePermission,
} from "../../src/sections/contract/permissions.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { agree } from "../../src/text.js";
import type { UndeclaredPolicy } from "../../src/types.js";
import { countWord } from "./lib/count-word.js";
import { runMain } from "./lib/entry.js";
import { block, markdownBlock } from "./lib/generated-regions.js";
import { type GeneratedFiles, regenerateFiles } from "./lib/region-driver.js";

/** The repository root, two levels above this script. */
const ROOT = join(import.meta.dir, "..", "..");

/** YAML 1.1, so a key it would re-type (on, y, null) comes out quoted for action.yml's 1.1 readers; the merge tag is removed, since it claims the string "<<" whatever style the scalar asks for and action.yml carries no merges. */
const YAML_DOCUMENT: DocumentOptions & SchemaOptions & ParseOptions = {
  version: "1.1",
  merge: false,
  customTags: (tags) =>
    tags.filter((tag) =>
      typeof tag === "string" ? tag !== "merge" : tag.tag !== "tag:yaml.org,2002:merge",
    ),
};

/** The library takes lineWidth as a soft limit for a folded description (a line one column over stays whole); quoted scalars are JSON strings, one line however long, with JSON's escapes. */
const YAML_STYLE: ToStringOptions = { lineWidth: 78, singleQuote: false, doubleQuotedAsJSON: true };

/** A name that may stay an unquoted YAML key. */
const PLAIN_NAME = /^[a-z][a-z0-9-]*$/;

/** One line not starting with whitespace: any other description would fold into a form action.yml does not carry (a blank line, an indentation indicator, a kept newline), so the generator refuses it instead of writing it. */
const DESCRIPTION = z
  .string()
  .regex(/^\S[^\r\n]*$/, "one line of text, not starting with whitespace");

/** The one field every declaration renders; the rest is the entry's own. */
const DESCRIBED = z.object({ description: DESCRIPTION });

/** Each declaration parsed with `schema`, every own name kept (a record schema would drop `__proto__`, a name the
 * emitter writes), or the first miss as "name.path: message". */
function declarations<T>(
  schema: z.ZodType<T>,
  decls: Readonly<Record<string, unknown>>,
): Record<string, T> | string {
  const parsed: Array<[string, T]> = [];
  for (const [name, decl] of Object.entries(decls)) {
    const result = schema.safeParse(decl);
    if (!result.success) {
      const issue = result.error.issues[0];
      return `${[name, ...(issue?.path ?? [])].map(String).join(".")}: ${issue?.message ?? "invalid"}`;
    }
    parsed.push([name, result.data]);
  }
  return Object.fromEntries(parsed);
}

function scalar(value: string, type: Scalar.Type): Scalar<string> {
  const node = new Scalar(value);
  node.type = type;
  return node;
}

/** A plain-shaped name stays plain unless the schema would re-type it; any other name is quoted outright. */
function yamlKey(name: string): Scalar<string> {
  return scalar(name, PLAIN_NAME.test(name) ? Scalar.PLAIN : Scalar.QUOTE_DOUBLE);
}

/** The entries of the top-level `key` mapping, rendered under that key so they carry the file's own nesting; the
 * key line itself is the file's, outside the region. */
function yamlEntries<T extends { readonly description: string }>(
  key: string,
  decls: Readonly<Record<string, T>>,
  entry: (decl: T) => object,
): string {
  const described = declarations(DESCRIBED, decls);
  if (typeof described === "string") {
    throw new Error(`the ${key} declarations: ${described}`);
  }
  const doc = new Document({}, YAML_DOCUMENT);
  const map = new YAMLMap<Scalar<string>, object>(doc.schema);
  for (const [name, decl] of Object.entries(decls)) {
    map.set(yamlKey(name), entry(decl));
  }
  // An empty mapping serializes as `{}` on the key's own line; the region then holds nothing.
  if (map.items.length === 0) {
    return "";
  }
  doc.set(key, map);
  return doc.toString(YAML_STYLE).slice(`${key}:\n`.length, -1);
}

export function renderActionInputs(
  decls: Readonly<Record<string, Pick<InputDecl, "description" | "default">>>,
): string {
  return yamlEntries("inputs", decls, (decl) => ({
    description: scalar(decl.description, Scalar.BLOCK_FOLDED),
    required: false,
    // Every default double-quoted: the string type visible at a glance.
    default: scalar(decl.default, Scalar.QUOTE_DOUBLE),
  }));
}

export function renderActionOutputs(
  decls: Readonly<Record<string, { readonly description: string }>>,
): string {
  return yamlEntries("outputs", decls, (decl) => ({
    description: scalar(decl.description, Scalar.BLOCK_FOLDED),
  }));
}

/** "a", "a and b", "a, b, and c": the list as English prose writes it. */
const PROSE_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** Why `item` cannot be one item of a prose list: a comma or the word "and" would read as a joiner. */
function proseItemFault(item: string): string | undefined {
  return /,|(^|\s)and(\s|$)/.test(item) ? 'holds a comma or the word "and"' : undefined;
}

function proseList(items: readonly string[]): string {
  const faulty = items.find((item) => proseItemFault(item) !== undefined);
  if (faulty !== undefined) {
    throw new Error(`"${faulty}" ${proseItemFault(faulty)}, which an item of a prose list cannot`);
  }
  return PROSE_LIST.format(items);
}

export interface KnobbedSection {
  readonly key: string;
  readonly undeclaredDefault: "delete" | "keep";
}

function deleteFirst<T>(items: readonly T[], policy: (item: T) => UndeclaredPolicy): T[] {
  return [
    ...items.filter((item) => policy(item) === "delete"),
    ...items.filter((item) => policy(item) === "keep"),
  ];
}

const COUNT_SENTENCE_LEAD = " sections list the live resources sitting next to the declared ones: ";

/** The count sentence over `keys` in the order it lists them: the count in words, then the keys in code spans. */
function countSentence(keys: readonly string[]): string {
  const word = countWord(keys.length);
  const spans = keys.map((key) => `\`${key}\``);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}${COUNT_SENTENCE_LEAD}${proseList(spans)}.`;
}

function countSentenceKeys(sections: readonly KnobbedSection[]): string[] {
  return deleteFirst(sections, (section) => section.undeclaredDefault).map(
    (section) => section.key,
  );
}

export function renderPolicyCountSentence(sections: readonly KnobbedSection[]): string {
  return countSentence(countSentenceKeys(sections));
}

/** A Defaults-per-section row's prose: the default's parenthesized `caveat`, and what the opposite policy (`override`) buys. */
export interface PolicyRowProse {
  readonly caveat?: string;
  readonly override: string;
}

/**
 * Why a row's prose cannot be rendered: blank prose would render `delete ()` or a bare policy span, cells
 * cellFault() admits since the policy word fills them. The renderer refuses it at its own boundary, by the
 * trimmed-blank rule cellFault() uses. A structural type cannot vouch for a property a narrowing hid, so the value
 * is inspected as unknown.
 */
function proseFault(row: PolicyRowProse): string | undefined {
  const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";
  return blank(row.override) || (row.caveat !== undefined && blank(row.caveat))
    ? "has a blank caveat or override"
    : undefined;
}

const OPPOSITE: Readonly<Record<UndeclaredPolicy, UndeclaredPolicy>> = {
  delete: "keep",
  keep: "delete",
};

const DEFAULTS_TABLE_HEADER = "| Section | Default | The override buys you |\n|---|---|---|";

/** One Defaults row: the section and the prose its cells carry. */
interface PolicyRow {
  readonly section: KnobbedSection;
  readonly prose: PolicyRowProse;
}

/** A row's three cells, as the renderer writes them. */
function policyCells(row: PolicyRow): readonly string[] {
  const caveat = row.prose.caveat === undefined ? "" : ` (${row.prose.caveat})`;
  return [
    `\`${row.section.key}\``,
    `${row.section.undeclaredDefault}${caveat}`,
    `\`${OPPOSITE[row.section.undeclaredDefault]}\`: ${row.prose.override}`,
  ];
}

/** What a Defaults table may not hold: each row's prose by proseFault(), then the table rule over the cells. */
function policyTableFault(rows: readonly PolicyRow[]): string | undefined {
  for (const row of rows) {
    const fault = proseFault(row.prose);
    if (fault !== undefined) {
      return `the "${row.section.key}" Defaults row ${fault}`;
    }
  }
  return tableFault(DEFAULTS_TABLE_HEADER, rows.map(policyCells), "keyed");
}

/** Each section's Defaults row with its prose, delete-first; a section without prose stops the build naming it. */
function policyRows(
  sections: readonly KnobbedSection[],
  prose: Readonly<Record<string, PolicyRowProse>>,
): PolicyRow[] {
  return deleteFirst(sections, (section) => section.undeclaredDefault).map((section): PolicyRow => {
    const text = prose[section.key];
    if (text === undefined) {
      throw new Error(`no Defaults-per-section prose for the "${section.key}" section`);
    }
    // Read once, so the fault check and the cells see the same values.
    return { section, prose: { caveat: text.caveat, override: text.override } };
  });
}

/** The Defaults table, in the delete-first order policyRows() gives. */
export function renderPolicyDefaultsTable(
  sections: readonly KnobbedSection[],
  prose: Readonly<Record<string, PolicyRowProse>>,
): string {
  const rows = policyRows(sections, prose);
  const fault = policyTableFault(rows);
  if (fault !== undefined) {
    throw new Error(fault);
  }
  return renderTable(DEFAULTS_TABLE_HEADER, rows.map(policyCells));
}

/** The row every secret family shares: the value is write-only, so a wrong delete is a loss, not a drift. */
const SECRET_ROW_PROSE: PolicyRowProse = {
  override: "prune stale secrets - a deleted secret's value is unrecoverable",
};

/** The Defaults-per-section prose by section key; a knobbed section without a row stops the build naming it. */
const POLICY_ROW_PROSE: Record<UndeclaredPolicySection, PolicyRowProse> = {
  labels: {
    caveat: "Probot parity",
    override: "manage a core set without deleting ad-hoc labels",
  },
  autolinks: { override: "declare some references, tolerate the rest" },
  collaborators: {
    caveat: "owner always exempt",
    override: "manage listed people without removing others",
  },
  teams: {
    caveat: "a grant made at the organization level is never touched",
    override: "make the file the complete inventory of direct team grants, revoking the rest",
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
  actions_secrets: SECRET_ROW_PROSE,
  dependabot_secrets: SECRET_ROW_PROSE,
  codespaces_secrets: SECRET_ROW_PROSE,
  agents_secrets: SECRET_ROW_PROSE,
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

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function orgLabel(permission: SectionPermission): string[] {
  return permission.org === undefined ? [] : [RESOURCE_LABEL_ORG[permission.org]];
}

const GRANT_SENTENCE_LEAD = "To manage everything in one PAT, grant ";

/** The labels the grant sentence names: the write grants, the read-only extras, and the organization grants. */
interface GrantLabels {
  readonly writes: readonly string[];
  readonly reads: readonly string[];
  readonly orgs: readonly string[];
}

function grantLabels(sections: readonly SectionMeta[]): GrantLabels {
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
  return {
    writes: writeList,
    reads: unique(reads).filter((label) => !writeList.includes(label)),
    orgs: unique(orgs),
  };
}

function grantSentence({ writes, reads, orgs }: GrantLabels): string {
  const extras = [
    ...(reads.length > 0 ? [`${proseList(reads)} at read`] : []),
    ...(orgs.length > 0
      ? [
          `(for org repos) the ${proseList(orgs)} organization ${agree(orgs.length, "permission", "permissions")} at read`,
        ]
      : []),
  ];
  const plus = extras.length > 0 ? `, plus ${extras.join(" and ")}` : "";
  return `${GRANT_SENTENCE_LEAD}${proseList(writes)} at write${plus}.`;
}

export function renderGrantSentence(sections: readonly SectionMeta[]): string {
  return grantSentence(grantLabels(sections));
}

/**
 * One gated-reads bullet's facts: which of a section's reads GitHub gates at write, and the grant that unlocks
 * them.
 */
type GatedRead =
  | {
      readonly key: string;
      readonly gated: "every";
      readonly labels: readonly string[];
      readonly ownGrant: boolean;
    }
  | {
      readonly key: string;
      readonly gated: "some";
      readonly routes: readonly string[];
      readonly labels: readonly string[];
    };

function gatedReads(sections: readonly SectionMeta[]): GatedRead[] {
  return sections.flatMap((section): GatedRead[] => {
    const gated = writeGatedReads(section);
    if (gated.length === 0) {
      return [];
    }
    const labels = unique(gated.map((read) => primaryLabel(read.permission)));
    if (readGating(section) === "write-gated") {
      const ownGrant = gated.every((read) => samePermission(read.permission, section.permission));
      return [{ key: section.key, gated: "every", labels, ownGrant }];
    }
    return [{ key: section.key, gated: "some", routes: gated.map((read) => read.route), labels }];
  });
}

function gatedBullet(read: GatedRead): string {
  if (read.gated === "every") {
    const grant = read.ownGrant ? "its write grant" : `the ${proseList(read.labels)} write grant`;
    return `- GitHub gates even the ${proseList(read.labels)} reads at write, so \`${read.key}\` needs ${grant} in check mode too.`;
  }
  const routes = read.routes.map((route) => `\`${route}\``);
  return `- GitHub gates the ${proseList(routes)} reads at write, so \`${read.key}\` needs its ${proseList(read.labels)} write grant in check mode to verify what they return.`;
}

function gatedBullets(reads: readonly GatedRead[]): string {
  return reads.map(gatedBullet).join("\n");
}

export function renderGatedReads(sections: readonly SectionMeta[]): string {
  return gatedBullets(gatedReads(sections));
}

const NO_GATED_READS = "A read-only PAT covers every section in check mode.";
const GATED_READS_LEAD_IN =
  "The read-only rule has exceptions, each a section to drop from the preview or grant at write:";

function checkModeGatedReads(reads: readonly GatedRead[]): string {
  return reads.length === 0 ? NO_GATED_READS : `${GATED_READS_LEAD_IN}\n\n${gatedBullets(reads)}`;
}

export function renderCheckModeGatedReads(sections: readonly SectionMeta[]): string {
  return checkModeGatedReads(gatedReads(sections));
}

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

export const FILES: GeneratedFiles = {
  "action.yml": {
    regions: [
      {
        name: "action-inputs",
        placement: { kind: "under-key", key: "inputs" },
        render: () => block(renderActionInputs(INPUT_DECLS)),
      },
      {
        name: "action-outputs",
        placement: { kind: "under-key", key: "outputs" },
        render: () => block(renderActionOutputs(OUTPUT_DECLS)),
      },
    ],
  },
  "docs/reference/undeclared-policy.md": {
    regions: [
      {
        name: "policy-count-sentence",
        placement: { kind: "under-heading", heading: "# The undeclared policy" },
        render: () => markdownBlock(renderPolicyCountSentence(knobbedSections())),
      },
      {
        name: "policy-defaults-table",
        placement: { kind: "under-heading", heading: "## Defaults per section" },
        render: () => markdownBlock(renderPolicyDefaultsTable(knobbedSections(), POLICY_ROW_PROSE)),
      },
    ],
  },
  "docs/reference/permissions.md": {
    regions: [
      {
        name: "permissions-grant-sentence",
        placement: { kind: "under-heading", heading: "## What to grant" },
        render: () => markdownBlock(renderGrantSentence(SECTIONS)),
      },
      {
        name: "permissions-gated-reads",
        placement: { kind: "under-heading", heading: "## How a denial surfaces" },
        render: () => markdownBlock(renderGatedReads(SECTIONS)),
      },
    ],
  },
  "docs/operate/check-mode.md": {
    regions: [
      {
        name: "check-mode-gated-reads",
        placement: {
          kind: "under-heading",
          heading: "## Checking settings changes on pull requests",
        },
        render: () => markdownBlock(renderCheckModeGatedReads(SECTIONS)),
      },
    ],
  },
};

if (import.meta.main) {
  await runMain("gen-action-docs", () => regenerateFiles("gen-action-docs", FILES, ROOT));
}

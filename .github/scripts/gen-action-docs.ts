import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
import {
  Document,
  type DocumentOptions,
  type ParseOptions,
  parseDocument,
  Scalar,
  type SchemaOptions,
  type ToStringOptions,
  YAMLMap,
} from "yaml";
import { z } from "zod";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import type { InputDecl } from "../../src/flows/inputs.js";
import { INPUT_DECLS } from "../../src/flows/inputs.js";
import { renderTable, tableBody, tableFault } from "../../src/report/markdown.js";
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
import { agree } from "../../src/text.js";
import type { UndeclaredPolicy } from "../../src/types.js";
import { countWord } from "./lib/count-word.js";
import {
  block,
  blockLine,
  blockLines,
  GeneratedRegion,
  regenerateRegions,
} from "./lib/generated-regions.js";

const ROOT = join(import.meta.dir, "..", "..");

/** The schema the scalars are rendered and read back under: a key YAML 1.1 would re-type (on, y, null, ...) comes out
 * quoted, for the 1.1 readers of action.yml still in the wild. Its merge tag is removed: it claims the string "<<"
 * itself, whatever style the scalar asks for, and action.yml carries no merges. */
const YAML_DOCUMENT: DocumentOptions & SchemaOptions & ParseOptions = {
  version: "1.1",
  merge: false,
  customTags: (tags) =>
    tags.filter((tag) =>
      typeof tag === "string" ? tag !== "merge" : tag.tag !== "tag:yaml.org,2002:merge",
    ),
};

/** Column budget for a folded description line, indent included; the library takes it as a soft limit (a line one
 * column over stays whole). Quoted scalars are JSON strings: one line however long, with JSON's escapes. */
const YAML_STYLE: ToStringOptions = { lineWidth: 78, singleQuote: false, doubleQuotedAsJSON: true };

const PLAIN_NAME = /^[a-z][a-z0-9-]*$/;

/** One line not starting with whitespace: any other description would fold into a form action.yml does not carry (a
 * blank line, an indentation indicator, a kept newline), so the generator refuses it instead of writing it. */
const DESCRIPTION = z
  .string()
  .regex(/^\S[^\r\n]*$/, "one line of text, not starting with whitespace");

const INPUT_ENTRY = z.strictObject({
  description: DESCRIPTION,
  required: z.literal(false),
  default: z.string(),
});
const OUTPUT_ENTRY = z.strictObject({ description: DESCRIPTION });

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
    // Every default double-quoted: one form for the region shape to name, and the string type visible at a glance.
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

/** Why `item` cannot be one item of a prose list: a comma or the word "and" would read back as a joiner. */
function proseItemFault(item: string): string | undefined {
  return /,|(^|\s)and(\s|$)/.test(item) ? 'holds a comma or the word "and"' : undefined;
}

function proseList(items: readonly string[]): string {
  const faulty = items.find((item) => proseItemFault(item) !== undefined);
  if (faulty !== undefined) {
    throw new Error(`"${faulty}" ${proseItemFault(faulty)}, which an item of a prose list cannot`);
  }
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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

const COUNT_SENTENCE = new RegExp(
  String.raw`^[A-Z][a-z-]*${RegExp.escape(COUNT_SENTENCE_LEAD)}(.+)\.$`,
);

/** The keys a count sentence lists; the count word is the renderer's to re-derive, so the byte compare judges it. */
function parseCountSentence(body: string): Result<readonly string[], string> {
  return blockLine(body).andThen((line) => {
    const listed = COUNT_SENTENCE.exec(line)?.[1];
    if (listed === undefined) {
      return err("line 1 is not the count sentence");
    }
    const keys = [...listed.matchAll(/`([a-z_]+)`/g)].map((span) => span[1] ?? "");
    return keys.length === 0 ? err("line 1 names no section key in a code span") : ok(keys);
  });
}

/** A Defaults-per-section row's prose: the default's parenthesized `caveat`, and what the opposite policy (`override`) buys. */
export interface PolicyRowProse {
  readonly caveat?: string;
  readonly override: string;
}

/**
 * Why a row's prose cannot be rendered: blank prose would render `delete ()` or a bare policy span, cells
 * cellFault() admits since the policy word fills them. The renderer refuses it at its own boundary and the parser
 * through this same check, by the trimmed-blank rule cellFault() uses, so what the renderer writes is exactly what
 * the guard reads back. A structural type cannot vouch for a property a narrowing hid, so the value is inspected
 * as unknown.
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

export const DEFAULTS_TABLE_HEADER = "| Section | Default | The override buys you |\n|---|---|---|";

/** One Defaults row: the section and the prose its cells carry. */
export interface PolicyRow {
  readonly section: KnobbedSection;
  readonly prose: PolicyRowProse;
}

/** A row's three cells, as the renderer writes them and the guard reads them back. */
export function policyCells(row: PolicyRow): readonly string[] {
  const caveat = row.prose.caveat === undefined ? "" : ` (${row.prose.caveat})`;
  return [
    `\`${row.section.key}\``,
    `${row.section.undeclaredDefault}${caveat}`,
    `\`${OPPOSITE[row.section.undeclaredDefault]}\`: ${row.prose.override}`,
  ];
}

/**
 * The one statement of what a Defaults table may hold: each row's prose by proseFault(), then the table rule over
 * the cells. The renderer consults it whole before writing; the guard consults the same two rules as it parses,
 * so a test can hold both sides to it.
 */
export function policyTableFault(rows: readonly PolicyRow[]): string | undefined {
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

/** The Defaults table in delete-first order, the order the guard holds a committed page to through the byte compare. */
function renderPolicyRows(rows: readonly PolicyRow[]): string {
  const ordered = deleteFirst(rows, (row) => row.section.undeclaredDefault);
  const fault = policyTableFault(ordered);
  if (fault !== undefined) {
    throw new Error(fault);
  }
  return renderTable(DEFAULTS_TABLE_HEADER, ordered.map(policyCells));
}

export function renderPolicyDefaultsTable(
  sections: readonly KnobbedSection[],
  prose: Readonly<Record<string, PolicyRowProse>>,
): string {
  return renderPolicyRows(policyRows(sections, prose));
}

/** A Defaults row read back to the section and prose it renders from; the delete-first order is then the
 * renderer's to check, through the byte compare. The dotAll flag keeps the two Unicode line separators
 * cellFault() admits inside the prose. */
function policyRow(cells: readonly string[], key: string): Result<PolicyRow, string> {
  const policy = /^(delete|keep)(?: \((.*)\))?$/s.exec(cells[1] ?? "");
  const buys = /^`(delete|keep)`: (.*)$/s.exec(cells[2] ?? "");
  if (policy === null) {
    return err("states no delete or keep default");
  }
  if (buys === null) {
    return err("names no policy span before its override prose");
  }
  const undeclaredDefault = policy[1] === "delete" ? "delete" : "keep";
  if (buys[1] !== OPPOSITE[undeclaredDefault]) {
    return err(
      `names \`${buys[1]}\` where the override is the opposite policy, \`${OPPOSITE[undeclaredDefault]}\``,
    );
  }
  const row = { caveat: policy[2], override: buys[2] ?? "" };
  const fault = proseFault(row);
  if (fault !== undefined) {
    return err(`${fault}, which the renderer refuses`);
  }
  return ok({ section: { key, undeclaredDefault }, prose: row });
}

/** The row every secret family shares: the value is write-only, so a wrong delete is a loss, not a drift. */
const SECRET_ROW_PROSE: PolicyRowProse = {
  override: "prune stale secrets - a deleted secret's value is unrecoverable",
};

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

/** `items` as a prose list's items, or the first one proseList() would refuse. */
function proseListItems(items: readonly string[]): Result<readonly string[], string> {
  const faulty = items.find((item) => proseItemFault(item) !== undefined);
  return faulty === undefined
    ? ok(items)
    : err(`lists "${faulty}", which ${proseItemFault(faulty)}`);
}

/**
 * proseList() read back: "a", "a and b", or "a, b, and c". Exact, since every item passes proseItemFault(); text
 * whose items would not is refused rather than handed to a renderer that throws.
 */
function proseItems(text: string): Result<readonly string[], string> {
  const parts = text.split(", ");
  const last = parts.at(-1);
  return proseListItems(
    parts.length > 2 && last?.startsWith("and ")
      ? [...parts.slice(0, -1), last.slice("and ".length)]
      : text.split(" and "),
  );
}

const GRANT_SENTENCE = new RegExp(
  String.raw`^${RegExp.escape(GRANT_SENTENCE_LEAD)}(.+?) at write(?:, plus (.+))?\.$`,
);
const GRANT_EXTRAS =
  /^(?:(.+) at read and )?\(for org repos\) the (.+) organization permissions? at read$|^(.+) at read$/;

function parseGrantSentence(body: string): Result<GrantLabels, string> {
  return blockLine(body).andThen((line) => {
    const sentence = GRANT_SENTENCE.exec(line);
    if (sentence === null) {
      return err("line 1 is not the grant sentence");
    }
    const extras = sentence[2] === undefined ? null : GRANT_EXTRAS.exec(sentence[2]);
    if (sentence[2] !== undefined && extras === null) {
      return err("line 1 adds grants in neither the read form nor the organization form");
    }
    const reads = extras?.[1] ?? extras?.[3];
    const orgs = extras?.[2];
    return Result.combine([
      proseItems(sentence[1] ?? ""),
      reads === undefined ? ok([]) : proseItems(reads),
      orgs === undefined ? ok([]) : proseItems(orgs),
    ])
      .map(([writes = [], reads = [], orgs = []]): GrantLabels => ({ writes, reads, orgs }))
      .mapErr((fault) => `line 1 ${fault}`);
  });
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

const EVERY_GATED =
  /^- GitHub gates even the (.+) reads at write, so `([a-z_]+)` needs (its write grant|the .+ write grant) in check mode too\.$/;
const SOME_GATED =
  /^- GitHub gates the (.+) reads at write, so `([a-z_]+)` needs its (.+) write grant in check mode to verify what they return\.$/;

/** `lines` read back as gated-reads bullets, the first sitting at line `first`. */
function parseGatedBullets(lines: readonly string[], first: number): Result<GatedRead[], string> {
  const reads: GatedRead[] = [];
  for (const [index, line] of lines.entries()) {
    const every = EVERY_GATED.exec(line);
    const some = SOME_GATED.exec(line);
    if (every === null && some === null) {
      return err(`line ${first + index} is not a gated-reads bullet`);
    }
    const labels = proseItems((every ?? some)?.[every !== null ? 1 : 3] ?? "");
    // A route is listed as a code span, so the span is the item the prose rule judges.
    const spans = proseListItems([...(some?.[1] ?? "").matchAll(/`[^`]+`/g)].map((m) => m[0]));
    const read = Result.combine([labels, spans]);
    if (read.isErr()) {
      return err(`line ${first + index} ${read.error}`);
    }
    const [readLabels = [], routeSpans = []] = read.value;
    if (every !== null) {
      const ownGrant = every[3] === "its write grant";
      reads.push({ key: every[2] ?? "", gated: "every", labels: readLabels, ownGrant });
    } else if (some !== null) {
      const routes = routeSpans.map((span) => span.slice(1, -1));
      reads.push({ key: some[2] ?? "", gated: "some", routes, labels: readLabels });
    }
  }
  return ok(reads);
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

function parseCheckModeGatedReads(body: string): Result<GatedRead[], string> {
  return blockLines(body).andThen((lines) => {
    if (lines.length === 1 && lines[0] === NO_GATED_READS) {
      return ok([]);
    }
    if (lines[0] !== GATED_READS_LEAD_IN) {
      return err("line 1 is neither the read-only sentence nor the lead-in to the gated reads");
    }
    if (lines[1] !== "") {
      return err("line 2 is not the blank line under the lead-in");
    }
    return parseGatedBullets(lines.slice(2), 3);
  });
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

/**
 * A YAML region's body read back as the `key` mapping's declarations under `entry`, every own name kept; the
 * emitter is its own grammar, so a spelling it does not write fails the byte compare that follows.
 */
function yamlDeclarations<T>(
  key: string,
  entry: z.ZodType<T>,
): (body: string) => Result<Record<string, T>, string> {
  return (body) => {
    const doc = parseDocument(`${key}:${body}`, { ...YAML_DOCUMENT, prettyErrors: false });
    const error = doc.errors[0];
    if (error !== undefined) {
      // The library counts the prepended key line as line 1, so the line is counted in the body instead.
      const line = body.slice(0, error.pos[0] - `${key}:`.length).split("\n").length - 1;
      return err(`line ${line} does not parse as YAML (${error.message})`);
    }
    let root: unknown;
    try {
      root = doc.toJS();
    } catch (failure) {
      // An alias without its anchor parses but does not convert; to the guard that is a refusal.
      return err(
        `it does not convert from YAML (${failure instanceof Error ? failure.message : String(failure)})`,
      );
    }
    const mapping =
      typeof root === "object" && root !== null
        ? ((root as Record<string, unknown>)[key] ?? {})
        : root;
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      return err(`it is not a mapping of ${key} declarations`);
    }
    const declared = declarations(entry, mapping as Record<string, unknown>);
    return typeof declared === "string"
      ? err(`it is not a set of ${key} declarations (${declared})`)
      : ok(declared);
  };
}

/**
 * Each region reads its body back and re-renders it, so a marker moved elsewhere fails instead of regenerating
 * in the wrong place or erasing authored text.
 */
export const GENERATED_REGIONS: Readonly<Record<string, readonly GeneratedRegion[]>> = {
  "action.yml": [
    GeneratedRegion.of<Readonly<Record<string, Pick<InputDecl, "description" | "default">>>>({
      name: "action-inputs",
      placement: { kind: "under-key", key: "inputs" },
      data: () => INPUT_DECLS,
      render: block(renderActionInputs),
      parse: yamlDeclarations("inputs", INPUT_ENTRY),
    }),
    GeneratedRegion.of<Readonly<Record<string, { readonly description: string }>>>({
      name: "action-outputs",
      placement: { kind: "under-key", key: "outputs" },
      data: () => OUTPUT_DECLS,
      render: block(renderActionOutputs),
      parse: yamlDeclarations("outputs", OUTPUT_ENTRY),
    }),
  ],
  "docs/reference/undeclared-policy.md": [
    GeneratedRegion.of<readonly string[]>({
      name: "policy-count-sentence",
      placement: { kind: "under-heading", heading: "# The undeclared policy" },
      data: () => countSentenceKeys(knobbedSections()),
      render: block(countSentence),
      parse: parseCountSentence,
    }),
    GeneratedRegion.of<readonly PolicyRow[]>({
      name: "policy-defaults-table",
      placement: { kind: "under-heading", heading: "## Defaults per section" },
      data: () => policyRows(knobbedSections(), POLICY_ROW_PROSE),
      render: block(renderPolicyRows),
      parse: tableBody(DEFAULTS_TABLE_HEADER, "keyed", policyRow),
    }),
  ],
  "docs/reference/permissions.md": [
    GeneratedRegion.of({
      name: "permissions-grant-sentence",
      placement: { kind: "under-heading", heading: "## What to grant" },
      data: () => grantLabels(SECTIONS),
      render: block(grantSentence),
      parse: parseGrantSentence,
    }),
    GeneratedRegion.of<readonly GatedRead[]>({
      name: "permissions-gated-reads",
      placement: { kind: "under-heading", heading: "## How a denial surfaces" },
      data: () => gatedReads(SECTIONS),
      render: block(gatedBullets),
      parse: (body) => blockLines(body).andThen((lines) => parseGatedBullets(lines, 1)),
    }),
  ],
  "docs/operate/check-mode.md": [
    GeneratedRegion.of<readonly GatedRead[]>({
      name: "check-mode-gated-reads",
      placement: {
        kind: "under-heading",
        heading: "## Checking settings changes on pull requests",
      },
      data: () => gatedReads(SECTIONS),
      render: block(checkModeGatedReads),
      parse: parseCheckModeGatedReads,
    }),
  ],
};

export function regenerateText(path: string, text: string): string {
  const regions = GENERATED_REGIONS[path];
  if (regions === undefined) {
    throw new Error(`no generated regions are registered for ${path}`);
  }
  return regenerateRegions(text, regions, path);
}

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

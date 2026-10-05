import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { countWord } from "./lib/count-word.js";
import { type GeneratedRegion, regenerateRegions } from "./lib/generated-regions.js";
import { tableCell } from "./lib/markdown-table.js";

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
  .regex(/^\S[^\n]*$/, "one line of text, not starting with whitespace");

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

function proseList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export interface KnobbedSection {
  readonly key: string;
  readonly undeclaredDefault: "delete" | "keep";
}

function deleteFirst(sections: readonly KnobbedSection[]): KnobbedSection[] {
  return [
    ...sections.filter((section) => section.undeclaredDefault === "delete"),
    ...sections.filter((section) => section.undeclaredDefault === "keep"),
  ];
}

const COUNT_SENTENCE_LEAD = " sections list the live resources sitting next to the declared ones: ";

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

const DEFAULTS_TABLE_HEADER = "| Section | Default | The override buys you |\n|---|---|---|";

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
    const cells = [
      `\`${section.key}\``,
      tableCell(`${section.undeclaredDefault}${caveat}`, `the ${section.key} Default cell`),
      tableCell(
        `\`${opposite}\`: ${text.override}`,
        `the ${section.key} "The override buys you" cell`,
      ),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [DEFAULTS_TABLE_HEADER, ...rows].join("\n");
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
          `(for org repos) the ${proseList(orgList)} organization ${agree(orgList.length, "permission", "permissions")} at read`,
        ]
      : []),
  ];
  const plus = extras.length > 0 ? `, plus ${extras.join(" and ")}` : "";
  return `${GRANT_SENTENCE_LEAD}${proseList(writeList)} at write${plus}.`;
}

export function renderGatedReads(sections: readonly SectionMeta[]): string {
  return sections
    .flatMap((section) => {
      const gated = writeGatedReads(section);
      if (gated.length === 0) {
        return [];
      }
      const labels = unique(gated.map((read) => primaryLabel(read.permission)));
      if (readGating(section) === "write-gated") {
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

const NO_GATED_READS = "A read-only PAT covers every section in check mode.";
const GATED_READS_LEAD_IN =
  "The read-only rule has exceptions, each a section to drop from the preview or grant at write:";

export function renderCheckModeGatedReads(sections: readonly SectionMeta[]): string {
  const bullets = renderGatedReads(sections);
  if (bullets === "") {
    return NO_GATED_READS;
  }
  return `${GATED_READS_LEAD_IN}\n\n${bullets}`;
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

/** The empty alternative admits a freshly placed region and an empty rendering alike. */
function blockShape(lines: string): RegExp {
  return new RegExp(String.raw`^\n(?:${lines}|\n)?$`);
}

function tableShape(header: string, cells: string): RegExp {
  return blockShape(String.raw`${RegExp.escape(header)}\n(?:\| ${cells} \|\n)*`);
}

/** The emitter is its own grammar: a body is admitted when re-rendering the declarations it parses to reproduces it
 * byte for byte, so no spelling the emitter does not write gets through. A freshly placed region holds "\n" and
 * renders next. */
function roundTrip<T extends { readonly description: string }>(
  key: string,
  entry: z.ZodType<T>,
  render: (decls: Readonly<Record<string, T>>) => string,
): (body: string) => string | undefined {
  return (body) => {
    if (body === "\n") {
      return undefined;
    }
    const doc = parseDocument(`${key}:${body}`, YAML_DOCUMENT);
    const error = doc.errors[0];
    if (error !== undefined) {
      return `it does not parse as YAML (${error.message.split("\n")[0]})`;
    }
    let root: unknown;
    try {
      root = doc.toJS();
    } catch (failure) {
      // An alias without its anchor parses but does not convert; to the guard that is a refusal.
      return `it does not convert from YAML (${failure instanceof Error ? failure.message : String(failure)})`;
    }
    const mapping =
      typeof root === "object" && root !== null
        ? ((root as Record<string, unknown>)[key] ?? {})
        : root;
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      return `it is not a mapping of ${key} declarations`;
    }
    const declared = declarations(entry, mapping as Record<string, unknown>);
    if (typeof declared === "string") {
      return `it is not a set of ${key} declarations (${declared})`;
    }
    const rendered = `\n${render(declared)}\n`;
    if (rendered === body) {
      return undefined;
    }
    const authored = body.split("\n");
    const expected = rendered.split("\n");
    const differing = authored.findIndex((line, i) => line !== expected[i]);
    const at = differing === -1 ? authored.length : differing;
    return `line ${at} reads ${JSON.stringify(authored[at] ?? "")} where the generator writes ${JSON.stringify(expected[at] ?? "")}`;
  };
}

const GATED_READ_BULLET =
  String.raw`- GitHub gates (?:even )?the [^\n]+ reads at write, so \x60[a-z_]+\x60 needs ` +
  String.raw`(?:its|the)(?: [^\n]+)? write grant in check mode (?:too|to verify what they ` +
  String.raw`return)\.\n`;

function block(render: () => string): () => string {
  return () => `\n${render()}\n`;
}

/** Each region's `body` matches every body this generator could have written for it, so a marker moved elsewhere
 * fails instead of regenerating in the wrong place or erasing authored text. */
export const GENERATED_REGIONS: Readonly<Record<string, readonly GeneratedRegion[]>> = {
  "action.yml": [
    {
      name: "action-inputs",
      placement: { kind: "under-key", key: "inputs" },
      body: roundTrip("inputs", INPUT_ENTRY, renderActionInputs),
      render: block(() => renderActionInputs(INPUT_DECLS)),
    },
    {
      name: "action-outputs",
      placement: { kind: "under-key", key: "outputs" },
      body: roundTrip("outputs", OUTPUT_ENTRY, renderActionOutputs),
      render: block(() => renderActionOutputs(OUTPUT_DECLS)),
    },
  ],
  "docs/reference/undeclared-policy.md": [
    {
      name: "policy-count-sentence",
      placement: { kind: "under-heading", heading: "# The undeclared policy" },
      body: blockShape(String.raw`[A-Z][a-z-]*${RegExp.escape(COUNT_SENTENCE_LEAD)}[^\n]+\.\n`),
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
      body: blockShape(String.raw`${RegExp.escape(GRANT_SENTENCE_LEAD)}[^\n]+\.\n`),
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
        String.raw`${RegExp.escape(NO_GATED_READS)}\n|${RegExp.escape(GATED_READS_LEAD_IN)}\n\n(?:${GATED_READ_BULLET})+`,
      ),
      render: block(() => renderCheckModeGatedReads(SECTIONS)),
    },
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

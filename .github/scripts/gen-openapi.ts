/**
 * Regenerates WHOLESALE the TypeScript GitHub's OpenAPI descriptor dictates, from the installed @octokit/openapi
 * (the non-dereferenced api.github.com.json, so component names survive). Build time only: neither the descriptor
 * nor this script is bundled.
 *   src/generated/spec-roles.ts -> the invitation role enums (the PATCH body's, the GET listing's)
 *   src/generated/spec-rules.ts -> one zod row per ruleset rule type, parameters typed as the spec types them
 *   src/generated/spec-enums.ts -> the vocabularies, bounds, and small bodies the sections send to GitHub verbatim
 *
 * A path the descriptor no longer carries, or a shape the emitter does not know, ends the run naming it: a
 * descriptor that outgrows the emitter fails the build instead of rendering less than the spec says. The rows call
 * zod the way the hand-written rows did (every check aborting), so the refusal messages the tests pin hold;
 * z.fromJSONSchema would judge the same shapes at runtime, with non-aborting checks and zod's own union report.
 *   bun run build:openapi             -> writes every output, formatted by biome as the lint expects
 *   test/scripts/gen-openapi.test.ts  -> pins each committed output to a fresh render, and runs under the nightly's
 *                                        @latest install so a descriptor release that moves an enum fails the night
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runMain } from "./lib/entry.js";

const ROOT = join(import.meta.dir, "..", "..");

const DESCRIPTOR_PATH = fileURLToPath(
  import.meta.resolve("@octokit/openapi/generated/api.github.com.json"),
);

export interface SchemaNode {
  readonly [key: string]: unknown;
  readonly $ref?: string;
  readonly type?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly unknown[];
  readonly oneOf?: readonly SchemaNode[];
  readonly title?: unknown;
}

export interface Descriptor {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: { readonly schemas: Readonly<Record<string, SchemaNode>> };
}

export function loadDescriptor(): Descriptor {
  return JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8")) as Descriptor;
}

const COMPONENT_REF = "#/components/schemas/";

/** The schema component a `$ref` names; a `$ref` of any other kind (a parameter, a response, a header) is refused. */
export function component(descriptor: Descriptor, ref: string): SchemaNode {
  const name = ref.startsWith(COMPONENT_REF) ? ref.slice(COMPONENT_REF.length) : undefined;
  const schema = name === undefined ? undefined : descriptor.components.schemas[name];
  if (schema === undefined || schema === null) {
    throw new Error(`${ref} names no component schema`);
  }
  return schema;
}

/** OpenAPI ignores a `$ref`'s sibling keywords, so a render from an alias would say less than its target without
 * failing. */
function resolved(descriptor: Descriptor, node: unknown): unknown {
  const ref = (node as Readonly<Record<string, unknown>> | null)?.$ref;
  if (typeof ref !== "string") {
    return node;
  }
  const target = component(descriptor, ref);
  if (typeof target.$ref === "string") {
    throw new Error(`${ref} is a reference to ${target.$ref}, a chain the emitter does not follow`);
  }
  return target;
}

/** A missing step ends the run naming the path up to it, so a descriptor that moved an enum says where. */
function nodeAt(descriptor: Descriptor, path: readonly string[]): SchemaNode {
  let node: unknown = descriptor;
  for (const [index, key] of path.entries()) {
    const next: unknown = (
      resolved(descriptor, node) as Readonly<Record<string, unknown>> | null
    )?.[key];
    if (next === undefined || next === null) {
      throw new Error(`${path.slice(0, index + 1).join(".")} is missing from the descriptor`);
    }
    node = next;
  }
  return resolved(descriptor, node) as SchemaNode;
}

/** An empty enum is refused like a missing one: rendered, the collaborators section would refuse every pending
 * invitation's role. */
export function enumAt(descriptor: Descriptor, path: readonly string[]): string[] {
  const node = nodeAt(descriptor, path);
  const values = node.enum;
  const dotted = path.join(".");
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${dotted} carries no enum, or an empty one`);
  }
  const members = values.map((value) => {
    if (typeof value !== "string") {
      throw new Error(`${dotted} enum member ${JSON.stringify(value)} is not a string`);
    }
    return value;
  });
  // A keyword beside the enum (a pattern) would narrow what the tuple admits with nothing in the render to say so.
  checkedType(node, dotted);
  return members;
}

const header = (what: string) => `/**
 * GENERATED by gen-openapi.ts - do not edit. ${what}
 * descriptor; regenerate with \`bun run build:openapi\` after a descriptor bump.
 */
`;

const stringList = (values: readonly string[]) => values.map((v) => JSON.stringify(v)).join(", ");

/** The platform caps a source line and biome never breaks a string, so a long description is spelled in word
 * pieces joined back with the one space they were split at; a word longer than a piece (a URL) stands alone, whole,
 * since a word cut in two reads as a misspelling to the spelling gate. */
const DESCRIPTION_PIECE = 80;
export function descriptionLiteral(text: string): string {
  if (text.length <= DESCRIPTION_PIECE) {
    return JSON.stringify(text);
  }
  const pieces: string[] = [];
  // Undefined, not "": a run of spaces splits into empty words, and each of them is a word the join restores.
  let piece: string | undefined;
  for (const word of text.split(" ")) {
    if (piece !== undefined && piece.length + 1 + word.length > DESCRIPTION_PIECE) {
      pieces.push(piece);
      piece = word;
    } else {
      piece = piece === undefined ? word : `${piece} ${word}`;
    }
  }
  pieces.push(piece ?? "");
  return `[${stringList(pieces)}].join(" ")`;
}

/** A node's own prose as `.describe()`, or nothing: a `$ref` node's prose belongs to the component it names. */
function described(node: SchemaNode): string {
  return typeof node.description === "string" && node.$ref === undefined
    ? `.describe(${descriptionLiteral(node.description)})`
    : "";
}

/** The `.meta()` of a published definition: its id, and the descriptor's prose where it has some. Spelled one
 * property per line: biome keeps an object a line break opened expanded, and its first pass over the member chain
 * is then its last, so the committed render is what the lint expects. */
function published(id: string, node: SchemaNode): string {
  const description =
    typeof node.description === "string"
      ? `\n  description: ${descriptionLiteral(node.description)},`
      : "";
  return `.meta({\n  id: ${JSON.stringify(id)},${description}\n})`;
}

// --- Roles ----------------------------------------------------------------------------------------------------

export const ROLES_PATH = "src/generated/spec-roles.ts";

const INVITATION_PATH = "/repos/{owner}/{repo}/invitations/{invitation_id}";
const INVITATIONS_PATH = "/repos/{owner}/{repo}/invitations";
const JSON_BODY = ["content", "application/json", "schema"] as const;

export function renderRoles(descriptor: Descriptor): string {
  const settable = enumAt(descriptor, [
    "paths",
    INVITATION_PATH,
    "patch",
    "requestBody",
    ...JSON_BODY,
    "properties",
    "permissions",
  ]);
  const reported = enumAt(descriptor, [
    "paths",
    INVITATIONS_PATH,
    "get",
    "responses",
    "200",
    ...JSON_BODY,
    "items",
    "properties",
    "permissions",
  ]);
  return `${header("The invitation role vocabularies of GitHub's OpenAPI")}
/** The roles the invitation PATCH body accepts: what a pending invitation can be set to. */
export const INVITATION_ROLES: ReadonlySet<string> = new Set([${stringList(settable)}]);

/** The roles the invitation GET listing reports; it can exceed the PATCH's. */
export const REPORTED_INVITATION_ROLES: ReadonlySet<string> = new Set([${stringList(reported)}]);
`;
}

// --- Rules ----------------------------------------------------------------------------------------------------

export const RULES_PATH = "src/generated/spec-rules.ts";

const RULESETS_PATH = "/repos/{owner}/{repo}/rulesets";
const RULESET_PATH = "/repos/{owner}/{repo}/rulesets/{ruleset_id}";

/**
 * The parameter components the rows reference, by the definition id published for each (docs/sections/rulesets.docs.yml
 * describes them); null for a shape the published schema inlines, whose const takes the component's title. A
 * component outside this table ends the run naming it.
 */
const COMPONENT_IDS: Readonly<Record<string, string | null>> = {
  "repository-rule-params-status-check-configuration": "StatusCheckConfig",
  "repository-rule-params-workflow-file-reference": "WorkflowFileConfig",
  "repository-rule-params-code-scanning-tool": "CodeScanningToolConfig",
  "repository-rule-params-actor": "ReviewDismissalActorConfig",
  "repository-rule-params-required-reviewer-configuration": "RequiredReviewerConfig",
  "repository-rule-params-dismissal-restriction": null,
  "repository-rule-params-reviewer": null,
};

/** An inline parameter shape several rule types spell alike, by its sorted field names, and the one definition
 * published for it; such a shape outside this table ends the run naming the rule types. */
const SHARED_PARAMETER_IDS: Readonly<Record<string, string>> = {
  "name,negate,operator,pattern": "PatternRuleParameters",
};

/**
 * Not shape: `description` reaches the published schema through `.describe()`, the rest is dropped. `default` is
 * what GitHub fills in for an omitted key; a section spells the one default its parsed entry must carry by hand
 * (a ruleset's target), and every other key stays omitted so the live default is never drift.
 */
const METADATA_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "default",
  "example",
  "x-github",
]);

/** The shape keywords per type; `nullable` is read beside them for every type. */
const KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  object: new Set(["type", "properties", "required"]),
  string: new Set(["type", "enum"]),
  boolean: new Set(["type"]),
  integer: new Set(["type", "minimum", "maximum"]),
  number: new Set(["type", "format", "minimum", "maximum"]),
  array: new Set(["type", "items"]),
};

const UNION_KEYWORDS: ReadonlySet<string> = new Set(["type", "oneOf"]);

/** The node's type, once every keyword on it is one the emitter renders for that type; anything else refuses by path. */
function checkedType(node: SchemaNode, path: string): string {
  const { type } = node;
  const allowed = typeof type === "string" ? KEYWORDS[type] : undefined;
  if (allowed === undefined) {
    throw new Error(`${path}: the emitter does not know type ${JSON.stringify(type)}`);
  }
  for (const name of Object.keys(node)) {
    if (name === "nullable") {
      if (typeof node.nullable !== "boolean") {
        throw new Error(`${path}: nullable ${JSON.stringify(node.nullable)} is not a boolean`);
      }
    } else if (!allowed.has(name) && !METADATA_KEYWORDS.has(name)) {
      throw new Error(`${path}: the emitter does not know keyword "${name}" on a ${type}`);
    }
  }
  return type as string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** The node without its prose at any depth: what two rule types must share for one published shape. A key under
 * `properties` is a field name, never a keyword, so a field called description stays. */
function shape(node: unknown, properties = false): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => shape(item));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([name]) => properties || !METADATA_KEYWORDS.has(name))
      .map(([name, child]) => [name, shape(child, !properties && name === "properties")]),
  );
}

/** How the emitter closes a mapping: loose keeps undeclared keys (the rows, a passthrough body), strict refuses them. */
type Objects = "loose" | "strict";

/**
 * The rows abort on a failed check (src/sections/rulesets/rule-overrides.ts says why); a body outside a union
 * does not, so its other refusals still report beside a failed bound.
 */
interface EmitterOptions {
  readonly objects?: Objects;
  readonly abort?: boolean;
}

type Field = (name: string, child: SchemaNode, path: string) => string | undefined;

/** One render's state: the components and shared shapes met, in dependency order. */
class ZodEmitter {
  readonly consts = new Map<string, string>();
  private readonly objects: Objects;
  /** The check parameter spelled into every bound, or nothing. */
  private readonly abort: string;

  constructor(
    private readonly descriptor: Descriptor,
    options: EmitterOptions = {},
  ) {
    this.objects = options.objects ?? "loose";
    this.abort = (options.abort ?? true) ? "{ abort: true }" : "";
  }

  private refuse(path: string, what: string): never {
    throw new Error(`${path}: ${what}`);
  }

  /** OpenAPI 3.0's `nullable: true`; a published id goes before it, so it stays on the mapping, and prose after
   * it, so the published schema reads the description at the property. */
  private nullable(node: SchemaNode): string {
    return node.nullable === true ? ".nullable()" : "";
  }

  private bound(node: SchemaNode, path: string, keyword: "minimum" | "maximum"): string {
    const value = node[keyword];
    if (value === undefined) {
      return "";
    }
    if (typeof value !== "number") {
      return this.refuse(path, `${keyword} ${JSON.stringify(value)} is not a number`);
    }
    const abort = this.abort === "" ? "" : `, ${this.abort}`;
    return `.${keyword === "minimum" ? "min" : "max"}(${value}${abort})`;
  }

  /** The zod expression for a node, its own prose left to the caller. */
  node(node: SchemaNode, path: string): string {
    if (typeof node.$ref === "string") {
      return this.component(node.$ref, path);
    }
    if (node.type === "object") {
      return this.object(node, path);
    }
    return `${this.scalar(node, path)}${this.nullable(node)}`;
  }

  private scalar(node: SchemaNode, path: string): string {
    switch (checkedType(node, path)) {
      case "string": {
        if (node.enum === undefined) {
          return "z.string()";
        }
        const values = enumAt({ ...this.descriptor, paths: { [path]: node } }, ["paths", path]);
        return values.length === 1
          ? `z.literal(${JSON.stringify(values[0])})`
          : `z.enum([${stringList(values)}])`;
      }
      case "boolean":
        return "z.boolean()";
      case "integer":
        return `z.int(${this.abort})${this.bound(node, path, "minimum")}${this.bound(node, path, "maximum")}`;
      case "number":
        if (node.format !== undefined && node.format !== "float") {
          this.refuse(
            path,
            `the emitter does not know number format ${JSON.stringify(node.format)}`,
          );
        }
        return `z.number()${this.bound(node, path, "minimum")}${this.bound(node, path, "maximum")}`;
      default:
        if (node.items === undefined) {
          return this.refuse(path, "an array without items");
        }
        return `z.array(${this.node(node.items, `${path}[]`)})`;
    }
  }

  /**
   * Loose, not plain, unless strict was asked for: the snapshot projection (shared/snapshot-helpers.ts) keeps a live
   * field the shape does not name only behind an explicit catchall, and a field GitHub adds to a rule must survive
   * a snapshot. `id` publishes the mapping under that definition; `field` supplies a property's whole expression in
   * place of the emitter's own (prose included, or left off a reference to a published definition, which draft-7
   * would drop); `.optional()` is still appended outside `required`.
   */
  object(
    node: SchemaNode,
    path: string,
    { id, field = () => undefined }: { readonly id?: string; readonly field?: Field } = {},
  ): string {
    const type = checkedType(node, path);
    if (type !== "object") {
      this.refuse(path, `an object was expected, not a ${type}`);
    }
    const properties = node.properties ?? {};
    if (node.required !== undefined && !Array.isArray(node.required)) {
      this.refuse(path, `required is ${JSON.stringify(node.required)}, not a list of field names`);
    }
    const required = new Set(
      (node.required ?? []).map((name) => {
        if (typeof name !== "string" || !Object.hasOwn(properties, name)) {
          this.refuse(
            path,
            `required names ${JSON.stringify(name)}, which properties does not declare`,
          );
        }
        return name;
      }),
    );
    const fields = Object.entries(properties).map(([name, child]) => {
      const optional = required.has(name) ? "" : ".optional()";
      const childPath = `${path}.${name}`;
      const expression =
        field(name, child, childPath) ?? `${this.node(child, childPath)}${described(child)}`;
      return `${key(name)}: ${expression}${optional}`;
    });
    const meta = id === undefined ? "" : published(id, node);
    return `z.${this.objects}Object({ ${fields.join(", ")} })${meta}${this.nullable(node)}`;
  }

  /** The const a component renders to, declared once after the components it references. */
  component(ref: string, path: string): string {
    const name = ref.slice(COMPONENT_REF.length);
    const id = COMPONENT_IDS[name];
    if (id === undefined) {
      return this.refuse(
        path,
        `${ref} is not in COMPONENT_IDS; name its published definition, or null to inline it`,
      );
    }
    const schema = component(this.descriptor, ref);
    const constName = id ?? (typeof schema.title === "string" ? schema.title : "");
    if (!IDENTIFIER.test(constName)) {
      return this.refuse(path, `${ref} has no title to name an inlined const by`);
    }
    if (!this.consts.has(constName)) {
      this.consts.set(
        constName,
        id === null
          ? `${this.object(schema, name)}${described(schema)}`
          : this.object(schema, name, { id }),
      );
    }
    return constName;
  }
}

interface RuleVariant {
  readonly type: string;
  readonly node: SchemaNode;
  readonly path: string;
}

/** The rule variants the POST and PUT bodies share; two bodies that disagree would need two sets of rows. */
function ruleVariants(descriptor: Descriptor): RuleVariant[] {
  const rules = (method: string, route: string) =>
    nodeAt(descriptor, [
      "paths",
      route,
      method,
      "requestBody",
      ...JSON_BODY,
      "properties",
      "rules",
    ]);
  const post = rules("post", RULESETS_PATH);
  if (!isDeepStrictEqual(post, rules("put", RULESET_PATH))) {
    throw new Error(
      `the rules of POST ${RULESETS_PATH} and PUT ${RULESET_PATH} differ; the rows render one shape`,
    );
  }
  // The list and the union node may say nothing beyond their items: a constraint there would bind every row.
  const list = { path: "rules", node: post, type: "array", allowed: KEYWORDS.array ?? new Set() };
  const items = post.items === undefined ? undefined : resolved(descriptor, post.items);
  const union = {
    path: "rules[]",
    node: items as SchemaNode,
    type: "object",
    allowed: UNION_KEYWORDS,
  };
  for (const { path, node, type, allowed } of [list, union]) {
    for (const name of Object.keys(node ?? {})) {
      if (!allowed.has(name) && !METADATA_KEYWORDS.has(name)) {
        throw new Error(`${path}: the emitter does not know keyword "${name}" on a ${type}`);
      }
    }
    if (node?.type !== type) {
      throw new Error(`${path}: an ${type} was expected, not a ${String(node?.type)}`);
    }
  }
  const variants = union.node.oneOf;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(`the rules of POST ${RULESETS_PATH} are not a oneOf of rule variants`);
  }
  return variants.map((variant, index) => {
    const ref = typeof variant.$ref === "string" ? variant.$ref : `rules[${index}]`;
    const node = resolved(descriptor, variant) as SchemaNode;
    const [type, ...more] = node.properties?.type?.enum ?? [];
    if (typeof type !== "string" || more.length > 0) {
      throw new Error(
        `${ref}: a rule variant's type is one enum value, not ${JSON.stringify(node.properties?.type)}`,
      );
    }
    return { type, node, path: ref };
  });
}

export function renderRules(descriptor: Descriptor): string {
  const variants = ruleVariants(descriptor);
  const emitter = new ZodEmitter(descriptor);
  const inline = variants.filter(
    ({ node }) =>
      node.properties?.parameters !== undefined && node.properties.parameters.$ref === undefined,
  );
  const shared = new Map<string, string>();
  const spelled = new Map<string, string[]>();
  const groups: { shape: unknown; members: RuleVariant[] }[] = [];
  for (const variant of inline) {
    const own = shape(variant.node.properties?.parameters);
    const found = groups.find((group) => isDeepStrictEqual(group.shape, own));
    if (found === undefined) {
      groups.push({ shape: own, members: [variant] });
    } else {
      found.members.push(variant);
    }
  }
  for (const { members: group } of groups) {
    if (group.length < 2) {
      continue;
    }
    const [first] = group;
    const parameters = first?.node.properties?.parameters ?? {};
    const fields = Object.keys(parameters.properties ?? {})
      .sort()
      .join(",");
    const id = SHARED_PARAMETER_IDS[fields];
    const types = group.map(({ type }) => type);
    if (id === undefined) {
      throw new Error(
        `${types.join(", ")} share one parameters shape with no published definition; add "${fields}" to SHARED_PARAMETER_IDS`,
      );
    }
    const earlier = spelled.get(id);
    if (earlier !== undefined) {
      throw new Error(
        `${id} is spelled two ways: by ${earlier.join(", ")} and by ${types.join(", ")}; one published definition cannot carry both`,
      );
    }
    spelled.set(id, types);
    for (const type of types) {
      shared.set(type, id);
    }
    emitter.consts.set(id, emitter.object(parameters, `${first?.path}.parameters`, { id }));
  }
  const rows = variants.map(({ type, node, path }) =>
    emitter.object(node, path, {
      id: `Rule<${type}>`,
      field: (name, child, childPath) =>
        name === "parameters" && child.$ref === undefined
          ? (shared.get(type) ?? `${emitter.object(child, childPath)}${described(child)}`)
          : undefined,
    }),
  );
  const consts = [...emitter.consts].map(([name, body]) => `const ${name} = ${body};`);
  return `${header("The ruleset rule rows of GitHub's OpenAPI")}
import { z } from "zod";

${consts.join("\n\n")}

/** One row per rule type the descriptor's rulesets POST and PUT take, in the descriptor's order; parameters are
 * typed and described as it types and describes them, so a wrong casing or bound is refused at parse instead of
 * coming back as a 422, and the published schema carries GitHub's own words where the docs file adds none. */
export const SPEC_RULES = [
${rows.map((row) => `  ${row},`).join("\n")}
] as const;
`;
}

// --- Vocabularies -------------------------------------------------------------------------------------------------

export const ENUMS_PATH = "src/generated/spec-enums.ts";

const REPO = "/repos/{owner}/{repo}";

/** The request body of a route's method, through its `$ref` where the body is one. */
const body = (method: string, route: string) =>
  ["paths", `${REPO}${route}`, method, "requestBody", ...JSON_BODY] as const;

const schema = (name: string) => ["components", "schemas", name] as const;

const REPO_PATCH = body("patch", "");

/**
 * The string enums the sections refuse by, each rendered as a readonly tuple in the descriptor's order (the order a
 * refusal's "expected one of" lists and the published schema's enum carry). A GET's vocabulary stands in where the
 * write body types the field as a bare string; the importing section says so.
 */
const SPEC_ENUMS: ReadonlyArray<{ readonly name: string; readonly path: readonly string[] }> = [
  {
    name: "REVIEWER_TYPES",
    path: [
      ...REPO_PATCH,
      "properties",
      "security_and_analysis",
      "properties",
      "secret_scanning_delegated_bypass_options",
      "properties",
      "reviewers",
      "items",
      "properties",
      "reviewer_type",
    ],
  },
  {
    name: "REVIEWER_MODES",
    path: [
      ...REPO_PATCH,
      "properties",
      "security_and_analysis",
      "properties",
      "secret_scanning_delegated_bypass_options",
      "properties",
      "reviewers",
      "items",
      "properties",
      "mode",
    ],
  },
  {
    name: "FEATURE_STATUSES",
    path: [
      ...schema("security-and-analysis"),
      "properties",
      "advanced_security",
      "properties",
      "status",
    ],
  },
  {
    name: "SQUASH_MERGE_COMMIT_TITLES",
    path: [...REPO_PATCH, "properties", "squash_merge_commit_title"],
  },
  {
    name: "SQUASH_MERGE_COMMIT_MESSAGES",
    path: [...REPO_PATCH, "properties", "squash_merge_commit_message"],
  },
  { name: "MERGE_COMMIT_TITLES", path: [...REPO_PATCH, "properties", "merge_commit_title"] },
  { name: "MERGE_COMMIT_MESSAGES", path: [...REPO_PATCH, "properties", "merge_commit_message"] },
  {
    name: "PULL_REQUEST_CREATION_POLICIES",
    path: [...REPO_PATCH, "properties", "pull_request_creation_policy"],
  },
  { name: "ALLOWED_ACTIONS", path: schema("allowed-actions") },
  { name: "DEFAULT_WORKFLOW_PERMISSIONS", path: schema("actions-default-workflow-permissions") },
  {
    name: "ACCESS_LEVELS",
    path: [...body("put", "/actions/permissions/access"), "properties", "access_level"],
  },
  {
    name: "APPROVAL_POLICIES",
    path: [
      ...body("put", "/actions/permissions/fork-pr-contributor-approval"),
      "properties",
      "approval_policy",
    ],
  },
  {
    name: "DEPLOYMENT_BRANCH_POLICY_TYPES",
    path: [...schema("deployment-branch-policy-name-pattern-with-type"), "properties", "type"],
  },
  { name: "DEPLOYMENT_REVIEWER_TYPES", path: schema("deployment-reviewer-type") },
  { name: "RULESET_TARGETS", path: [...body("post", "/rulesets"), "properties", "target"] },
  { name: "RULESET_ENFORCEMENTS", path: schema("repository-rule-enforcement") },
  { name: "INTERACTION_GROUPS", path: schema("interaction-group") },
  { name: "INTERACTION_EXPIRIES", path: schema("interaction-expiry") },
  { name: "PAGES_BUILD_TYPES", path: [...body("put", "/pages"), "properties", "build_type"] },
  {
    name: "PAGES_SOURCE_PATHS",
    path: [...body("put", "/pages"), "properties", "source", "anyOf", "1", "properties", "path"],
  },
  { name: "MILESTONE_STATES", path: [...body("post", "/milestones"), "properties", "state"] },
  {
    name: "CODE_SCANNING_STATES",
    path: [...schema("code-scanning-default-setup-update"), "properties", "state"],
  },
  {
    name: "CODE_SCANNING_QUERY_SUITES",
    path: [...schema("code-scanning-default-setup-update"), "properties", "query_suite"],
  },
  {
    name: "CODE_SCANNING_RUNNER_TYPES",
    path: [...schema("code-scanning-default-setup-update"), "properties", "runner_type"],
  },
  {
    name: "CODE_SCANNING_THREAT_MODELS",
    path: [...schema("code-scanning-default-setup-update"), "properties", "threat_model"],
  },
  {
    name: "CODE_QUALITY_STATES",
    path: [...schema("code-quality-setup-update"), "properties", "state"],
  },
  {
    name: "CODE_QUALITY_RUNNER_TYPES",
    path: [...schema("code-quality-setup-update"), "properties", "runner_type"],
  },
  {
    name: "CODE_QUALITY_AI_FINDINGS_OPTIONS",
    path: [...schema("code-quality-setup-update"), "properties", "ai_findings_option"],
  },
];

/** An integer's `minimum` and `maximum`, both required: a section spells its own refusal with the two numbers. */
const SPEC_BOUNDS: ReadonlyArray<{ readonly name: string; readonly path: readonly string[] }> = [
  {
    name: "MAX_OPEN_PULL_REQUESTS",
    path: [
      ...body("patch", "/interaction-limits/pulls/creation-cap"),
      "properties",
      "max_open_pull_requests",
    ],
  },
];

/**
 * The small bodies a section sends to GitHub verbatim, each one zod const: typed and described as the descriptor
 * types and describes it, with the published id where the schema publishes one (an inlined shape takes the
 * descriptor's own prose). The refusals the descriptor cannot express are the section's, attached at the import.
 */
const SPEC_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly id?: string;
  readonly path: readonly string[];
  readonly objects: Objects;
}> = [
  { name: "SelectedActions", path: schema("selected-actions"), objects: "strict" },
  {
    name: "ForkPrWorkflowsPrivateRepos",
    path: body("put", "/actions/permissions/fork-pr-workflows-private-repos"),
    objects: "loose",
  },
  {
    name: "DeploymentBranchPolicyFlags",
    path: schema("deployment-branch-policy-settings"),
    objects: "loose",
  },
  {
    name: "BypassActorConfig",
    id: "BypassActorConfig",
    path: schema("repository-ruleset-bypass-actor"),
    objects: "loose",
  },
  { name: "RulesetConditions", path: schema("repository-ruleset-conditions"), objects: "loose" },
];

export function boundsAt(
  descriptor: Descriptor,
  path: readonly string[],
): { min: number; max: number } {
  const node = nodeAt(descriptor, path);
  const dotted = path.join(".");
  if (node.type !== "integer") {
    throw new Error(`${dotted} is not an integer`);
  }
  // A keyword beside the bounds (a multipleOf) would narrow what the pair admits with nothing in the render to say so.
  checkedType(node, dotted);
  const { minimum: min, maximum: max } = node;
  if (typeof min !== "number" || typeof max !== "number") {
    throw new Error(`${dotted} carries no minimum and maximum`);
  }
  return { min, max };
}

export function renderEnums(descriptor: Descriptor): string {
  const enums = SPEC_ENUMS.map(
    ({ name, path }) =>
      `export const ${name} = [${stringList(enumAt(descriptor, path))}] as const;`,
  );
  const bounds = SPEC_BOUNDS.map(({ name, path }) => {
    const { min, max } = boundsAt(descriptor, path);
    return `export const ${name} = { minimum: ${min}, maximum: ${max} } as const;`;
  });
  const shapes = SPEC_SHAPES.map(({ name, id, path, objects }) => {
    const node = nodeAt(descriptor, path);
    const dotted = path.join(".");
    // One emitter per body: none references a component, so no const is shared between two of them.
    const emitter = new ZodEmitter(descriptor, { objects, abort: false });
    const own =
      id === undefined
        ? `${emitter.object(node, dotted)}${described(node)}`
        : emitter.object(node, dotted, { id });
    if (emitter.consts.size > 0) {
      throw new Error(
        `${dotted} references ${[...emitter.consts.keys()].join(", ")}; a body renders alone`,
      );
    }
    return `export const ${name} = ${own};`;
  });
  return `${header("The passthrough vocabularies, bounds, and bodies of GitHub's OpenAPI")}
import { z } from "zod";

${enums.join("\n\n")}

${bounds.join("\n\n")}

${shapes.join("\n\n")}
`;
}

// --- Outputs ------------------------------------------------------------------------------------------------------

export const OUTPUTS: ReadonlyArray<{
  readonly path: string;
  readonly render: (descriptor: Descriptor) => string;
}> = [
  { path: ROLES_PATH, render: renderRoles },
  { path: RULES_PATH, render: renderRules },
  { path: ENUMS_PATH, render: renderEnums },
];

/** The lint judges the committed output like hand-written code, so it is formatted as biome formats a file at `path`. */
export function formatted(path: string, text: string): string {
  const biome = Bun.spawnSync(
    [join(ROOT, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${path}`],
    { cwd: ROOT, stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" },
  );
  if (biome.exitCode !== 0) {
    throw new Error(`biome refused the rendered ${path}:\n${biome.stderr.toString()}`);
  }
  return biome.stdout.toString();
}

export function render(output: (typeof OUTPUTS)[number], descriptor: Descriptor): string {
  return formatted(output.path, output.render(descriptor));
}

if (import.meta.main) {
  await runMain("gen-openapi", () => {
    const descriptor = loadDescriptor();
    for (const output of OUTPUTS) {
      writeFileSync(join(ROOT, output.path), render(output, descriptor));
      console.log(`wrote ${output.path}`);
    }
  });
}

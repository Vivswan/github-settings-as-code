/**
 * Refusal messages are user experience: every sentence a user can read when the settings file is refused at parse
 * time is pinned by a test that spells it, so a wording change is a deliberate test change and a new refusal cannot
 * ship unpinned. The message literals are read off the source AST (oxc-parser, walked with estree-walker), never by
 * regex over source text, and each must appear, cooked, inside a string of some test under test/ (a .ts literal or
 * template, or a scenario's expect lists). The failure names the source file, the line, and the literal.
 *
 * Every string literal in a section schema slice, a shared schema helper, or compilable-form.ts is a refusal message
 * unless its position is in the listed exclusions (DATA_CONSTANTS by name, keys, specifiers, type positions,
 * vocabulary calls); in section modules, module.ts, repo-secrets.ts, and problem.ts, every literal inside a
 * message-shaped object ({path, message}), an error:/consequence: property, or an issue-builder body is a message.
 * No reach or helper analysis: a literal cannot hide from a file scan, so a spelling the census does not follow is
 * not a class it has to learn.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walk as walkTree } from "estree-walker";
import { parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** The shape every oxc node shares; estree-walker finds the children by the fields that carry a `type`. */
interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface TemplateElement extends Node {
  readonly value: { readonly cooked: string | null; readonly raw: string };
}

/** How a source file is read: every literal (a slice, a helper), or only its message positions (a module). */
type Sites = "every-literal" | "message-positions";

export interface Source {
  readonly path: string;
  readonly text: string;
  readonly sites: Sites;
}

/**
 * One message literal. A whole literal that is not prose (a terse word) is pinned only as the whole message of a
 * rendered line; a piece of a template or a `+` chain, and prose, by containment.
 */
interface Fragment {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly whole: boolean;
}

/** Prose: long enough to be a clause and holding a space. A shorter whole literal is a terse message, pinned whole. */
const MIN_PROSE_LENGTH = 16;

const INVARIANT_PREFIX = "BUG:";

/**
 * The exclusions, each a syntactic position a string literal can sit in and not be a message; the planted control
 * below carries one literal per position. Every other literal of a literal-first source is a message.
 *
 *   property key                 `{ "error": ... }`, the key itself
 *   module specifier             `import { z } from "zod"`
 *   type position                a literal type, an annotation
 *   vocabulary call              argument 0 of `z.enum([...])`, `z.literal("web")`, `.default("branch")`, `.includes("<num>")`
 *   value method                 `.split(",")`, `.join(", ")`, `.startsWith("-----BEGIN")`, `new RegExp("...")`, `new Set([...])`
 *   comparison or case           `name === ""`, `case "boolean":`
 *   data field                   `path: ["key"]`, `code: "custom"`, `id: "LabelConfig"`, `route: "GET ..."`
 *   as const vocabulary          `["a", "b"] as const`, reached through arrays, objects, and properties only
 *   schema twin                  the argument of `.meta({...})` or `conditional(...)`, a JSON Schema mirror of a refinement
 *   regex source                 a `String.raw` template
 *   invariant                    a "BUG:" message for the developer holding the stack
 *   DATA_CONSTANTS               a named constant holding a key, a pattern piece, or a vocabulary; prose inside one is a message
 *   DATA_FUNCTIONS               a function that assembles regex source
 *   DATA_ARGUMENTS               a data argument of a local factory (`bareRule("creation")`)
 */
const VOCABULARY_CALLS: ReadonlySet<string> = new Set([
  "enum",
  "discriminatedUnion",
  "literal",
  "default",
  "prefault",
  "catch",
  "describe",
  "meta",
  "brand",
  "includes",
  "startsWith",
  "endsWith",
]);

const VALUE_METHODS: ReadonlySet<string> = new Set([
  "split",
  "join",
  "replace",
  "replaceAll",
  "indexOf",
  "lastIndexOf",
  "padStart",
  "padEnd",
  "repeat",
  "has",
  "get",
  "hasOwn",
  "test",
  "exec",
  "encode",
  "RegExp",
  "Set",
  "Map",
  "Error",
]);

/** The fields of an issue, a route table, or an actor table that carry data, never text a user reads as a message. */
const DATA_FIELDS: ReadonlySet<string> = new Set([
  "path",
  "key",
  "code",
  "id",
  "kind",
  "type",
  "route",
  "field",
  "nameKey",
  "example",
  "form",
  "syntax",
  "params",
  "statuses",
  "phase",
  "accessGrade",
  "notFound",
  "primaryRead",
  "check",
  "text",
]);

/** The calls whose object argument is a JSON Schema twin of a refinement: keys and enum values, never text. */
const SCHEMA_TWIN_CALLS: ReadonlySet<string> = new Set(["meta", "conditional"]);

/** The functions of compilable-form.ts that assemble regex source: every literal in them is a pattern piece. */
const DATA_FUNCTIONS: ReadonlySet<string> = new Set(["render", "codePointEscape"]);

/**
 * The local factories and helpers whose string arguments are data (a key name, a rule type, a failure code, a size
 * measure, a definition id), by argument index, and those whose string arguments are pieces a longer message is
 * composed from (pinned by containment). Auditable by name; a control below fails naming an entry no source declares
 * or imports.
 */
const DATA_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  actorList: [0, 1],
  reviewActorHolder: [0],
  bareRule: [0],
  rule: [0],
  patternRule: [0],
  ruleId: [0],
  sectionFailure: [0],
  boundedString: [1],
  sealedSecretConfig: [0],
  variableConfig: [0],
};

const PIECE_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  closedKeyError: [0],
  identifiedBy: [2],
  duplicateFieldIssues: [2],
  duplicateIssues: [2],
  duplicateVariableNameIssues: [1],
  duplicateSecretNameIssues: [1],
  holderError: [0],
  commitMessageFamily: [0, 1],
  githubName: [0],
  renamedKeyError: [0, 1, 2, 3],
};

/**
 * The named constants of the literal-first sources whose string literals are data, not messages: key names,
 * vocabularies, and pattern pieces. A prose-length literal inside one is still a message. Auditable: every entry is
 * a name a reader can open, and a control below fails naming one no source declares.
 */
const DATA_CONSTANTS: ReadonlySet<string> = new Set([
  // shared/schema-helpers.ts
  "UNDECLARED_POLICIES",
  "LAYERINGS",
  // shared/setup-schema.ts
  "GET_ONLY_KEYS",
  // shared/roles.ts
  "ROLE_FOR_PERMISSION",
  "STANDARD_PERMISSIONS",
  "INVITATION_ROLES",
  "DEFAULT_ROLE",
  // branches/schema.ts
  "ACTOR_LIST_EXAMPLE",
  "PROTECTION_MAPPING_KEYS",
  // deploy_keys/schema.ts
  "PUBLIC_KEY_ALGORITHMS",
  "BASE64_QUARTET",
  "BASE64_BLOB",
  "FIELD_SEPARATOR",
  "PRIVATE_KEY_FRAMING",
  // interaction_limits/schema.ts
  "INTERACTION_GROUPS",
  "INTERACTION_EXPIRIES",
  // repository/schema.ts
  "GET_ONLY_KEYS",
  "SECTION_OWNED_KEYS",
  "REVIEWER_TYPES",
  "REVIEWER_MODES",
  "COMMIT_MESSAGE_VOCABULARIES",
  "SQUASH_COMMIT_PAIRS",
  "TOPIC_GRAMMAR",
  "CREATION_POLICIES",
  // rulesets/schema.ts
  "REF_NAME_TOKENS",
  "REF_NAME_ILLEGAL",
  "BYPASS_ACTOR_TYPES",
  "IDENTIFIED_ACTOR_TYPES",
  "PATTERN_OPERATORS",
  // actions/schema.ts
  "REPORTED_ONLY",
  // code_quality_setup, code_scanning_default_setup
  "CODE_QUALITY_LANGUAGES",
  "CODE_SCANNING_LANGUAGES",
  // compilable-form.ts
  "GROUP_NAME",
  "GROUP_REWRITES",
  "CODE_POINT_ESCAPES",
  // secret_scanning_custom_patterns/schema.ts
  "REGEX_SYNTAX",
]);

/** A list section's `noun:` at the top level of its declaration names the resource in its duplicate refusal ("names the same label as"). */
const MODULE_NOUN_KEY = "noun";

/** The property keys whose value is a message: zod's `error`, an issue's `message`, the closed-surface `consequence`. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["message", "error", "consequence", "legal"]);

/** The issue builders of src/problem.ts, by name; their bodies are message positions. */
const ISSUE_BUILDER = /Issue$/;

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** The test functions whose first argument is a title, not a string a user reads. */
const TEST_FUNCTIONS: ReadonlySet<string> = new Set(["test", "describe", "it"]);

const SHARED_REFUSAL_HELPERS = [
  "schema-helpers",
  "setup-schema",
  "roles",
  "renamed-key",
  "raw-values",
];

function field<T>(node: Node, name: string): T {
  return (node as unknown as Record<string, T>)[name] as T;
}

/** The visitor's view of a step: the node, its parent, and the parent's field it sits in. */
interface Step {
  readonly node: Node;
  readonly parent: Node | null;
  readonly key: string | undefined;
}

/** Depth-first over the tree; `enter` returns false to leave a subtree unread. */
function walk(
  root: Node,
  enter: (step: Step) => boolean | undefined,
  leave?: (node: Node) => void,
): void {
  walkTree(root as never, {
    enter(node, parent, key) {
      const step: Step = {
        node: node as unknown as Node,
        parent: parent as unknown as Node | null,
        key: typeof key === "string" ? key : undefined,
      };
      if (enter(step) === false) {
        this.skip();
      }
    },
    leave(node) {
      leave?.(node as unknown as Node);
    },
  });
}

function isProse(text: string): boolean {
  return text.length >= MIN_PROSE_LENGTH && text.includes(" ");
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function isStringLiteral(node: Node): boolean {
  return node.type === "Literal" && typeof field(node, "value") === "string";
}

function isConcatenation(node: Node): boolean {
  return node.type === "BinaryExpression" && field<string>(node, "operator") === "+";
}

/** The name of a non-computed property key, or of a member expression's property. */
function keyName(node: Node): string | undefined {
  if (field<boolean>(node, "computed") === true) {
    return undefined;
  }
  const key = field<Node>(node, node.type === "Property" ? "key" : "property");
  if (key.type === "Identifier") {
    return field<string>(key, "name");
  }
  return isStringLiteral(key) ? field<string>(key, "value") : undefined;
}

/** The method a call invokes (`enum` in `z.enum(...)`, `RegExp` in `new RegExp(...)`), or undefined. */
function calledName(call: Node): string | undefined {
  const callee = field<Node>(call, "callee");
  if (callee.type === "MemberExpression") {
    return keyName(callee);
  }
  return callee.type === "Identifier" ? field<string>(callee, "name") : undefined;
}

/** The name a variable declarator binds, when it is one identifier. */
function declaredName(declarator: Node): string | undefined {
  const id = field<Node>(declarator, "id");
  return id.type === "Identifier" ? field<string>(id, "name") : undefined;
}

/**
 * Why a literal at this step is not a message, or undefined when it is one. `ancestors` is the chain from the root
 * down to the literal's parent.
 */
function exclusion(step: Step, ancestors: readonly Step[]): string | undefined {
  const { parent, key } = step;
  if (parent === null) {
    return undefined;
  }
  let twin = false;
  let constVocabulary = false;
  if (parent.type === "Property" && key === "key") {
    return "property key";
  }
  if (parent.type.startsWith("Import") || parent.type.startsWith("Export")) {
    return "module specifier";
  }
  if (parent.type === "TaggedTemplateExpression" && isStringRaw(field<Node>(parent, "tag"))) {
    return "regex source";
  }
  if (parent.type === "SwitchCase") {
    return "case label";
  }
  // The receiver of a value method (`"(|^$".includes(x)`, `["a", "b"].join(", ")`) is data, whatever the argument.
  if (parent.type === "MemberExpression" && key === "object") {
    const method = field<Node>(parent, "property");
    const name = method.type === "Identifier" ? field<string>(method, "name") : undefined;
    if (name !== undefined && (VALUE_METHODS.has(name) || VOCABULARY_CALLS.has(name))) {
      return `value method receiver ${name}`;
    }
  }
  if (
    parent.type === "BinaryExpression" &&
    ["===", "!==", "==", "!=", "in"].includes(field<string>(parent, "operator"))
  ) {
    return "comparison";
  }
  if (parent.type === "Property" && key === "value" && DATA_FIELDS.has(keyName(parent) ?? "")) {
    return `data field ${keyName(parent)}`;
  }
  ancestors.forEach(({ node }, index) => {
    // The step below this ancestor: the literal's own step when the ancestor is the parent.
    const below = ancestors[index + 1] ?? step;
    if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      SCHEMA_TWIN_CALLS.has(calledName(node) ?? "") &&
      below.key === "arguments"
    ) {
      twin = true;
    }
  });
  if (twin) {
    return "schema twin";
  }
  ancestors.forEach(({ node }, index) => {
    if (node.type === "TSAsExpression" && isConstAssertion(node)) {
      const between = ancestors.slice(index + 1).map(({ node: inner }) => inner.type);
      if (
        between.every((type) =>
          ["ArrayExpression", "ObjectExpression", "Property"].includes(type),
        ) &&
        !holdsProse(step.node)
      ) {
        constVocabulary = true;
      }
    }
  });
  if (constVocabulary) {
    return "as const vocabulary";
  }
  for (const { node } of ancestors) {
    if (
      node.type.startsWith("TS") &&
      ![
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSTypeAssertion",
        "TSNonNullExpression",
      ].includes(node.type)
    ) {
      return "type position";
    }
    if (
      node.type === "VariableDeclarator" &&
      DATA_CONSTANTS.has(declaredName(node) ?? "") &&
      !holdsProse(step.node)
    ) {
      return `data constant ${declaredName(node)}`;
    }
    if (node.type === "FunctionDeclaration" && DATA_FUNCTIONS.has(functionName(node) ?? "")) {
      return `data function ${functionName(node)}`;
    }
  }
  // The literal's holder past any array nesting: a data field, or the call it is an argument of (directly, or as
  // the receiver of a value method such as `["a", "b"].join(" ")`).
  let depth = ancestors.length - 1;
  while (depth >= 0 && ancestors[depth]?.node.type === "ArrayExpression") {
    depth -= 1;
  }
  const holder = ancestors[depth];
  if (holder === undefined) {
    return undefined;
  }
  if (holder.node.type === "Property" && DATA_FIELDS.has(keyName(holder.node) ?? "")) {
    return `data field ${keyName(holder.node)}`;
  }
  const call =
    holder.node.type === "MemberExpression" && ancestors[depth - 1]?.node.type === "CallExpression"
      ? ancestors[depth - 1]?.node
      : holder.node;
  if (call === undefined || (call.type !== "CallExpression" && call.type !== "NewExpression")) {
    return undefined;
  }
  const name = calledName(call) ?? "";
  const argument = ancestors[depth + 1]?.node ?? step.node;
  const index = field<readonly Node[]>(call, "arguments").indexOf(argument);
  if (VOCABULARY_CALLS.has(name) && index === 0) {
    return `vocabulary call ${name}`;
  }
  if (VALUE_METHODS.has(name)) {
    return `value method ${name}`;
  }
  if (DATA_ARGUMENTS[name]?.includes(index)) {
    return `data argument ${name}[${index}]`;
  }
  return undefined;
}

/** Whether a literal (or any piece of a template) is prose: a vocabulary word never is, so prose in a table is a message. */
function holdsProse(node: Node): boolean {
  return textsOf(node).some(({ text }) => isProse(text));
}

/** `String.raw`: the one tag that marks a regex source; any other tag in a message position is a message. */
function isStringRaw(tag: Node): boolean {
  return (
    tag.type === "MemberExpression" &&
    field<Node>(tag, "object").type === "Identifier" &&
    field<string>(field<Node>(tag, "object"), "name") === "String" &&
    keyName(tag) === "raw"
  );
}

function functionName(declaration: Node): string | undefined {
  const id = field<Node | null>(declaration, "id");
  return id === null ? undefined : field<string>(id, "name");
}

/** `[...] as const`: a vocabulary the schema enumerates, never text. */
function isConstAssertion(node: Node): boolean {
  const annotation = field<Node>(node, "typeAnnotation");
  if (annotation.type !== "TSTypeReference") {
    return false;
  }
  const name = field<Node>(annotation, "typeName");
  return name.type === "Identifier" && field<string>(name, "name") === "const";
}

/** Whether the literal is an argument a registered helper composes into a longer message: pinned by containment. */
function isPieceArgument(step: Step): boolean {
  const { parent, node } = step;
  if (parent?.type !== "CallExpression") {
    return false;
  }
  const index = field<readonly Node[]>(parent, "arguments").indexOf(node);
  return PIECE_ARGUMENTS[calledName(parent) ?? ""]?.includes(index) ?? false;
}

/** A literal's message texts: the literal, or the non-blank pieces of a template; a "BUG:" opening is an invariant. */
function textsOf(node: Node): { start: number; text: string; whole: boolean }[] {
  if (isStringLiteral(node)) {
    const value = field<string>(node, "value");
    if (value.trim() === "" || value.startsWith(INVARIANT_PREFIX)) {
      return [];
    }
    return [{ start: node.start, text: value, whole: !isProse(value) }];
  }
  const quasis = field<readonly TemplateElement[]>(node, "quasis");
  const expressions = field<readonly Node[]>(node, "expressions");
  const cooked = (quasi: TemplateElement) => quasi.value.cooked ?? quasi.value.raw;
  if ((cooked(quasis[0] as TemplateElement) ?? "").startsWith(INVARIANT_PREFIX)) {
    return [];
  }
  if (expressions.length === 0) {
    const value = cooked(quasis[0] as TemplateElement);
    return value.trim() === "" ? [] : [{ start: node.start, text: value, whole: !isProse(value) }];
  }
  return quasis
    .filter((quasi) => /[^\s()[\]{}.,;:]/.test(cooked(quasi)))
    .map((quasi) => ({ start: quasi.start, text: cooked(quasi), whole: false }));
}

/** Every message literal under `root`, the exclusions applied at each. */
function literalsUnder(
  root: Node,
  path: string,
  text: string,
  into: Map<number, Fragment>,
  asPiece = false,
): void {
  const ancestors: Step[] = [];
  walk(
    root,
    (step) => {
      const { node, parent } = step;
      if (isStringLiteral(node) || node.type === "TemplateLiteral") {
        const why = exclusion(step, ancestors);
        if (why === undefined) {
          // A piece of a longer message, pinned by containment: an operand of a `+` chain, a literal inside a
          // template hole, an arm of a conditional, a helper's return, a registered piece argument.
          const piece =
            asPiece ||
            ancestors.some(
              ({ node: ancestor }) =>
                isConcatenation(ancestor) || ancestor.type === "TemplateLiteral",
            ) ||
            parent?.type === "ConditionalExpression" ||
            parent?.type === "ReturnStatement" ||
            isPieceArgument(step);
          for (const { start, text: value, whole } of textsOf(node)) {
            if (piece && !/[^\s()[\]{}.,;:]/.test(value)) {
              continue;
            }
            if (!into.has(start)) {
              into.set(start, {
                path,
                line: lineOf(text, start),
                text: value,
                whole: whole && !piece,
              });
            }
          }
        }
        if (node.type === "TemplateLiteral") {
          // The holes are read too: a literal inside one is a piece of this message.
          ancestors.push(step);
          return undefined;
        }
        return false;
      }
      ancestors.push(step);
      return undefined;
    },
    (node) => {
      if (ancestors[ancestors.length - 1]?.node === node) {
        ancestors.pop();
      }
    },
  );
}

/**
 * A module's message positions: an object literal carrying a `message` property (an issue), an `error` or
 * `consequence` property's value, and the value of a top-level constant an `error`/`message` property names (a
 * message function such as WILDCARD_KEY_ERROR). Everything else in a module is plan text and outcomes, out of this
 * census by the owner's ruling (parse refusals only).
 */
function messagePositions(program: Node): { positions: Node[]; pieces: Node[] } {
  const positions: Node[] = [];
  const pieces: Node[] = [];
  const named = new Set<string>();
  const locals: Node[] = [];
  let functionDepth = 0;
  // A live shape (`LiveDeployKey`, the repository's naming for a GET body) reports a response outside the documented
  // API shape, never a settings-file refusal; a transform anywhere else (the routed list shape) is a parse position.
  const liveSpans: Node[] = [];
  walk(program, ({ node }) => {
    if (node.type === "VariableDeclarator" && /^Live/.test(declaredName(node) ?? "")) {
      liveSpans.push(node);
    }
    return undefined;
  });
  walk(
    program,
    ({ node }) => {
      if (
        node.type === "CallExpression" &&
        calledName(node) === "transform" &&
        liveSpans.some((span) => span.start <= node.start && node.end <= span.end)
      ) {
        return false;
      }
      // A registered helper's piece argument (`identifiedBy(key, field, "workflow")`), and a top-level `noun:`.
      if (node.type === "CallExpression") {
        const indexes = PIECE_ARGUMENTS[calledName(node) ?? ""] ?? [];
        const args = field<readonly Node[]>(node, "arguments");
        for (const index of indexes) {
          const argument = args[index];
          if (argument !== undefined) {
            pieces.push(argument);
          }
        }
      }
      if (node.type === "Property" && keyName(node) === MODULE_NOUN_KEY && functionDepth === 0) {
        pieces.push(field<Node>(node, "value"));
      }
      if (FUNCTION_TYPES.has(node.type)) {
        functionDepth += 1;
      }
      if (node.type === "VariableDeclarator") {
        locals.push(node);
      }
      if (node.type === "Property" && MESSAGE_KEYS.has(keyName(node) ?? "")) {
        const value = field<Node>(node, "value");
        positions.push(value);
        walk(value, ({ node: inner }) => {
          if (inner.type === "Identifier") {
            named.add(field<string>(inner, "name"));
          }
          return undefined;
        });
      }
      return undefined;
    },
    (node) => {
      if (FUNCTION_TYPES.has(node.type)) {
        functionDepth -= 1;
      }
    },
  );
  // The constants a message names, at the top level or local to the enclosing function (`beside`), one hop.
  for (const declarator of locals) {
    if (named.has(declaredName(declarator) ?? "")) {
      positions.push(declarator);
    }
  }
  for (const statement of field<readonly Node[]>(program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? field<Node | null>(statement, "declaration")
        : statement;
    if (declaration?.type === "FunctionDeclaration") {
      const name = field<string>(field<Node>(declaration, "id"), "name");
      if (ISSUE_BUILDER.test(name) || named.has(name)) {
        positions.push(declaration);
      }
    }
  }
  return { positions, pieces };
}

/** A message position reaches the top-level constants and functions it names, one hop and no further. */
function builderConstants(program: Node, builders: readonly Node[]): Node[] {
  const named = new Set<string>();
  for (const builder of builders) {
    walk(builder, ({ node }) => {
      if (node.type === "Identifier") {
        named.add(field<string>(node, "name"));
      }
      return undefined;
    });
  }
  const constants: Node[] = [];
  for (const statement of field<readonly Node[]>(program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? field<Node | null>(statement, "declaration")
        : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of field<readonly Node[]>(declaration, "declarations")) {
        if (named.has(declaredName(declarator) ?? "") && !builders.includes(declarator)) {
          constants.push(declarator);
        }
      }
    }
    if (
      declaration?.type === "FunctionDeclaration" &&
      named.has(functionName(declaration) ?? "") &&
      !builders.includes(declaration)
    ) {
      constants.push(declaration);
    }
  }
  return constants;
}

function parse(path: string, text: string): Node {
  const { program, errors } = parseSync(path, text);
  if (errors.length > 0) {
    throw new Error(`${path} does not parse, so its strings cannot be read: ${errors[0]?.message}`);
  }
  return program as unknown as Node;
}

/** Every message literal of the sources, in file order. */
export function messageFragments(sources: Iterable<Source>): Fragment[] {
  const fragments: Fragment[] = [];
  for (const { path, text, sites } of sources) {
    const program = parse(path, text);
    const found = new Map<number, Fragment>();
    if (sites === "every-literal") {
      literalsUnder(program, path, text, found);
    } else {
      const { positions, pieces } = messagePositions(program);
      for (const site of [...positions, ...builderConstants(program, positions)]) {
        literalsUnder(site, path, text, found);
      }
      for (const piece of pieces) {
        literalsUnder(piece, path, text, found, true);
      }
    }
    fragments.push(...[...found.entries()].sort(([a], [b]) => a - b).map(([, f]) => f));
  }
  return fragments;
}

/** `test.each(rows)` is not a title call: its argument is the table, whose rows are assertions. */
function isTestCall(call: Node): boolean {
  let callee = field<Node>(call, "callee");
  if (callee.type === "MemberExpression" && keyName(callee) === "each") {
    return false;
  }
  while (callee.type === "CallExpression" || callee.type === "MemberExpression") {
    callee = field<Node>(callee, callee.type === "CallExpression" ? "callee" : "object");
  }
  return callee.type === "Identifier" && TEST_FUNCTIONS.has(field<string>(callee, "name"));
}

/** A scenario asserts on printed text through the string lists under `expect`; its settings and outcomes are inputs and statuses. */
function scenarioAssertions(scenario: unknown): string[] {
  const expect = (scenario as { expect?: Record<string, unknown> } | null)?.expect;
  return Object.values(expect ?? {}).flatMap((value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
}

/** A literal's value; a template's quasis, and a `+` chain's operands, joined around their holes. */
function spelled(node: Node): string {
  if (isStringLiteral(node)) {
    return field<string>(node, "value");
  }
  if (node.type === "TemplateLiteral") {
    return field<readonly TemplateElement[]>(node, "quasis")
      .map((quasi) => quasi.value.cooked ?? "")
      .join(" ");
  }
  if (isConcatenation(node)) {
    return `${spelled(field<Node>(node, "left"))}${spelled(field<Node>(node, "right"))}`;
  }
  return " ";
}

/**
 * The strings a test asserts on: a template's quasis, and the operands of a `+` chain, joined around their holes, so
 * a pin with the same holes and a pin of the full sentence both contain the source fragment. A test's title describes
 * the case and asserts nothing, so it is left out. A scenario's pins are its `expect` lists.
 */
export function testStrings(path: string, text: string): string[] {
  if (!path.endsWith(".ts")) {
    return scenarioAssertions(parseYaml(text));
  }
  const strings: string[] = [];
  const titles = new Set<Node>();
  walk(parse(path, text), ({ node }) => {
    if (node.type === "CallExpression" && isTestCall(node)) {
      const title = field<readonly Node[]>(node, "arguments")[0];
      if (title !== undefined) {
        titles.add(title);
      }
    }
    if (titles.has(node)) {
      return false;
    }
    if (isStringLiteral(node) || node.type === "TemplateLiteral" || isConcatenation(node)) {
      strings.push(spelled(node));
      return false;
    }
    return undefined;
  });
  return strings;
}

/**
 * Whether a test string pins a fragment. A piece of a message, and prose, are pinned by containment. A whole message
 * that is not prose (terse, or one spaceless word) is a token another test may hold by accident (a role named
 * "probe", the head of zod's own "Invalid input: ..."), so it counts only as the whole message of a rendered line:
 * after the `: ` that follows the key path, and ending the string or the line.
 */
function pinsFragment(pinned: string, fragment: Fragment): boolean {
  if (!fragment.whole) {
    return isProse(fragment.text)
      ? pinned.includes(fragment.text)
      : containsWord(pinned, fragment.text);
  }
  const lead = `: ${fragment.text}`;
  for (let at = pinned.indexOf(lead); at !== -1; at = pinned.indexOf(lead, at + 1)) {
    const after = pinned[at + lead.length];
    if (after === undefined || after === "\n") {
      return true;
    }
  }
  return false;
}

/**
 * Whether `pinned` holds `piece` at word boundaries: "a list" inside "comma list" is not the piece "a list". An edge
 * that is not a word character (a quote, a space, a colon) needs no boundary of its own.
 */
function containsWord(pinned: string, piece: string): boolean {
  const isWord = (character: string | undefined) => character !== undefined && /\w/.test(character);
  const headIsWord = isWord(piece[0]);
  const tailIsWord = isWord(piece[piece.length - 1]);
  for (let at = pinned.indexOf(piece); at !== -1; at = pinned.indexOf(piece, at + 1)) {
    const clearBefore = !headIsWord || !isWord(pinned[at - 1]);
    const clearAfter = !tailIsWord || !isWord(pinned[at + piece.length]);
    if (clearBefore && clearAfter) {
      return true;
    }
  }
  return false;
}

/** The fragments no test string pins, as `path:line: "fragment"` lines. */
export function unpinnedMessages(sources: Iterable<Source>, tests: readonly string[]): string[] {
  return messageFragments(sources)
    .filter((fragment) => !tests.some((pinned) => pinsFragment(pinned, fragment)))
    .map((fragment) => `${fragment.path}:${fragment.line}: ${JSON.stringify(fragment.text)}`);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The refusal sources of this repository, each with the way it is read; a listed file that is gone is a loud failure, never a silent drop. */
export function refusalSources(root: string): Source[] {
  const sources: Source[] = [];
  const add = (path: string, sites: Sites) => {
    if (!existsSync(join(root, path))) {
      throw new Error(
        `${path} is a refusal source of this census but does not exist; a moved or renamed source is listed again under its new path`,
      );
    }
    sources.push({ path, text: read(root, path), sites });
  };
  const sectionDirs = readdirSync(join(root, "src/sections"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of sectionDirs) {
    if (dir === "shared" || dir === "contract") {
      continue;
    }
    add(`src/sections/${dir}/schema.ts`, "every-literal");
    add(`src/sections/${dir}/index.ts`, "message-positions");
  }
  for (const helper of SHARED_REFUSAL_HELPERS) {
    add(`src/sections/shared/${helper}.ts`, "every-literal");
  }
  // The regex check's own reasons render inside the pattern refusal; the RegExp engine's messages pass through unread.
  add("src/sections/secret_scanning_custom_patterns/compilable-form.ts", "every-literal");
  // The environments section's nested lists validate in their own files.
  for (const nested of ["nested", "branch-policies", "protection-rules"]) {
    add(`src/sections/environments/${nested}.ts`, "message-positions");
  }
  add("src/sections/shared/repo-secrets.ts", "message-positions");
  add("src/sections/contract/module.ts", "message-positions");
  add("src/problem.ts", "message-positions");
  return sources;
}

/** Every string spelled by a test under test/, this census excluded (it quotes nothing a user reads). */
export function pinnedStrings(root: string, self: string): string[] {
  return readdirSync(join(root, "test"), { recursive: true })
    .map(String)
    .filter((name) => (name.endsWith(".ts") || name.endsWith(".yml")) && `test/${name}` !== self)
    .sort()
    .flatMap((name) => testStrings(`test/${name}`, read(root, `test/${name}`)));
}

const SELF = "test/sections/refusal-messages.test.ts";

describe("every parse-refusal message a user can read is pinned by a test", () => {
  test("each message literal of the refusal sources appears in a test's strings", () => {
    expect(unpinnedMessages(refusalSources(ROOT), pinnedStrings(ROOT, SELF))).toEqual([]);
  });

  test("the census reads a real number of messages from both kinds of source (control)", () => {
    const sources = refusalSources(ROOT);
    const byKind = (sites: Sites) =>
      messageFragments(sources.filter((source) => source.sites === sites)).length;
    expect(sources.map((source) => source.path)).toContain("src/sections/labels/schema.ts");
    expect(byKind("every-literal")).toBeGreaterThan(250);
    expect(byKind("message-positions")).toBeGreaterThan(20);
  });

  test("every DATA_CONSTANTS name is a constant of some literal-first source, so the exclusion list cannot go stale (control)", () => {
    const declared = new Set<string>();
    for (const source of refusalSources(ROOT).filter((s) => s.sites === "every-literal")) {
      walk(parse(source.path, source.text), ({ node }) => {
        if (node.type === "VariableDeclarator") {
          declared.add(declaredName(node) ?? "");
        }
        return undefined;
      });
    }
    expect([...DATA_CONSTANTS].filter((name) => !declared.has(name))).toEqual([]);
  });

  test("every DATA_ARGUMENTS and PIECE_ARGUMENTS name is a function some census source declares or imports, so the registries cannot go stale (control)", () => {
    const known = new Set<string>();
    for (const source of refusalSources(ROOT)) {
      walk(parse(source.path, source.text), ({ node }) => {
        if (node.type === "FunctionDeclaration") {
          known.add(functionName(node) ?? "");
        }
        if (node.type === "VariableDeclarator") {
          known.add(declaredName(node) ?? "");
        }
        if (node.type === "ImportSpecifier") {
          known.add(field<string>(field<Node>(node, "local"), "name"));
        }
        return undefined;
      });
    }
    const registered = [...Object.keys(DATA_ARGUMENTS), ...Object.keys(PIECE_ARGUMENTS)];
    expect(registered.filter((name) => !known.has(name))).toEqual([]);
  });

  test("a listed source that is gone fails naming its path instead of dropping its messages (control)", () =>
    withTempDir("refusal-sources-", (root) => {
      mkdirSync(join(root, "src/sections/planted"), { recursive: true });
      writeFileSync(join(root, "src/sections/planted/schema.ts"), "export const a = 1;\n");
      expect(() => refusalSources(root)).toThrow(
        /^src\/sections\/planted\/index\.ts is a refusal source of this census but does not exist/,
      );
    }));

  /** One literal per exclusion position, then a message in every spelling a source can give one. */
  const plantedSlice: Source = {
    path: "src/sections/planted/schema.ts",
    text: [
      'import { z } from "zod";',
      'export { a as "renamed" } from "./b.js";',
      'const spec = { "quoted key": 1, code: "custom", path: ["title"], id: "PlantedConfig", route: "GET /repos" };',
      'type Kind = "branch" | "tag";',
      'declare const kind: "branch" | "tag";',
      'const enumerated = z.enum(["open", "closed"]).default("open");',
      'const lit = z.literal("web").includes("<num>");',
      'const parts = list.split(",").join(", ");',
      'const framing = ["PRIVATE", "KEY-----"].join(" ");',
      'if (kind === "tag") { switch (kind) { case "tag": break; } }',
      "const raw = String.raw`[~^: ]|\\.\\.`;",
      'const REF_NAME_TOKENS = ["~ALL", "~DEFAULT_BRANCH"] as const;',
      'const PLANTED_KINDS = { knobbed: { directives: "a planted directive sentence inside an as const table", renamed: true } } as const;',
      'const twin = z.object({}).meta({ anyOf: [{ required: ["contexts"] }] });',
      'const pattern = new RegExp("^[a-z]+$"); const names = new Set(["a", "b"]); const ok = !"(|^$".includes(previous);',
      'function render(): string { return "[^"; }',
      'throw new Error("BUG: a planted invariant names no user");',
      // messages, every spelling
      'export const Word = z.string({ error: "probe" });',
      "export const NoHoles = z.string({ error: `probe2` });",
      `export const Picked = z.string({ error: (issue) => \`\${issue.input === undefined ? "Missing" : "Bad"}\` });`,
      'export const Sized = boundedString(9, "code points", () => "too long");',
      'const reasons = { bad: "probe3", long: "a planted table entry read by property" };',
      "export const Tabled = z.string({ error: reasons.bad }).min(1, reasons.long);",
      'let msg: string; msg = "probe4";',
      'export const Computed = z.string({ ["error"]: "probe5" });',
      "function titled(message: string) { return z.string().min(1, message); }",
      'export const Titled = titled("probe6");',
      `export const Punct = z.string({ error: (issue) => issue.code + ": !!!" });`,
      'export const Cast = z.string({ error: <string>"Color required" });',
      'const callback = { message: () => "probe7" };',
      'for (const m of ["probe8", "probe9"]) { ctx.addIssue({ message: m }); }',
      'const chained = () => helperA(); function helperA() { return helperB(); } function helperB() { return "probe10"; }',
      `export const Holes = z.string().min(1, { error: (issue) => \`\${issue.input}: too short\` });`,
      'export const Plus = z.string({ error: "Please " + "enter text" });',
      "export const Tagged = z.string({ error: plantedTag`probe tagged` });",
      'const KNOWN = [rule("creation", { error: "a planted rule message" })] as const;',
      'export const Picked2 = z.enum(["open", "closed"], "Please pick a planted state").or(z.literal("web", "probe lit"));',
      `const RULE = \`a planted key holds only \${WHAT}; remove the other characters\`;`,
      'const PLANTED_ESCAPES = [[/^\\\\q/, "a planted reason for a q escape"]];',
      'const GET_ONLY_KEYS = ["node_id", "a planted sentence inside a data constant"];',
    ].join("\n"),
    sites: "every-literal",
  };

  const plantedModule: Source = {
    path: "src/sections/planted/index.ts",
    text: [
      `const WHY = (key: string) => \`the key \${key} would silently do nothing on this endpoint\`;`,
      'const ROUTE = "GET /repos/{owner}/{repo}/planted listing every entry";',
      'const note = "a planted plan note, outside the census by the owner ruling";',
      'const outcome = { describe: "planted setting applied" };',
      'const LivePlanted = z.object({}).transform((live, ctx) => { ctx.addIssue({ code: "custom", message: "a live planted body is not a document refusal" }); });',
      'function routedPlanted() { const beside = flag ? "an optional planted directive" : "a planted policy";',
      `  return z.custom(() => true).transform((value, ctx) => { ctx.addIssue({ code: "custom", message: \`a planted routed shape refusal (and \${beside})\`, params: { legal: "a planted legal form" } }); }); }`,
      'function malformedListIssues(): DeclaredIssue[] { return [{ path: "[0].value", message: "an empty list is not a value" }]; }',
      'function plantedWhy(): string { return "probe why"; }',
      `function plantedNested(entries: unknown[], envName: string) { return duplicateFieldIssues(entries, { field: "name" }, \`planted rule of the "\${envName}" environment\`); }`,
      'function planted(): void { const inner = { noun: "a nested planted noun, plan text" }; }',
      "export const section = {",
      '  ...identifiedBy("planted", "name", "planted thing"),',
      '  noun: "planted noun",',
      '  validate: (label: string) => [{ path: "[0].key", message: WHY(label) }, { path: "[1].key", message: "probe" }, { path: "[2].key", message: plantedWhy() }, ...malformedListIssues()],',
      '  shape: loosen(z.object({ title: z.string({ error: "Please declare a title" }) })),',
      '  closedSurface: { consequence: "the planted body carries only the name", other: { consequence: "drops keys" } },',
      '  endpoints: { list: { statuses: { 200: "the planted list, which no refusal quotes" } } },',
      "};",
    ].join("\n"),
    sites: "message-positions",
  };

  const plantedProblem: Source = {
    path: "src/problem.ts",
    text: [
      'const ADVICE = "Remove the planted key, or keep the note as a YAML comment";',
      'function describePlantedShape(value: unknown): string { return Array.isArray(value) ? "a list" : "a mapping"; }',
      "export function plantedIssue(unknown: string, actual: unknown): string {",
      `  return \`unknown planted key: \${unknown}; got \${describePlantedShape(actual)}. \${ADVICE}\`;`,
      "}",
      'function describeOther(): string { return "not a document refusal, not read here"; }',
    ].join("\n"),
    sites: "message-positions",
  };

  const planted = [plantedSlice, plantedModule, plantedProblem];

  test("every planted message is a finding by construction, whatever its spelling; every planted exclusion is silent (control)", () => {
    const prose = testStrings(
      "test/prose.test.ts",
      [
        'const note = "the preflight probe found nothing"; const other = "no probes here";',
        'const longer = "planted.key: probe: expected string, received number";',
        'const split = "planted.key: probe" + ": expected string, received number";',
        'const inside = "prefix-probe6-suffix";',
        'test("does not remove the other characters", () => {});',
        'describe.each([1])("the planted body carries only the name %s", () => {});',
      ].join("\n"),
    );
    expect(unpinnedMessages(planted, prose)).toEqual([
      'src/sections/planted/schema.ts:13: "a planted directive sentence inside an as const table"',
      'src/sections/planted/schema.ts:18: "probe"',
      'src/sections/planted/schema.ts:19: "probe2"',
      'src/sections/planted/schema.ts:20: "Missing"',
      'src/sections/planted/schema.ts:20: "Bad"',
      'src/sections/planted/schema.ts:21: "too long"',
      'src/sections/planted/schema.ts:22: "probe3"',
      'src/sections/planted/schema.ts:22: "a planted table entry read by property"',
      'src/sections/planted/schema.ts:24: "probe4"',
      'src/sections/planted/schema.ts:25: "probe5"',
      'src/sections/planted/schema.ts:27: "probe6"',
      'src/sections/planted/schema.ts:28: ": !!!"',
      'src/sections/planted/schema.ts:29: "Color required"',
      'src/sections/planted/schema.ts:30: "probe7"',
      'src/sections/planted/schema.ts:31: "probe8"',
      'src/sections/planted/schema.ts:31: "probe9"',
      'src/sections/planted/schema.ts:32: "probe10"',
      'src/sections/planted/schema.ts:33: ": too short"',
      'src/sections/planted/schema.ts:34: "Please "',
      'src/sections/planted/schema.ts:34: "enter text"',
      'src/sections/planted/schema.ts:35: "probe tagged"',
      'src/sections/planted/schema.ts:36: "a planted rule message"',
      'src/sections/planted/schema.ts:37: "Please pick a planted state"',
      'src/sections/planted/schema.ts:37: "probe lit"',
      'src/sections/planted/schema.ts:38: "a planted key holds only "',
      'src/sections/planted/schema.ts:38: "; remove the other characters"',
      'src/sections/planted/schema.ts:39: "a planted reason for a q escape"',
      'src/sections/planted/schema.ts:40: "a planted sentence inside a data constant"',
      'src/sections/planted/index.ts:1: "the key "',
      'src/sections/planted/index.ts:1: " would silently do nothing on this endpoint"',
      'src/sections/planted/index.ts:6: "an optional planted directive"',
      'src/sections/planted/index.ts:6: "a planted policy"',
      'src/sections/planted/index.ts:7: "a planted routed shape refusal (and "',
      'src/sections/planted/index.ts:7: "a planted legal form"',
      'src/sections/planted/index.ts:8: "an empty list is not a value"',
      'src/sections/planted/index.ts:9: "probe why"',
      'src/sections/planted/index.ts:10: "planted rule of the \\""',
      'src/sections/planted/index.ts:10: "\\" environment"',
      'src/sections/planted/index.ts:13: "planted thing"',
      'src/sections/planted/index.ts:14: "planted noun"',
      'src/sections/planted/index.ts:15: "probe"',
      'src/sections/planted/index.ts:16: "Please declare a title"',
      'src/sections/planted/index.ts:17: "the planted body carries only the name"',
      'src/sections/planted/index.ts:17: "drops keys"',
      'src/problem.ts:1: "Remove the planted key, or keep the note as a YAML comment"',
      'src/problem.ts:2: "a list"',
      'src/problem.ts:2: "a mapping"',
      'src/problem.ts:4: "unknown planted key: "',
      'src/problem.ts:4: "; got "',
    ]);
  });

  test("the same messages pinned as a full sentence, a template with the same holes, or a + chain pass (control)", () => {
    const pins = testStrings(
      "test/planted.test.ts",
      [
        "const full = 'planted.key: a planted key holds only letters; remove the other characters';",
        'const terse = ["planted.key: probe", "planted.key: probe2", "planted.key: Missing", "planted.key: Bad"];',
        'const more = "planted.key: code points\\nplanted.key: too long\\nplanted.key: probe3\\nplanted.key: probe4";',
        'const rest = "planted.key: probe5\\nplanted.key: probe6\\nplanted.key: custom: !!!\\nplanted.key: Color required";',
        'const fns = "planted.key: probe7\\nplanted.key: probe8\\nplanted.key: probe9\\nplanted.key: probe10";',
        `const holes = \`planted.key: one raw word\\nplanted.key: \${input}: too short\`;`,
        'const pieces = "planted.key: " + "Please enter text";',
        'const table = "planted.key: a planted table entry read by property";',
        'const reason = "planted[0].pattern: cannot be compiled (a planted reason for a q escape)";',
        'const constant = "planted.key: a planted sentence inside a data constant";',
        `const templated = (key: string) => \`the key \${key} would silently do nothing on this endpoint\`;`,
        'const clause = "the planted body carries only the name";',
        'const inline = "planted[0].title: Please declare a title";',
        'const shaped = "planted[0].value: an empty list is not a value";',
        'const routed = "planted: a planted routed shape refusal (and an optional planted directive); planted: a planted routed shape refusal (and a planted policy)";',
        'const legal = "planted has no empty state; write a planted legal form";',
        'const directive = "labels: Unrecognized key; a planted directive sentence inside an as const table";',
        'const why = "planted[2].key: probe why";',
        `const nouns = \`"x" names the same planted thing as "y"; planted noun; planted rule of the "prod" environment\`;`,
        'const narrowed = "planted.key: probe tagged\\nplanted.key: a planted rule message\\nplanted.key: Please pick a planted state\\nplanted.key: probe lit";',
        'const shapes = "got a list; got a mapping";',
        "const sealed = 'planted[0] (name \"x\"): drops keys';",
        `const advice = \`unknown planted key: \${name}; got \${shape}. Remove the planted key, or keep the note as a YAML comment\`;`,
      ].join("\n"),
    );
    expect(unpinnedMessages(planted, pins)).toEqual([]);
  });

  test("a scenario pins a message through its expect lists; its settings and outcomes do not (control)", () => {
    const inputsOnly = testStrings(
      "test/planted/scenarios/inputs.yml",
      "settings:\n  planted:\n    - key: probe\nexpect:\n  outcomes:\n    planted: probe2\n",
    );
    expect(unpinnedMessages([plantedSlice], inputsOnly)).toContain(
      'src/sections/planted/schema.ts:18: "probe"',
    );
    const scenario = [
      "expect:",
      "  stdout_contains:",
      "    - 'planted.key: probe'",
      '    - "planted.key: probe2"',
      "",
    ].join("\n");
    const pins = testStrings("test/planted/scenarios/planted.yml", scenario);
    const left = unpinnedMessages([plantedSlice], pins);
    expect(left).not.toContain('src/sections/planted/schema.ts:18: "probe"');
    expect(left).not.toContain('src/sections/planted/schema.ts:19: "probe2"');
  });

  test("a source that does not parse fails naming it instead of reading as pinned (control)", () => {
    const broken: Source = {
      path: "src/broken.ts",
      text: "const x = ;",
      sites: "every-literal",
    };
    expect(() => unpinnedMessages([broken], [])).toThrow(
      /^src\/broken\.ts does not parse, so its strings cannot be read: /,
    );
  });
});

/**
 * Each proof brand is minted at ONE site, the validator's success return, and every other value carrying it is read
 * off that document: the validated brand (ValidatedInput, ValidatedBrand, ValidatedSettings) at validateSettingsDoc's
 * mint, the plainness proof (ProvedPlain) at validateSectionShapes'. A cast to a branded type anywhere
 * else is a second mint that skips the checks the brand stands for, so the tree is scanned for one.
 *
 * Scope: the scan catches casts written in the ordinary form (`as`, `<T>`) to the brand or to a type that carries it
 * in an annotated data or return position. A value laundered through `any`, `never`, `typeof`, an inferred member
 * type, an untyped parse, or a spread carries the brand without such a cast and is out of scope, since TypeScript
 * itself cannot see it. Resolution is syntactic: a declared name is judged in its own file and an imported one by its
 * bare name, a type parameter by its constraint, and a generic's member by the generic's parts; namespaces and class
 * expressions are not collected.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Node as ESTreeNode, walk } from "estree-walker";
import { parseSync } from "oxc-parser";
import { ROOT } from "../root.js";

interface Brand {
  /** The brand's own names: the carrier aliases and the unique symbols they key on. */
  readonly names: readonly string[];

  /** The mint, named so a move is a deliberate edit here. */
  readonly mint: Cast;
}

const VALIDATED: Brand = {
  names: [
    "ValidatedBrand",
    "ValidatedInput",
    "ValidatedSettings",
    "validatedInput",
    "validatedSettings",
  ],
  mint: {
    file: "src/engine/orchestrate.ts",
    within: "mintValidatedSettings",
    text: "resolved as ValidatedSettings",
  },
};

const PROVED_PLAIN: Brand = {
  names: ["ProvedPlain", "provedPlain"],
  mint: {
    file: "src/engine/validate.ts",
    within: "validateSectionShapes",
    text: "parsedSections as ProvedPlain<SettingsFile>",
  },
};

const SCANNED_DIRS = ["src", "test", ".github/scripts"];

interface Cast {
  /** The repo-relative path of the file the cast sits in. */
  file: string;

  /** The enclosing function declaration's name; "<module>" at the top level. */
  within: string;

  /** The cast expression's source text. */
  text: string;
}

interface Source {
  file: string;
  text: string;
}

type Node = { type: string; start: number; end: number } & Record<string, unknown>;

/** The node kinds of which only the type parameters and the return type are descended: a type reached only through a function's parameters consumes a branded value and does not carry one. */
const FUNCTION_POSITIONS = new Set([
  "TSFunctionType",
  "TSConstructorType",
  "TSMethodSignature",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/**
 * estree-walker over this file's nodes, the synthetic class shapes included (it finds children by the fields carrying
 * a `type`). `enter` answering false skips the node's children and its `leave`.
 */
function walkNodes(root: Node, enter: (node: Node) => boolean, leave: () => void): void {
  walk(root as unknown as ESTreeNode, {
    enter(node) {
      if (!enter(node as unknown as Node)) {
        this.skip();
      }
    },
    leave,
  });
}

function parse(source: Source): Node {
  const { program, errors } = parseSync(source.file, source.text);
  if (errors.length > 0) {
    throw new Error(`${source.file}: ${errors.map((e) => e.message).join("; ")}`);
  }
  return program as unknown as Node;
}

function memberName(key: Node): string | undefined {
  if (key.type === "Identifier") {
    return key.name as string;
  }
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** The binding a parameter declares, through a parameter property and a default. */
function parameterId(p: Node): Node {
  const parameter = p.type === "TSParameterProperty" ? (p.parameter as Node) : p;
  return parameter.type === "AssignmentPattern" ? (parameter.left as Node) : parameter;
}

/** The annotation of a setter's parameter: the type the property reads as. */
function setterAnnotation(fn: Node): unknown {
  const first = Array.isArray(fn.params) ? fn.params[0] : undefined;
  return isNode(first) ? parameterId(first).typeAnnotation : undefined;
}

/** The type annotation a class member's type comes from: written, or a setter's parameter, or what a method returns. */
function memberAnnotation(m: Node): unknown {
  if (isNode(m.typeAnnotation)) {
    return m.typeAnnotation;
  }
  const fn = m.value;
  if (!isNode(fn)) {
    return undefined;
  }
  if (m.kind === "set") {
    return setterAnnotation(fn);
  }
  if (!isNode(fn.returnType)) {
    return undefined;
  }
  if (m.kind === "get") {
    return fn.returnType;
  }
  const signature = {
    type: "TSFunctionType",
    start: fn.start,
    end: fn.end,
    typeParameters: fn.typeParameters,
    params: [],
    returnType: fn.returnType,
  };
  return { type: "TSTypeAnnotation", start: fn.start, end: fn.end, typeAnnotation: signature };
}

/**
 * A class's instance shape as an object type: what it extends, its type parameters, its constructor's parameter
 * properties, and its other instance members by `memberAnnotation`. Static members are not reachable from an instance
 * and stay out.
 */
function classShape(node: Node): Node {
  const members: Node[] = [node.superClass, node.superTypeArguments].filter(isNode);
  const add = (member: Node, key: unknown, annotation: unknown): void => {
    if (isNode(annotation)) {
      members.push({
        type: "TSPropertySignature",
        start: member.start,
        end: member.end,
        key,
        computed: member.computed === true || !isNode(key),
        typeAnnotation: annotation,
      });
    }
  };
  for (const m of (node.body as Node).body as Node[]) {
    if (m.static === true) {
      continue;
    }
    if (m.kind === "constructor") {
      for (const p of (m.value as Node).params as Node[]) {
        if (p.type === "TSParameterProperty") {
          const id = parameterId(p);
          add(p, id, id.typeAnnotation);
        }
      }
      continue;
    }
    add(m, m.key, memberAnnotation(m));
  }
  return {
    type: "TSTypeLiteral",
    start: node.start,
    end: node.end,
    members,
    typeParameters: node.typeParameters,
  };
}

/** A declared name is judged in its own file: a same-named type elsewhere neither shadows nor stands in for it. */
function key(file: string, name: string): string {
  return `${file}\0${name}`;
}

/** The type names that carry the brand: by `key()` for every declaration, and by bare name for reference sites. */
interface Carriers {
  readonly keys: Set<string>;
  readonly names: Set<string>;
}

/**
 * The type parameters in scope at a point, each by its constraint and the scope that constraint reads in. One without
 * a constraint carries nothing, and still shadows a same-named declaration.
 */
type Bound = ReadonlyMap<string, Constrained>;

interface Constrained {
  readonly constraint?: Node;
  readonly scope: Bound;
}

const NO_BOUND: Bound = new Map();

/** `outer` extended by the type parameters `node` declares, if any. */
function bindTypeParameters(node: Node, outer: Bound): Bound {
  if (!isNode(node.typeParameters)) {
    return outer;
  }
  const inner = new Map<string, Constrained>(outer);
  for (const p of node.typeParameters.params as Node[]) {
    const name = (p.name as Node).name as string;
    inner.set(
      name,
      isNode(p.constraint) ? { constraint: p.constraint, scope: inner } : { scope: inner },
    );
  }
  return inner;
}

/** A declaration's body, its file, and the type parameters in scope where it is written, so what it names is judged there. */
interface Declared {
  readonly file: string;
  readonly body: Node;
  readonly bound: Bound;
}

/** True when `type` is a reference to a type parameter in `bound`. */
function isBound(type: Node, bound: Bound): boolean {
  const typeName = type.type === "TSTypeReference" ? (type.typeName as Node) : undefined;
  return typeName?.type === "Identifier" && bound.has(typeName.name as string);
}

/** The shape a declaration node declares: an alias or interface node itself, a named class's shape, else undefined. */
function declaredShape(node: Node): Node | undefined {
  if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") {
    return node;
  }
  if (node.type === "ClassDeclaration" && isNode(node.id)) {
    return classShape(node);
  }
  return undefined;
}

/** The members of a resolved shape: an interface body's or a type literal's; undefined for any other shape. */
function shapeMembers(shape: Node): Node[] | undefined {
  if (shape.type === "TSInterfaceDeclaration") {
    return (shape.body as Node).body as Node[];
  }
  if (shape.type === "TSTypeLiteral") {
    return shape.members as Node[];
  }
  return undefined;
}

/**
 * The parsed tree plus every type alias, interface, and class by file and name, for resolving `Carrier["field"]` to
 * the field's type and for judging a name where it is declared.
 */
class Tree {
  /** Every parsed file beside its source. */
  readonly programs: Array<{ source: Source; program: Node }> = [];

  /** A name declared twice in one file (merged interfaces, a nested scope) keeps both declarations. */
  readonly declarations = new Map<string, Map<string, Declared[]>>();

  /** Each file's import aliases, local name to imported name. */
  private readonly aliases = new Map<string, Map<string, string>>();

  constructor(sources: readonly Source[]) {
    for (const source of sources) {
      const program = parse(source);
      this.programs.push({ source, program });
      this.collect(program, source.file);
    }
  }

  private collect(program: Node, file: string): void {
    const bounds: Bound[] = [NO_BOUND];
    const enter = (node: Node): boolean => {
      const bound = bindTypeParameters(node, bounds.at(-1) ?? NO_BOUND);
      bounds.push(bound);
      if (node.type === "ImportSpecifier") {
        this.collectAlias(node, file);
      }
      const body = declaredShape(node);
      if (body !== undefined) {
        const perFile = this.declarations.get(file) ?? new Map<string, Declared[]>();
        const name = (node.id as Node).name as string;
        perFile.set(name, [...(perFile.get(name) ?? []), { file, body, bound }]);
        this.declarations.set(file, perFile);
      }
      return true;
    };
    walkNodes(program, enter, () => bounds.pop());
  }

  /** `import { Imported as Local }`: the local name stands for the imported one wherever the file references it. */
  private collectAlias(specifier: Node, file: string): void {
    const imported = memberName(specifier.imported as Node);
    const local = (specifier.local as Node).name as string;
    if (imported !== undefined && imported !== local) {
      const perFile = this.aliases.get(file) ?? new Map<string, string>();
      perFile.set(local, imported);
      this.aliases.set(file, perFile);
    }
  }

  /** The name `name` stands for in `file`: what an import alias imports, else itself. */
  private imported(file: string, name: string): string {
    return this.aliases.get(file)?.get(name) ?? name;
  }

  /**
   * The declaration a name refers to from `file`: the file's own when it has exactly one, otherwise the single
   * declaration of that name elsewhere (an import), and undefined when the name is declared twice or in several files.
   */
  declaration(file: string, name: string): Declared | undefined {
    const local = this.declarations.get(file)?.get(name);
    const elsewhere = this.imported(file, name);
    const candidates =
      local ?? [...this.declarations.values()].flatMap((m) => m.get(elsewhere) ?? []);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Whether `name`, referenced from `file`, carries the brand: the file's own declaration is judged by its key, an
   * imported one by name, so a local non-carrier does not inherit a carrier's name from another file.
   */
  carries(file: string, name: string, carriers: Carriers): boolean {
    return this.declarations.get(file)?.has(name) === true
      ? carriers.keys.has(key(file, name))
      : carriers.names.has(this.imported(file, name));
  }

  /**
   * The type of a named member of a declared object type, in the declaring file and scope, or undefined when the
   * object type is not a plain interface, class, or type literal (a mapped or intersection type), is generic (the
   * member's type may be a type parameter), has a member whose key is not a written name (an index signature, a
   * computed expression), or has no single such member of its own (a getter and setter pair).
   */
  member(file: string, objectType: Node, key: string): Declared | undefined {
    if (objectType.type !== "TSTypeReference" || isNode(objectType.typeArguments)) {
      return undefined;
    }
    const typeName = objectType.typeName as Node;
    if (typeName.type !== "Identifier") {
      return undefined;
    }
    const declaration = this.declaration(file, typeName.name as string);
    if (declaration === undefined || isNode(declaration.body.typeParameters)) {
      return undefined;
    }
    const shape =
      declaration.body.type === "TSTypeAliasDeclaration"
        ? (declaration.body.typeAnnotation as Node)
        : declaration.body;
    const members = shapeMembers(shape);
    const properties = members?.filter((m) => m.type === "TSPropertySignature") ?? [];
    // A computed key is a written name only when it is a string literal; an identifier there is a variable.
    const nameOf = (m: Node): string | undefined =>
      !isNode(m.key) || (m.computed === true && m.key.type !== "Literal")
        ? undefined
        : memberName(m.key);
    const opaque = properties.some((m) => nameOf(m) === undefined);
    const [hit, ...more] = properties.filter((m) => nameOf(m) === key);
    return !opaque && hit !== undefined && more.length === 0
      ? { ...declaration, body: (hit.typeAnnotation as Node).typeAnnotation as Node }
      : undefined;
  }

  /** The constraints and picked members being followed, so a type that reaches itself ends the descent. */
  private readonly following = new Set<Node>();

  private follow(node: Node, judge: () => boolean): boolean {
    if (this.following.has(node)) {
      return false;
    }
    this.following.add(node);
    try {
      return judge();
    } finally {
      this.following.delete(node);
    }
  }

  /** A function position by its type parameters and return type (a setter by its annotation), its parameters left out. */
  private functionPositionMentions(
    file: string,
    node: Node,
    carriers: Carriers,
    bound: Bound,
  ): boolean {
    const parts =
      node.kind === "set" ? [setterAnnotation(node)] : [node.typeParameters, node.returnType];
    return parts.filter(isNode).some((part) => this.mentions(file, part, carriers, bound));
  }

  /** An identifier: a carrier by name, or a type parameter by its constraint in the scope declaring it. */
  private identifierMentions(
    file: string,
    name: string,
    carriers: Carriers,
    bound: Bound,
  ): boolean {
    const constrained = bound.get(name);
    if (constrained === undefined) {
      return this.carries(file, name, carriers);
    }
    const { constraint, scope } = constrained;
    return (
      constraint !== undefined &&
      this.follow(constraint, () => this.mentions(file, constraint, carriers, scope))
    );
  }

  /** The member a string-literal index picks off an indexed access's object type, where it is declared; undefined when it does not resolve. */
  private pickedMember(file: string, node: Node): Declared | undefined {
    const index = node.indexType as Node;
    const literal = index.type === "TSLiteralType" ? (index.literal as Node) : undefined;
    if (literal?.type === "Literal" && typeof literal.value === "string") {
      return this.member(file, node.objectType as Node, literal.value);
    }
    return undefined;
  }

  /**
   * True when a carrier is named at or under `node` in `file`, outside the parameters of a function position. A type
   * parameter in `bound` is judged by its constraint, in the scope declaring it. An indexed access `T["k"]` on a
   * resolvable object type is judged by the member it picks, in the file and scope declaring it, so
   * `RepoRunOptions["mode"]` does not carry what `RepoRunOptions["settings"]` does; an unresolvable one is judged by
   * its parts.
   */
  mentions(file: string, root: Node, carriers: Carriers, outer: Bound = NO_BOUND): boolean {
    const bounds: Bound[] = [outer];
    let found = false;
    const enter = (node: Node): boolean => {
      const bound = bindTypeParameters(node, bounds.at(-1) ?? NO_BOUND);
      const verdict = found ? true : this.ownVerdict(file, node, carriers, bound);
      if (verdict !== undefined) {
        found ||= verdict;
        return false;
      }
      bounds.push(bound);
      return true;
    };
    walkNodes(root, enter, () => bounds.pop());
    return found;
  }

  /** What a node says by itself: a function position, an identifier, a named property, a resolvable indexed access; undefined for a node judged by its children. */
  private ownVerdict(
    file: string,
    node: Node,
    carriers: Carriers,
    bound: Bound,
  ): boolean | undefined {
    if (FUNCTION_POSITIONS.has(node.type)) {
      return this.functionPositionMentions(file, node, carriers, bound);
    }
    if (node.type === "Identifier") {
      return this.identifierMentions(file, node.name as string, carriers, bound);
    }
    // A written property name is a key, not a type: only its annotation can carry. A computed key may name a brand symbol.
    if (node.type === "TSPropertySignature" && node.computed !== true) {
      const annotation = node.typeAnnotation;
      return isNode(annotation) && this.mentions(file, annotation, carriers, bound);
    }
    if (node.type === "TSIndexedAccessType" && !isBound(node.objectType as Node, bound)) {
      const picked = this.pickedMember(file, node);
      if (picked !== undefined) {
        return this.follow(picked.body, () =>
          this.mentions(picked.file, picked.body, carriers, picked.bound),
        );
      }
    }
    return undefined;
  }
}

/**
 * Every type alias, interface, or class whose DATA or RETURN positions (properties, mapped values, intersections,
 * unions, generic arguments, defaults, and constraints, what a method or function type returns) reach the brand, to a
 * fixpoint: RepoRunOptions holds a ValidatedSettings, so a cast to RepoRunOptions mints too. A type that only takes
 * the brand as a parameter (SectionModule's plan) is a consumer and stays out.
 */
function brandCarriers(tree: Tree, brand: Brand): Carriers {
  const carriers: Carriers = { keys: new Set(), names: new Set(brand.names) };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, perFile] of tree.declarations) {
      for (const [name, declared] of perFile) {
        const carries = declared.some((d) => tree.mentions(d.file, d.body, carriers, d.bound));
        if (!carriers.keys.has(key(file, name)) && carries) {
          carriers.keys.add(key(file, name));
          carriers.names.add(name);
          grew = true;
        }
      }
    }
  }
  return carriers;
}

/** Every `expr as T` and `<T>expr` whose T names the brand, a carrier, or a type parameter constrained to one. */
function brandCasts(tree: Tree, carriers: Carriers): Cast[] {
  const casts: Cast[] = [];
  for (const { source, program } of tree.programs) {
    const scopes: Array<{ within: string; bound: Bound }> = [
      { within: "<module>", bound: NO_BOUND },
    ];
    const enter = (node: Node): boolean => {
      const outer = scopes.at(-1) ?? { within: "<module>", bound: NO_BOUND };
      const within =
        node.type === "FunctionDeclaration" && isNode(node.id)
          ? (node.id.name as string)
          : outer.within;
      const bound = bindTypeParameters(node, outer.bound);
      scopes.push({ within, bound });
      const isCast = node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
      if (isCast && tree.mentions(source.file, node.typeAnnotation as Node, carriers, bound)) {
        casts.push({
          file: source.file,
          within,
          text: source.text.slice(node.start, node.end).replace(/\s+/g, " "),
        });
      }
      return true;
    };
    walkNodes(program, enter, () => scopes.pop());
  }
  return casts;
}

export function scanBrand(
  sources: readonly Source[],
  brand: Brand = VALIDATED,
): { carriers: Set<string>; casts: Cast[] } {
  const tree = new Tree(sources);
  const carriers = brandCarriers(tree, brand);
  return { carriers: carriers.names, casts: brandCasts(tree, carriers) };
}

function readTree(): Source[] {
  const sources: Source[] = [];
  for (const dir of SCANNED_DIRS) {
    const base = join(ROOT, dir);
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      sources.push({ file: relative(ROOT, path), text: readFileSync(path, "utf8") });
    }
  }
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}

describe("the validated brand's mint", () => {
  const sources = readTree();
  const { carriers, casts } = scanBrand(sources);

  test("the carrier closure reaches the run options, not the module contract or a picked plain field", () => {
    expect(carriers.has("RepoRunOptions")).toBe(true);
    expect(carriers.has("SectionModule")).toBe(false);
    expect(carriers.has("SectionInput")).toBe(false);
    // Holds RepoRunOptions["onMissingPermission"], a plain field of a carrier.
    expect(carriers.has("SnapshotOptions")).toBe(false);
  });

  test("exactly one cast constructs it: the validator's success return", () => {
    expect(casts).toEqual([VALIDATED.mint]);
  });

  // The ValidatedSettings mint takes the proof as a parameter, so it consumes the plainness brand and never carries
  // it: the two brands have one mint each, not a shared one.
  test("the plainness proof has its own single mint: the section walk's success return", () => {
    const plain = scanBrand(sources, PROVED_PLAIN);
    expect(plain.carriers.has("ValidatedSettings")).toBe(false);
    expect(plain.casts).toEqual([PROVED_PLAIN.mint]);
  });

  test("a cast to the brand, a carrier, or an inline type holding one is found (positive control)", () => {
    const fixture: Source = {
      file: "fixture.ts",
      text: [
        'import type { ValidatedInput, ValidatedSettings } from "./x.js";',
        'interface RepoRunOptions { settings: ValidatedSettings; mode: "apply" | "check" }',
        "declare const doc: unknown;",
        "export function mintA() { return doc as { settings: ValidatedSettings }; }",
        'export const mintB = <ValidatedInput<"labels">>doc;',
        "export const mintC = doc as unknown as RepoRunOptions;",
        'export const mintD = doc as RepoRunOptions["settings"];',
        "export function consumer(input: ValidatedSettings): number { return 1; }",
        "export const plain = doc as { name: string };",
        'export const mode = doc as RepoRunOptions["mode"];',
        "interface Box<T> { value: T; count: number }",
        'export const mintE = doc as Box<ValidatedSettings>["value"];',
        'export const loud = doc as Box<ValidatedSettings>["count"];',
        'export const quiet = doc as Box<number>["value"];',
        "type Defaulted<T = ValidatedSettings> = { value: T };",
        'export const mintF = doc as Defaulted["value"];',
        "export function forge<T extends ValidatedSettings>(value: unknown): T { return value as T; }",
        "export function keep<T extends string>(value: unknown): T { return value as T; }",
        "type T = { value: string };",
        "type V = ValidatedSettings;",
        "export function shadow<V>(value: unknown): V { return value as V; }",
        'export function forgeIndexed<T extends { value: ValidatedSettings }>(value: unknown): T["value"] { return value as T["value"]; }',
        "export function forgeOuter<T extends ValidatedSettings, U extends T>(value: unknown): U { function inner<T extends string>(): U { return value as U; } return inner(); }",
        "export function forgeLocal<T extends ValidatedSettings>(value: unknown): ValidatedSettings { type Local = { value: T }; return (value as Local).value; }",
      ].join("\n"),
    };
    // An instantiated generic is judged by its parts, so the picked plain field of one is a loud false positive.
    expect(scanBrand([fixture]).casts).toEqual([
      { file: "fixture.ts", within: "mintA", text: "doc as { settings: ValidatedSettings }" },
      { file: "fixture.ts", within: "<module>", text: '<ValidatedInput<"labels">>doc' },
      { file: "fixture.ts", within: "<module>", text: "doc as unknown as RepoRunOptions" },
      { file: "fixture.ts", within: "<module>", text: 'doc as RepoRunOptions["settings"]' },
      { file: "fixture.ts", within: "<module>", text: 'doc as Box<ValidatedSettings>["value"]' },
      { file: "fixture.ts", within: "<module>", text: 'doc as Box<ValidatedSettings>["count"]' },
      { file: "fixture.ts", within: "<module>", text: 'doc as Defaulted["value"]' },
      { file: "fixture.ts", within: "forge", text: "value as T" },
      { file: "fixture.ts", within: "forgeIndexed", text: 'value as T["value"]' },
      { file: "fixture.ts", within: "inner", text: "value as U" },
      { file: "fixture.ts", within: "forgeLocal", text: "value as Local" },
    ]);
  });

  test("a declaration holding the brand joins the closure; one only taking or picking past it does not", () => {
    const fixture: Source = {
      file: "fixture.ts",
      text: [
        "type Holder = { readonly inner: ValidatedSettings; count: number };",
        "interface Nested { holder: Holder }",
        "interface Extended extends Nested { extra: number }",
        "type Wrapped = Promise<Holder>;",
        "interface Taker { plan(input: ValidatedSettings): void }",
        "type Fn = (input: ValidatedSettings) => void;",
        "type Maker = () => ValidatedSettings;",
        "interface Factory { make(input: number): ValidatedSettings }",
        "type Defaulted<T = ValidatedSettings> = { value: T };",
        "type Bounded = <T extends ValidatedSettings>() => T;",
        "type Generic<T> = { value: T };",
        "interface Merged { count: number }",
        "interface Merged { settings: ValidatedSettings }",
        "interface SetOnly { set value(v: ValidatedSettings) }",
        'type Loop = { next: () => Loop["next"] };',
        'type PickedPlain = { count: Holder["count"]; name: Extended["extra"] };',
        'type PickedBrand = { value: Holder["inner"] };',
      ].join("\n"),
    };
    const closure = scanBrand([fixture]).carriers;
    const judged = Object.fromEntries(
      [
        "Holder",
        "Nested",
        "Extended",
        "Wrapped",
        "Taker",
        "Fn",
        "Maker",
        "Factory",
        "Defaulted",
        "Bounded",
        "Generic",
        "Merged",
        "SetOnly",
        "Loop",
        "PickedPlain",
        "PickedBrand",
      ].map((name) => [name, closure.has(name)]),
    );
    expect(judged).toEqual({
      Holder: true,
      Nested: true,
      Extended: true,
      Wrapped: true,
      Taker: false,
      Fn: false,
      Maker: true,
      Factory: true,
      Defaulted: true,
      Bounded: true,
      Generic: false,
      Merged: true,
      SetOnly: true,
      Loop: false,
      PickedPlain: false,
      PickedBrand: true,
    });
  });

  test("a class holding or returning the brand is a carrier; a cast to it is found (negative control)", () => {
    const fixture: Source = {
      file: "fixture.ts",
      text: [
        "declare const raw: unknown;",
        "class Holder { settings!: ValidatedSettings; count: number = 0 }",
        "class Maker { get(): ValidatedSettings { return this.make(); } private make(): ValidatedSettings { return raw as never; } }",
        "class Param { constructor(public readonly settings: ValidatedSettings, mode: string) {} }",
        "class Sub extends Holder { extra = 1 }",
        "class Setter { set settings(value: ValidatedSettings) {} }",
        "abstract class Bounded { abstract make<T extends ValidatedSettings>(): T }",
        "class Taker { constructor(input: ValidatedSettings) {} use(input: ValidatedSettings): void {} }",
        "class Statics { static shared: ValidatedSettings; static build(): ValidatedSettings { return raw as never; } }",
        "class Accessors { set value(v: unknown) {} get value(): ValidatedSettings { return raw as never; } }",
        'class Computed { set value(v: unknown) {} get ["value"](): ValidatedSettings { return raw as never; } }',
        'const name = "value";',
        "class Named { set value(v: unknown) {} get [name](): ValidatedSettings { return raw as never; } }",
        "export const a = (raw as Holder).settings;",
        "export const b = (raw as Maker).get();",
        "export const c = (raw as Param).settings;",
        "export const d = (raw as Sub).settings;",
        "export const e = (raw as Setter).settings;",
        "export const f = (raw as Bounded).make();",
        "export const g = raw as Taker;",
        "export const h = raw as Statics;",
        'export const i = raw as Holder["count"];',
        'export const j = raw as Param["settings"];',
        'export const k = raw as Accessors["value"];',
        'export const l = raw as Computed["value"];',
        'export const m = raw as Named["value"];',
      ].join("\n"),
    };
    const { carriers, casts } = scanBrand([fixture]);
    const judged = Object.fromEntries(
      ["Holder", "Maker", "Param", "Sub", "Setter", "Bounded", "Taker", "Statics"].map((name) => [
        name,
        carriers.has(name),
      ]),
    );
    expect(judged).toEqual({
      Holder: true,
      Maker: true,
      Param: true,
      Sub: true,
      Setter: true,
      Bounded: true,
      Taker: false,
      Statics: false,
    });
    expect(casts.map((c) => c.text)).toEqual([
      "raw as Holder",
      "raw as Maker",
      "raw as Param",
      "raw as Sub",
      "raw as Setter",
      "raw as Bounded",
      'raw as Param["settings"]',
      'raw as Accessors["value"]',
      'raw as Computed["value"]',
      'raw as Named["value"]',
    ]);
  });

  test("a name is judged where it is declared; a same-named type in another file neither shadows nor stands in", () => {
    const carrier = [
      "export type Shape = { settings: ValidatedSettings };",
      "type Inner = { settings: ValidatedSettings };",
      "export interface Outer { value: Inner }",
      "export const a = raw as Shape;",
    ].join("\n");
    // Collected after the carrier, so a last-wins table would drop the carrier's declarations; Outer["value"] is
    // judged in carrier.ts, where Inner carries, not against this file's own Inner.
    const plain = [
      'import type { Outer } from "./carrier.js";',
      "type Shape = { name: string };",
      "type Inner = { name: string };",
      "export const b = raw as Shape;",
      'export const c = raw as Shape["name"];',
      'export const d = raw as Outer["value"];',
    ].join("\n");
    const files = [
      { file: "carrier.ts", text: carrier },
      { file: "plain.ts", text: plain },
      {
        file: "importer.ts",
        text: 'import type { Shape } from "./carrier.js";\nexport const e = raw as Shape;',
      },
    ];
    expect(scanBrand(files).casts.map((c) => `${c.file}: ${c.text}`)).toEqual([
      "carrier.ts: raw as Shape",
      'plain.ts: raw as Outer["value"]',
      "importer.ts: raw as Shape",
    ]);
  });

  // An import may rename the brand, so a cast spelled with the local name is the same second mint.
  test("an import alias is judged as the name it imports", () => {
    const files = [
      {
        file: "shape.ts",
        text: "export type Shape = { settings: ValidatedSettings; name: string };",
      },
      {
        file: "alias.ts",
        text: [
          'import type { ValidatedSettings as VS } from "./x.js";',
          'import { type Shape as S, other as VSS } from "./shape.js";',
          "export const a = raw as VS;",
          'export const b = raw as S["settings"];',
          'export const c = raw as S["name"];',
          "export const d = raw as VSS;",
          "type Plain = { VS: string };",
          "export const e = raw as { VS: string };",
          "export const f = raw as Plain;",
          "export const g = raw as { [VS]: string };",
        ].join("\n"),
      },
    ];
    expect(scanBrand(files).casts.map((c) => `${c.file}: ${c.text}`)).toEqual([
      "alias.ts: raw as VS",
      'alias.ts: raw as S["settings"]',
      "alias.ts: raw as { [VS]: string }",
    ]);
  });
});

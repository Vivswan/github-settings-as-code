/**
 * The validated brand (ValidatedInput, ValidatedBrand, ValidatedSettings) is minted at ONE site, validateSettingsDoc's
 * success return; every other value carrying it is read off that document. A cast to a branded type anywhere else is a
 * second mint that skips the file-only checks, so the tree is scanned for one.
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
import { parseSync } from "oxc-parser";
import { ROOT } from "../root.js";

/** The brand's own names: the carrier aliases and the unique symbols they key on. */
const BRAND_NAMES = [
  "ValidatedBrand",
  "ValidatedInput",
  "ValidatedSettings",
  "validatedInput",
  "validatedSettings",
] as const;

/** The mint, named so a move is a deliberate edit here. */
const MINT = {
  file: "src/engine/orchestrate.ts",
  within: "validateSettingsDoc",
  text: "resolved as ValidatedSettings",
};

const SCANNED_DIRS = ["src", "test", ".github/scripts"];

interface Cast {
  file: string;
  /** The enclosing function declaration's name; "<module>" at the top level. */
  within: string;
  text: string;
}

interface Source {
  file: string;
  text: string;
}

type Node = { type: string; start: number; end: number } & Record<string, unknown>;

/**
 * A type reached only through a function's parameters consumes a branded value; it does not carry one. Of these node
 * kinds only the type parameters and the return type are descended when deciding whether a declaration carries the
 * brand.
 */
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

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          out.push(item);
        }
      }
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
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

/**
 * The parsed tree plus every type alias, interface, and class by file and name, for resolving `Carrier["field"]` to
 * the field's type and for judging a name where it is declared.
 */
class Tree {
  readonly programs: Array<{ source: Source; program: Node }> = [];
  /** A name declared twice in one file (merged interfaces, a nested scope) keeps both declarations. */
  readonly declarations = new Map<string, Map<string, Declared[]>>();

  constructor(sources: readonly Source[]) {
    for (const source of sources) {
      const program = parse(source);
      this.programs.push({ source, program });
      this.collect(program, source.file, NO_BOUND);
    }
  }

  private collect(node: Node, file: string, outer: Bound): void {
    const bound = bindTypeParameters(node, outer);
    const body =
      node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration"
        ? node
        : node.type === "ClassDeclaration" && isNode(node.id)
          ? classShape(node)
          : undefined;
    if (body !== undefined) {
      const perFile = this.declarations.get(file) ?? new Map<string, Declared[]>();
      const name = (node.id as Node).name as string;
      perFile.set(name, [...(perFile.get(name) ?? []), { file, body, bound }]);
      this.declarations.set(file, perFile);
    }
    for (const child of children(node)) {
      this.collect(child, file, bound);
    }
  }

  /**
   * The declaration a name refers to from `file`: the file's own when it has exactly one, otherwise the single
   * declaration of that name elsewhere (an import), and undefined when the name is declared twice or in several files.
   */
  declaration(file: string, name: string): Declared | undefined {
    const local = this.declarations.get(file)?.get(name);
    const candidates = local ?? [...this.declarations.values()].flatMap((m) => m.get(name) ?? []);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Whether `name`, referenced from `file`, carries the brand: the file's own declaration is judged by its key, an
   * imported one by name, so a local non-carrier does not inherit a carrier's name from another file.
   */
  carries(file: string, name: string, carriers: Carriers): boolean {
    return this.declarations.get(file)?.has(name) === true
      ? carriers.keys.has(key(file, name))
      : carriers.names.has(name);
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
    const members =
      shape.type === "TSInterfaceDeclaration"
        ? ((shape.body as Node).body as Node[])
        : shape.type === "TSTypeLiteral"
          ? (shape.members as Node[])
          : undefined;
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

  /**
   * True when a carrier is named at or under `node` in `file`, outside the parameters of a function position. A type
   * parameter in `bound` is judged by its constraint, in the scope declaring it. An indexed access `T["k"]` on a
   * resolvable object type is judged by the member it picks, in the file and scope declaring it, so
   * `RepoRunOptions["mode"]` does not carry what `RepoRunOptions["settings"]` does; an unresolvable one is judged by
   * its parts.
   */
  mentions(file: string, node: Node, carriers: Carriers, outer: Bound = NO_BOUND): boolean {
    const bound = bindTypeParameters(node, outer);
    if (FUNCTION_POSITIONS.has(node.type)) {
      const parts =
        node.kind === "set" ? [setterAnnotation(node)] : [node.typeParameters, node.returnType];
      return parts.filter(isNode).some((part) => this.mentions(file, part, carriers, bound));
    }
    if (node.type === "Identifier") {
      const name = node.name as string;
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
    if (node.type === "TSIndexedAccessType" && !isBound(node.objectType as Node, bound)) {
      const index = node.indexType as Node;
      const literal = index.type === "TSLiteralType" ? (index.literal as Node) : undefined;
      const picked =
        literal?.type === "Literal" && typeof literal.value === "string"
          ? this.member(file, node.objectType as Node, literal.value)
          : undefined;
      if (picked !== undefined) {
        return this.follow(picked.body, () =>
          this.mentions(picked.file, picked.body, carriers, picked.bound),
        );
      }
    }
    return children(node).some((child) => this.mentions(file, child, carriers, bound));
  }
}

/**
 * Every type alias, interface, or class whose DATA or RETURN positions (properties, mapped values, intersections,
 * unions, generic arguments, defaults, and constraints, what a method or function type returns) reach the brand, to a
 * fixpoint: RepoRunOptions holds a ValidatedSettings, so a cast to RepoRunOptions mints too. A type that only takes
 * the brand as a parameter (SectionModule's plan) is a consumer and stays out.
 */
function brandCarriers(tree: Tree): Carriers {
  const carriers: Carriers = { keys: new Set(), names: new Set(BRAND_NAMES) };
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
    const walk = (node: Node, within: string, outer: Bound): void => {
      const scope =
        node.type === "FunctionDeclaration" && isNode(node.id) ? (node.id.name as string) : within;
      const bound = bindTypeParameters(node, outer);
      if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
        if (tree.mentions(source.file, node.typeAnnotation as Node, carriers, bound)) {
          casts.push({
            file: source.file,
            within: scope,
            text: source.text.slice(node.start, node.end).replace(/\s+/g, " "),
          });
        }
      }
      for (const child of children(node)) {
        walk(child, scope, bound);
      }
    };
    walk(program, "<module>", NO_BOUND);
  }
  return casts;
}

export function scanBrand(sources: readonly Source[]): { carriers: Set<string>; casts: Cast[] } {
  const tree = new Tree(sources);
  const carriers = brandCarriers(tree);
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
  const { carriers, casts } = scanBrand(readTree());

  test("the carrier closure reaches the run options, not the module contract or a picked plain field", () => {
    expect(carriers.has("RepoRunOptions")).toBe(true);
    expect(carriers.has("SectionModule")).toBe(false);
    expect(carriers.has("SectionInput")).toBe(false);
    // Holds RepoRunOptions["onMissingPermission"], a plain field of a carrier.
    expect(carriers.has("SnapshotOptions")).toBe(false);
  });

  test("exactly one cast constructs it: the validator's success return", () => {
    expect(casts).toEqual([MINT]);
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
});

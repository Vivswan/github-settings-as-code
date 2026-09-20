/**
 * The validated brand (ValidatedInput, ValidatedBrand, ValidatedSettings) is minted at ONE site, validateSettingsDoc's
 * success return; every other value carrying it is read off that document. A cast to a branded type anywhere else is a
 * second mint that skips the file-only checks, so the tree is scanned for one.
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
  text: "parsed as ValidatedSettings",
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
 * A type reached only through a function's parameters consumes a branded value; it does not carry one. These node
 * kinds are not descended when deciding whether a declaration carries the brand.
 */
const CONSUMER_POSITIONS = new Set([
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

/** The parsed tree plus every type alias and interface by name, for resolving `Carrier["field"]` to the field's type. */
class Tree {
  readonly programs: Array<{ source: Source; program: Node }> = [];
  readonly declarations = new Map<string, Node>();

  constructor(sources: readonly Source[]) {
    for (const source of sources) {
      const program = parse(source);
      this.programs.push({ source, program });
      this.collect(program);
    }
  }

  private collect(node: Node): void {
    if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") {
      const name = (node.id as Node).name as string;
      this.declarations.set(
        name,
        node.type === "TSTypeAliasDeclaration" ? (node.typeAnnotation as Node) : node,
      );
    }
    for (const child of children(node)) {
      this.collect(child);
    }
  }

  /**
   * The type of a named member of a declared object type, or undefined when the object type is not a plain interface
   * or type literal (a mapped or intersection type), or has no such member of its own.
   */
  member(objectType: Node, key: string): Node | undefined {
    if (objectType.type !== "TSTypeReference") {
      return undefined;
    }
    const typeName = objectType.typeName as Node;
    if (typeName.type !== "Identifier") {
      return undefined;
    }
    const declaration = this.declarations.get(typeName.name as string);
    const members =
      declaration?.type === "TSInterfaceDeclaration"
        ? ((declaration.body as Node).body as Node[])
        : declaration?.type === "TSTypeLiteral"
          ? (declaration.members as Node[])
          : undefined;
    const hit = members?.find(
      (m) => m.type === "TSPropertySignature" && !m.computed && memberName(m.key as Node) === key,
    );
    return hit === undefined ? undefined : ((hit.typeAnnotation as Node).typeAnnotation as Node);
  }

  /**
   * True when an identifier in `names` appears at or under `node`, outside the positions `skip` names. An indexed
   * access `T["k"]` on a resolvable object type is judged by the member it picks, so `RepoRunOptions["mode"]` does not
   * carry what `RepoRunOptions["settings"]` does; an unresolvable one is judged by its parts.
   */
  mentions(node: Node, names: ReadonlySet<string>, skip: ReadonlySet<string>): boolean {
    if (skip.has(node.type)) {
      return false;
    }
    if (node.type === "Identifier" && names.has(node.name as string)) {
      return true;
    }
    if (node.type === "TSIndexedAccessType") {
      const index = node.indexType as Node;
      const literal = index.type === "TSLiteralType" ? (index.literal as Node) : undefined;
      const picked =
        literal?.type === "Literal" && typeof literal.value === "string"
          ? this.member(node.objectType as Node, literal.value)
          : undefined;
      if (picked !== undefined) {
        return this.mentions(picked, names, skip);
      }
    }
    return children(node).some((child) => this.mentions(child, names, skip));
  }
}

/**
 * Every type alias or interface whose DATA positions (properties, mapped values, intersections, unions, generic
 * arguments) reach the brand, to a fixpoint: RepoRunOptions holds a ValidatedSettings, so a cast to RepoRunOptions
 * mints too. A type that only takes the brand as a parameter (SectionModule's plan) is a consumer and stays out.
 */
function brandCarriers(tree: Tree): Set<string> {
  const carriers = new Set<string>(BRAND_NAMES);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of tree.declarations) {
      if (!carriers.has(name) && tree.mentions(body, carriers, CONSUMER_POSITIONS)) {
        carriers.add(name);
        grew = true;
      }
    }
  }
  return carriers;
}

/** Every `expr as T` and `<T>expr` whose T names the brand or a carrier. */
function brandCasts(tree: Tree, carriers: ReadonlySet<string>): Cast[] {
  const casts: Cast[] = [];
  const none = new Set<string>();
  for (const { source, program } of tree.programs) {
    const walk = (node: Node, within: string): void => {
      const scope =
        node.type === "FunctionDeclaration" && isNode(node.id) ? (node.id.name as string) : within;
      if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
        if (tree.mentions(node.typeAnnotation as Node, carriers, none)) {
          casts.push({
            file: source.file,
            within: scope,
            text: source.text.slice(node.start, node.end).replace(/\s+/g, " "),
          });
        }
      }
      for (const child of children(node)) {
        walk(child, scope);
      }
    };
    walk(program, "<module>");
  }
  return casts;
}

export function scanBrand(sources: readonly Source[]): { carriers: Set<string>; casts: Cast[] } {
  const tree = new Tree(sources);
  const carriers = brandCarriers(tree);
  return { carriers, casts: brandCasts(tree, carriers) };
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
      ].join("\n"),
    };
    expect(scanBrand([fixture]).casts).toEqual([
      { file: "fixture.ts", within: "mintA", text: "doc as { settings: ValidatedSettings }" },
      { file: "fixture.ts", within: "<module>", text: '<ValidatedInput<"labels">>doc' },
      { file: "fixture.ts", within: "<module>", text: "doc as unknown as RepoRunOptions" },
      { file: "fixture.ts", within: "<module>", text: 'doc as RepoRunOptions["settings"]' },
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
        'type PickedPlain = { count: Holder["count"]; name: Extended["extra"] };',
        'type PickedBrand = { value: Holder["inner"] };',
      ].join("\n"),
    };
    const closure = scanBrand([fixture]).carriers;
    const judged = Object.fromEntries(
      ["Holder", "Nested", "Extended", "Wrapped", "Taker", "Fn", "PickedPlain", "PickedBrand"].map(
        (name) => [name, closure.has(name)],
      ),
    );
    expect(judged).toEqual({
      Holder: true,
      Nested: true,
      Extended: true,
      Wrapped: true,
      Taker: false,
      Fn: false,
      PickedPlain: false,
      PickedBrand: true,
    });
  });
});

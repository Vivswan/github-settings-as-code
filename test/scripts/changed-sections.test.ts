import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALL_SELECTING_PREFIXES,
  type ChangedFile,
  deriveSharedFanOut,
  parseNameStatus,
  renderSelection,
  resolveImport,
  scanImports,
  sectionsForFiles,
} from "../../.github/scripts/changed-sections.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const SRC_DIR = join(ROOT, "src");
const SECTIONS_DIR = join(SRC_DIR, "sections");
const SECTION_KEY_SET: ReadonlySet<string> = new Set(SECTION_KEYS);

function changed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, deleted: false }));
}

function removed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, deleted: true }));
}

/** Every path under src/sections on disk, repo-relative with forward slashes. */
function sectionsPathsOnDisk(dir = SECTIONS_DIR, prefix = "src/sections"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sectionsPathsOnDisk(join(dir, entry.name), path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** The given keys in SECTION_KEYS order, which is the order the fan-out emits. */
function inKeyOrder(...keys: SectionKey[]): SectionKey[] {
  const wanted = new Set<SectionKey>(keys);
  return SECTION_KEYS.filter((key) => wanted.has(key));
}

/** `root` filled as a repo holding `files` (repo-relative path -> text). */
function syntheticRepo(root: string, files: Record<string, string>): string {
  mkdirSync(join(root, "src", "sections", "shared"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const GRAPH_FIXTURE: Record<string, string> = {
  "src/sections/shared/engine.ts": "export const engine = 1;\n",
  "src/sections/shared/factory.ts":
    'import { engine } from "./engine.js";\nexport const factory = engine;\n',
  "src/sections/shared/util/index.ts": "export const util = 1;\n",
  "src/sections/labels/index.ts":
    'import {\n  factory,\n} from "../shared/factory.js";\nexport default factory;\n',
  "src/sections/teams/index.ts": 'export { engine } from "../shared/engine";\n',
  "src/sections/milestones/mock.ts": 'export const util = await import("../shared/util");\n',
  "src/sections/pages/mock.ts": "export const util = await import(`../shared/util`);\n",
  "src/sections/pages/schema.ts":
    'import type { engine } from "../shared/engine.js";\nexport type Engine = typeof engine;\n',
  "src/sections/labels/labels.test.ts": 'import { util } from "../shared/util/index.js";\nutil;\n',
  "src/schema.ts":
    'import { engine } from "./sections/shared/engine.js";\nexport default engine;\n',
  "src/sections/registry.ts": 'import "./labels/index.js";\nimport "./teams/index.js";\n',
};

describe("changed-sections derived fan-out", () => {
  test("every section that spells a shared import is in that shared file's derived fan-out", () => {
    // The scan against a plain-text reading of the tree: a form the scan misses, or a section file it skips, would
    // shrink a fan-out and let a PR under-select its smoke run.
    const fanOut = deriveSharedFanOut(ROOT);
    const spelled = new Map<string, Set<string>>();
    for (const path of sectionsPathsOnDisk()) {
      const dir = path.split("/")[2] ?? "";
      if (!SECTION_KEY_SET.has(dir) || !path.endsWith(".ts") || path.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(join(ROOT, path), "utf8");
      for (const [, spec = ""] of text.matchAll(/from "\.\.\/shared\/([^"]+)"/g)) {
        const shared = `${spec.replace(/\.js$/, "")}.ts`;
        spelled.set(shared, new Set([...(spelled.get(shared) ?? []), dir]));
      }
    }
    expect(spelled.size).toBeGreaterThan(5);
    for (const [shared, dirs] of spelled) {
      expect(fanOut[shared], shared).toEqual(expect.arrayContaining([...dirs]));
    }
  });

  test("scanImports finds every runtime import form and nothing that only looks like one", () => {
    const text = [
      'import { a } from "./a.js";',
      "import {",
      "  b,",
      "  c,",
      '} from "../b/c.js";',
      'export { e } from "./e";',
      'export * from "../f/index.js";',
      'const g = await import("./g.js");',
      'import "./side-effect.js";',
      'const r = require("./require.js");',
      'import tsr = require("./ts-require.js");',
      // Bare specifiers are not edges in the src/ graph.
      'import { z } from "zod";',
      'import { readFileSync } from "node:fs";',
      // Type-only imports are erased from the bundle.
      'import type { D } from "./type-only.js";',
      'import { type Only } from "./inline-type-only.js";',
      'export type { T } from "./type-reexport.js";',
      // Lookalikes a regex would take for imports.
      '// import { nope } from "./line-comment.js";',
      '/* export { nope } from "./block-comment.js"; */',
      'const s = "import(\\"./string.js\\")";',
      'const tpl = `import x from "./template.js"`;',
    ].join("\n");
    expect(scanImports(text, "probe.ts")).toEqual([
      "./a.js",
      "../b/c.js",
      "./e",
      "../f/index.js",
      "./g.js",
      "./side-effect.js",
      "./require.js",
      "./ts-require.js",
    ]);
  });

  test("scanImports throws on a computed specifier instead of dropping the edge", () => {
    // Bun's import list silently omits these three; the error must name the file and line.
    for (const [line, form] of [
      ["const d = await import(name);", "import(name)"],
      ["const r = require(name);", "require(name)"],
      [`const t = await import(\`./\${name}.js\`);`, "template import"],
    ] as const) {
      expect(
        () => scanImports(`const name = "./dyn.js";\n${line}\n`, "src/sections/labels/index.ts"),
        form,
      ).toThrow(/src\/sections\/labels\/index\.ts:2 loads a module through a computed specifier/);
    }
    expect(scanImports("const t = await import(`./lit.js`);\n", "probe.ts")).toEqual(["./lit.js"]);
  });

  test("scanImports reads a file that opens with a shebang, as the bin entry does", () => {
    expect(
      scanImports(
        '#!/usr/bin/env node\nimport { main } from "./cli/program.js";\nmain();\n',
        "cli.ts",
      ),
    ).toEqual(["./cli/program.js"]);
  });

  test("resolveImport maps .js to .ts, a directory to its index, and .json to itself, and throws on a dangling one", () =>
    withTempDir("changed-sections-", (dir) => {
      const root = syntheticRepo(dir, {
        "src/sections/shared/engine.ts": "",
        "src/sections/shared/util/index.ts": "",
        "src/sections/labels/index.ts": "",
        "lib/settings.schema.json": "{}",
      });
      const importer = join(root, "src/sections/labels/index.ts");
      expect(resolveImport(importer, "../shared/engine.js")).toBe(
        join(root, "src/sections/shared/engine.ts"),
      );
      expect(resolveImport(importer, "../shared/engine")).toBe(
        join(root, "src/sections/shared/engine.ts"),
      );
      expect(resolveImport(importer, "../shared/util")).toBe(
        join(root, "src/sections/shared/util/index.ts"),
      );
      expect(resolveImport(importer, "../../../lib/settings.schema.json")).toBe(
        join(root, "lib/settings.schema.json"),
      );
      expect(() => resolveImport(importer, "../shared/missing.js")).toThrow(
        /imports "\.\.\/shared\/missing\.js", which resolves to no file/,
      );
      expect(() => resolveImport(importer, "../../../lib/missing.json")).toThrow(
        /imports "\.\.\/\.\.\/\.\.\/lib\/missing\.json", which resolves to no file/,
      );
    }));

  test("the fan-out follows the graph through intermediates and ignores non-section importers", () =>
    withTempDir("changed-sections-", (dir) => {
      const fanOut = deriveSharedFanOut(syntheticRepo(dir, GRAPH_FIXTURE));
      expect(fanOut).toEqual({
        // src/schema.ts imports engine directly and registry.ts reaches it through teams; neither adds a key, and pages' type-only import is no edge.
        "engine.ts": inKeyOrder("labels", "teams"),
        "factory.ts": inKeyOrder("labels"),
        // labels' unit test imports util too and is not an edge.
        "util/index.ts": inKeyOrder("pages", "milestones"),
      });
    }));

  test.each<[label: string, files: Record<string, string>, error: RegExp]>([
    [
      "a shared file no section imports",
      {
        "src/sections/shared/live.ts": "export const live = 1;\n",
        "src/sections/shared/dead.ts": "export const dead = 1;\n",
        "src/sections/labels/index.ts":
          'import { live } from "../shared/live.js";\nexport default live;\n',
      },
      /no section imports src\/sections\/shared\/dead\.ts/,
    ],
    [
      "a dangling relative import anywhere under src",
      {
        "src/sections/shared/engine.ts": "export const engine = 1;\n",
        "src/sections/labels/index.ts":
          'import { gone } from "../shared/gone.js";\nexport default gone;\n',
      },
      /resolves to no file/,
    ],
    [
      // The graph must read every file through the computed-specifier check, not the transpiler alone, which
      // silently drops such an edge and under-selects.
      "a computed import anywhere under src, naming the file",
      {
        ...GRAPH_FIXTURE,
        "src/sections/webhooks/index.ts":
          'const which = "../shared/engine.js";\nexport const engine = await import(which);\n',
      },
      /src\/sections\/webhooks\/index\.ts:2 loads a module through a computed specifier/,
    ],
  ])("%s fails the whole derivation", (_label, files, error) =>
    withTempDir("changed-sections-", (dir) => {
      expect(() => deriveSharedFanOut(syntheticRepo(dir, files))).toThrow(error);
    }),
  );
});

describe("changed-sections file map", () => {
  test("every path on disk under src/sections resolves through some selector rule", () => {
    for (const path of sectionsPathsOnDisk()) {
      expect(() => sectionsForFiles(changed(path)), `${path} does not resolve`).not.toThrow();
    }
  });

  test("every top-level src entry is either sections/ or all-selecting", () => {
    // A new top-level src module the selector does not know would let PRs touching only it skip the smoke job. Stray artifacts like .DS_Store are not
    // selector inputs.
    for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.name.endsWith(".ts")) {
        continue;
      }
      const path = entry.isDirectory() ? `src/${entry.name}/` : `src/${entry.name}`;
      if (path === "src/sections/") {
        continue;
      }
      expect(
        ALL_SELECTING_PREFIXES.includes(path),
        `${path} is not in ALL_SELECTING_PREFIXES, so the selector would ignore changes to it`,
      ).toBe(true);
    }
  });
});

describe("changed-sections selection", () => {
  // Every rule that reads a path list to a rendered selection: "none", "all", or the keys in SECTION_KEYS order.
  test.each<[label: string, rendered: string, files: string[]]>([
    ["a docs-only change", "none", ["README.md", "COVERAGE.md", ".github/workflows/ci.yml"]],
    ["a section's entry", "labels", ["src/sections/labels/index.ts"]],
    ["a section's mock", "labels", ["src/sections/labels/mock.ts"]],
    [
      "a section's scenario",
      "environments",
      ["src/sections/environments/scenarios/environments-apply.yml"],
    ],
    [
      "a section whose key carries underscores",
      "secret_scanning_custom_patterns",
      ["src/sections/secret_scanning_custom_patterns/schema.ts"],
    ],
    [
      "multiple section directories, which union in SECTION_KEYS order",
      "labels,milestones",
      ["src/sections/milestones/index.ts", "src/sections/labels/index.ts"],
    ],
    ["registry.ts", "all", ["src/sections/registry.ts"]],
    [
      "the shared docs prose, like the docs registry",
      "none",
      ["src/sections/shared/shared.docs.yml"],
    ],
    [
      "the shared docs prose beside a section",
      "labels",
      ["src/sections/shared/shared.docs.yml", "src/sections/labels/index.ts"],
    ],
    // The docs-only aggregator is never in the bundle and build:check gates docs drift, so it behaves like lib/.
    ["docs-registry.ts", "none", ["src/sections/docs-registry.ts"]],
    [
      "docs-registry.ts beside a section, which it never masks",
      "labels",
      ["src/sections/docs-registry.ts", "src/sections/labels/index.ts"],
    ],
    [
      "docs-registry.ts beside a core path",
      "all",
      ["src/sections/docs-registry.ts", "src/schema.ts"],
    ],
    // The src/ entries are held to ALL_SELECTING_PREFIXES by the file-map test; these cross-cutting prefixes outside
    // src's top level have no such reading.
    ["the request layer", "all", ["src/sections/contract/requests.ts"]],
    ["the e2e runner", "all", ["test/e2e/runner.ts"]],
    ["the selector itself", "all", [".github/scripts/changed-sections.ts"]],
    ["a workflow", "all", [".github/workflows/checks.yml"]],
    ["a composite action", "all", [".github/actions/fetch-test-artifacts/action.yml"]],
    // lib/settings.schema.json regenerates alongside schema-affecting src changes; forcing "all" would kill diff-awareness.
    [
      "a section change plus a regenerated schema, which scopes to the section",
      "labels",
      ["src/sections/labels/index.ts", "lib/settings.schema.json"],
    ],
    [
      "a core-path change beside a section change, which wins",
      "all",
      ["src/sections/labels/index.ts", "src/engine/diff.ts"],
    ],
  ])("%s selects %s", (_label, rendered, files) => {
    expect(renderSelection(sectionsForFiles(changed(...files)))).toBe(rendered);
  });

  test("a shared file selects its derived fan-out", () => {
    const fanOut = deriveSharedFanOut(ROOT)["roles.ts"] ?? [];
    expect(fanOut.length).toBeGreaterThan(1);
    expect(renderSelection(sectionsForFiles(changed("src/sections/shared/roles.ts")))).toBe(
      fanOut.join(","),
    );
  });

  test("a deleted shared file adds nothing itself; every other path rule still applies", () => {
    // Its importers had to change in the same diff and select their sections.
    expect(sectionsForFiles(removed("src/sections/shared/roles.ts")).kind).toBe("none");
    expect(
      renderSelection(
        sectionsForFiles([
          ...removed("src/sections/shared/roles.ts"),
          ...changed("src/sections/collaborators/index.ts", "src/sections/teams/index.ts"),
        ]),
      ),
    ).toBe("collaborators,teams");
    // A deleted scenario can leave a route cold, so its section still runs.
    expect(
      renderSelection(sectionsForFiles(removed("src/sections/labels/scenarios/labels-apply.yml"))),
    ).toBe("labels");
    expect(sectionsForFiles(removed("src/sections/registry.ts")).kind).toBe("all");
    expect(() => sectionsForFiles(removed("src/sections/labels.ts"))).toThrow(
      /matches no selector rule/,
    );
  });

  test("a deleted shared file whose importers now resolve to its sibling spelling selects that sibling's sections", () =>
    withTempDir("changed-sections-", (dir) => {
      // foo.ts and foo/index.ts are interchangeable to an importer of "./foo.js", so deleting one leaves the importers unchanged and typecheck green.
      const fanOut = deriveSharedFanOut(
        syntheticRepo(dir, {
          "src/sections/shared/a/index.ts": "export const a = 1;\n",
          "src/sections/shared/b.ts": "export const b = 1;\n",
          "src/sections/labels/index.ts":
            'import { a } from "../shared/a.js";\nexport default a;\n',
          "src/sections/teams/index.ts": 'import { b } from "../shared/b.js";\nexport default b;\n',
        }),
      );
      const select = (files: ChangedFile[]) =>
        renderSelection(sectionsForFiles(files, () => fanOut));
      expect(select(removed("src/sections/shared/a.ts"))).toBe("labels");
      expect(select(removed("src/sections/shared/b/index.ts"))).toBe("teams");
      expect(select(removed("src/sections/shared/c.ts"))).toBe("none");
      // Only .ts files are selector inputs, so "a.js" cannot borrow a/index.ts.
      expect(() => select(removed("src/sections/shared/a.js"))).toThrow(/matches no selector rule/);
      expect(() => select(removed("src/sections/shared/notes.md"))).toThrow(
        /matches no selector rule/,
      );
    }));

  test("parseNameStatus reads NUL-delimited records raw and throws on any other shape", () => {
    // -z keeps a path with a tab, a quote, and a backslash verbatim; git would C-quote it otherwise and the src/sections/ prefix would go unmatched.
    const odd = 'src/sections/labels/scenarios/tab\there "quoted" back\\slash.yml';
    expect(
      parseNameStatus(
        `A\0src/sections/labels/index.ts\0M\0README.md\0D\0src/sections/shared/roles.ts\0T\0lib/settings.schema.json\0M\0${odd}\0`,
      ),
    ).toEqual([
      ...changed("src/sections/labels/index.ts", "README.md"),
      ...removed("src/sections/shared/roles.ts"),
      ...changed("lib/settings.schema.json", odd),
    ]);
    // Every status --no-renames can emit is a record; only D means deleted.
    expect(parseNameStatus("A\0a\0D\0d\0M\0m\0T\0t\0U\0u\0X\0x\0B\0b\0")).toEqual([
      ...changed("a"),
      ...removed("d"),
      ...changed("m", "t", "u", "x", "b"),
    ]);
    expect(parseNameStatus("")).toEqual([]);
    // A rename score means --no-renames was lost and its two paths misalign the fields; Q is a letter git never uses.
    expect(() => parseNameStatus("R100\0old.ts\0new.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("R\0old.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("Q\0q.ts\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("M\0")).toThrow(/unparseable/);
    expect(() => parseNameStatus("src/sections/labels/index.ts\0")).toThrow(/unparseable/);
    // A cut-off stream (no terminator on the last field) is not a record.
    expect(() => parseNameStatus("M\0README.md")).toThrow(/not NUL-terminated/);
  });

  test("an unrecognized src/sections path throws instead of silently selecting nothing, even beside a cross-cutting path", () => {
    // registry.ts and docs-registry.ts are the only flat files the layout allows; a section directory must spell its
    // key; under shared/ only mapped .ts files and the docs prose are known.
    for (const stray of [
      "src/sections/labels.ts",
      "src/sections/not_a_key/index.ts",
      "src/sections/shared/unmapped.ts",
      "src/sections/shared/notes.yml",
    ]) {
      expect(() => sectionsForFiles(changed(stray)), `${stray} must throw`).toThrow(
        /matches no selector rule/,
      );
      // Every src/sections/ path is resolved before answering "all", so the stray path cannot ride along.
      expect(
        () => sectionsForFiles(changed("src/schema.ts", stray)),
        `${stray} beside a core path`,
      ).toThrow(/matches no selector rule/);
    }
  });
});

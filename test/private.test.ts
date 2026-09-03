import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { isPrivate, markPrivate } from "../src/private.js";
import { revealPrivate } from "../src/private-open.js";

/**
 * The files allowed to import the opener module, each with its full export
 * list: a new export name is an explicit review, and leaking the opener through
 * an EXISTING export's value is the accepted residual of reviewed trusted code.
 */
const OPENER_IMPORTERS: Record<string, string[]> = {
  "src/action/redact.ts": [
    "DEFAULT_PRIVATE_REPORT",
    "DEFAULT_PRIVATE_REPOS",
    "PRIVATE_REPORT_CHANNELS",
    "PRIVATE_REPOS_POLICIES",
    "REDACTED_DETAIL",
    "REDACTED_NOTE",
    "WITHHELD_REPORT_NOTICE",
    "attempt",
    "capturingIo",
    "emitRedactedResult",
    "isIssueChannel",
    "isPrivateVisibility",
    "openTargetChannel",
    "planRedaction",
    "publicChannel",
    "publicDetail",
    "redactedChannel",
    "toPublicView",
  ],
  "src/discovery/discover.ts": [
    "AFFILIATIONS",
    "ARCHIVED_FILTERS",
    "DEFAULT_DISCOVERY_FILTERS",
    "FORKS_FILTERS",
    "VISIBILITY_FILTERS",
    "discoverRepos",
    "excludeMatches",
    "formatSkipNotice",
  ],
  "src/private.ts": ["isPrivate", "markPrivate"],
  "src/report/delivery.ts": [
    "applyMarkerInjection",
    "composeTargetReport",
    "deliverReport",
    "uploadArtifactReport",
  ],
  "test/private.test.ts": [],
};
const OPENER_MODULE = resolve("src/private-open");

const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

/** One file's runtime edges to the opener module and its exports, as the graph sees them. */
interface OpenerSurface {
  /** True when a runtime import edge points at the opener module. */
  imports: boolean;
  /** Every runtime export name, sorted; `export *` from the opener counts as "*". */
  exports: string[];
}

const toOpener = (file: string, specifier: string): boolean =>
  resolve(dirname(file), specifier.replace(/[?#].*$/, "").replace(/\.[cm]?[jt]s$/, "")) ===
  OPENER_MODULE;

/**
 * Bun's scan lists imports and exports but folds `export * from` into an
 * import edge with no export name, so that one shape is read from oxc. A
 * computed specifier already fails the changed-sections selector tripwire.
 */
function openerSurface(file: string, text: string): OpenerSurface {
  const scan = TRANSPILER.scan(text);
  const imports = scan.imports.some((entry) => toOpener(file, entry.path));
  const exports = [...scan.exports];
  const { program } = parseSync(file, text);
  for (const statement of program.body) {
    if (
      statement.type === "ExportAllDeclaration" &&
      statement.exportKind !== "type" &&
      toOpener(file, String(statement.source.value))
    ) {
      exports.push("*");
    }
  }
  return { imports, exports: exports.sort() };
}

function sourceFiles(dir: string): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [[path, readFileSync(path, "utf8")]] : [];
  });
}

/** The importers of the opener module among `sources`, each with its export list. */
function openerImporters(sources: Iterable<[string, string]>): Record<string, string[]> {
  const importers: Record<string, string[]> = {};
  for (const [path, text] of sources) {
    const surface = openerSurface(path, text);
    if (surface.imports) {
      importers[path] = surface.exports;
    }
  }
  return importers;
}

describe("Private<T>", () => {
  test("a sealed value round-trips through reveal and is recognized by the guard, plain values are not", () => {
    const sealed = markPrivate({ slug: "o/priv", n: 1 });
    expect(isPrivate(sealed)).toBe(true);
    expect(revealPrivate(sealed)).toEqual({ slug: "o/priv", n: 1 });
    for (const plain of ["o/priv", { slug: "o/priv" }, null, undefined, 0, []]) {
      expect(isPrivate(plain)).toBe(false);
    }
    // The box neither stringifies nor serializes to its content.
    expect(`${sealed}`).not.toContain("o/priv");
    expect(JSON.stringify(sealed)).toBe("{}");
  });

  test("exactly the projections import the opener, and their export lists are pinned", () => {
    const own: [string, string] = [
      "test/private.test.ts",
      readFileSync("test/private.test.ts", "utf8"),
    ];
    expect(openerImporters([...sourceFiles("src"), own])).toEqual(OPENER_IMPORTERS);
  });

  test("a new importer or a re-export is reported, however it is spelled; type-only edges are not", () => {
    const opener = 'import { revealPrivate } from "../private-open.js";\n';
    const files: Array<[string, string]> = [
      ["src/x/s.ts", `${opener}export const f = (v: any) => revealPrivate(v);\n`],
      ["src/y.ts", 'import * as open from "./private-open";\nexport const v = open;\n'],
      ["src/named.ts", 'export { revealPrivate } from "./private-open.js";\n'],
      [
        "src/renamed.ts",
        'export { revealPrivate as open, PRIVATE as SYM } from "./private-open.js";\n',
      ],
      ["src/star.ts", 'export * from "./private-open.js";\nexport const own = 1;\n'],
      [
        "src/x/local.ts",
        `${opener}const alias = revealPrivate;\nexport { alias, revealPrivate as also };\n`,
      ],
      [
        "src/query.ts",
        'import { PRIVATE } from "./private-open.ts?raw";\nexport const v = PRIVATE;\n',
      ],
      [
        "src/t.ts",
        'import type { revealPrivate } from "./private-open.js";\nexport type { Private } from "./private.js";\nexport type F = typeof revealPrivate;\n',
      ],
      [
        "src/u.ts",
        'import { markPrivate } from "./private.js";\nexport const v = markPrivate(1);\n',
      ],
    ];
    expect(openerImporters(files)).toEqual({
      "src/x/s.ts": ["f"],
      "src/y.ts": ["v"],
      "src/named.ts": ["revealPrivate"],
      "src/renamed.ts": ["SYM", "open"],
      "src/star.ts": ["*", "own"],
      "src/x/local.ts": ["alias", "also"],
      "src/query.ts": ["v"],
    });
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Node as ESTreeNode, walk } from "estree-walker";
import { type Node, parseSync } from "oxc-parser";
import { actionsIo } from "../../src/action/io.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** The node types whose `source` names the module they load. */
const LOADS_BY_SOURCE: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSImportType",
]);

/** The specifier a module-loading node names by a literal (a template with no expressions is one), else undefined. */
function loadedSpecifier(node: Node): string | undefined {
  const isRequire =
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require";
  let request: Node | null | undefined;
  if (isRequire) {
    request = node.arguments[0];
  } else if (node.type === "TSExternalModuleReference") {
    request = node.expression;
  } else if (LOADS_BY_SOURCE.has(node.type) && "source" in node) {
    request = node.source;
  }

  if (request?.type === "Literal" && typeof request.value === "string") {
    return request.value;
  }
  if (request?.type === "TemplateLiteral" && request.expressions.length === 0) {
    return request.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Whether `source` loads @actions/core: by a static import, a re-export, import(), require(), or an import type. */
function namesActionsCore(source: string): boolean {
  const { program, errors } = parseSync("module.ts", source);
  if (errors.length > 0) {
    // A file the parser gave up on has an incomplete tree, which would read as "loads nothing".
    throw new Error(
      `the source does not parse: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  let named = false;
  walk(program as unknown as ESTreeNode, {
    enter(node) {
      named ||= loadedSpecifier(node as unknown as Node) === "@actions/core";
    },
  });
  return named;
}

describe("the Io port boundary", () => {
  // The detector's controls: every way a module can name the package, and the two mentions that must not count.
  test.each([
    ['import * as core from "@actions/core";', true],
    ["import { debug } from '@actions/core';", true],
    ['export { setSecret } from "@actions/core";', true],
    ['const core = await import("@actions/core");', true],
    ['const core = require("@actions/core");', true],
    ["const core = await import(`@actions/core`);", true],
    ['import core = require("@actions/core");', true],
    ['type Core = typeof import("@actions/core");', true],
    ["// the action layer implements it over @actions/core", false],
    ['const why = "@actions/core";', false],
    ['import { retry } from "@octokit/plugin-retry";', false],
  ])("the specifier check classifies %j as %p", (source, named) => {
    expect(namesActionsCore(source)).toBe(named);
  });

  test("only src/action/ names @actions/core", () => {
    // Every other layer reaches the runner through the Io port, so redaction and capture have one place to stand.
    const srcDir = join(ROOT, "src");
    const files = readdirSync(srcDir, { recursive: true }) as string[];
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (!file.endsWith(".ts") || file.split(/[\\/]/)[0] === "action") {
        continue;
      }
      scanned += 1;
      if (namesActionsCore(readFileSync(join(srcDir, file), "utf8"))) {
        offenders.push(`src/${file}`);
      }
    }
    expect(offenders).toEqual([]);
    // The scan saw the tree (a wrong root would pass vacuously), and the check tells an import from a mention:
    // the action's Io imports the package, the CLI's runner face only names it in its header.
    expect(scanned).toBeGreaterThan(50);
    expect(namesActionsCore(readFileSync(join(srcDir, "action", "io.ts"), "utf8"))).toBe(true);
    const cliRunner = readFileSync(join(srcDir, "cli", "actions.ts"), "utf8");
    expect(cliRunner).toContain("@actions/core");
    expect(namesActionsCore(cliRunner)).toBe(false);
  });
});

describe("actionsIo", () => {
  const saved = {
    summary: process.env.GITHUB_STEP_SUMMARY,
    output: process.env.GITHUB_OUTPUT,
  };
  afterEach(() => {
    for (const [key, value] of [
      ["GITHUB_STEP_SUMMARY", saved.summary],
      ["GITHUB_OUTPUT", saved.output],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  test("summary appends each block with one trailing newline, and skips when the runner file is unset", () =>
    withTempDir("sac-io-", (dir) => {
      const file = join(dir, "summary.md");
      delete process.env.GITHUB_STEP_SUMMARY;
      actionsIo.summary("dropped");
      process.env.GITHUB_STEP_SUMMARY = file;
      actionsIo.summary("## first block");
      actionsIo.summary("| a |\n|---|");
      expect(readFileSync(file, "utf8")).toBe("## first block\n| a |\n|---|\n");
    }));

  test("output writes the runner's output file only when it is set, and never a stdout command", () =>
    withTempDir("sac-io-", (dir) => {
      // The runner creates the file; @actions/core refuses to append to a missing one. Without the file, @actions/core
      // would fall back to the retired ::set-output:: stdout command, so stdout is watched too.
      const file = join(dir, "output.txt");
      writeFileSync(file, "");
      delete process.env.GITHUB_OUTPUT;
      const chunks: string[] = [];
      const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        actionsIo.output("result", "dropped");
        // @ts-expect-error a misspelled output name fails to compile at the port
        actionsIo.output("reslut", "dropped");
      } finally {
        write.mockRestore();
      }
      expect(chunks).toEqual([]);
      process.env.GITHUB_OUTPUT = file;
      actionsIo.output("result", "clean");
      // @actions/core writes outputs in heredoc form: name<<DELIM / value / DELIM
      const written = readFileSync(file, "utf8");
      expect(written).toMatch(/^result<<[^\n]+\nclean\n[^\n]+\n$/);
      expect(written).not.toContain("dropped");
    }));

  test("mask registers the value in the registry masked() reads", () => {
    // One registry behind both: the API tracer reads masked() at runtime to redact what mask() registered.
    actionsIo.mask("o/private");
    expect(actionsIo.masked().has("o/private")).toBe(true);
  });
});

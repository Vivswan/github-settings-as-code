/**
 * The verdict `bun run check:headers` prints, so CI's test job carries the gate: a source file added without its
 * header fails here, naming the file. The fixture tree holds one file per way a file can open or sit outside the
 * gate's reach, since a form the scan misreads would let a headerless file pass.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesWithoutHeader } from "../../.github/scripts/check-file-headers.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const SCRIPT = join(ROOT, ".github", "scripts", "check-file-headers.ts");

const HEADER = "/**\n * What the module owns.\n */\n\n";

const CODE = 'import { join } from "node:path";\n\nexport const here = join(".", "x");\n';

type TreeFile = readonly [path: string, text: string, named: boolean];

/** One file per opening and per place a file can sit; `named` marks the ones the gate must name. */
const TREE: readonly TreeFile[] = [
  ["src/headed.ts", HEADER + CODE, false],
  ["src/blank-lines-first.ts", `\n\n${HEADER}${CODE}`, false],
  ["src/import-first.ts", CODE, true],
  ["src/line-comment.ts", `// What the module owns.\n\n${CODE}`, true],
  ["src/plain-block.ts", `/* What the module owns. */\n\n${CODE}`, true],
  ["src/header-after-code.ts", CODE + HEADER, true],
  ["src/empty.ts", "", true],
  ["src/nested/deep/import-first.ts", CODE, true],
  ["src/generated/import-first.ts", CODE, false],
  ["src/notes.md", "No comment here.\n", false],
  [".github/scripts/shebang-headed.ts", `#!/usr/bin/env bun\n${HEADER}${CODE}`, false],
  [".github/scripts/shebang-import-first.ts", `#!/usr/bin/env bun\n${CODE}`, true],
  [".github/scripts/lib/import-first.ts", CODE, true],
  ["test/import-first.test.ts", CODE, false],
];

function write(root: string, files: readonly TreeFile[]): void {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The CLI as the commit hook and `bun run check:headers` run it: from the repository root. */
function run(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync("bun", [SCRIPT], { cwd, encoding: "utf8" });
  return { status, stdout, stderr };
}

describe("the file-header gate", () => {
  test("every source file of this repository opens with its header", () => {
    expect(filesWithoutHeader(ROOT)).toEqual([]);
  });

  test("fails naming exactly the gated files that open with anything but a /** comment", () =>
    withTempDir("file-headers-", (dir) => {
      write(dir, TREE);
      const named = TREE.filter(([, , isNamed]) => isNamed)
        .map(([path]) => path)
        .sort();
      expect(run(dir)).toEqual({
        status: 1,
        stdout: "",
        stderr: [
          `check:headers: ${named.length} files open without a header comment:`,
          ...named.map((path) => `  ${path}`),
          "Open each with a /** ... */ block comment saying what the file owns (CONTRIBUTING.md, Code conventions).",
          "",
        ].join("\n"),
      });
    }));

  test("passes a tree whose gated files all open with a header (control)", () =>
    withTempDir("file-headers-", (dir) => {
      write(
        dir,
        TREE.filter(([, , isNamed]) => !isNamed),
      );
      expect(run(dir)).toEqual({
        status: 0,
        stdout: "check:headers: every source file opens with a header comment\n",
        stderr: "",
      });
    }));
});

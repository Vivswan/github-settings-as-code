/**
 * A count written "N thing(s)" ships when its author forgot src/text.ts, so every string literal under src/ and .github/scripts/ is read
 * for the parenthetical. SCOPE: accidental omissions only; a spelling chosen to evade the pattern is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import { ROOT } from "./root.js";
import { withTempDir } from "./temp-dir.js";

const SCANNED_DIRS = ["src", ".github/scripts"];

/**
 * A word then "(s)", read in the source text. A lambda parameter `(s) =>` has no word before its paren, and the `n` of a `\n` escape is
 * not a word either, so neither matches.
 */
const COUNT_PARENTHETICAL = /(?<!\\)\w\(s\)/g;

/**
 * A "BUG:" message names a programming error to the developer holding the stack: the list in brackets beside the noun carries the count,
 * and no run reports it to a user.
 */
const INVARIANT_PREFIX = "BUG:";

/** Stands in for the `}` that closes the hole before a template's later quasis, so `${noun}(s)` reads as a word before the paren. */
const HOLE = "_";

const FIX =
  'spells a count as "(s)"; write countNoun(count, one, many) or agree(count, one, many) from src/text.ts';

/**
 * Every "(s)" count parenthetical in the string literals of `files`, one line per hit: `path:line: "...context..." <fix>`. A file that
 * does not parse has no literals to read, and the empty AST oxc returns for it would pass as clean, so it throws instead.
 */
export function countParentheticals(files: Iterable<[path: string, text: string]>): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    // `value` is the source text from offset `start`, so a hit's line is its own, whatever the escapes and line endings around it.
    const report = (start: number, value: string) => {
      for (const found of value.matchAll(COUNT_PARENTHETICAL)) {
        const line = text.slice(0, start + found.index).split("\n").length;
        const context = value.slice(
          Math.max(0, found.index - 24),
          found.index + found[0].length + 24,
        );
        problems.push(`${path}:${line}: ${JSON.stringify(context)} ${FIX}`);
      }
    };
    const { program, errors } = parseSync(path, text);
    if (errors.length > 0) {
      throw new Error(
        `${path} does not parse, so its strings cannot be read: ${errors[0]?.message}`,
      );
    }
    new Visitor({
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        const body = text.slice(node.start + 1, node.end - 1);
        if (!body.startsWith(INVARIANT_PREFIX)) {
          report(node.start + 1, body);
        }
      },
      TemplateLiteral(node) {
        // A quasi's span runs from the backtick or `}` before it to the `${` or backtick after it.
        const body = (quasi: (typeof node.quasis)[number]) =>
          text.slice(quasi.start + 1, quasi.end - (quasi.tail ? 1 : 2));
        if (body(node.quasis[0] as (typeof node.quasis)[number]).startsWith(INVARIANT_PREFIX)) {
          return;
        }
        node.quasis.forEach((quasi, index) => {
          if (index === 0) {
            report(quasi.start + 1, body(quasi));
          } else {
            report(quasi.start, HOLE + body(quasi));
          }
        });
      },
    }).visit(program);
  }
  return problems;
}

/** The hits across every .ts file under the scanned directories of `root`, the paths relative to it. */
function treeParentheticals(root: string): string[] {
  return countParentheticals(
    SCANNED_DIRS.flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name): [string, string] => [
          join(dir, name),
          readFileSync(join(root, dir, name), "utf8"),
        ]),
    ),
  );
}

describe("count parentheticals", () => {
  test("no string under src/ or .github/scripts/ spells a count as (s)", () => {
    expect(treeParentheticals(ROOT)).toEqual([]);
  });

  test("a planted (s) in either scanned tree fails the same scan naming the file and line (negative control)", () =>
    withTempDir("count-nouns-", (root) => {
      const planted: Record<string, string> = {
        "src/deep/planted.ts": 'export const a = 1;\nexport const plain = "no file(s) here";\n',
        ".github/scripts/planted.ts": `export const templated = (n: number) => \`\${n} entr(y|ies) or entry(s)\`;\n`,
        "src/clean.ts": 'export const clean = "no count here";\n',
      };
      for (const [name, text] of Object.entries(planted)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), text);
      }
      expect(treeParentheticals(root)).toEqual([
        `src/deep/planted.ts:2: "no file(s) here" ${FIX}`,
        `.github/scripts/planted.ts:1: "_ entr(y|ies) or entry(s)" ${FIX}`,
      ]);
    }));

  test("every planted (s) fails naming its own line: a plain string, a template hole, two in one string, later template lines", () => {
    const text = [
      'import { x } from "./x.js";',
      "const plain = 'no file(s) here';",
      `const templated = \`\${n} \${noun}(s) found\`;`,
      'const twice = "file(s) and repo(s)";',
      "const spanning = `first line",
      "  second line names the label(s)`;",
      "const holeSpanning = `${",
      "  noun",
      "}(s) found`;",
      "export const all = plain + templated + twice + spanning + holeSpanning;",
    ].join("\n");
    expect(countParentheticals([["src/planted.ts", text]])).toEqual([
      `src/planted.ts:2: "no file(s) here" ${FIX}`,
      `src/planted.ts:3: "_(s) found" ${FIX}`,
      `src/planted.ts:4: "file(s) and repo(s)" ${FIX}`,
      `src/planted.ts:4: "file(s) and repo(s)" ${FIX}`,
      `src/planted.ts:6: "cond line names the label(s)" ${FIX}`,
      `src/planted.ts:9: "_(s) found" ${FIX}`,
    ]);
    const crlf = "const m = `first\r\nsecond\r\nthird\r\nfourth\r\nfile(s)`;";
    expect(countParentheticals([["src/crlf.ts", crlf]])).toEqual([
      `src/crlf.ts:5: "cond\\r\\nthird\\r\\nfourth\\r\\nfile(s)" ${FIX}`,
    ]);
    // oxc hands out UTF-16 offsets, the unit String.prototype.slice reads, so a multi-byte character before or inside a literal moves nothing.
    const nonAscii = [
      "// \u00e9",
      'const a = "x(s)";',
      `const b = \`\u65e5\u672c \${n} label(s)\`;`,
    ].join("\n");
    expect(countParentheticals([["src/non-ascii.ts", nonAscii]])).toEqual([
      `src/non-ascii.ts:2: "x(s)" ${FIX}`,
      `src/non-ascii.ts:3: "_ label(s)" ${FIX}`,
    ]);
  });

  test("a lambda parameter, an escape before a lambda, a comment, and a BUG: invariant are not counts (controls)", () => {
    const text = [
      "// the file(s) this comment names are not a message",
      "/** neither is the key(s) note in this block */",
      "const trimmed = list.map((s) => s.trim());",
      "const example = `Example:\\n(s) => s.trim()`;",
      `const bug = \`BUG: \${route} was given unused param(s) [\${list}]\`;`,
      'const plainBug = "BUG: base key(s) reached plan()";',
    ].join("\n");
    expect(countParentheticals([["src/controls.ts", text]])).toEqual([]);
  });

  test("a file that does not parse fails naming it instead of reading as clean (control)", () => {
    const text = "const plain = 'no file(s) here';\nconst broken = ;\n";
    expect(() => countParentheticals([["src/broken.ts", text]])).toThrow(
      /^src\/broken\.ts does not parse, so its strings cannot be read: /,
    );
  });
});

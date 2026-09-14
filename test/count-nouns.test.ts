/**
 * A count written "N thing(s)" ships when its author forgot src/text.ts, so every string literal under src/ and .github/scripts/ is read
 * for the parenthetical. SCOPE: accidental omissions only; a spelling chosen to evade the pattern is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import { ROOT } from "./root.js";

const SCANNED_DIRS = ["src", ".github/scripts"];

/** A word then "(s)". A lambda parameter `(s) =>` has no word before its paren, so it never matches. */
const COUNT_PARENTHETICAL = /\w\(s\)/g;

/**
 * A "BUG:" message names a programming error to the developer holding the stack: the list in brackets beside the noun carries the count,
 * and no run reports it to a user.
 */
const INVARIANT_PREFIX = "BUG:";

/** Stands in for the `${expression}` hole before a template's later quasis, so `${noun}(s)` reads as a word before the paren. */
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
    // `start` is the source offset of `value`'s first character, so a hit on a later line of a template names that line.
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
        if (typeof node.value === "string" && !node.value.startsWith(INVARIANT_PREFIX)) {
          report(node.start, node.value);
        }
      },
      TemplateLiteral(node) {
        if (node.quasis[0]?.value.raw.startsWith(INVARIANT_PREFIX)) {
          return;
        }
        // The raw text keeps each quasi's offsets aligned with the source.
        node.quasis.forEach((quasi, index) => {
          const hole = index === 0 ? "" : HOLE;
          report(quasi.start - hole.length, hole + quasi.value.raw);
        });
      },
    }).visit(program);
  }
  return problems;
}

function sourceFiles(): Array<[string, string]> {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name): [string, string] => [
        join(dir, name),
        readFileSync(join(ROOT, dir, name), "utf8"),
      ]),
  );
}

describe("count parentheticals", () => {
  test("no string under src/ or .github/scripts/ spells a count as (s)", () => {
    expect(countParentheticals(sourceFiles())).toEqual([]);
  });

  test("every planted (s) fails naming its own line: a plain string, a template hole, two in one string, a later template line", () => {
    const text = [
      'import { x } from "./x.js";',
      "const plain = 'no file(s) here';",
      `const templated = \`\${n} \${noun}(s) found\`;`,
      'const twice = "file(s) and repo(s)";',
      "const spanning = `first line",
      "  second line names the label(s)`;",
      "export const all = plain + templated + twice + spanning;",
    ].join("\n");
    expect(countParentheticals([["src/planted.ts", text]])).toEqual([
      `src/planted.ts:2: "no file(s) here" ${FIX}`,
      `src/planted.ts:3: "_(s) found" ${FIX}`,
      `src/planted.ts:4: "file(s) and repo(s)" ${FIX}`,
      `src/planted.ts:4: "file(s) and repo(s)" ${FIX}`,
      `src/planted.ts:6: "cond line names the label(s)" ${FIX}`,
    ]);
  });

  test("a lambda parameter, a comment, and a BUG: invariant are not counts (controls)", () => {
    const text = [
      "// the file(s) this comment names are not a message",
      "/** neither is the key(s) note in this block */",
      "const trimmed = list.map((s) => s.trim());",
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

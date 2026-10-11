import { describe, expect, spyOn, test } from "bun:test";
import { err } from "neverthrow";
import picomatch from "picomatch";
import {
  compileExcludePattern,
  type ExcludePattern,
  excludeMatches,
} from "../../src/discovery/exclude-pattern.js";
import { describeProblem } from "../../src/problem.js";

/** The compiled form of a pattern the test knows to be valid; a refusal is a test bug, named. */
const compiled = (pattern: string): ExcludePattern =>
  compileExcludePattern(pattern).match(
    (exclude) => exclude,
    (problem) => {
      throw new Error(describeProblem(problem));
    },
  );

describe("compileExcludePattern", () => {
  test.each<[string, string, string, boolean]>([
    ["* spans any characters, anchored at both ends", "tmp-*", "o/tmp-x", true],
    ["* spans any characters, anchored at both ends", "tmp", "o/tmp-x", false],
    ["* spans any characters, anchored at both ends", "*-archive", "o/old-archive", true],
    ["* spans a leading dot, which names a repository, not a hidden file", "*", "o/.github", true],
    ["a dot is literal", "a.b", "o/a.b", true],
    ["a dot is literal", "a.b", "o/axb", false],
    ["matching is case-insensitive", "TMP-*", "o/tmp-x", true],
    ["matching is case-insensitive", "octo/*", "OCTO/x", true],
    ["a pattern with a slash matches the full slug", "octo/*", "octo/anything", true],
    ["a pattern with a slash matches the full slug", "octo/*", "example-org/anything", false],
    ["a pattern without a slash matches the name only", "web*", "weborg/api", false],
    ["a pattern without a slash matches the name only", "web*", "anyowner/web-x", true],
    ["? matches exactly one character", "tmp-?", "o/tmp-1", true],
    ["? matches exactly one character", "tmp-?", "o/tmp-10", false],
    ["? matches exactly one character", "tmp-?", "o/tmp-", false],
    ["[abc] matches one of the set", "svc-[ab]", "o/svc-a", true],
    ["[abc] matches one of the set", "svc-[ab]", "o/svc-c", false],
    ["[!abc] matches one character outside the set", "svc-[!ab]", "o/svc-c", true],
    ["[!abc] matches one character outside the set", "svc-[!ab]", "o/svc-a", false],
    ["a leading ! negates the whole pattern", "!svc-*", "o/tooling", true],
    ["a leading ! negates the whole pattern", "!svc-*", "o/svc-a", false],
    ["a leading ! negates the whole pattern", "!octo/*", "octo/x", false],
    ["a leading ! negates the whole pattern", "!octo/*", "other/x", true],
    ["* around a literal dot spans an empty run too (no fast path)", "*.*", "o/archive.", true],
    ["* around a literal dot spans an empty run too (no fast path)", "*.*", "o/.github", true],
    ["* around a literal dot spans an empty run too (no fast path)", "*.*", "o/archive", false],
  ])("%s: %p against %p is %p", (_rule, pattern, slug, matches) => {
    expect(excludeMatches(compiled(pattern), slug)).toBe(matches);
  });

  test("the compiled entry keeps the operator's text for the skip notice and the scope its slash chose", () => {
    expect(compiled("TMP-*")).toMatchObject({ pattern: "TMP-*", scope: "name" });
    expect(compiled("octo/*")).toMatchObject({ pattern: "octo/*", scope: "slug" });
  });

  test("an accepted pattern is compiled once: the engine step's regex is the one kept", () => {
    const makeRe = spyOn(picomatch, "makeRe");
    try {
      expect(compileExcludePattern("svc-[ab]").isOk()).toBe(true);
      expect(makeRe).toHaveBeenCalledTimes(1);
    } finally {
      makeRe.mockRestore();
    }
  });

  // Every flaw of one pattern is named at once, each sentence one fix, in the order the fixes apply.
  const DOT_SLASH = 'it starts with "./", which names no owner, so drop every leading "./"';
  const STARS =
    'it holds a run of stars, which matches no more than one "*" does, so write one "*"';
  test.each<[string, string]>([
    ["./tmp-**", `${DOT_SLASH}, and ${STARS}`],
    ["!./", `${DOT_SLASH}, and "!" has nothing to negate`],
    ["././x", DOT_SLASH],
    [
      " ./x/. ",
      `it is wrapped in whitespace, so trim it, and ${DOT_SLASH}, and "." and ".." are never names`,
    ],
    ["  ", "it is wrapped in whitespace, so trim it, and it is empty"],
    [
      "./***x y",
      `it holds " ", which no owner or repository name contains, so remove it, and ${DOT_SLASH}, and ${STARS}`,
    ],
    ["a/**/c", `${STARS}, and it takes at most one "/", with a non-empty glob on each side of it`],
    [
      "[**]",
      'the class "[**]" takes name characters only, so write it as "[]", and the class "[]" matches nothing, ' +
        "so delete it, and it is empty",
    ],
    [
      "svc-(a)+",
      'it holds "(", ")", "+", which no owner or repository name contains, so remove them',
    ],
    [
      `!./${"a".repeat(65_536)}`,
      `${DOT_SLASH}, and it is 65537 characters long, past the cap of 65536, so shorten it`,
    ],
    [
      `./${"a".repeat(65_536)}[z-a]`,
      `the class "[z-a]" has the backwards range "z-a", so write it as "[a-z]", and ${DOT_SLASH}, and it is ` +
        "65541 characters long, past the cap of 65536, so shorten it",
    ],
    [
      "./[z-*]",
      `the class "[z-*]" takes name characters only, so write it as "[z-]", and ${DOT_SLASH}`,
    ],
    [
      "svc-[!z-a0-9]",
      'the class "[!z-a0-9]" has the backwards range "z-a", so write it as "[!a-z0-9]"',
    ],
    [
      "[0a--]",
      'the class "[0a--]" has a "-" where it reads as a range operator, so write it as "[0a-]"',
    ],
    ["[-z-a]", 'the class "[-z-a]" has the backwards range "z-a", so write it as "[-a-z]"'],
    [
      "[9-0a--]",
      'the class "[9-0a--]" has a "-" where it reads as a range operator, so write it as "[9-0a-]", and ' +
        'the class "[9-0a-]" has the backwards range "9-0", so write it as "[0-9a-]"',
    ],
    [
      "[z-a_-.]",
      'the class "[z-a_-.]" has the backwards range "z-a" and "_-.", so write it as "[a-z.-_]"',
    ],
    [
      "!!./tmp-**",
      `its "!" at 1 neither negates nor opens a class, so remove it, and ${DOT_SLASH}, and ${STARS}`,
    ],
    [
      "x/.!",
      'its "!" at 3 neither negates nor opens a class, so remove it, and "." and ".." are never names',
    ],
    ["[a/b]", 'its "[" at 0 and "]" at 4 have no partner, so remove them'],
    ["*[]*", `the class "[]" matches nothing, so delete it, and ${STARS}`],
    ["[]./x", `the class "[]" matches nothing, so delete it, and ${DOT_SLASH}`],
    ["svc-[ab", 'its "[" at 4 has no partner, so remove it'],
    [
      "x[!a",
      'its "[" at 1 has no partner, so remove it, and its "!" at 1 neither negates nor opens a class, so remove it',
    ],
  ])("%p is refused naming every flaw", (pattern, reason) => {
    expect(compileExcludePattern(pattern)).toEqual(
      err({ code: "input-exclude-pattern-invalid", pattern, reason }),
    );
  });

  test("a stray quote or backslash is quoted so it stays distinguishable from the punctuation", () => {
    expect(compileExcludePattern('svc-"a"')).toEqual(
      err({
        code: "input-exclude-pattern-invalid",
        pattern: 'svc-"a"',
        reason: 'it holds "\\"", which no owner or repository name contains, so remove it',
      }),
    );
    const slash = compileExcludePattern("svc-\\d");
    expect(slash.isErr() && slash.error.reason).toBe(
      'it holds "\\\\", which no owner or repository name contains, so remove it',
    );
    const problem = compileExcludePattern('svc-"a"');
    expect(problem.isErr() && describeProblem(problem.error)).toContain(
      'the "exclude" input pattern "svc-\\"a\\"" is not a usable glob',
    );
  });

  // A refusal is a program: each sentence names one fix a machine can apply (so a reader can too), in order, and
  // the result is accepted or carries only what the user has to write (an empty body, the sides around a "/", a
  // side that is only dots, a shorter pattern), every one of which the first refusal named already. If a
  // sentence has no machine fix and is not one of those, it is not a fix, and the applier throws.
  const REMAINDERS = [
    /^it is empty$/,
    /^"!" has nothing to negate$/,
    /^it takes at most one "\/"/,
    /^"\." and "\.\." are never names$/,
    /^it is \d+ characters long, past the cap/,
    /^it compiles to a regular expression the runtime refuses/,
  ];
  const isRemainder = (sentence: string): boolean =>
    REMAINDERS.some((remainder) => remainder.test(sentence));
  const quoted = (text: string): string[] =>
    [...text.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  const applyFix = (view: string, sentence: string): string => {
    if (sentence.startsWith("it is wrapped in whitespace")) {
      return view.trim();
    }
    if (sentence.startsWith("it holds a run of stars")) {
      return view.replace(/\*{2,}/g, "*");
    }
    if (sentence.startsWith("it holds ")) {
      const chars = quoted(sentence.slice(0, sentence.indexOf(", which")));
      return view
        .split("")
        .filter((char) => !chars.includes(char))
        .join("");
    }
    if (sentence.startsWith("its ")) {
      const where = [...sentence.matchAll(/ at (\d+)/g)].map((m) => Number(m[1]));
      return view
        .split("")
        .filter((_, i) => !where.includes(i))
        .join("");
    }
    if (sentence.startsWith('it starts with "./"')) {
      return view.replace(/^(!?)(?:\.\/)+/, "$1");
    }
    if (sentence.startsWith("the class ")) {
      const parts = quoted(sentence);
      const cls = parts[0] ?? "";
      return view.replace(cls, sentence.endsWith("so delete it") ? "" : (parts.at(-1) ?? ""));
    }
    if (isRemainder(sentence)) {
      return view;
    }
    throw new Error(`no machine fix for: ${sentence}`);
  };
  const oneRound = (pattern: string): void => {
    const first = compileExcludePattern(pattern);
    if (first.isOk()) {
      return;
    }
    const sentences = first.error.reason.split(", and ");
    const second = compileExcludePattern(sentences.reduce(applyFix, pattern));
    if (second.isErr()) {
      for (const left of second.error.reason.split(", and ")) {
        const shown = JSON.stringify(pattern).slice(0, 80);
        const detail = `${shown} left "${left}" after: ${first.error.reason.slice(0, 400)}`;
        expect(isRemainder(left), detail).toBe(true);
        expect(sentences, detail).toContain(left);
      }
    }
  };
  test.each([
    "!!./tmp-**",
    "x/.!",
    "./***x y",
    "a/**/c",
    "[**]",
    "./[z-*]",
    "[0a--]",
    "[-a---b]",
    "!./",
    "./",
    "x[!a",
    "[a/b]",
    "[[a]]",
    `./${"a".repeat(65_536)}[z-a]`,
    `!./${"a".repeat(65_536)}`,
    "*[]*",
    "[]./x",
    `./${"?".repeat(60_000)}`,
  ])("the fixes named for %p apply in one round", oneRound);
  // Builder controls ran the same generator at 4000 patterns (seed 20261005, with a 65,540-character piece) and
  // 50,000 patterns (seed 0x9e3779b9, 96 pieces, up to 12 per pattern); the committed set stays small.
  test("the fixes named for 300 generated patterns apply in one round", () => {
    const pieces = [
      "tmp",
      "svc-a",
      ".github",
      "*",
      "**",
      "***",
      "?",
      "./",
      "././",
      "!",
      "!!",
      "^",
      "/",
      "..",
      ".",
      "(",
      "+",
      " ",
      "\\",
      '"',
      "[",
      "]",
      "[ab]",
      "[!ab]",
      "[z-a]",
      "[a*]",
      "[]",
      "[!]",
      "[0a--]",
      "[--a]",
      "[-a-]",
      "[a-z-9]",
      "[[a]]",
      "[9-0_-.]",
      "-",
      "_",
    ];
    let seed = 20261005;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 300; n++) {
      const count = 1 + (next() % 5);
      let pattern = "";
      for (let i = 0; i < count; i++) {
        pattern += pieces[next() % pieces.length];
      }
      oneRound(pattern);
    }
  });

  // Every row is a pattern picomatch itself would accept or refuse with its own words, several compiled to a wrong
  // or never-matching regex: "(a)+" a quantifier, "\d" a digit class, "{az..bz}" a range, a leading "./" dropped,
  // "***a." with the dot unescaped, "!!" an empty body, "[a/b]" a class across the slash, "[z-a]" and the length
  // cap thrown as regex errors. A pattern is the user's input, so each is refused naming the fix, never repaired.
  test.each<[string, string]>([
    [" tmp-* ", "trim it"],
    ["tmp-*\n", "trim it"],
    ["svc-(a)+", 'it holds "("'],
    ["svc-\\d", 'it holds "\\\\"'],
    ["svc-{az..bz}", 'it holds "{"'],
    ['svc-"a"', 'it holds "\\""'],
    ["a|b", 'it holds "|"'],
    ["tmp x", 'it holds " "'],
    ["a/b/c", 'at most one "/"'],
    ["octo/", 'at most one "/"'],
    ["/repo", 'at most one "/"'],
    ["./tmp-*", 'drop every leading "./"'],
    ["!./svc-*", 'drop every leading "./"'],
    ["./", 'drop every leading "./"'],
    ["!", "nothing to negate"],
    ["!/x", 'at most one "/"'],
    ["x/..", '"." and ".." are never names'],
    ["x/.", '"." and ".." are never names'],
    ["tmp-**", 'write one "*"'],
    ["***a.", 'write one "*"'],
    ["o/**", 'write one "*"'],
    ["!!svc-*", "neither negates nor opens a class"],
    ["a!b", "neither negates nor opens a class"],
    ["^a", 'its "^" at 0 neither negates nor opens a class'],
    ["[a/b]", "have no partner"],
    ["svc-[ab", "has no partner"],
    ["[]", 'the class "[]" matches nothing, so delete it'],
    ["[*]", 'the class "[*]" takes name characters only'],
    ["[z-a]", 'has the backwards range "z-a"'],
    ["a".repeat(70_000), "past the cap of 65536, so shorten it"],
  ])(
    "%p is refused with the reason, not thrown or compiled to something else",
    (pattern, reason) => {
      const result = compileExcludePattern(pattern);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({ code: "input-exclude-pattern-invalid", pattern });
        expect(result.error).toHaveProperty("reason", expect.stringContaining(reason));
      }
    },
  );
});

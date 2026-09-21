import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { GENERATED_OUTPUTS, generatedPaths } from "../../.github/scripts/generated.js";
import { ROOT } from "../root.js";

/**
 * auto-fix.yml enumerates the generated outputs by hand four times (the trigger paths, the build job's `git add`,
 * the push job's `case` allowlist and its error message) and runs the generators by hand once. Each list is a
 * security boundary, so it stays literal in the workflow; this test pins every list to GENERATED_OUTPUTS, the one
 * table the generators derive, so a newly registered output cannot slip past the workflow.
 *
 * The lists are read with regexes over the two `run:` scripts, `#` lines stripped, as the workflow writes them
 * today: one `git add -A --` command whose paths continue over `\`-newlines, and one `case "$path" in` with one
 * accepting arm before `*)`. A parse yields an empty list unless its shape occurs exactly once among the live
 * commands, so a second staging command or accepting arm, a commented-out command, or a rewrite of either shape
 * fails the "parser sees both allowlists" test instead of passing on the copy the regex happened to find.
 */

const WORKFLOW_PATH = ".github/workflows/auto-fix.yml";
const workflow = parse(readFileSync(join(ROOT, WORKFLOW_PATH), "utf8")) as {
  on: { pull_request: { paths: string[] } };
  jobs: Record<"build" | "push", { steps: { id?: string; run?: string }[] }>;
};
const scripts = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

const triggerPaths = workflow.on.pull_request.paths;
const rebuildRun = workflow.jobs.build.steps.find((step) => step.id === "rebuild")?.run ?? "";
const pushRun = workflow.jobs.push.steps.find((step) => step.id === "push")?.run ?? "";

/** Splits a shell word list that may continue over `\`-newlines. */
function words(text: string): string[] {
  return text
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** A `git add` inside a `#` comment is not a staging command. */
function live(script: string): string {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** A second `git add`, however spaced, would stage around the allowlist, so it empties the list. */
function stagedPaths(script: string): string[] {
  const commands = live(script);
  if ((commands.match(/\bgit\s+add\b/g) ?? []).length !== 1) return [];
  return words(/git add -A -- ((?:[^\n\\]|\\\n)+)/.exec(commands)?.[1] ?? "");
}

/** The patterns of the push script's one `case` statement's one accepting arm before `*)`. A second arm there, a
 * second `case` anywhere (nested inside the default arm, it would accept before the error), or any `git add` (the
 * patch is the push job's only route into the index) empties the list. */
function admittedPatterns(script: string): string[] {
  const commands = live(script);
  if (/\bgit\s+add\b/.test(commands) || (commands.match(/\bcase\s/g) ?? []).length !== 1) return [];
  const arms = /case "\$path" in\n([\s\S]*?)^\s*\*\)/m.exec(commands)?.[1] ?? "";
  if ((arms.match(/;;/g) ?? []).length !== 1) return [];
  return words(arms.replace(/\)\s*;;\s*$/, "")).filter((word) => word !== "|");
}

const gitAddPaths = stagedPaths(rebuildRun);
const casePatterns = admittedPatterns(pushRun);
const errorMessage = /::error::([\s\S]*?)refusing to push/.exec(pushRun)?.[1] ?? "";

/** `dir/` stages everything under dir, deletions included. A `dir/*` glob would not: the shell expands it to the
 * files that still exist before git runs, so a gap file the graduation deleted would stay out of the patch. */
function staged(entry: string, path: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : entry === path;
}

/** `dir/*` admits everything under dir: an unquoted case pattern's `*` matches `/` too. */
function admitted(pattern: string, path: string): boolean {
  return pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

const paths = generatedPaths();
const generators = [...new Set(GENERATED_OUTPUTS.map((output) => output.generator))];

describe("auto-fix.yml tracks the generated-output table", () => {
  test("the parser sees both allowlists, and they name the same paths", () => {
    expect(gitAddPaths.length).toBeGreaterThan(0);
    expect(casePatterns.length).toBeGreaterThan(0);
    expect(gitAddPaths.map((entry) => (entry.endsWith("/") ? `${entry}*` : entry)).sort()).toEqual(
      [...casePatterns].sort(),
    );
  });

  // Each mutation leaves the original lines in place, so a parser taking the first regex match still returns the
  // original list: the extra command or arm sits behind the match, and a commented-out command matches inside it.
  test.each([
    [
      "a second git add in the rebuild step",
      () => stagedPaths(`${rebuildRun}git add -A -- package.json\n`),
    ],
    [
      "a second git add spaced past the word boundary",
      () => stagedPaths(`${rebuildRun}git  add -A -- package.json\n`),
    ],
    [
      "the git add commented out",
      () => stagedPaths(rebuildRun.replace(/^(\s*)(git add -A --)/m, "$1# $2")),
    ],
    [
      "a second accepting arm before *)",
      () => admittedPatterns(pushRun.replace(/^(\s*)\*\)/m, "$1package.json) ;;\n$1*)")),
    ],
    [
      "a git add in the push script before its commit",
      () =>
        admittedPatterns(
          pushRun.replace(/^(\s*)git commit /m, "$1git add -A -- package.json\n$1git commit "),
        ),
    ],
    [
      "a nested case accepting inside the default arm",
      () =>
        admittedPatterns(
          pushRun.replace(
            /^(\s*)\*\)\n/m,
            '$1*)\n$1  case "$path" in package.json) continue ;; esac\n',
          ),
        ),
    ],
  ])("%s empties the parsed list", (_, mutated) => {
    expect(mutated()).toEqual([]);
  });

  test("every generated output is staged by the build job and admitted by the push job", () => {
    for (const path of paths) {
      expect(
        gitAddPaths.some((entry) => staged(entry, path)),
        `git add: ${path}`,
      ).toBe(true);
      expect(
        casePatterns.some((pattern) => admitted(pattern, path)),
        `case: ${path}`,
      ).toBe(true);
    }
  });

  test("every allowlist entry covers a generated output, and the error message names each entry", () => {
    for (const pattern of casePatterns) {
      expect(
        paths.some((path) => admitted(pattern, path)),
        pattern,
      ).toBe(true);
      // A `dir/*` arm reads as `dir/` in the message.
      expect(errorMessage, pattern).toContain(pattern.replace(/\*$/, ""));
    }
  });

  test("a hand edit to a generated output or its generator triggers the fix", () => {
    for (const path of [...paths, ...generators]) {
      expect(
        triggerPaths.some((pattern) => new Bun.Glob(pattern).match(path)),
        `on.paths: ${path}`,
      ).toBe(true);
    }
  });

  test("the rebuild step runs exactly the generators, in table order", () => {
    // The graduation step regenerates the gaps index only when a gap graduates, so the index generator runs here
    // too. `bun run build:x` resolves through package.json to the script it runs.
    const run = [...rebuildRun.matchAll(/^\s*bun (run )?(\S+)$/gm)].map(([, viaScript, name]) =>
      viaScript === undefined ? name : /^bun (\S+)$/.exec(scripts[name ?? ""] ?? "")?.[1],
    );
    expect(run).toEqual(generators);
  });
});

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
 * The lists are read with regexes over the two `run:` scripts as the workflow writes them today: one `git add -A --`
 * command whose paths continue over `\`-newlines, and one `case "$path" in` whose first arm is the allowlist. A
 * rewrite of either shape fails here as an empty list, never as a silent pass.
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

const gitAddPaths = words(/git add -A -- ((?:[^\n\\]|\\\n)+)/.exec(rebuildRun)?.[1] ?? "");
const casePatterns = words(/case "\$path" in\n([\s\S]*?)\) ;;/.exec(pushRun)?.[1] ?? "").filter(
  (word) => word !== "|",
);
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

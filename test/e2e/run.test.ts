import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const RUN = join(ROOT, "test", "e2e", "run.ts");
const USAGE = "the flags are --sections <key,key|all>, --scenario <name>, --print-stdout";

/** A runner that does not refuse at the entry is into the corpus with a node child under it, so the bound kills the
 * process group, not one pid, and the scenario directories it leaves land in the case's own TMPDIR. */
function run(
  args: string[],
): Promise<{ exitCode: number | string | null; stdout: string; stderr: string }> {
  return withTempDir(
    "run-flags-",
    (tmp) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [RUN, ...args], {
          cwd: ROOT,
          env: { ...process.env, TMPDIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        const bound = setTimeout(() => {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        }, 10_000);
        child.on("close", (code, signal) => {
          clearTimeout(bound);
          resolve({ exitCode: code ?? signal, stdout, stderr });
        });
      }),
  );
}

// A parser that ignores what it does not recognize lets a typo'd flag, an inline `--sections=labels`, or a stray word
// run the whole corpus for minutes and exit green. Each case is an input the shell cannot refuse for the script; the
// wording of all but the empty list is parseArgs's own, so a row pins the word the refusal names, not the sentence.
test.each<[label: string, args: string[], named: string]>([
  ["--sections with no value", ["--sections"], "'--sections <value>'"],
  ["--scenario with no value", ["--scenario"], "'--scenario <value>'"],
  [
    "--sections with an empty list",
    ["--sections", " , "],
    "--sections got an empty list; name at least one section, or all",
  ],
  // The later "all" would otherwise clear the filter and run the corpus over a list that named nothing.
  [
    "an earlier --sections with an empty list",
    ["--sections", "", "--sections", "all"],
    "--sections got an empty list; name at least one section, or all",
  ],
  ["a misspelled flag", ["--section", "labels"], "'--section'"],
  // A "--" or a flag standing where the value belongs must not become the value: here the later "all" would clear
  // the filter and run the corpus.
  ["--sections swallowing a --", ["--sections", "--", "--sections", "all"], "'--sections'"],
  ["--sections swallowing the next flag", ["--sections", "--print-stdout"], "'--sections'"],
  ["a stray argument", ["labels"], "'labels'"],
  // bun drops a "--" that directly follows the script path, so the row puts a flag ahead of it.
  ["the flags after a --", ["--print-stdout", "--", "--sections", "labels"], "'--sections'"],
  ["--print-stdout with a value", ["--print-stdout=yes"], "'--print-stdout'"],
])(
  "%s is refused at the entry, naming the flag and the fix",
  async (_label, args, named) => {
    const { stderr, ...rest } = await run(args);
    expect(rest).toEqual({ exitCode: 2, stdout: "" });
    expect(stderr).toStartWith("e2e: ");
    expect(stderr).toContain(named);
    expect(stderr).toEndWith(`; ${USAGE}\n`);
  },
  20_000,
);

// A filter nothing matches exits 1 before any scenario runs, and its message echoes the filters as parsed, so the
// two parsings a hand walk gets wrong (an inline value, a later `all`) are pinned without running the corpus.
test.each<[label: string, args: string[], filters: string]>([
  [
    "--sections=<key> is read as the flag's value",
    ["--sections=no-such-section"],
    '--sections "no-such-section"',
  ],
  [
    "a later --sections all clears the list",
    ["--scenario", "no-such-scenario", "--sections", "labels", "--sections", "all"],
    '--scenario "no-such-scenario"',
  ],
])(
  "%s",
  async (_label, args, filters) => {
    const result = await run(args);
    expect([result.exitCode, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toMatch(
      new RegExp(
        `^none of the \\d+ scenario\\(s\\) under .* match ${filters.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; check`,
      ),
    );
  },
  20_000,
);

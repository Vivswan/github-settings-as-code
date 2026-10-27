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

// The hand-rolled parser these replaced ignored every argument it did not recognize, so a typo'd flag, an inline
// `--sections=labels`, or a stray word ran the whole corpus for minutes and exited green. Each case is an input
// the shell cannot refuse for the script.
test.each<[label: string, args: string[], error: string]>([
  ["--sections with no value", ["--sections"], `--sections needs a value; ${USAGE}`],
  ["--scenario with no value", ["--scenario"], `--scenario needs a value; ${USAGE}`],
  [
    "--sections with an empty list",
    ["--sections", " , "],
    `--sections got an empty list; name at least one section, or all; ${USAGE}`,
  ],
  ["a misspelled flag", ["--section", "labels"], `unknown flag --section; ${USAGE}`],
  // parseArgs hands a string flag the next word whatever it is, so a "--" or a flag standing where the value
  // belongs would otherwise become the value: here the later "all" would clear the filter and run the corpus.
  [
    "--sections swallowing a --",
    ["--sections", "--", "--sections", "all"],
    `--sections needs a value; ${USAGE}`,
  ],
  [
    "--sections swallowing the next flag",
    ["--sections", "--print-stdout"],
    `--sections needs a value; ${USAGE}`,
  ],
  ["a stray argument", ["labels"], `unexpected argument "labels"; ${USAGE}`],
  // bun drops a "--" that directly follows the script path, so the row puts a flag ahead of it.
  [
    "a -- and the flags after it",
    ["--print-stdout", "--", "--sections", "labels"],
    `unexpected argument "--"; ${USAGE}`,
  ],
  [
    "--print-stdout with a value",
    ["--print-stdout=yes"],
    `--print-stdout takes no value; ${USAGE}`,
  ],
])(
  "%s is refused at the entry, naming the flag and the fix",
  async (_label, args, error) => {
    expect(await run(args)).toEqual({ exitCode: 2, stdout: "", stderr: `e2e: ${error}\n` });
  },
  20_000,
);

// A filter nothing matches exits 1 before any scenario runs, and its message echoes the filters as parsed, so the
// two parsings the old code got wrong (an inline value, a later `all`) are pinned without running the corpus.
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

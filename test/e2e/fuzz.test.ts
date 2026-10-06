import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const FUZZ = join(ROOT, "test", "e2e", "fuzz.ts");
const USAGE = "the flags are --iterations <count>, --seed <seed>, --sections <key,key>";
const SEED_FIX = "pass the whole number from 0 to 4294967295 the fuzzer printed";
const COUNT_FIX = "pass a whole number from 0 to 4294967295 (0 runs the directed battery alone)";

/** A fuzzer that does not refuse at the entry is mid-soak with a scenario runner's node child under it, so the bound
 * kills the process group, not one pid, and the scenario directories it leaves land in the case's own TMPDIR. */
function fuzz(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number | string | null; stdout: string; stderr: string }> {
  return withTempDir(
    "fuzz-flags-",
    (tmp) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [FUZZ, ...args], {
          cwd: ROOT,
          env: Object.fromEntries(
            Object.entries({ ...process.env, FUZZ_SEED: undefined, TMPDIR: tmp, ...env }).filter(
              ([, value]) => value !== undefined,
            ),
          ) as Record<string, string>,
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

// `Number("abc")` is NaN, and a NaN iteration count ran zero iterations and exited green; a NaN seed silently drew a
// random one. Each case is an input the shell cannot refuse for the script.
test.each<[label: string, args: string[], env: Record<string, string>, error: string]>([
  [
    "--iterations abc",
    ["--iterations", "abc"],
    {},
    `--iterations "abc" is not a count; ${COUNT_FIX}`,
  ],
  ["--iterations=-1", ["--iterations=-1"], {}, `--iterations "-1" is not a count; ${COUNT_FIX}`],
  ["--iterations with no value", ["--iterations"], {}, `--iterations needs a value; ${USAGE}`],
  [
    "--iterations past uint32",
    ["--iterations", "4294967296"],
    {},
    `--iterations "4294967296" is not a count; ${COUNT_FIX}`,
  ],
  [
    "--seed abc",
    ["--seed", "abc", "--iterations", "1"],
    {},
    `--seed "abc" is not a seed; ${SEED_FIX}`,
  ],
  [
    "--seed past uint32",
    ["--seed", "4294967296"],
    {},
    `--seed "4294967296" is not a seed; ${SEED_FIX}`,
  ],
  [
    "FUZZ_SEED=abc",
    ["--iterations", "1"],
    { FUZZ_SEED: "abc" },
    `FUZZ_SEED "abc" is not a seed; ${SEED_FIX}`,
  ],
  ["a misspelled flag", ["--iteration", "5"], {}, `unknown flag --iteration; ${USAGE}`],
  ["a stray argument", ["--iterations", "1", "extra"], {}, `unexpected argument "extra"; ${USAGE}`],
])(
  "%s is refused at the entry, naming the flag and the fix",
  async (_label, args, env, error) => {
    expect(await fuzz(args, env)).toEqual({ exitCode: 2, stdout: "", stderr: `fuzz: ${error}\n` });
  },
  20_000,
);

/**
 * The one command wrapper of .github/scripts: the status a shell would report for each way a command ends, where
 * each stream lands, the refusal `must` throws, and that no other script spawns a process on its own.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { command, output } from "../../.github/scripts/lib/command.js";
import { withTempDir } from "../temp-dir.js";

const SCRIPTS = join(import.meta.dir, "..", "..", ".github", "scripts");

describe("command", () => {
  // Callers branch on these numbers (git's 1 for "no", ls-remote's 2); a signal or a missing program read as 0 or 1
  // would pass for one of them.
  test.each<[label: string, argv: string[], status: number]>([
    ["an exit code is the status", ["sh", "-c", "exit 3"], 3],
    ["a signal is 128 plus its number", ["sh", "-c", "kill -TERM $$"], 143],
    ["a program that cannot start is 127", ["no-such-program-for-this-test"], 127],
  ])("%s", (_label, argv, status) => {
    expect(command(argv).status).toBe(status);
  });

  // tryGit discards stderr to stay silent on a missing path: a reason written past that choice lands on the
  // release log for every absent file.
  test("a program that cannot start writes its reason where stderr was sent, and nowhere else", () =>
    withTempDir("command-", (dir) => {
      const file = join(dir, "log");
      const ran = command(["no-such-program-for-this-test"], {
        stdout: { file },
        stderr: "stdout",
      });
      expect(ran).toEqual({ status: 127, stdout: "", stderr: "" });
      expect(readFileSync(file, "utf8")).toStartWith("no-such-program-for-this-test: ");
    }));

  test("captured streams come back whole, each on its own side", () => {
    expect(command(["sh", "-c", "printf ' out \\n\\n'; printf 'err\\n' >&2; exit 1"])).toEqual({
      status: 1,
      stdout: " out \n\n",
      stderr: "err\n",
    });
  });

  test("a stdin text is read to its end, and added variables reach the command", () => {
    const ran = command(["sh", "-c", 'cat; printf "%s" "$ADDED"'], {
      stdin: { text: "piped\n" },
      env: { ADDED: "yes" },
    });
    expect(ran.stdout).toBe("piped\nyes");
  });

  test("a file takes stdout, and stderr with it when sent to stdout, in arrival order", () =>
    withTempDir("command-", (dir) => {
      const file = join(dir, "log");
      const ran = command(["sh", "-c", "echo one; echo two >&2; echo three"], {
        stdout: { file },
        stderr: "stdout",
      });
      expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
    }));

  test("the command runs in the directory named", () =>
    withTempDir("command-", (dir) => {
      expect(output(["sh", "-c", 'basename "$PWD"'], { cwd: dir })).toBe(
        dir.split("/").at(-1) ?? "",
      );
    }));
});

describe("output", () => {
  test("output is stdout as $(...) yields it: only the trailing newlines go", () => {
    expect(output(["printf", " a \\n\\n"])).toBe(" a ");
  });
});

// A second spawn helper beside the wrapper brings back a second failure shape for the same failure.
test("no script under .github/scripts spawns a process outside lib/command.ts", () => {
  const spawning = /\bchild_process\b|\bBun\s*\.\s*(spawn|spawnSync|\$)/;
  const offenders = [...new Bun.Glob("**/*.ts").scanSync(SCRIPTS)]
    .filter((path) => path !== "lib/command.ts")
    .filter((path) => spawning.test(readFileSync(join(SCRIPTS, path), "utf8")));
  expect(offenders).toEqual([]);
});

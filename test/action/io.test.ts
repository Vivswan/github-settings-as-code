import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionsIo } from "../../src/action/io.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** A static import, a re-export, a dynamic import(), or a require() all quote the specifier; a comment mentioning it bare does not. */
function namesActionsCore(source: string): boolean {
  return /["']@actions\/core["']/.test(source);
}

describe("the Io port boundary", () => {
  // The detector's controls: every way a module can name the package, and the two mentions that must not count.
  test.each([
    ['import * as core from "@actions/core";', true],
    ["import { debug } from '@actions/core';", true],
    ['export { setSecret } from "@actions/core";', true],
    ['const core = await import("@actions/core");', true],
    ['const core = require("@actions/core");', true],
    ["// the action layer implements it over @actions/core", false],
    ['import { retry } from "@octokit/plugin-retry";', false],
  ])("the specifier check classifies %j as %p", (source, named) => {
    expect(namesActionsCore(source)).toBe(named);
  });

  test("only src/action/ names @actions/core", () => {
    // Every other layer reaches the runner through the Io port, so redaction and capture have one place to stand.
    const srcDir = join(ROOT, "src");
    const files = readdirSync(srcDir, { recursive: true }) as string[];
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (!file.endsWith(".ts") || file.split(/[\\/]/)[0] === "action") {
        continue;
      }
      scanned += 1;
      if (namesActionsCore(readFileSync(join(srcDir, file), "utf8"))) {
        offenders.push(`src/${file}`);
      }
    }
    expect(offenders).toEqual([]);
    // The scan saw the tree (a wrong root would pass vacuously), and the check tells an import from a mention:
    // the action's Io imports the package, the CLI's runner face only names it in its header.
    expect(scanned).toBeGreaterThan(50);
    expect(namesActionsCore(readFileSync(join(srcDir, "action", "io.ts"), "utf8"))).toBe(true);
    const cliRunner = readFileSync(join(srcDir, "cli", "actions.ts"), "utf8");
    expect(cliRunner).toContain("@actions/core");
    expect(namesActionsCore(cliRunner)).toBe(false);
  });
});

describe("actionsIo", () => {
  const saved = {
    summary: process.env.GITHUB_STEP_SUMMARY,
    output: process.env.GITHUB_OUTPUT,
  };
  afterEach(() => {
    for (const [key, value] of [
      ["GITHUB_STEP_SUMMARY", saved.summary],
      ["GITHUB_OUTPUT", saved.output],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  test("summary appends each block with one trailing newline, and skips when the runner file is unset", () =>
    withTempDir("sac-io-", (dir) => {
      const file = join(dir, "summary.md");
      delete process.env.GITHUB_STEP_SUMMARY;
      actionsIo.summary("dropped");
      process.env.GITHUB_STEP_SUMMARY = file;
      actionsIo.summary("## first block");
      actionsIo.summary("| a |\n|---|");
      expect(readFileSync(file, "utf8")).toBe("## first block\n| a |\n|---|\n");
    }));

  test("output writes the runner's output file only when it is set, and never a stdout command", () =>
    withTempDir("sac-io-", (dir) => {
      // The runner creates the file; @actions/core refuses to append to a missing one. Without the file, @actions/core
      // would fall back to the retired ::set-output:: stdout command, so stdout is watched too.
      const file = join(dir, "output.txt");
      writeFileSync(file, "");
      delete process.env.GITHUB_OUTPUT;
      const chunks: string[] = [];
      const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        actionsIo.output("result", "dropped");
        // @ts-expect-error a misspelled output name fails to compile at the port
        actionsIo.output("reslut", "dropped");
      } finally {
        write.mockRestore();
      }
      expect(chunks).toEqual([]);
      process.env.GITHUB_OUTPUT = file;
      actionsIo.output("result", "clean");
      // @actions/core writes outputs in heredoc form: name<<DELIM / value / DELIM
      const written = readFileSync(file, "utf8");
      expect(written).toMatch(/^result<<[^\n]+\nclean\n[^\n]+\n$/);
      expect(written).not.toContain("dropped");
    }));

  test("mask registers the value in the registry masked() reads", () => {
    // One registry behind both: the API tracer reads masked() at runtime to redact what mask() registered.
    actionsIo.mask("o/private");
    expect(actionsIo.masked().has("o/private")).toBe(true);
  });
});

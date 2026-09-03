import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsIo } from "../../src/action/io.js";
import { writeSummary } from "../../src/action/summary.js";

/**
 * Whether `source` names the runner module as a module specifier - a static
 * import, a re-export, a dynamic import(), or a require() all quote it; a
 * comment mentioning it bare does not.
 */
function namesActionsCore(source: string): boolean {
  return /["']@actions\/core["']/.test(source);
}

describe("the Io port boundary", () => {
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
    // Every other layer reaches the runner through the Io port, so redaction
    // and capture have one place to stand. A new direct dependency anywhere
    // else is a leak this scan names.
    const srcDir = join(import.meta.dir, "..", "..", "src");
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
    // The scan saw the tree (a wrong root would pass vacuously), and the one
    // permitted importer is where the check expects it.
    expect(scanned).toBeGreaterThan(50);
    expect(namesActionsCore(readFileSync(join(srcDir, "action", "io.ts"), "utf8"))).toBe(true);
  });
});

describe("actionsIo", () => {
  const saved = {
    summary: process.env.GITHUB_STEP_SUMMARY,
    output: process.env.GITHUB_OUTPUT,
  };
  const dirs: string[] = [];
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
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "sac-io-"));
    dirs.push(dir);
    return dir;
  };

  test("summary appends each block with one trailing newline, and skips when the runner file is unset", () => {
    const file = join(scratch(), "summary.md");
    delete process.env.GITHUB_STEP_SUMMARY;
    actionsIo.summary("dropped");
    process.env.GITHUB_STEP_SUMMARY = file;
    writeSummary(
      actionsIo,
      [{ key: "repository", status: "drift", detail: ["has_wiki: true -> false"] }],
      "check",
    );
    actionsIo.summary("## second block");
    expect(readFileSync(file, "utf8")).toBe(
      [
        "## github-settings-as-code (check)",
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| repository | :warning: drift | has_wiki: true -> false |",
        "## second block",
        "",
      ].join("\n"),
    );
  });

  test("output writes the runner's output file only when it is set", () => {
    // The runner creates the file; @actions/core refuses to append to a missing one.
    const file = join(scratch(), "output.txt");
    writeFileSync(file, "");
    delete process.env.GITHUB_OUTPUT;
    actionsIo.output("result", "dropped");
    process.env.GITHUB_OUTPUT = file;
    actionsIo.output("result", "clean");
    // @actions/core writes outputs in heredoc form: name<<DELIM / value / DELIM
    const written = readFileSync(file, "utf8");
    expect(written).toMatch(/^result<<[^\n]+\nclean\n[^\n]+\n$/);
    expect(written).not.toContain("dropped");
  });

  test("mask registers the value in the readable registry", () => {
    actionsIo.mask("o/private");
    expect(actionsIo.masked().has("o/private")).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionsIo } from "../../src/action/io.js";
import { writeSummary } from "../../src/flows/summary.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** A static import, a re-export, a dynamic import(), or a require() all quote the specifier; a comment mentioning it bare does not. */
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
    // The scan saw the tree (a wrong root would pass vacuously).
    expect(scanned).toBeGreaterThan(50);
    expect(namesActionsCore(readFileSync(join(srcDir, "action", "io.ts"), "utf8"))).toBe(true);
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
      writeSummary(
        actionsIo,
        { outcomes: [{ key: "repository", status: "drift", detail: ["has_wiki: true -> false"] }] },
        "check",
        "drift",
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
    }));

  test("output writes the runner's output file only when it is set", () =>
    withTempDir("sac-io-", (dir) => {
      // The runner creates the file; @actions/core refuses to append to a missing one.
      const file = join(dir, "output.txt");
      writeFileSync(file, "");
      delete process.env.GITHUB_OUTPUT;
      actionsIo.output("result", "dropped");
      // @ts-expect-error a misspelled output name fails to compile at the port
      actionsIo.output("reslut", "dropped");
      process.env.GITHUB_OUTPUT = file;
      actionsIo.output("result", "clean");
      // @actions/core writes outputs in heredoc form: name<<DELIM / value / DELIM
      const written = readFileSync(file, "utf8");
      expect(written).toMatch(/^result<<[^\n]+\nclean\n[^\n]+\n$/);
      expect(written).not.toContain("dropped");
    }));

  test("mask registers the value in the readable registry", () => {
    actionsIo.mask("o/private");
    expect(actionsIo.masked().has("o/private")).toBe(true);
  });
});

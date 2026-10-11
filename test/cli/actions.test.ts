/**
 * The CLI under a GitHub Actions runner: the same Io calls the action's Io
 * makes produce the same workflow commands and the same runner files, so a
 * gsac step and the action step are one thing to the runner. The action side
 * runs the real @actions/core with its stdout captured; the CLI side runs the
 * Actions-mode Io over memory streams and files under a private temp dir.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionsIo } from "../../src/action/io.js";
import { actionsRunner } from "../../src/cli/actions.js";
import { cliIo, maskedStreams } from "../../src/cli/io.js";
import type { Io } from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { withTempDir } from "../temp-dir.js";
import { memoryStream, runCli } from "./streams.js";

const RUNNER_ENV = ["GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"] as const;
const saved = new Map(RUNNER_ENV.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** Every runner-facing channel once, with the characters the runner's escaping and heredoc forms exist for. */
function drive(io: Io): void {
  io.mask("ghp_secret");
  io.annotate("notice", "100% done\r\nnext line");
  io.annotate("warning", "skipped teams");
  io.annotate("error", "PATCH /repos/o/r failed: 500 boom");
  io.output("result", "partial");
  io.output("repos-result", '{\n  "o/r": { "result": "partial" }\n}');
  io.summary("## first");
  io.summary("| a |\n|---|");
}

/** @actions/core mints one random delimiter per record; the pin compares the records around it. */
function sameDelimiters(text: string): string {
  return text.replace(/ghadelimiter_[0-9a-f-]{36}/g, "ghadelimiter_<uuid>");
}

/** The action's Io over the real @actions/core, its stdout and runner files captured. */
function driveAction(dir: string): { stdout: string; output: string; summary: string } {
  const output = join(dir, "action-output.txt");
  const summary = join(dir, "action-summary.md");
  // @actions/core refuses to append to a missing GITHUB_OUTPUT; the runner creates it.
  writeFileSync(output, "");
  process.env.GITHUB_OUTPUT = output;
  process.env.GITHUB_STEP_SUMMARY = summary;
  const chunks: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    drive(actionsIo);
  } finally {
    write.mockRestore();
  }
  return {
    stdout: chunks.join(""),
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

/** The CLI's Io under the runner's environment, over memory streams and its own runner files. */
function driveCli(dir: string, summaryFile?: string) {
  const output = join(dir, "cli-output.txt");
  const summary = join(dir, "cli-summary.md");
  const stdout = memoryStream();
  const stderr = memoryStream();
  const runner = actionsRunner({
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  });
  const opened = cliIo({
    streams: maskedStreams({ stdout: stdout.stream, stderr: stderr.stream }, runner),
    json: false,
    verbose: true,
    colors: false,
    summaryFile,
  });
  return {
    ...opened,
    stdout: stdout.text,
    stderr: stderr.text,
    output: () => readFileSync(output, "utf8"),
    summary: () => readFileSync(summary, "utf8"),
  };
}

describe("the CLI under GitHub Actions", () => {
  test("the action's Io and the Actions-mode CLI Io emit the same commands and write the same runner files", () =>
    withTempDir("gsac-actions-", (dir) => {
      const action = driveAction(dir);
      const cli = driveCli(dir);
      drive(cli.io);
      expect(cli.stdout()).toBe(action.stdout);
      expect(action.stdout).toBe(
        [
          "::add-mask::ghp_secret",
          "::notice::100%25 done%0D%0Anext line",
          "::warning::skipped teams",
          "::error::PATCH /repos/o/r failed: 500 boom",
          "",
        ].join("\n"),
      );
      expect(cli.stderr()).toBe("");
      expect(sameDelimiters(cli.output())).toBe(sameDelimiters(action.output));
      expect(sameDelimiters(action.output)).toBe(
        [
          "result<<ghadelimiter_<uuid>",
          "partial",
          "ghadelimiter_<uuid>",
          "repos-result<<ghadelimiter_<uuid>",
          "{",
          '  "o/r": { "result": "partial" }',
          "}",
          "ghadelimiter_<uuid>",
          "",
        ].join("\n"),
      );
      // Each record's own delimiter, minted fresh, so a value can never close another record.
      const delimiters = [...cli.output().matchAll(/ghadelimiter_[0-9a-f-]{36}/g)].map((m) => m[0]);
      expect(delimiters).toHaveLength(4);
      expect(delimiters[0]).toBe(delimiters[1]);
      expect(delimiters[2]).toBe(delimiters[3]);
      expect(delimiters[0]).not.toBe(delimiters[2]);
      expect(cli.summary()).toBe(action.summary);
      expect(action.summary).toBe("## first\n| a |\n|---|\n");
    }));

  test("--summary <file> takes the summary from the runner's step summary; an unset GITHUB_OUTPUT drops the record", () =>
    withTempDir("gsac-actions-", (dir) => {
      const named = join(dir, "named.md");
      const cli = driveCli(dir, named);
      cli.io.summary("## named");
      expect(readFileSync(named, "utf8")).toBe("## named\n");
      expect(() => cli.summary()).toThrow(/ENOENT/);
      const stdout = memoryStream();
      const bare = cliIo({
        streams: maskedStreams(
          { stdout: stdout.stream, stderr: memoryStream().stream },
          actionsRunner({ GITHUB_ACTIONS: "true", GITHUB_OUTPUT: "" }),
        ),
        json: false,
        verbose: false,
        colors: false,
      });
      bare.io.output("result", "clean");
      bare.flush();
      expect(stdout.text()).toBe("result=clean\n");
    }));

  test("a masked value reaches stdout only inside its ::add-mask:: command, and never touches a command name", () =>
    withTempDir("gsac-actions-", (dir) => {
      const cli = driveCli(dir);
      cli.io.mask("ghp_secret");
      // A secret spelled like a level: the command name stays whole, the message's occurrence is redacted.
      cli.io.mask("error");
      cli.io.log("token ghp_secret in a log line");
      cli.io.annotate("error", "401 error for ghp_secret at 100%");
      cli.io.debug("Authorization: token ghp_secret");
      cli.io.summary("# run by ghp_secret");
      cli.io.output("result", "failed ghp_secret");
      cli.flush();
      const [maskSecret, maskError, ...rest] = cli.stdout().split("\n");
      expect(maskSecret).toBe("::add-mask::ghp_secret");
      expect(maskError).toBe("::add-mask::error");
      expect(rest.join("\n")).toBe(
        "token *** in a log line\n::error::401 *** for *** at 100%25\nresult=failed ***\n",
      );
      // The step outputs carry the raw value, as under the action: a later step reads them back, and the runner masks
      // their display through the add-mask command above. Every rendered channel is redacted.
      const everything = rest.join("\n") + cli.stderr() + cli.summary();
      expect(everything).not.toContain("ghp_secret");
      expect(cli.stderr()).toBe("debug: Authorization: token ***\n");
      expect(sameDelimiters(cli.output())).toBe(
        "result<<ghadelimiter_<uuid>\nfailed ghp_secret\nghadelimiter_<uuid>\n",
      );
      expect(cli.summary()).toBe("# run by ***\n");
    }));

  const REFUSAL =
    "cannot read settings from ***: Error: ENOENT: no such file or directory, open '***'. Check that the file " +
    'exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML\n';

  test.each([
    [
      "GITHUB_ACTIONS=true",
      { GITHUB_ACTIONS: "true" },
      { stdout: `::add-mask::ghp_token\n::error::${REFUSAL}`, stderr: "" },
    ],
    ["a terminal", {}, { stdout: "", stderr: `error: ${REFUSAL}` }],
  ])(
    "main() picks the face from the host environment: under %s the token's mask and the error land as the reader expects",
    async (_where, env, expected) => {
      const result = await runCli(["validate", "ghp_token"], new MockApi({}), {
        ...env,
        GITHUB_TOKEN: "ghp_token",
      });
      expect(result).toEqual({ code: 1, ...expected });
    },
  );
});

/**
 * The CLI under a GitHub Actions runner: the same Io calls the action's Io
 * makes produce the same workflow commands and the same runner files, so a
 * gsac step and the action step are one thing to the runner. The action side
 * runs the real @actions/core with its stdout captured; the CLI side runs the
 * Actions-mode Io over memory streams and files under a private temp dir.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionsIo } from "../../src/action/io.js";
import { actionsRunner } from "../../src/cli/actions.js";
import { cliIo, maskedStreams, openSummaryFile } from "../../src/cli/io.js";
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
  io.log('labels: created "a\r\nb##[error]c" at 100%');
  io.output("result", "partial");
  io.output("repos-result", '{\n  "o/r": { "result": "partial" }\n}');
  io.summary("## first");
  io.summary("| a |\n|---|");
}

/** @actions/core mints one random delimiter per record; the pin compares the records around it. */
function sameDelimiters(text: string): string {
  return text.replace(/ghadelimiter_[0-9a-f-]{36}/g, "ghadelimiter_<uuid>");
}

/** What the action's Io puts on stdout over the real @actions/core: its commands, and its log lines as console.log ends them. */
function actionStdout(calls: (io: Io) => void): string {
  const chunks: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const log = spyOn(console, "log").mockImplementation((line) => {
    chunks.push(`${line}\n`);
  });
  try {
    calls(actionsIo);
  } finally {
    write.mockRestore();
    log.mockRestore();
  }
  return chunks.join("");
}

/** The action's Io over the real @actions/core, its stdout and runner files captured. */
function driveAction(dir: string): { stdout: string; output: string; summary: string } {
  const output = join(dir, "action-output.txt");
  const summary = join(dir, "action-summary.md");
  // @actions/core refuses to append to a missing GITHUB_OUTPUT; the runner creates it.
  writeFileSync(output, "");
  process.env.GITHUB_OUTPUT = output;
  process.env.GITHUB_STEP_SUMMARY = summary;
  return {
    stdout: actionStdout(drive),
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

/** The CLI's Io under the runner's environment, over memory streams and its own runner files. */
function driveCli(dir: string, summaryFd?: number) {
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
    summaryFd,
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
          // One log line, the same from both faces: its line breaks are escaped at each sink, `##[` at the action's sink and
          // at the CLI's stream boundary, and `%` stays, since only a command's data is decoded.
          'labels: created "a%0D%0Ab%23%23[error]c" at 100%',
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

  // The runner reads two forms as a workflow command: `::` at the start of a line, after leading whitespace, and
  // `##[` anywhere in one. A name a settings file or GitHub supplied would issue either from the admin's run.
  test.each([
    [
      "a line feed before `::`",
      "x\n::error file=README.md,line=1::spoofed",
      "x%0A::error file=README.md,line=1::spoofed",
    ],
    [
      "CR LF before `::`",
      "x\r\n::error file=README.md,line=1::spoofed",
      "x%0D%0A::error file=README.md,line=1::spoofed",
    ],
    [
      "a lone CR before `::`",
      "x\r::error file=README.md,line=1::spoofed",
      "x%0D::error file=README.md,line=1::spoofed",
    ],
    ["`##[` and no line break", "x##[error]spoofed", "x%23%23[error]spoofed"],
    ["both forms", "x\n::error::a##[error]b", "x%0A::error::a%23%23[error]b"],
  ])(
    "a logged name holding %s is one line of plain text on both faces, so the runner reads no command in it",
    (_form, name, escaped) =>
      withTempDir("gsac-actions-", (dir) => {
        const logs = (io: Io): void => {
          io.log(`drift: labels["${name}"]: missing`);
          io.log("result: drift");
        };
        const cli = driveCli(dir);
        logs(cli.io);
        for (const stdout of [actionStdout(logs), cli.stdout()]) {
          const lines = stdout.split(/\r\n|\r|\n/);
          expect(lines).toEqual([`drift: labels["${escaped}"]: missing`, "result: drift", ""]);
          const commands = lines.filter(
            (line) => line.trimStart().startsWith("::") || line.includes("##["),
          );
          expect(commands).toEqual([]);
        }
      }),
  );

  // The runner reads `##[` as a command anywhere in a line, so under one the stream rewrites it in every chunk that is
  // not a finished command, whichever write carried it. A write added later is covered without wrapping it.
  test.each<[string, Record<string, string>, (name: string, problem: string) => string[][]]>([
    [
      "under a runner the log, the debug trace, and the --json envelope lose `##[`, and a finished command keeps its text",
      { GITHUB_ACTIONS: "true" },
      (_name, problem) => [
        [
          "::add-mask::ghp_secret",
          `::error::${problem}`,
          '{"result":"failed","problem":"labels[1].name: \\"x%23%23[error]y\\" names the same label"}',
        ],
        [
          'labels: created label "x%23%23[error]y"',
          'debug: POST /repos/o/r/labels -> 201 payload: {"name":"x%23%23[error]y"}',
        ],
      ],
    ],
    [
      "on a terminal, where nothing reads commands, the same writes arrive byte for byte",
      {},
      (name, problem) => [
        [JSON.stringify({ result: "failed", problem })],
        [
          `labels: created label "${name}"`,
          `debug: POST /repos/o/r/labels -> 201 payload: {"name":"${name}"}`,
          `error: ${problem}`,
        ],
      ],
    ],
  ])("%s", (_case, env, expected) => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    const { io, flush } = cliIo({
      streams: maskedStreams({ stdout: stdout.stream, stderr: stderr.stream }, actionsRunner(env)),
      json: true,
      verbose: true,
      colors: false,
    });
    const name = "x##[error]y";
    const problem = `labels[1].name: "${name}" names the same label`;
    io.mask("ghp_secret");
    io.log(`labels: created label "${name}"`);
    io.debug(`POST /repos/o/r/labels -> 201 payload: {"name":"${name}"}`);
    io.annotate("error", problem);
    io.output("result", "failed");
    flush(problem);
    const [out, err] = expected(name, problem);
    expect([stdout.text().split("\n"), stderr.text().split("\n")]).toEqual([
      [...(out ?? []), ""],
      [...(err ?? []), ""],
    ]);
  });

  test("--summary <file> takes the summary from the runner's step summary; an unset GITHUB_OUTPUT drops the record", () =>
    withTempDir("gsac-actions-", (dir) => {
      const named = join(dir, "named.md");
      const summaryFd = openSummaryFile(named)._unsafeUnwrap();
      const cli = driveCli(dir, summaryFd);
      cli.io.summary("## named");
      closeSync(summaryFd);
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

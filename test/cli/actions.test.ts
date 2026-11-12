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

// Char.IsWhiteSpace, as Microsoft's reference groups it:
//   U+0009..U+000D, U+0085                                          -> the control characters the reference names
//   U+0020, U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000  -> the SpaceSeparator category
//   U+2028, U+2029                                                  -> the LineSeparator and ParagraphSeparator categories

/** From Microsoft's reference for Char.IsWhiteSpace, not from the code under test: the 25 characters the runner's TrimStart() removes before it looks for `::`. */
const DOTNET_WHITE_SPACE: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

/** The runner's two parsers, as its source reads a line: `::` after the white space TrimStart() removes, or `##[` anywhere. */
function runnerReadsCommand(line: string): boolean {
  let start = 0;
  while (DOTNET_WHITE_SPACE.includes(line.charCodeAt(start))) {
    start += 1;
  }
  return line.startsWith("::", start) || line.includes("##[");
}

/** The drift line a list section logs for a declared entry the repository lacks, the name as the settings file gave it. */
function drift(name: string): string {
  return `drift: labels["${name}"]: missing`;
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
  // `##[` anywhere in one. Text a settings file or GitHub supplied would issue either from the admin's run.
  test.each([
    [
      "a line feed before `::`",
      drift("x\n::error file=README.md,line=1::spoofed"),
      drift("x%0A::error file=README.md,line=1::spoofed"),
    ],
    [
      "CR LF before `::`",
      drift("x\r\n::error file=README.md,line=1::spoofed"),
      drift("x%0D%0A::error file=README.md,line=1::spoofed"),
    ],
    [
      "a lone CR before `::`",
      drift("x\r::error file=README.md,line=1::spoofed"),
      drift("x%0D::error file=README.md,line=1::spoofed"),
    ],
    ["`##[` and no line break", drift("x##[error]spoofed"), drift("x%23%23[error]spoofed")],
    ["both forms", drift("x\n::error::a##[error]b"), drift("x%0A::error::a%23%23[error]b")],
    [
      "`::` at its own start, after whitespace",
      "\t \u0085::error::spoofed: created",
      "\t \u0085%3A%3Aerror::spoofed: created",
    ],
  ])(
    "a logged line holding %s is one line of plain text on both faces, so the runner reads no command in it",
    (_form, line, plain) =>
      withTempDir("gsac-actions-", (dir) => {
        const logs = (io: Io): void => {
          io.log(line);
          io.log("result: drift");
        };
        const cli = driveCli(dir);
        logs(cli.io);
        for (const stdout of [actionStdout(logs), cli.stdout()]) {
          const lines = stdout.split(/\r\n|\r|\n/);
          expect(lines).toEqual([plain, "result: drift", ""]);
          expect(lines.filter(runnerReadsCommand)).toEqual([]);
        }
      }),
  );

  // The runner masks a registered secret only where its text stands as registered, so an escape that ran first would
  // print the secret in a form anyone can reverse. Redaction sees the text as logged; the escapes come after it.
  test.each<[string, string | undefined, string, string]>([
    [
      "a registered secret holding `##[` reaches both faces as the redaction and in no other form",
      "pw##[tag]123",
      "value=pw##[tag]123",
      "value=***",
    ],
    [
      "a registered secret holding a line break reaches both faces as the redaction and in no other form",
      "key-line-1\nkey-line-2",
      "value=key-line-1\nkey-line-2",
      "value=***",
    ],
    [
      "a registered secret that begins with `::` reaches both faces as the redaction and in no other form",
      "::tok-456",
      "::tok-456 is the value",
      "*** is the value",
    ],
    [
      "an unregistered value of the same shapes is still escaped on both faces",
      undefined,
      "::tok-789 holds x##[tag]\nand a break",
      "%3A%3Atok-789 holds x%23%23[tag]%0Aand a break",
    ],
  ])("%s", (_case, secret, line, written) =>
    withTempDir("gsac-actions-", (dir) => {
      const logs = (io: Io): void => {
        if (secret !== undefined) {
          io.mask(secret);
        }
        io.log(line);
      };
      const cli = driveCli(dir);
      logs(cli.io);
      // The add-mask command carries the value by design: it is how the runner learns the mask.
      const logged = (stdout: string): string[] =>
        stdout.split("\n").filter((printed) => !printed.startsWith("::add-mask::"));
      expect({ action: logged(actionStdout(logs)), cli: logged(cli.stdout()) }).toEqual({
        action: [written, ""],
        cli: [written, ""],
      });
    }),
  );

  test("both faces take exactly .NET's white-space characters as the leading whitespace before `::`", () =>
    withTempDir("gsac-actions-", (dir) => {
      // CR and LF are left out: a log line escapes them, and the rows above cover that. Surrogate halves are no characters.
      const codes = Array.from({ length: 0x10000 }, (_, code) => code).filter(
        (code) => code !== 0x0a && code !== 0x0d && (code < 0xd800 || code > 0xdfff),
      );
      const logs = (io: Io): void => {
        for (const code of codes) {
          io.log(`${String.fromCharCode(code)}::x`);
        }
      };
      const cli = driveCli(dir);
      logs(cli.io);
      for (const stdout of [actionStdout(logs), cli.stdout()]) {
        const lines = stdout.split("\n");
        const trimmed = codes.filter(
          (code, at) => lines[at] === `${String.fromCharCode(code)}%3A%3Ax`,
        );
        const changed = codes.filter((code, at) => lines[at] !== `${String.fromCharCode(code)}::x`);
        expect(trimmed).toEqual(
          DOTNET_WHITE_SPACE.filter((code) => code !== 0x0a && code !== 0x0d),
        );
        // The one other line that changes is `:::x`, which opens with the command marker itself.
        expect(changed.filter((code) => !trimmed.includes(code))).toEqual([0x3a]);
      }
    }));

  // Under a runner the stream rewrites both forms in every chunk that is not a finished command, whichever write
  // carried it, so a write added later is covered without wrapping it. On a terminal nothing reads commands.
  test.each<[string, Record<string, string>, (name: string, problem: string) => string[][]]>([
    [
      "under a runner the log, the debug trace, the --json envelope, and a bare stream write lose `##[` and a leading `::`, and a finished command keeps its text",
      { GITHUB_ACTIONS: "true" },
      (_name, problem) => [
        [
          "::add-mask::ghp_secret",
          "::add-mask::pw##[tag]123",
          `::error::${problem}`,
          '{"result":"failed","problem":"labels[1].name: \\"x%23%23[error]y\\" names the same label"}',
        ],
        [
          'labels: created label "x%23%23[error]y"',
          "%3A%3Anotice::from a settings value",
          'debug: POST /repos/o/r/labels -> 201 payload: {"name":"x%23%23[error]y"}',
          "debug: Authorization: ***",
          "  %3A%3Awarning::from a write added later",
          "safe\u2028::file.yml opens no line, but\r%3A%3Athis does",
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
          "::notice::from a settings value",
          `debug: POST /repos/o/r/labels -> 201 payload: {"name":"${name}"}`,
          "debug: Authorization: ***",
          "  ::warning::from a write added later",
          "safe\u2028::file.yml opens no line, but\r::this does",
          `error: ${problem}`,
        ],
      ],
    ],
  ])("%s", (_case, env, expected) => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    const streams = maskedStreams(
      { stdout: stdout.stream, stderr: stderr.stream },
      actionsRunner(env),
    );
    const { io, flush } = cliIo({ streams, json: true, verbose: true, colors: false });
    const name = "x##[error]y";
    const problem = `labels[1].name: "${name}" names the same label`;
    io.mask("ghp_secret");
    io.mask("pw##[tag]123");
    io.log(`labels: created label "${name}"`);
    io.log("::notice::from a settings value");
    io.debug(`POST /repos/o/r/labels -> 201 payload: {"name":"${name}"}`);
    // A write that is no log line, holding a mask the rewrite would break: the stream redacts first.
    io.debug("Authorization: pw##[tag]123");
    streams.stderr.write("  ::warning::from a write added later\n");
    // The runner's reader ends a line at CR or LF and nowhere else, U+2028 included.
    streams.stderr.write("safe\u2028::file.yml opens no line, but\r::this does\n");
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

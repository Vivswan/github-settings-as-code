/**
 * The CLI's Io: where each channel lands, the `level: message` shape, the
 * json routing, the summary file, the debug gate, and the masking every
 * channel goes through (no runner masks for a terminal).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIoOptions, cliIo, maskedStreams } from "../../src/cli/io.js";
import { memoryStream } from "./streams.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(options: Partial<Omit<CliIoOptions, "streams">> = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const opened = cliIo({
    streams: maskedStreams({ stdout: stdout.stream, stderr: stderr.stream }),
    json: false,
    verbose: false,
    colors: false,
    ...options,
  });
  return { ...opened, stdout: stdout.text, stderr: stderr.text };
}

/** Every channel written once, the way a run writes them. */
function exercise(io: ReturnType<typeof cliIo>["io"]): void {
  io.log("labels: 2 in sync");
  io.annotate("notice", "nothing to do");
  io.annotate("warning", "skipped teams");
  io.annotate("error", "PATCH /repos/o/r failed: 500 boom");
  io.debug("GET /repos/o/r -> 200");
  io.output("skipped-sections", "teams");
  io.output("result", "partial");
}

describe("the CLI Io", () => {
  test("logs land on stdout, annotations on stderr as level: message, outputs as name=value lines", () => {
    const { io, flush, stdout, stderr } = open();
    exercise(io);
    flush();
    expect(stdout()).toBe("labels: 2 in sync\nskipped-sections=teams\nresult=partial\n");
    expect(stderr()).toBe(
      "notice: nothing to do\nwarning: skipped teams\nerror: PATCH /repos/o/r failed: 500 boom\n",
    );
  });

  test("--json prints the outputs as one object on stdout and moves the log lines to stderr", () => {
    const { io, flush, stdout, stderr } = open({ json: true });
    exercise(io);
    flush();
    expect(JSON.parse(stdout())).toEqual({ "skipped-sections": "teams", result: "partial" });
    expect(stdout().split("\n")).toHaveLength(2);
    expect(stderr()).toBe(
      "labels: 2 in sync\nnotice: nothing to do\nwarning: skipped teams\nerror: PATCH /repos/o/r failed: 500 boom\n",
    );
  });

  test("--verbose shows the debug trace on stderr; without it the trace is dropped", () => {
    const quiet = open();
    quiet.io.debug("GET /repos/o/r -> 200");
    expect(quiet.stderr()).toBe("");
    const loud = open({ verbose: true });
    loud.io.debug("GET /repos/o/r -> 200");
    expect(loud.stderr()).toBe("debug: GET /repos/o/r -> 200\n");
  });

  test("colored labels wrap only the level word", () => {
    const { io, stderr } = open({ colors: true });
    io.annotate("error", "boom");
    expect(stderr()).toBe("[31merror[39m: boom\n");
  });

  test("a masked value is redacted on every channel, the outputs included", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsac-io-"));
    scratch.push(dir);
    const summary = join(dir, "summary.md");
    const { io, flush, stdout, stderr } = open({ summaryFile: summary, verbose: true });
    io.mask("ghp_secret");
    io.log("token ghp_secret in a log line");
    io.annotate("error", "401 for ghp_secret");
    io.debug("Authorization: token ghp_secret");
    io.summary("# run by ghp_secret");
    io.output("result", "failed ghp_secret");
    flush();
    const everything = stdout() + stderr() + readFileSync(summary, "utf8");
    expect(everything).not.toContain("ghp_secret");
    expect(stdout()).toBe("token *** in a log line\nresult=failed ***\n");
    expect(stderr()).toBe("error: 401 for ***\ndebug: Authorization: token ***\n");
    expect(readFileSync(summary, "utf8")).toBe("# run by ***\n");
  });

  test("summary blocks append to the named file and are dropped without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsac-io-"));
    scratch.push(dir);
    const summary = join(dir, "summary.md");
    const named = open({ summaryFile: summary });
    named.io.summary("## first");
    named.io.summary("## second");
    expect(readFileSync(summary, "utf8")).toBe("## first\n## second\n");
    // Without a file the block goes nowhere: no stream carries it, and the working
    // directory (where a defaulted path would land) stays empty.
    const cwd = mkdtempSync(join(tmpdir(), "gsac-io-cwd-"));
    scratch.push(cwd);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const unnamed = open();
      unnamed.io.summary("## dropped");
      expect(unnamed.stdout() + unnamed.stderr()).toBe("");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      process.chdir(previous);
    }
    expect(readdirSync(dir)).toEqual(["summary.md"]);
    expect(readFileSync(summary, "utf8")).toBe("## first\n## second\n");
  });

  test("identical consecutive lines are all printed, never folded", () => {
    // consola folds repeats within a second by default; a drift report with
    // the same line per target must keep every one.
    const { io, stderr } = open();
    for (let i = 0; i < 8; i++) {
      io.annotate("warning", "same line");
    }
    expect(stderr()).toBe("warning: same line\n".repeat(8));
  });
});

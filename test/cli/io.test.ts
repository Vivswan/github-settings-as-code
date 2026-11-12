/**
 * The CLI's Io on a terminal: where each channel lands, the `level: message`
 * shape, the json routing, the summary file, and the debug gate. The
 * redaction every channel goes through is pinned beside the runner face in
 * test/cli/actions.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CliIoOptions, cliIo, maskedStreams, settleSummaryFile } from "../../src/cli/io.js";
import { withTempDir } from "../temp-dir.js";
import { memoryStream } from "./streams.js";

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

/** Each entry of `dir` with what it holds: a file's text, or where a link points. */
function listing(dir: string): string[] {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    return lstatSync(path).isSymbolicLink()
      ? `${name} -> ${readlinkSync(path)}`
      : `${name}: ${readFileSync(path, "utf8")}`;
  });
}

/** Every channel written once, the way a run writes them. */
function exercise(io: ReturnType<typeof cliIo>["io"]): void {
  io.log("labels: 2 in sync");
  io.annotate("notice", "nothing to do");
  io.annotate("warning", "skipped teams");
  io.annotate("error", "PATCH /repos/o/r failed: 500 boom");
  io.debug("GET /repos/o/r -> 200");
  io.output("result", "partial");
  io.output("skipped-sections", "teams");
  io.output("repos-result", JSON.stringify(REPOS_RESULT));
}

const REPOS_RESULT = {
  "o/r": { result: "partial", source: "remote", "skipped-sections": ["teams"] },
};

describe("the CLI Io", () => {
  test("logs land on stdout, annotations on stderr as level: message, outputs as name=value lines", () => {
    const { io, flush, stdout, stderr } = open();
    exercise(io);
    flush();
    expect(stdout()).toBe(
      `labels: 2 in sync\nresult=partial\nskipped-sections=teams\nrepos-result=${JSON.stringify(REPOS_RESULT)}\n`,
    );
    expect(stderr()).toBe(
      "notice: nothing to do\nwarning: skipped teams\nerror: PATCH /repos/o/r failed: 500 boom\n",
    );
  });

  test("--json prints the outputs as one object on stdout, the list and the map as values, and moves the log lines to stderr", () => {
    const { io, flush, stdout, stderr } = open({ json: true });
    exercise(io);
    flush();
    expect(JSON.parse(stdout())).toEqual({
      result: "partial",
      "skipped-sections": ["teams"],
      "repos-result": REPOS_RESULT,
    });
    expect(stdout().split("\n")).toHaveLength(2);
    expect(stderr()).toBe(
      "labels: 2 in sync\nnotice: nothing to do\nwarning: skipped teams\nerror: PATCH /repos/o/r failed: 500 boom\n",
    );
  });

  test("a masked value that spans lines is redacted before its line breaks are escaped", () => {
    // Escaped first, the value in the line would no longer equal the value in the registry, and it would print.
    const { io, stdout } = open();
    io.mask("first half\nsecond half");
    io.log("deploy key: first half\nsecond half\ndone");
    expect(stdout()).toBe("deploy key: ***%0Adone\n");
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

  test("summary blocks append to the named file and are dropped without one", () =>
    withTempDir("gsac-io-", async (dir) => {
      const summary = join(dir, "summary.md");
      const named = open({ summaryFile: settleSummaryFile(summary)._unsafeUnwrap() });
      named.io.summary("## first");
      named.io.summary("## second");
      expect(readFileSync(summary, "utf8")).toBe("## first\n## second\n");
      // Without a file the block goes nowhere: no stream carries it, and the working
      // directory (where a defaulted path would land) stays empty.
      await withTempDir("gsac-io-cwd-", (cwd) => {
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
      });
      expect(readdirSync(dir)).toEqual(["summary.md"]);
      expect(readFileSync(summary, "utf8")).toBe("## first\n## second\n");
    }));

  // The check runs before the run reads its inputs. A file it left behind would be read as an input named there by
  // mistake, and a link to a file not yet written must still lead the summary there.
  test.each<[string, (dir: string) => void, string, string]>([
    ["a path that does not exist", () => {}, "summary.md", ""],
    [
      "a file that holds a block",
      (dir) => writeFileSync(join(dir, "summary.md"), "## kept\n"),
      "summary.md",
      "## kept\n",
    ],
    [
      "a link to a file not yet written",
      (dir) => symlinkSync("run.md", join(dir, "summary.md")),
      "run.md",
      "",
    ],
  ])(
    "settling --summary at %s leaves the directory as it found it, and the block still lands",
    (_kind, arrange, lands, kept) =>
      withTempDir("gsac-io-", (dir) => {
        arrange(dir);
        const found = listing(dir);
        const summaryFile = settleSummaryFile(join(dir, "summary.md"))._unsafeUnwrap();
        expect(listing(dir)).toEqual(found);
        open({ summaryFile }).io.summary("## block");
        expect(readFileSync(join(dir, lands), "utf8")).toBe(`${kept}## block\n`);
      }),
  );

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

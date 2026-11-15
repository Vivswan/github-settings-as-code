/**
 * The one way a script under .github/scripts runs another program, and the one file there that spawns a process
 * (test/scripts/command.test.ts holds the rest to it): an argv with no shell between, each of the three streams sent
 * where the caller names, and the outcome returned as a value. `command` is for a command whose status is the
 * answer: no failure of the command becomes a throw or an exit (a `stdout` file that cannot be opened still
 * throws). `must` is the same run for a command the script cannot go on without, and throws the refusal
 * lib/entry.ts prints. Bun and Node builtins only: the release job runs its scripts with nothing installed.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";

interface Placement {
  /** Where the command runs; the script's own working directory when absent. */
  cwd?: string;

  /** Added over the script's own environment. */
  env?: Readonly<Record<string, string>>;

  /** Closed when absent; the script's own stdin, or a text the command reads to its end. */
  stdin?: "inherit" | { text: string };
}

/** Each output stream on its own: captured when absent, or the script's log; stdout to a file as `> file` writes it;
 * stderr both captured and written to the log once the command ends, or nowhere. */
interface SeparateStreams {
  stdout?: "capture" | "inherit" | { file: string };
  stderr?: "capture" | "inherit" | "log-and-capture" | "discard";
}

/** stderr wherever stdout goes, as `2>&1` sends it: only a stdout that is not captured has a place to share. */
interface MergedStreams {
  stdout: "inherit" | { file: string };
  stderr: "stdout";
}

export type CommandOptions = Placement & (SeparateStreams | MergedStreams);

/** How a command ended. `status` is the one a shell would report: the exit code, 128 plus the signal number for a
 * command a signal ended, 127 for one that could not start (the reason is on stderr, wherever that went). Each
 * stream is what was captured, whole, as UTF-8; empty for a stream sent elsewhere. */
export interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** All three streams the script's own, as a line of a workflow step's shell has them. */
export const STREAMED = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;

type Sink = "pipe" | "inherit" | "ignore" | number;

function stderrSink(stderr: CommandOptions["stderr"], stdout: Sink): Sink {
  switch (stderr) {
    case "inherit":
      return "inherit";
    case "discard":
      return "ignore";
    case "stdout":
      // The script's own stdout by its descriptor: "inherit" for stderr would be the script's stderr.
      return stdout === "inherit" ? 1 : stdout;
    default:
      return "pipe";
  }
}

function stdinSource(stdin: CommandOptions["stdin"]): "inherit" | "ignore" | Buffer {
  if (stdin === undefined) {
    return "ignore";
  }
  return stdin === "inherit" ? "inherit" : Buffer.from(stdin.text);
}

/** The status a shell would report for a command that ran. */
function shellStatus(exitCode: number | null, signalCode: string | null | undefined): number {
  if (signalCode == null) {
    return exitCode ?? 1;
  }
  return 128 + (constants.signals[signalCode as NodeJS.Signals] ?? 0);
}

/** The run itself, each captured stream as text; a program that cannot start is the 127 a shell reports, its reason as stderr. */
function spawned(argv: readonly string[], options: CommandOptions, out: Sink, err: Sink): Outcome {
  try {
    const result = Bun.spawnSync([...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: stdinSource(options.stdin),
      stdout: out,
      stderr: err,
    });
    return {
      status: shellStatus(result.exitCode, result.signalCode),
      stdout: out === "pipe" ? String(result.stdout ?? "") : "",
      stderr: err === "pipe" ? String(result.stderr ?? "") : "",
    };
  } catch (error) {
    const reason = `${argv[0] ?? ""}: ${error instanceof Error ? error.message : String(error)}\n`;
    if (err === "inherit") {
      process.stderr.write(reason);
    } else if (typeof err === "number") {
      writeSync(err, reason);
    }
    return { status: 127, stdout: "", stderr: err === "pipe" ? reason : "" };
  }
}

/** Runs `argv` to its end and returns how it ended. */
export function command(argv: readonly string[], options: CommandOptions = {}): Outcome {
  const file = typeof options.stdout === "object" ? openSync(options.stdout.file, "w") : null;
  try {
    const out: Sink = file ?? (options.stdout === "inherit" ? "inherit" : "pipe");
    const outcome = spawned(argv, options, out, stderrSink(options.stderr, out));
    if (options.stderr === "log-and-capture") {
      process.stderr.write(outcome.stderr);
    }
    return outcome;
  } finally {
    if (file !== null) {
      closeSync(file);
    }
  }
}

/** A command the script could not go on without, as `must` refuses it: the argv, and its stderr when captured. */
export function commandFailure(argv: readonly string[], outcome: Outcome): Error {
  const detail = outcome.stderr.trim() === "" ? "" : `: ${outcome.stderr.trim()}`;
  return new Error(`${argv.join(" ")} failed${detail}`);
}

/** `command` for a run that has to succeed: any other status throws `commandFailure`. */
export function must(argv: readonly string[], options: CommandOptions = {}): Outcome {
  const outcome = command(argv, options);
  if (outcome.status !== 0) {
    throw commandFailure(argv, outcome);
  }
  return outcome;
}

/** `must`, and its stdout as `$(...)` yields it: the trailing newlines removed. */
export function output(argv: readonly string[], options: CommandOptions = {}): string {
  return must(argv, options).stdout.replace(/\n+$/, "");
}

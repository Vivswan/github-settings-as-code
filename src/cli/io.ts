/**
 * The CLI's output boundary and its Io. No runner masks for a terminal, so
 * every writer, the parser included, goes through maskedStreams(). Under a
 * GitHub Actions runner the same Io speaks the runner's commands and files
 * beside that redaction, so a gsac step and the action step read alike.
 */

import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import {
  type ConsolaReporter,
  createConsola,
  type LogLevel,
  LogLevels,
  type LogType,
} from "consola";
import pc from "picocolors";
import {
  type AnnotationLevel,
  type Io,
  type MaskPair,
  maskRegistry,
  type OutputName,
  redactRanges,
} from "../index.js";
import { type ActionsRunner, outputRecord, workflowCommand } from "./actions.js";

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/** Streams that redact every masked value on write, with the registry that feeds them. */
export interface MaskedStreams extends CliStreams, MaskPair {
  /** `text` with every masked value replaced, for the writes that bypass the streams. */
  redact(text: string): string;
  /** The runner this boundary reports to; none for a terminal. */
  readonly runner: RunnerChannel | undefined;
}

/** The runner's face on the boundary: its files, and its commands on stdout. */
interface RunnerChannel extends ActionsRunner {
  /** `::name::message` with the message redacted and the command name left whole. */
  command(name: AnnotationLevel, message: string): void;
}

/** A chunk that is already final, a workflow command: its name must survive a masked value spelled like it. */
class Verbatim {
  constructor(readonly text: string) {}
}

/** A stream that redacts each chunk before handing it to `target`; one queue, so no chunk overtakes another. */
class RedactingStream extends Writable {
  constructor(
    private readonly target: Writable,
    private readonly redact: (text: string) => string,
  ) {
    super({ objectMode: true });
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    const text = chunk instanceof Verbatim ? chunk.text : this.redact(String(chunk));
    // A full target holds the next chunk until it drains, so backpressure reaches the writer.
    if (this.target.write(text)) {
      callback();
    } else {
      this.target.once("drain", callback);
    }
  }
}

/**
 * Every write to the returned streams is redacted; register a value before
 * anything can print it. One registry serves the parser, the Io, and the
 * file-only commands alike, so no writer can bypass it. The runner's commands
 * are the two writes redaction never touches whole: the add-mask command must
 * carry the value, and a masked value spelled like a command name ("error")
 * must not turn any command into `::***::`.
 */
export function maskedStreams(streams: CliStreams, runner?: ActionsRunner): MaskedStreams {
  const registry = maskRegistry(
    runner === undefined ? () => {} : (value) => command(workflowCommand("add-mask", value)),
  );
  const redact = (text: string): string => redactRanges(text, registry.masked());
  const stdout = new RedactingStream(streams.stdout, redact);
  /** A finished command line, queued behind the redacted writes before it. */
  function command(line: string): void {
    stdout.write(new Verbatim(line));
  }
  return {
    stdout,
    stderr: new RedactingStream(streams.stderr, redact),
    redact,
    runner:
      runner === undefined
        ? undefined
        : {
            ...runner,
            command: (name, message) => command(workflowCommand(name, redact(message))),
          },
    ...registry,
  };
}

export interface CliIoOptions {
  readonly streams: MaskedStreams;
  /** Print the outputs as one JSON object; log lines move to stderr so stdout is that object alone. */
  readonly json: boolean;
  /** Show the debug trace. */
  readonly verbose: boolean;
  /** The file summary blocks are appended to; none falls back to the runner's step summary, or drops them. */
  readonly summaryFile?: string;
  readonly colors: boolean;
}

export interface CliIo {
  readonly io: Io;
  /**
   * Print the collected outputs to stdout, in the form the json option picked. `problem` is the fatal problem a run
   * ended in, worded for the terminal; the envelope carries it beside the outputs, the line form already has it on stderr.
   */
  flush(problem?: string): void;
}

/** The consola type each annotation level logs as; consola gates them by level. */
const CONSOLA_TYPE: Record<AnnotationLevel, "info" | "warn" | "error"> = {
  notice: "info",
  warning: "warn",
  error: "error",
};

type Colors = ReturnType<typeof pc.createColors>;
type Paint = (colors: Colors) => Colors["red"];

/** The label a consola type prints under, in the action's annotation words. */
const LABEL: Partial<Record<LogType, { label: string; paint: Paint }>> = {
  info: { label: "notice", paint: (colors) => colors.blue },
  warn: { label: "warning", paint: (colors) => colors.yellow },
  error: { label: "error", paint: (colors) => colors.red },
  debug: { label: "debug", paint: (colors) => colors.dim },
};

/**
 * How each output reads inside the --json envelope: the action's outputs are strings (a comma list, a JSON document),
 * and a JSON envelope carries the value itself, never a string a reader would parse again.
 */
const JSON_OUTPUT: Record<OutputName, (value: string) => unknown> = {
  result: (value) => value,
  "skipped-sections": (value) => (value === "" ? [] : value.split(",")),
  "repos-result": (value) => JSON.parse(value),
};

export function cliIo(options: CliIoOptions): CliIo {
  const { streams } = options;
  const colors = pc.createColors(options.colors);
  const reporter: ConsolaReporter = {
    log(logObj) {
      const meta = LABEL[logObj.type];
      const text = logObj.args.map(String).join(" ");
      const prefix = meta === undefined ? "" : `${meta.paint(colors)(meta.label)}: `;
      streams.stderr.write(`${prefix}${text}\n`);
    },
  };
  const level: LogLevel = options.verbose ? LogLevels.debug : LogLevels.info;
  // throttle: 0 keeps every line: consola otherwise folds repeated identical
  // lines within a second into "(repeated N times)", losing drift lines.
  const consola = createConsola({ level, reporters: [reporter], throttle: 0 });
  const logStream = options.json ? streams.stderr : streams.stdout;
  const { runner } = streams;
  const summaryFile = options.summaryFile ?? runner?.summaryFile;
  const outputs = new Map<OutputName, string>();
  const annotate: Io["annotate"] =
    runner === undefined
      ? (level, message) => consola[CONSOLA_TYPE[level]](message)
      : (level, message) => runner.command(level, message);
  return {
    io: {
      annotate,
      log: (line) => logStream.write(`${line}\n`),
      debug: (line) => consola.debug(line),
      summary: (markdown) => {
        if (summaryFile !== undefined) {
          appendFileSync(summaryFile, `${streams.redact(markdown)}\n`);
        }
      },
      output: (name, value) => {
        outputs.set(name, value);
        if (runner?.outputFile !== undefined) {
          // The raw value, as the action writes it: a later step reads it back, and the runner masks the log display.
          appendFileSync(runner.outputFile, outputRecord(name, value));
        }
      },
      mask: streams.mask,
      masked: streams.masked,
    },
    flush: (problem) => {
      if (options.json) {
        const envelope = Object.fromEntries(
          [...outputs].map(([name, value]) => [name, JSON_OUTPUT[name](value)]),
        );
        streams.stdout.write(
          `${JSON.stringify(problem === undefined ? envelope : { ...envelope, problem })}\n`,
        );
        return;
      }
      for (const [name, value] of outputs) {
        streams.stdout.write(`${name}=${value}\n`);
      }
    },
  };
}

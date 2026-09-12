/**
 * The CLI's output boundary and its Io. No runner masks for a terminal, so
 * every writer, the parser included, goes through maskedStreams().
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
} from "../index.js";

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/** Streams that redact every masked value on write, with the registry that feeds them. */
export interface MaskedStreams extends CliStreams, MaskPair {
  /** `text` with every masked value replaced, for the writes that bypass the streams. */
  redact(text: string): string;
}

/** A stream that redacts each chunk before handing it to `target`. */
class RedactingStream extends Writable {
  constructor(
    private readonly target: Writable,
    private readonly redact: (text: string) => string,
  ) {
    super({ decodeStrings: false });
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    // A full target holds the next chunk until it drains, so backpressure reaches the writer.
    if (this.target.write(this.redact(String(chunk)))) {
      callback();
    } else {
      this.target.once("drain", callback);
    }
  }
}

/**
 * `text` with every occurrence of every masked value replaced by `***`.
 * Occurrences are located in the original text and overlapping or touching
 * ones are merged, so two values that overlap (a prefix of another, or
 * "ABC" and "BCD" across "ABCD") leave no fragment, as replacing one value
 * after another would.
 */
function redactRanges(text: string, masked: ReadonlySet<string>): string {
  const ranges: Array<[number, number]> = [];
  for (const value of masked) {
    if (value === "") {
      continue;
    }
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      ranges.push([at, at + value.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  let open: [number, number] | undefined;
  for (const [start, end] of ranges) {
    if (open !== undefined && start <= open[1]) {
      open[1] = Math.max(open[1], end);
      continue;
    }
    if (open !== undefined) {
      out += `${text.slice(cursor, open[0])}***`;
      cursor = open[1];
    }
    open = [start, end];
  }
  if (open !== undefined) {
    out += `${text.slice(cursor, open[0])}***`;
    cursor = open[1];
  }
  return out + text.slice(cursor);
}

/**
 * Every write to the returned streams is redacted; register a value before
 * anything can print it. One registry serves the parser, the Io, and the
 * file-only commands alike, so no writer can bypass it.
 */
export function maskedStreams(streams: CliStreams): MaskedStreams {
  const registry = maskRegistry(() => {});
  const redact = (text: string): string => redactRanges(text, registry.masked());
  return {
    stdout: new RedactingStream(streams.stdout, redact),
    stderr: new RedactingStream(streams.stderr, redact),
    redact,
    ...registry,
  };
}

export interface CliIoOptions {
  readonly streams: MaskedStreams;
  /** Print the outputs as one JSON object; log lines move to stderr so stdout is that object alone. */
  readonly json: boolean;
  /** Show the debug trace. */
  readonly verbose: boolean;
  /** The file summary blocks are appended to; none drops them. */
  readonly summaryFile?: string;
  readonly colors: boolean;
}

export interface CliIo {
  readonly io: Io;
  /** Print the collected outputs to stdout, in the form the json option picked. */
  flush(): void;
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
  const outputs = new Map<OutputName, string>();
  return {
    io: {
      annotate: (annotation, message) => consola[CONSOLA_TYPE[annotation]](message),
      log: (line) => logStream.write(`${line}\n`),
      debug: (line) => consola.debug(line),
      summary: (markdown) => {
        if (options.summaryFile !== undefined) {
          appendFileSync(options.summaryFile, `${streams.redact(markdown)}\n`);
        }
      },
      output: (name, value) => {
        outputs.set(name, value);
      },
      mask: streams.mask,
      masked: streams.masked,
    },
    flush: () => {
      if (options.json) {
        streams.stdout.write(`${JSON.stringify(Object.fromEntries(outputs))}\n`);
        return;
      }
      for (const [name, value] of outputs) {
        streams.stdout.write(`${name}=${value}\n`);
      }
    },
  };
}

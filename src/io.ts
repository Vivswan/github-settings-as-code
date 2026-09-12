/**
 * The output port every layer reports through. Defined at the root so the
 * engine (which calls it) and the action layer (which implements it over
 * @actions/core) share one contract without importing each other.
 */

export type AnnotationLevel = "notice" | "warning" | "error";

/**
 * The action outputs, the one list every Io.output call is typed over; the
 * action layer pins a description to each (OUTPUT_DECLS in src/action/io.ts).
 */
export type OutputName = "result" | "skipped-sections" | "repos-result";

const MASK_PAIR: unique symbol = Symbol("Io.maskPair");
type Minted<F> = F & { readonly [MASK_PAIR]: true };

/**
 * Both members are branded over one Set by maskRegistry(), so a plain function cannot replace either. Pairing members
 * from two calls still typechecks; closing that would take one opaque registry value on Io.
 */
export interface MaskPair {
  /**
   * Redaction registers every private slug here as defense in depth. Required, not optional, so a missing
   * implementation cannot silently no-op in production.
   */
  readonly mask: Minted<(value: string) => void>;
  /** The API trace reads it to redact structurally (whole path, dropped payload) where the runner's literal `***` cannot. */
  readonly masked: Minted<() => ReadonlySet<string>>;
}

export interface Io extends MaskPair {
  annotate(level: AnnotationLevel, message: string): void;
  log(line: string): void;
  /** A trace line, shown only when the run has step debug logging enabled. */
  debug(line: string): void;
  summary(markdown: string): void;
  output(name: OutputName, value: string): void;
}

function mint<F extends (...args: never[]) => unknown>(member: F): Minted<F> {
  return Object.assign(member, { [MASK_PAIR]: true as const });
}

export function maskRegistry(sink: (value: string) => void): MaskPair {
  const masked = new Set<string>();
  return {
    mask: mint((value: string) => {
      masked.add(value);
      sink(value);
    }),
    masked: mint(() => masked),
  };
}

/**
 * `text` with every occurrence of every masked value replaced by `***`: the
 * one redactor for the Ios that mask text themselves (collectingIo, the CLI's
 * streams) where the action leaves it to the runner. Occurrences are located
 * in the original text and overlapping or touching ones are merged, so two
 * values that overlap (a prefix of another, or "ABC" and "BCD" across "ABCD")
 * leave no fragment, as replacing one value after another would.
 */
export function redactRanges(text: string, masked: ReadonlySet<string>): string {
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
 * Only annotate and log take the prefix: the debug trace, summary, and outputs are rendered by their writers, and the
 * mask pair registers raw values, not rendered lines.
 */
export function prefixedIo(io: Io, prefix: string): Io {
  if (prefix === "") {
    return io;
  }
  return {
    annotate: (level, message) => io.annotate(level, `${prefix}${message}`),
    log: (line) => io.log(`${prefix}${line}`),
    debug: (line) => io.debug(line),
    summary: (markdown) => io.summary(markdown),
    output: (name, value) => io.output(name, value),
    mask: io.mask,
    masked: io.masked,
  };
}

export interface CollectedLine {
  level?: AnnotationLevel;
  line: string;
}

/**
 * An Io that records instead of printing. Every captured line, output, and summary block is redacted against the
 * values registered so far, as a runner masks its log, so a library caller that prints the capture cannot leak
 * a secret. The debug trace is dropped, as a runner without step debugging drops it.
 */
export function collectingIo(): {
  io: Io;
  lines: CollectedLine[];
  outputs: Partial<Record<OutputName, string>>;
  summary: string[];
} {
  const lines: CollectedLine[] = [];
  const outputs: Partial<Record<OutputName, string>> = {};
  const summary: string[] = [];
  const registry = maskRegistry(() => {});
  const redact = (text: string): string => redactRanges(text, registry.masked());
  return {
    io: {
      annotate: (level, message) => lines.push({ level, line: redact(message) }),
      log: (line) => lines.push({ line: redact(line) }),
      debug: () => {},
      summary: (markdown) => summary.push(redact(markdown)),
      output: (name, value) => {
        outputs[name] = redact(value);
      },
      ...registry,
    },
    lines,
    outputs,
    summary,
  };
}

/** An Io that drops everything. Fresh per call, so one caller's masks never reach another's registry. */
export function silentIo(): Io {
  return {
    annotate: () => {},
    log: () => {},
    debug: () => {},
    summary: () => {},
    output: () => {},
    ...maskRegistry(() => {}),
  };
}

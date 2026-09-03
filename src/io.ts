/**
 * The output port every layer reports through. Defined at the root so the
 * engine (which calls it) and the action layer (which implements it over
 * @actions/core) share one contract without importing each other.
 */

/** The level of one workflow annotation, as the Io port (and its captures) spell it. */
export type AnnotationLevel = "notice" | "warning" | "error";

export interface Io {
  annotate(level: AnnotationLevel, message: string): void;
  log(line: string): void;
  /** A trace line, shown only when the run has step debug logging enabled. */
  debug(line: string): void;
  /** Append a markdown block to the step summary. */
  summary(markdown: string): void;
  /** Set an action output; the action layer pins `name` to its declared outputs. */
  output(name: string, value: string): void;
  /**
   * Register a value the runner must mask (`***`) wherever it appears in
   * later log output. Redaction registers every private slug here as defense
   * in depth. Required, not optional, so a missing implementation cannot
   * silently no-op in production.
   */
  mask(value: string): void;
  /**
   * Every value registered through mask(), verbatim. The API trace reads it
   * to redact structurally (whole path, dropped payload) where the runner's
   * literal `***` cannot; the two registries are one.
   */
  masked(): ReadonlySet<string>;
}

/**
 * The mask pair an Io carries: `mask` records the value and forwards it to
 * `sink`, `masked` reads that same set - so the structural trace redaction
 * can never consult a different registry than the literal mask.
 */
export function maskRegistry(sink: (value: string) => void): Pick<Io, "mask" | "masked"> {
  const masked = new Set<string>();
  return {
    mask: (value) => {
      masked.add(value);
      sink(value);
    },
    masked: () => masked,
  };
}

/**
 * Wrap an Io so every annotation and log line is prefixed with `prefix`.
 * An empty prefix returns the sink unchanged. The other channels pass
 * through untouched: the debug trace, summary, and outputs are rendered by
 * their writers, and `mask` registers a raw value, not a rendered line.
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
    mask: (value) => io.mask(value),
    masked: () => io.masked(),
  };
}

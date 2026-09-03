/**
 * The output port every layer reports through. Defined at the root so the
 * engine (which calls it) and the action layer (which implements it over
 * @actions/core) share one contract without importing each other.
 */

/** The level of one workflow annotation, as the Io port (and its captures) spell it. */
export type AnnotationLevel = "notice" | "warning" | "error";

/**
 * The action outputs, the one list every Io.output call is typed over; the
 * action layer pins a description to each (OUTPUT_DECLS in src/action/io.ts).
 */
export type OutputName = "result" | "skipped-sections" | "repos-result";

// Module-private, so other modules cannot name the member brand.
const MASK_PAIR: unique symbol = Symbol("Io.maskPair");
type Minted<F> = F & { readonly [MASK_PAIR]: true };

/**
 * maskRegistry() brands both members over one Set, so a plain function
 * cannot replace either. Pairing members from two calls still typechecks;
 * closing that would take one opaque registry value on Io.
 */
export interface MaskPair {
  /**
   * Register a value the runner must mask (`***`) wherever it appears in
   * later log output. Redaction registers every private slug here as defense
   * in depth. Required, not optional, so a missing implementation cannot
   * silently no-op in production.
   */
  readonly mask: Minted<(value: string) => void>;
  /**
   * Every value registered through mask(), verbatim. The API trace reads it
   * to redact structurally (whole path, dropped payload) where the runner's
   * literal `***` cannot.
   */
  readonly masked: Minted<() => ReadonlySet<string>>;
}

export interface Io extends MaskPair {
  annotate(level: AnnotationLevel, message: string): void;
  log(line: string): void;
  /** A trace line, shown only when the run has step debug logging enabled. */
  debug(line: string): void;
  /** Append a markdown block to the step summary. */
  summary(markdown: string): void;
  /** Set one of the declared action outputs. */
  output(name: OutputName, value: string): void;
}

function mint<F extends (...args: never[]) => unknown>(member: F): Minted<F> {
  return Object.assign(member, { [MASK_PAIR]: true as const });
}

/** A fresh mask pair over one Set, forwarding every masked value to `sink`. */
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
 * Wrap an Io so every annotation and log line is prefixed with `prefix`.
 * An empty prefix returns the sink unchanged. The other channels pass
 * through untouched: the debug trace, summary, and outputs are rendered by
 * their writers, and the mask pair registers raw values, not rendered lines.
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

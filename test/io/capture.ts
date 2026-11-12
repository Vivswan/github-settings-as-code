/**
 * The one Io capture fake for tests: every channel lands in its own list and in one ordered event log
 * (`annotate <level>: <message>`, `log: <line>`, `summary: <first line>`, `output <name>=<value>`,
 * `mask: <value>`). Nothing is redacted (collectingIo does that); the debug trace is dropped. The event log keeps a
 * summary's first line only, so a test reading a whole summary reads `summaries`.
 */

import { type Io, maskRegistry, type OutputName } from "../../src/io.js";

export interface CapturedIo {
  /** The fake, every channel of it landing in the lists beside it. */
  io: Io;

  /** `<level>: <message>` per annotate call. */
  annotations: string[];

  /** Every log line, in order. */
  logs: string[];

  /** Every summary block, whole, in call order. */
  summaries: string[];

  /** The last value set per output name. */
  outputs: Partial<Record<OutputName, string>>;

  /** Every value registered through mask, in call order; io.masked() is the live set. */
  masks: string[];

  /** Every call across the channels, in order, spelled as the header says. */
  events: string[];
}

/** `onMask` runs at each mask call, for a test pinning what else has happened by the time a value is masked. */
export function captureIo(onMask: (value: string) => void = () => {}): CapturedIo {
  const captured: Omit<CapturedIo, "io"> = {
    annotations: [],
    logs: [],
    summaries: [],
    outputs: {},
    masks: [],
    events: [],
  };
  const { annotations, logs, summaries, outputs, masks, events } = captured;
  return {
    io: {
      annotate: (level, message) => {
        annotations.push(`${level}: ${message}`);
        events.push(`annotate ${level}: ${message}`);
      },
      log: (line) => {
        logs.push(line);
        events.push(`log: ${line}`);
      },
      debug: () => {},
      summary: (markdown) => {
        // Coerced first: a test forcing an opaque Private box through the port must not crash the fake.
        const text = `${markdown}`;
        summaries.push(text);
        events.push(`summary: ${text.split("\n")[0]}`);
      },
      output: (name, value) => {
        outputs[name] = value;
        events.push(`output ${name}=${value}`);
      },
      ...maskRegistry((value) => {
        masks.push(value);
        events.push(`mask: ${value}`);
        onMask(value);
      }),
    },
    ...captured,
  };
}

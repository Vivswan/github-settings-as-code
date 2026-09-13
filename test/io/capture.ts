/**
 * The one Io capture fake for tests: every channel lands in its own list and in one ordered event log, so a
 * test pins a single surface or the sequence across surfaces. Nothing is redacted (collectingIo does that);
 * the debug trace is dropped, as a runner without step debugging drops it.
 */

import { type Io, maskRegistry, type OutputName } from "../../src/io.js";

export interface CapturedIo {
  io: Io;
  /** `<level>: <message>` per annotate call. */
  annotations: string[];
  logs: string[];
  summaries: string[];
  outputs: Partial<Record<OutputName, string>>;
  /** Every value registered through mask, in call order; io.masked() is the live set. */
  masks: string[];
  /**
   * Every channel in call order: `annotate <level>: <message>`, `log: <line>`, `summary: <first line>`,
   * `output <name>=<value>`, `mask: <value>`.
   */
  events: string[];
}

/** `onMask` runs at each mask call, for a test pinning what else has happened by the time a value is masked. */
export function captureIo(onMask: (value: string) => void = () => {}): CapturedIo {
  const annotations: string[] = [];
  const logs: string[] = [];
  const summaries: string[] = [];
  const outputs: Partial<Record<OutputName, string>> = {};
  const masks: string[] = [];
  const events: string[] = [];
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
        summaries.push(markdown);
        events.push(`summary: ${`${markdown}`.split("\n")[0]}`);
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
    annotations,
    logs,
    summaries,
    outputs,
    masks,
    events,
  };
}

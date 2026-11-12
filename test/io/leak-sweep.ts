/**
 * The two-sided sweep a leak test runs: a private target's text is absent from what the hidden run wrote, and present
 * in a control (the same run in the clear, or what the hidden side was handed). Without the control, a needle that can
 * never print passes whatever the code does. Both sides are read raw, each surface under its own name.
 */

import { expect } from "bun:test";
import type { CapturedIo } from "./capture.js";

/** One side's output by surface name (`log`, `summary`, `outputs`, `trace`, ...), each surface as one text. */
type Surfaces = Readonly<Record<string, string>>;

/** At least one needle: a sweep for nothing cannot fail. */
type Needles = readonly [string, ...string[]];

/** What a recorded run made public: its leveled and plain lines, every summary whole, and its output values. Mask registrations are not among them: a runner prints none. */
export function publicSurfaces(
  run: Pick<CapturedIo, "annotations" | "logs" | "summaries" | "outputs">,
): Surfaces {
  return {
    log: [...run.annotations, ...run.logs].join("\n"),
    summary: run.summaries.join("\n"),
    outputs: Object.values(run.outputs).join("\n"),
  };
}

/** Fails naming every needle found on a surface of `hidden`, and every needle found on no surface of `control`. */
export function expectSealed(hidden: Surfaces, control: Surfaces, needles: Needles): void {
  const findings = needles.flatMap((needle) => {
    const reached = Object.entries(hidden)
      .filter(([, text]) => text.includes(needle))
      .map(([surface]) => `\`${needle}\` reached the hidden side's ${surface}`);
    const live = Object.values(control).some((text) => text.includes(needle));
    const controls = Object.keys(control).join(", ");
    return live
      ? reached
      : [
          ...reached,
          `\`${needle}\` is on no control surface (${controls}), so its sweep cannot fail`,
        ];
  });
  expect(findings).toEqual([]);
}

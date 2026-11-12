import { describe, expect, test } from "bun:test";
import { expectSealed } from "./leak-sweep.js";

// Every leak test fails through this helper, so one that stopped failing would pass them all on a leak at once.
describe("expectSealed", () => {
  const control = { log: "o/priv: drift", summary: "### o/priv (drift)" };

  test("a needle on a hidden surface fails, naming the needle and the surface", () => {
    const hidden = { log: "private repository #1: drift", summary: "details hidden (o/priv)" };
    expect(() => expectSealed(hidden, control, ["o/priv"])).toThrow(
      "`o/priv` reached the hidden side's summary",
    );
  });

  test("a needle on no control surface fails, naming the surfaces it was looked for on", () => {
    const hidden = { log: "private repository #1: drift" };
    expect(() => expectSealed(hidden, control, ["o/prvi"])).toThrow(
      "`o/prvi` is on no control surface (log, summary), so its sweep cannot fail",
    );
  });

  test("a needle absent from the hidden side and present in the control passes", () => {
    const hidden = { log: "private repository #1: drift" };
    expect(() => expectSealed(hidden, control, ["o/priv"])).not.toThrow();
  });
});

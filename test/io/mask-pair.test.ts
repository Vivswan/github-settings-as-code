import { describe, expect, test } from "bun:test";
import { type Io, type MaskPair, maskRegistry } from "../../src/io.js";
import { captureIo } from "./capture.js";

const channels: Omit<Io, keyof MaskPair> = {
  annotate: () => {},
  log: () => {},
  debug: () => {},
  summary: () => {},
  output: () => {},
};

describe("the Io mask pair", () => {
  test("a plain function cannot replace either minted member, even after a spread of a real pair", () => {
    // The two expect-error lines are the controls; the literal itself asserts nothing at runtime. Each replacement is the divergence the
    // brand forbids: a mask that forwards nothing into masked() would let trace redaction see an empty registry while the runner masks the value.
    const forged: Io = {
      ...channels,
      ...maskRegistry(() => {}),
      // @ts-expect-error a plain function cannot replace the minted mask
      mask: () => {},
      // @ts-expect-error a plain function cannot replace the minted masked
      masked: () => new Set(),
    };
    void forged;
  });

  test("mask() feeds the sink and the live registry masked() returns, fresh per pair", () => {
    const sunk: string[] = [];
    const pair = maskRegistry((value) => sunk.push(value));
    const seen = pair.masked();
    pair.mask("first");
    pair.mask("second");
    expect(sunk).toEqual(["first", "second"]);
    expect([...seen]).toEqual(["first", "second"]);
    // Two registries never share state: a fresh pair starts empty.
    expect(maskRegistry(() => {}).masked().size).toBe(0);
    // The test fake's pair is one registry too: a masked value reaches both its list and its live set.
    const { io, masks } = captureIo();
    io.mask("o/private");
    expect(masks).toEqual(["o/private"]);
    expect(io.masked().has("o/private")).toBe(true);
  });
});

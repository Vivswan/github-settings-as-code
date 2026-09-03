import { describe, expect, test } from "bun:test";
import { type Io, type MaskPair, maskRegistry } from "../../src/io.js";

const channels: Omit<Io, keyof MaskPair> = {
  annotate: () => {},
  log: () => {},
  debug: () => {},
  summary: () => {},
  output: () => {},
};

describe("the Io mask pair", () => {
  test("a plain function is not a mask member, even replacing one minted member after a spread", () => {
    // Each literal is the divergence the brand forbids: mask forwards nothing
    // into the set masked() reads, so trace redaction would see an empty
    // registry while the runner masks the value.
    const forgedMask: Io = {
      ...channels,
      ...maskRegistry(() => {}),
      // @ts-expect-error a plain function cannot replace the minted mask
      mask: () => {},
    };
    forgedMask.mask("o/private");
    expect(forgedMask.masked().size).toBe(0);
    const forgedMasked: Io = {
      ...channels,
      ...maskRegistry(() => {}),
      // @ts-expect-error a plain function cannot replace the minted masked
      masked: () => new Set(),
    };
    forgedMasked.mask("o/private");
    expect(forgedMasked.masked().size).toBe(0);

    const forwarded: string[] = [];
    const io: Io = { ...channels, ...maskRegistry((value) => forwarded.push(value)) };
    io.mask("o/private");
    expect(forwarded).toEqual(["o/private"]);
    expect(io.masked().has("o/private")).toBe(true);
  });

  test("masked() is the live registry mask() writes, not a snapshot", () => {
    const pair = maskRegistry(() => {});
    const seen = pair.masked();
    pair.mask("first");
    pair.mask("second");
    expect([...seen]).toEqual(["first", "second"]);
    // Two registries never share state: a fresh pair starts empty.
    expect(maskRegistry(() => {}).masked().size).toBe(0);
  });
});

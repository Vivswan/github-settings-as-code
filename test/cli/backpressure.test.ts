/**
 * The redacting stream honors the target's backpressure: a chunk the target
 * cannot take yet is acknowledged only once it drains, and nothing is lost
 * or reordered while the target is full.
 */

import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { maskedStreams } from "../../src/cli/io.js";

/** A target that accepts a chunk only when released; every accepted chunk is kept. */
function stalledTarget(): { stream: Writable; release(): void; chunks: string[] } {
  const chunks: string[] = [];
  let pending: (() => void) | null = null;
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      pending = callback;
    },
  });
  return {
    stream,
    chunks,
    release() {
      const done = pending;
      pending = null;
      done?.();
    },
  };
}

describe("the redacting stream under backpressure", () => {
  test("holds the next chunk until the target drains, acknowledging each only when the target took it", async () => {
    const target = stalledTarget();
    const streams = maskedStreams({
      stdout: target.stream,
      stderr: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    streams.mask("secret");
    let acknowledged = 0;
    streams.stdout.write("one secret\n", () => acknowledged++);
    streams.stdout.write("two\n", () => acknowledged++);
    await new Promise((resolve) => setImmediate(resolve));
    // The target is stalled on the first chunk, so the wrapper still holds both
    // (the first in flight, the second queued) and has acknowledged nothing; a
    // wrapper that acknowledges at once would hold nothing and have fired both.
    expect(target.chunks).toEqual(["one ***\n"]);
    expect(streams.stdout.writableLength).toBe("one secret\n".length + "two\n".length);
    expect(acknowledged).toBe(0);
    target.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(target.chunks).toEqual(["one ***\n", "two\n"]);
    expect(acknowledged).toBe(1);
    target.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(acknowledged).toBe(2);
  });
});

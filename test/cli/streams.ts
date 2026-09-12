/**
 * The streams the CLI tests hand the program: everything written is kept, so
 * a test reads stdout and stderr back as text.
 */

import { Writable } from "node:stream";

export interface MemoryStream {
  readonly stream: Writable;
  text(): string;
}

export function memoryStream(): MemoryStream {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

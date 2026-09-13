/**
 * The one temp-dir style for tests: a directory whose lifetime is the body it is handed to, created under
 * os.tmpdir() and removed on every exit path, failure included. No afterEach or afterAll hook cleans up.
 */

import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(
  prefix: string,
  body: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `test()` whose body is handed a fresh directory under `prefix`; a `test.each` case calls withTempDir itself. */
export function tempDirTest(
  prefix: string,
): (name: string, body: (dir: string) => void | Promise<void>) => void {
  return (name, body) => {
    test(name, () => withTempDir(prefix, body));
  };
}

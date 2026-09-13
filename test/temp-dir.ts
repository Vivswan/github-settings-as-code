/**
 * A temp directory whose lifetime is the body it is handed to: created under os.tmpdir(), removed on every exit
 * path, failure included. `test("...", () => withTempDir("prefix-", async (dir) => {...}))` is the one shape.
 */

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

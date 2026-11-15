/**
 * A temp directory whose lifetime is the body it is handed to: created under os.tmpdir(), removed on every exit
 * path, failure included. `test("...", () => withTempDir("prefix-", async (dir) => {...}))` is the one shape.
 * The body gets the real path: macOS keeps os.tmpdir() behind a symlink, and a tool that prints real paths
 * (tsc, git) would otherwise disagree with the path the test holds.
 */

import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(
  prefix: string,
  body: (dir: string) => T | Promise<T>,
): Promise<T> {
  using created = mkdtempDisposableSync(join(tmpdir(), prefix));
  return await body(realpathSync(created.path));
}

/**
 * biome's own formatting of a rendered text: the lint judges committed output like hand-written code, so a
 * generator writes what biome would.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** `text` as biome formats a file at `path`, which picks the language and the config's overrides; a text biome refuses throws, since a generator cannot write what the gate rejects. */
export function formatted(path: string, text: string): string {
  const biome = Bun.spawnSync(
    [join(ROOT, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${path}`],
    { cwd: ROOT, stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" },
  );
  if (biome.exitCode !== 0) {
    throw new Error(`biome refused the rendered ${path}:\n${biome.stderr.toString()}`);
  }
  return biome.stdout.toString();
}

/**
 * biome's own formatting of a rendered text: the lint judges committed output like hand-written code, so a
 * generator writes what biome would.
 */

import { join } from "node:path";
import { command } from "./command.js";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** `text` as biome formats a file at `path`, which picks the language and the config's overrides; a text biome refuses throws, since a generator cannot write what the gate rejects. */
export function formatted(path: string, text: string): string {
  const biome = command(
    [join(ROOT, "node_modules", ".bin", "biome"), "format", `--stdin-file-path=${path}`],
    { cwd: ROOT, stdin: { text } },
  );
  if (biome.status !== 0) {
    throw new Error(`biome refused the rendered ${path}:\n${biome.stderr}`);
  }
  return biome.stdout;
}

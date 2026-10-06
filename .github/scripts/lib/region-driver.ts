// The registry shape and the regeneration loop every region generator shares, so a generator declares its
// files and the rules around their regions, and drives nothing by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GeneratedRegion, regenerateRegions } from "./generated-regions.js";

/** One file a generator writes into: its regions, and the whole-file rules no region's placement can carry. */
export interface GeneratedFile {
  readonly regions: readonly GeneratedRegion[];
  /** Why the file as read is not one the generator writes into, judged before any region is; `path` names the file. */
  readonly shape?: (text: string, path: string) => string | undefined;
  /** Why the file reads wrong once every region is re-rendered, judged over the regenerated text. */
  readonly rendered?: (text: string, path: string) => string | undefined;
}

/** A generator's registry: every file it regenerates, by repo-relative path, in the order it writes them. */
export type GeneratedFiles = Readonly<Record<string, GeneratedFile>>;

export function regenerateFile(files: GeneratedFiles, path: string, text: string): string {
  const file = files[path];
  if (file === undefined) {
    throw new Error(`no generated regions are registered for ${path}`);
  }
  const shape = file.shape?.(text, path);
  if (shape !== undefined) {
    throw new Error(shape);
  }
  const out = regenerateRegions(text, file.regions, path);
  const rendered = file.rendered?.(out, path);
  if (rendered !== undefined) {
    throw new Error(rendered);
  }
  return out;
}

/** A generator's main; `generator` names it in the one line printed. */
export function regenerateFiles(generator: string, files: GeneratedFiles, root: string): void {
  const changed: string[] = [];
  for (const path of Object.keys(files)) {
    const file = join(root, path);
    const before = readFileSync(file, "utf8");
    const after = regenerateFile(files, path, before);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(path);
    }
  }
  console.log(
    changed.length === 0
      ? `${generator}: generated regions already up to date`
      : `${generator}: regenerated ${changed.join(", ")}`,
  );
}

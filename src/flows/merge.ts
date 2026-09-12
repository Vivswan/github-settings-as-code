/**
 * The mode: merge run flow: fold the settings-file layers into one validated
 * document and write it to merged-file. The written document is exactly what
 * a later apply or check step runs from that path; nothing here touches
 * GitHub, so the flow takes no client and needs no token.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describeOptOut, type Layering } from "../engine/layers.js";
import type { Io } from "../io.js";
import { concludeMerge, failRun } from "./deliver.js";
import { foldLayers, readLayerFiles } from "./layers.js";
import { renderMergedYaml } from "./library.js";
import { writeMergeSummary } from "./summary.js";

/**
 * A mode: merge run: the layers to fold, low to high, and where the result
 * goes. No token, no API version, no target, no section allowlist: merge mode
 * never reaches GitHub and writes every section the layers declare, and the
 * type carries that (no field to read a token or an allowlist from).
 */
export interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

/** How the merged document is named in its own validation errors. */
const MERGED_LABEL = "the merged settings document";

/**
 * The layer merged-file would overwrite, as a message, or null. Paths are
 * compared resolved, so "./a.yml" and "a.yml" collide. Guarded here, beside
 * the write: the next run would fold the merged document as if it were a layer.
 */
function mergedFileCollision(cfg: MergeConfig): string | null {
  const mergedPath = resolve(cfg.mergedFile);
  const collision = cfg.settingsFiles.findIndex((layer) => resolve(layer) === mergedPath);
  if (collision === -1) {
    return null;
  }
  return (
    `the "merged-file" input "${cfg.mergedFile}" is layer ${collision + 1} of the ` +
    `"settings-file" list ("${cfg.settingsFiles[collision]}"): the merge would overwrite that ` +
    `layer with the folded document, and the next run would fold the merged document as a ` +
    `layer. Write the merged document to a path outside the layer list`
  );
}

/** Execute a mode: merge run; returns the process exit code. */
export function runMerge(cfg: MergeConfig, io: Io): number {
  const collision = mergedFileCollision(cfg);
  if (collision !== null) {
    return failRun(io, collision);
  }
  const read = readLayerFiles(cfg.settingsFiles);
  if ("error" in read) {
    return failRun(io, read.error);
  }
  const folded = foldLayers(read.layers, MERGED_LABEL, cfg.layering, io);
  if ("error" in folded) {
    return failRun(io, folded.error);
  }
  for (const notice of folded.notices) {
    io.annotate("notice", describeOptOut(notice));
  }
  try {
    mkdirSync(dirname(cfg.mergedFile), { recursive: true });
    writeFileSync(cfg.mergedFile, renderMergedYaml(folded.settings));
  } catch (error) {
    return failRun(
      io,
      `cannot write the merged document to ${cfg.mergedFile}: ${String(error)}. Check that the "merged-file" input names a writable path`,
    );
  }
  writeMergeSummary(io, cfg.settingsFiles, cfg.mergedFile);
  return concludeMerge(io, { layers: cfg.settingsFiles, mergedFile: cfg.mergedFile });
}

/**
 * The mode: merge run flow: fold the settings-file layers into one validated
 * document and write it to merged-file. The written document is exactly what
 * a later apply or check step runs from that path; nothing here touches
 * GitHub, so the flow takes no client and needs no token.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describeOptOut } from "../engine/layers.js";
import type { Io } from "../io.js";
import { concludeMerge, failRun } from "./deliver.js";
import type { MergeConfig } from "./inputs.js";
import { foldLayers, readLayerFiles } from "./layers.js";
import { writeMergeSummary } from "./summary.js";

/** How the merged document is named in its own validation errors. */
const MERGED_LABEL = "the merged settings document";

/** Execute a mode: merge run; returns the process exit code. */
export function runMerge(cfg: MergeConfig, io: Io): number {
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
    writeFileSync(cfg.mergedFile, stringifyYaml(folded.settings));
  } catch (error) {
    return failRun(
      io,
      `cannot write the merged document to ${cfg.mergedFile}: ${String(error)}. Check that the "merged-file" input names a writable path`,
    );
  }
  writeMergeSummary(io, cfg.settingsFiles, cfg.mergedFile);
  return concludeMerge(io, { layers: cfg.settingsFiles, mergedFile: cfg.mergedFile });
}

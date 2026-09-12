/**
 * The mode: merge run flow. The written document is exactly what a later apply or check runs from that path; nothing
 * here touches GitHub, so the flow takes no client and needs no token.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { describeOptOut, type Layering } from "../engine/layers.js";
import type { Io } from "../io.js";
import type { Problem, ProblemOf } from "../problem.js";
import type { FinishedMerge } from "./deliver.js";
import { foldLayers, readLayerFiles } from "./layers.js";
import { renderMergedYaml } from "./library.js";

export interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

const MERGED_LABEL = "the merged settings document";

/**
 * Paths are compared resolved, so "./a.yml" and "a.yml" collide. Guarded beside the write: the next run would fold the
 * merged document as if it were a layer.
 */
function mergedFileCollision(cfg: MergeConfig): Result<void, ProblemOf<"merged-file-is-layer">> {
  const mergedPath = resolve(cfg.mergedFile);
  const index = cfg.settingsFiles.findIndex((layer) => resolve(layer) === mergedPath);
  const layer = cfg.settingsFiles[index];
  return layer === undefined
    ? ok()
    : err({ code: "merged-file-is-layer", mergedFile: cfg.mergedFile, index, layer });
}

export function runMerge(cfg: MergeConfig, io: Io): Result<FinishedMerge, Problem> {
  return mergedFileCollision(cfg)
    .andThen(() => readLayerFiles(cfg.settingsFiles))
    .andThen((layers) => foldLayers(layers, MERGED_LABEL, cfg.layering, io))
    .andThen((folded): Result<FinishedMerge, Problem> => {
      for (const notice of folded.notices) {
        io.annotate("notice", describeOptOut(notice));
      }
      try {
        mkdirSync(dirname(cfg.mergedFile), { recursive: true });
        writeFileSync(cfg.mergedFile, renderMergedYaml(folded.settings));
      } catch (error) {
        return err({
          code: "merged-file-unwritable",
          path: cfg.mergedFile,
          reason: String(error),
        });
      }
      return ok({ layers: cfg.settingsFiles, mergedFile: cfg.mergedFile });
    });
}

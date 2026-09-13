/**
 * The mode: merge run flow. The written document is exactly what a later apply or check runs from that path; nothing
 * here touches GitHub, so the flow takes no client and needs no token.
 */

import { err, ok, type Result } from "neverthrow";
import { describeOptOut, type Layering } from "../engine/layers.js";
import type { Io } from "../io.js";
import type { Problem, ProblemOf } from "../problem.js";
import type { FinishedMerge } from "./deliver.js";
import { foldLayers, readLayerFiles } from "./layers.js";
import { renderMergedYaml } from "./library.js";
import { canonicalPath, stagingPath, writeReplacing } from "./settings-write.js";

export interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

const MERGED_LABEL = "the merged settings document";

/**
 * Paths are compared as the filesystem names them, so "./a.yml", "a.yml", and a spelling through a symlinked directory
 * (macOS's /tmp for /private/tmp) all collide. Guarded beside the write, for the destination (the next run would fold
 * the merged document as if it were a layer) and for its staging sibling (the write would unlink the layer before the
 * fold's result even landed).
 */
function mergedFileCollision(cfg: MergeConfig): Result<void, ProblemOf<"merged-file-is-layer">> {
  for (const [path, staging] of [
    [cfg.mergedFile, false],
    [stagingPath(cfg.mergedFile), true],
  ] as const) {
    const landing = canonicalPath(path);
    const index = cfg.settingsFiles.findIndex((layer) => canonicalPath(layer) === landing);
    const layer = cfg.settingsFiles[index];
    if (layer !== undefined) {
      return err({
        code: "merged-file-is-layer",
        mergedFile: cfg.mergedFile,
        index,
        layer,
        staging,
      });
    }
  }
  return ok();
}

export function runMerge(cfg: MergeConfig, io: Io): Result<FinishedMerge, Problem> {
  return mergedFileCollision(cfg)
    .andThen(() => readLayerFiles(cfg.settingsFiles))
    .andThen((layers) => foldLayers(layers, MERGED_LABEL, cfg.layering, io))
    .andThen((folded): Result<FinishedMerge, Problem> => {
      for (const notice of folded.notices) {
        io.annotate("notice", describeOptOut(notice));
      }
      return writeReplacing(cfg.mergedFile, renderMergedYaml(folded.settings))
        .mapErr(
          (reason): Problem => ({ code: "merged-file-unwritable", path: cfg.mergedFile, reason }),
        )
        .map(() => ({ layers: cfg.settingsFiles, mergedFile: cfg.mergedFile }));
    });
}

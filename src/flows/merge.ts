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
import { readEntries, renameEntry, writeReplacing } from "./settings-write.js";

export interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

const MERGED_LABEL = "the merged settings document";

/**
 * An input layer is never the destination, under any name the read follows or the rename reaches: the entry the
 * rename replaces (the leaf under its resolved parent, a link there unfollowed) against every entry each layer's read
 * follows (each component, every link hop, the final file), compared by identity, so spellings, directory links, case
 * aliases, and link chains all meet. `out.yml -> layer.yml` as the destination with `layer.yml` as the layer is
 * admitted: the write replaces the link and leaves the layer intact. Guarded beside the write: the next run would
 * fold the merged document as if it were a layer.
 */
function mergedFileCollision(cfg: MergeConfig): Result<void, ProblemOf<"merged-file-is-layer">> {
  const replaced = renameEntry(cfg.mergedFile);
  if (replaced === null) {
    return ok();
  }
  const index = cfg.settingsFiles.findIndex((layer) => readEntries(layer).has(replaced));
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
      return writeReplacing(cfg.mergedFile, folded.yaml)
        .mapErr(
          (reason): Problem => ({ code: "merged-file-unwritable", path: cfg.mergedFile, reason }),
        )
        .map(() => ({ layers: cfg.settingsFiles, mergedFile: cfg.mergedFile }));
    });
}

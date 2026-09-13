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
import { canonicalPath, landingNames, renameTarget, writeReplacing } from "./settings-write.js";

export interface MergeConfig {
  settingsFiles: string[];
  mergedFile: string;
  layering: Layering;
}

const MERGED_LABEL = "the merged settings document";

/**
 * The destination's landing names (the rename target, and the referent unless the leaf is a link) against every
 * name a layer is read or written through (its rename target AND its referent, since the fold reads a link's referent
 * and the write may replace the link itself). So "./a.yml", "a.yml", a spelling through a symlinked directory (macOS's
 * /tmp for /private/tmp), a case alias of an existing layer, a layer that IS the link at the destination, and a layer
 * READ through a link to the destination (`alias.yml -> repo.yml` folded into `repo.yml`) all collide, while
 * `out.yml -> layer.yml` with `layer.yml` as the layer does not: the write replaces the link and leaves the layer
 * intact. Guarded beside the write: the next run would fold the merged document as if it were a layer.
 */
function mergedFileCollision(cfg: MergeConfig): Result<void, ProblemOf<"merged-file-is-layer">> {
  const landings = new Set(landingNames(cfg.mergedFile));
  const index = cfg.settingsFiles.findIndex((layer) =>
    [renameTarget(layer), canonicalPath(layer)].some((name) => landings.has(name)),
  );
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
      return writeReplacing(cfg.mergedFile, renderMergedYaml(folded.settings))
        .mapErr(
          (reason): Problem => ({ code: "merged-file-unwritable", path: cfg.mergedFile, reason }),
        )
        .map(() => ({ layers: cfg.settingsFiles, mergedFile: cfg.mergedFile }));
    });
}

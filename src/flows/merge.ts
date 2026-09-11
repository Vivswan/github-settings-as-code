/**
 * The mode: merge run flow: fold the settings-file layers into one validated
 * document and write it to merged-file. The written document is exactly what
 * a later apply or check step runs from that path; nothing here touches
 * GitHub, so the flow takes no client and needs no token.
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
 * Refuse a merged-file that names one of the layers. Paths are compared
 * resolved, so "./a.yml" and "a.yml" collide. Guarded here, beside the write:
 * the next run would fold the merged document as if it were a layer.
 */
function mergedFileCollision(cfg: MergeConfig): Result<void, ProblemOf<"merged-file-is-layer">> {
  const mergedPath = resolve(cfg.mergedFile);
  const index = cfg.settingsFiles.findIndex((layer) => resolve(layer) === mergedPath);
  const layer = cfg.settingsFiles[index];
  return layer === undefined
    ? ok()
    : err({ code: "merged-file-is-layer", mergedFile: cfg.mergedFile, index, layer });
}

/**
 * Execute a mode: merge run: read, fold, and write. A problem before the
 * document is written (a merged-file that is a layer, an unreadable layer, a
 * refused fold, an unwritable path) comes back for the caller to render; the
 * finished merge is what concludeMerge turns into the summary, the outputs,
 * and the exit code.
 */
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

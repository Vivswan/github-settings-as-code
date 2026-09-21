/** The action-side boundary of mode: render; nothing here reaches GitHub. */

import { ok, Result } from "neverthrow";
import { renderCanonicalYaml } from "../engine/canonical.js";
import {
  type FoldOptions,
  type Layer,
  mergeLayers,
  type RemovalNotice,
  standaloneView,
} from "../engine/layers.js";
import { type ValidatedSettings, validateSettingsDoc } from "../engine/orchestrate.js";
import { SectionSelection } from "../engine/section-selection.js";
import type { Io } from "../io.js";
import type { LayerProblem, ProblemOf, SettingsProblem } from "../problem.js";
import { readSettingsFile } from "./settings-read.js";

export function readLayerFiles(
  paths: readonly string[],
): Result<Layer[], ProblemOf<"settings-file-unreadable">> {
  return paths.reduce<Result<Layer[], ProblemOf<"settings-file-unreadable">>>(
    (layers, path) =>
      layers.andThen((read) =>
        readSettingsFile(path, "layer").map((doc) => [...read, { name: path, doc }]),
      ),
    ok([]),
  );
}

/**
 * A merge has no `sections` allowlist: the merged document is applied later by a step whose allowlist this run cannot
 * know, so an unknown top-level section is an error naming the layer, as in an apply.
 */
const EVERY_SECTION = SectionSelection.ALL;

export interface FoldedLayers {
  /** The fold as validation parsed it: the branded document every other verb takes. */
  settings: ValidatedSettings;
  notices: RemovalNotice[];
  /** The fold rendered in the canonical order (src/engine/canonical.ts), exactly as mode: render writes it to rendered-file. */
  yaml: string;
}

/**
 * One layer judged on its own, over its standalone view; an issue's list indices are the layer's own, so the path
 * names the entry the reader finds in the file, removal entries counted, as the fold's notices count them.
 */
function validateLayer(layer: Layer, io: Io): Result<ValidatedSettings, SettingsProblem> {
  const view = standaloneView(layer.doc);
  return validateSettingsDoc(view.doc, layer.name, EVERY_SECTION, io).mapErr((problem) =>
    problem.code === "settings-malformed-sections"
      ? { ...problem, issues: problem.issues.map(view.asWritten) }
      : problem,
  );
}

/**
 * A layer must be a valid document before it may contribute, so the merge can never complete a broken declaration into
 * a valid one. The fold, not the validated parse, is what is written: the file holds what the layers declared, and
 * validation only judges it.
 */
export function foldLayers(
  layers: readonly Layer[],
  sourceLabel: string,
  options: FoldOptions,
  io: Io,
): Result<FoldedLayers, SettingsProblem | LayerProblem> {
  return Result.combine(layers.map((layer) => validateLayer(layer, io)))
    .andThen(() => mergeLayers(layers, options))
    .andThen((merged) =>
      // The fold resolved every policy already, so the run input changes nothing here; passed so the two paths read alike.
      validateSettingsDoc(merged.settings, sourceLabel, EVERY_SECTION, io, {
        undeclared: options.undeclared,
      }).map((settings) => ({
        settings,
        notices: merged.notices,
        // Validation just proved the fold a plain mapping of section keys: the directives were consumed, and any other key refused.
        yaml: renderCanonicalYaml(merged.settings as Record<string, unknown>),
      })),
    );
}

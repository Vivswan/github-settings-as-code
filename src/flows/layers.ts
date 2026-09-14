/** The action-side boundary of mode: merge; nothing here reaches GitHub. */

import { ok, Result } from "neverthrow";
import { renderCanonicalYaml } from "../engine/canonical.js";
import {
  type Layer,
  type Layering,
  mergeLayers,
  type OptOutNotice,
  stripNulls,
} from "../engine/layers.js";
import { type ValidatedSettings, validateSettingsDoc } from "../engine/orchestrate.js";
import { SectionSelection } from "../engine/section-selection.js";
import type { Io } from "../io.js";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem, ProblemOf, SettingsProblem } from "../problem.js";
import { SECTION_KEYS, UNDECLARED_POLICY_SECTIONS } from "../schema.js";
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

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(SECTION_KEYS);

/**
 * The layer as the standalone validation sees it; neither marker below may reach the section shapes.
 *
 * null on a known section  -> dropped: an opt-out marker, not a setting to judge
 * a wrapper's `_layering`  -> dropped: a directive the fold validates itself
 * null on an unknown key   -> kept: it opts out of nothing, and only this per-layer pass can name the file that misspelled it
 */
function standaloneView(doc: unknown): unknown {
  const stripped = stripNulls(doc);
  if (!isPlainObject(doc) || !isPlainObject(stripped)) {
    return stripped;
  }
  for (const [key, value] of Object.entries(doc)) {
    if (value === null && !KNOWN_SECTIONS.has(key)) {
      stripped[key] = null;
    }
  }
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = stripped[key];
    if (isPlainObject(value)) {
      delete value._layering;
    }
  }
  return stripped;
}

/**
 * A merge has no `sections` allowlist: the merged document is applied later by a step whose allowlist this run cannot
 * know, so an unknown top-level section is an error naming the layer, as in an apply.
 */
const EVERY_SECTION = SectionSelection.ALL;

export interface FoldedLayers {
  /** The fold as validation parsed it: the branded document every other verb takes. */
  settings: ValidatedSettings;
  notices: OptOutNotice[];
  /** The fold rendered in the canonical order (src/engine/canonical.ts), exactly as mode: merge writes it to merged-file. */
  yaml: string;
}

/**
 * A layer must be a valid document before it may contribute, so the merge can never complete a broken declaration into
 * a valid one. The fold, not the validated parse, is what is written: the file holds what the layers declared, and
 * validation only judges it.
 */
export function foldLayers(
  layers: readonly Layer[],
  sourceLabel: string,
  layering: Layering,
  io: Io,
): Result<FoldedLayers, SettingsProblem | LayerProblem> {
  return Result.combine(
    layers.map((layer) =>
      validateSettingsDoc(standaloneView(layer.doc), layer.name, EVERY_SECTION, io),
    ),
  )
    .andThen(() => mergeLayers(layers, { layering }))
    .andThen((merged) =>
      validateSettingsDoc(merged.settings, sourceLabel, EVERY_SECTION, io).map((settings) => ({
        settings,
        notices: merged.notices,
        // Validation just proved the fold a plain mapping of section keys: the directives were consumed, and any other key refused.
        yaml: renderCanonicalYaml(merged.settings as Record<string, unknown>),
      })),
    );
}

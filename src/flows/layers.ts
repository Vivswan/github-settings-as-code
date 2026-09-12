/**
 * The action-side boundary of mode: merge: read the layer files off the local
 * filesystem, validate each on its own, fold them with the pure engine
 * (engine/layers.ts), and validate the result. Nothing here reaches GitHub.
 */

import { ok, Result } from "neverthrow";
import {
  type Layer,
  type Layering,
  mergeLayers,
  type OptOutNotice,
  stripNulls,
} from "../engine/layers.js";
import { type ValidatedSettings, validateSettingsDoc } from "../engine/orchestrate.js";
import type { Io } from "../io.js";
import { isPlainObject } from "../plain-data.js";
import type { LayerProblem, ProblemOf, SettingsProblem } from "../problem.js";
import { SECTION_KEYS, type SectionKey, UNDECLARED_POLICY_SECTIONS } from "../schema.js";
import { readSettingsFile } from "./settings-read.js";

/** Read and parse every layer, in order; the first unreadable path fails, named, and the rest are not read. */
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
 * The layer as the standalone validation sees it. A null on a known section
 * is an opt-out marker, not a setting to judge, and a knobbed wrapper's
 * `_layering` is a directive the fold validates and consumes with a message
 * naming the layer and the site; neither may reach the section shapes. A null
 * on an unknown key opts out of nothing, and only this per-layer pass can name
 * the file that misspelled it (a private `_` key's null is ignored either way).
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
 * A merge has no `sections` allowlist: the merged document is applied later by
 * a step whose allowlist this run cannot know, so every unknown top-level key
 * is an error naming the layer, as it would be for an apply.
 */
const NO_ALLOWLIST: ReadonlySet<SectionKey> = new Set();

/**
 * Validate every layer on its own terms, fold them low to high, and validate
 * the result: a layer must be a valid settings document before it may
 * contribute, so the merge can never complete a broken declaration into a
 * valid one. `sourceLabel` names the merged document in its own errors.
 */
export function foldLayers(
  layers: readonly Layer[],
  sourceLabel: string,
  layering: Layering,
  io: Io,
): Result<
  { settings: ValidatedSettings; notices: OptOutNotice[] },
  SettingsProblem | LayerProblem
> {
  return Result.combine(
    layers.map((layer) =>
      validateSettingsDoc(standaloneView(layer.doc), layer.name, NO_ALLOWLIST, io),
    ),
  )
    .andThen(() => mergeLayers(layers, { layering }))
    .andThen((merged) =>
      validateSettingsDoc(merged.settings, sourceLabel, NO_ALLOWLIST, io).map((settings) => ({
        settings,
        notices: merged.notices,
      })),
    );
}

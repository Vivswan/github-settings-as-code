/**
 * Engine-side collection of declared secret-field values. Sections declare
 * WHICH of their fields are secrets (SectionModule.secretValues); this module
 * walks the active sections of one settings document and pairs each raw
 * value with the document's provenance, so orchestrate.ts can validate and
 * resolve every reference in one place - before any section runs.
 *
 * Provenance is one value per DOCUMENT: operator- and target-authored values
 * never share a document. A target repository's own settings.yml is
 * target-authored; everything else - the single-repo settings file (and the
 * operator layers merge mode folds into it), a central per-repo file, and the
 * defaults document applied whole to a target that has no file of its own -
 * is operator-authored. The multi-repo flow decides the value where it
 * chooses the document (action/multi.ts); the single-repo flow takes the
 * engine's "operator" default.
 */

import type { SettingsSource, SourcedSecretValue } from "../action/secret-refs.js";
import type { SectionKey, SettingsFile } from "../schema.js";
import type { SectionModule } from "../sections/contract/module.js";

/** One declared secret value, tagged with the section that declared it. */
export interface SectionSecretValue extends SourcedSecretValue {
  section: SectionKey;
}

/**
 * Every declared secret-field value across the given sections, each tagged
 * with its owning section and the document's provenance. Sections without a
 * secretValues declaration contribute nothing.
 */
export function collectSecretValues(
  settings: SettingsFile,
  sections: readonly SectionModule[],
  source: SettingsSource,
): SectionSecretValue[] {
  const out: SectionSecretValue[] = [];
  for (const section of sections) {
    const declared = settings[section.key];
    if (declared === undefined || section.secretValues === undefined) {
      continue;
    }
    for (const { label, value } of section.secretValues(declared)) {
      out.push({ section: section.key, label, value, source });
    }
  }
  return out;
}

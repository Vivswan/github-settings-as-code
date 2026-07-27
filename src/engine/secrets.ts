/**
 * Engine-side collection of declared secret-field values. Sections declare
 * WHICH of their fields are secrets (SectionModule.secretValues); this module
 * walks the active sections of one merged settings document and pairs each
 * raw value with its provenance, so orchestrate.ts can validate and resolve
 * every reference in one place - before any section runs.
 *
 * Provenance is decided by the CALLER through `sourceOf`, because it is a
 * property of the source DOCUMENT, not of the merged result: the run flows
 * tag each value at read time (multi.ts builds the lookup from the
 * target-fetched document before applyDefaults folds it into the operator
 * layers), and by default every value is operator-owned (single-repo
 * settings, central files, and the defaults file are all authored by the
 * operator).
 */

import type { SettingsSource, SourcedSecretValue } from "../action/secret-refs.js";
import type { SectionKey, SettingsFile } from "../schema.js";
import type { SectionModule } from "../sections/contract.js";

/** One declared secret value, tagged with the section that declared it. */
export interface SectionSecretValue extends SourcedSecretValue {
  section: SectionKey;
}

/**
 * Every declared secret-field value across the given sections, each tagged
 * with its owning section and the provenance `sourceOf` assigns it. Sections
 * without a secretValues declaration contribute nothing.
 */
export function collectSecretValues(
  settings: SettingsFile,
  sections: readonly SectionModule[],
  sourceOf: (value: string) => SettingsSource,
): SectionSecretValue[] {
  const out: SectionSecretValue[] = [];
  for (const section of sections) {
    const declared = settings[section.key as keyof SettingsFile];
    if (declared === undefined || section.secretValues === undefined) {
      continue;
    }
    for (const value of section.secretValues(declared)) {
      out.push({ section: section.key, value, source: sourceOf(value) });
    }
  }
  return out;
}

/**
 * The raw secret-field value STRINGS one settings document declares, across
 * every registered section. The multi-repo flow calls this on a
 * target-fetched document BEFORE the defaults merge and closes over the
 * result: a merged value found in this set was declared by the target, so it
 * must be sourced "target" (references there are refused). Value-level
 * matching is sound because arrays replace wholesale in the merge - every
 * merged entry comes verbatim from exactly one source document - and a
 * collision (the same string declared by both documents) resolves to
 * "target", which fails closed.
 */
export function secretValueStrings(
  settings: SettingsFile,
  sections: readonly SectionModule[],
): Set<string> {
  const values = new Set<string>();
  for (const entry of collectSecretValues(settings, sections, () => "operator")) {
    values.add(entry.value);
  }
  return values;
}

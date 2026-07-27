/**
 * Engine-side collection of declared secret-field values. Sections declare
 * WHICH of their fields are secrets (SectionModule.secretValues); this module
 * walks the active sections of one merged settings document and pairs each
 * raw value with its provenance, so orchestrate.ts can validate and resolve
 * every reference in one place - before any section runs.
 *
 * Provenance is a property of the source DOCUMENT, not of the merged result,
 * and it survives the merge structurally: applyDefaults replaces arrays
 * wholesale (a wrapped section's entries array included), so every secret
 * value in a merged section came verbatim from exactly one document - the
 * target's when the target document declares that section, the operator's
 * defaults otherwise. targetSecretSource() turns one target-fetched document
 * into that per-section lookup at read time (multi.ts, before applyDefaults
 * folds it into the operator layers); by default every value is
 * operator-owned (single-repo settings, central files, and the defaults file
 * are all authored by the operator).
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
 * with its owning section and the provenance `sourceOf` assigns that
 * section. Sections without a secretValues declaration contribute nothing.
 */
export function collectSecretValues(
  settings: SettingsFile,
  sections: readonly SectionModule[],
  sourceOf: (section: SectionKey) => SettingsSource,
): SectionSecretValue[] {
  const out: SectionSecretValue[] = [];
  for (const section of sections) {
    const declared = settings[section.key as keyof SettingsFile];
    if (declared === undefined || section.secretValues === undefined) {
      continue;
    }
    const source = sourceOf(section.key);
    for (const value of section.secretValues(declared)) {
      out.push({ section: section.key, value, source });
    }
  }
  return out;
}

/**
 * The per-section provenance lookup for a document merged over the
 * operator's defaults, derived from the target-fetched SOURCE document's
 * structure. applyDefaults replaces arrays wholesale (a wrapped section's
 * entries array included, and a malformed target wrapper evicts the
 * defaults' section entirely), so a merged section's secret values are the
 * target's exactly when the target document declares that section; every
 * other section survives from the operator's defaults. A target's
 * `section: null` opt-out is stripped by the merge before values are
 * collected, so its attribution is never consulted.
 *
 * The two halves of the invariant carry different weight. CONFIDENTIALITY
 * (a target reference never resolves) holds UNCONDITIONALLY: attribution
 * keys off the target document's own key set, and the merge never moves
 * data across section keys, so a target-contributed value can only surface
 * in a section attributed "target" - under any merge semantics. Wholesale
 * replacement protects only AVAILABILITY: it is what stops an operator
 * value from surviving into a target-declared section and being
 * over-refused. The merge-invariant test in test/engine/secrets.test.ts
 * pins that half for every secretValues-declaring section.
 */
export function targetSecretSource(
  targetDoc: SettingsFile,
): (section: SectionKey) => SettingsSource {
  const declared = new Set<string>();
  if (typeof targetDoc === "object" && targetDoc !== null && !Array.isArray(targetDoc)) {
    for (const [key, value] of Object.entries(targetDoc)) {
      if (value !== undefined) {
        declared.add(key);
      }
    }
  }
  return (section) => (declared.has(section) ? "target" : "operator");
}

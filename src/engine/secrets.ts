/**
 * Engine-side collection of declared secret-field values. Sections declare
 * WHICH of their fields are secrets (SectionModule.secretValues); this module
 * walks the active sections of one settings document and pairs each raw
 * value with its provenance, so orchestrate.ts can validate and resolve every
 * reference in one place - before any section runs.
 *
 * Provenance is a property of the source DOCUMENT. Every document the engine
 * runs is applied as written, never merged with another, so each value in it
 * came from exactly one author: a target repository's own settings.yml is
 * target-authored, and everything else - the single-repo settings file, a
 * central per-repo file, and the defaults document (which is only ever
 * applied whole to a target that has no file of its own) - is
 * operator-authored. targetSecretSource() turns one target-fetched document
 * into the per-section lookup; by default every value is operator-owned.
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
    const declared = settings[section.key];
    if (declared === undefined || section.secretValues === undefined) {
      continue;
    }
    const source = sourceOf(section.key);
    for (const { label, value } of section.secretValues(declared)) {
      out.push({ section: section.key, label, value, source });
    }
  }
  return out;
}

/**
 * The per-section provenance lookup for a target-fetched document, derived
 * from that document's own structure: a section is sourced "target" exactly
 * when the target document declares it, "operator" otherwise.
 *
 * The two halves of the invariant hold for different reasons.
 * CONFIDENTIALITY (a target reference never resolves) holds because
 * attribution keys off the target document's own key set, so a
 * target-contributed value can only surface in a section attributed
 * "target". AVAILABILITY (an operator value is never over-refused) holds
 * because the target's document is applied as written: every value in a
 * target-declared section came from that target, and the operator-authored
 * defaults document never shares a run with it - it is only ever applied
 * whole, without this lookup, to a target that has no file of its own.
 */
export function targetSecretSource(targetDoc: unknown): (section: SectionKey) => SettingsSource {
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

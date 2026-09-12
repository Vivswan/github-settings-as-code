/**
 * Pairs each declared secret-field value (SectionModule.secretValues) with the document's provenance, so orchestrate.ts
 * validates every reference before any section runs and, in apply, resolves them all before the first write.
 * Provenance is one value per DOCUMENT: flows/multi.ts decides it where the document is chosen, and the single-repo
 * flow takes the "operator" default.
 *
 * a target repository's own settings.yml                       -> target
 * the single-repo file, a central file, the defaults document  -> operator
 */

import type { SectionKey, SettingsFile } from "../schema.js";
import type { SectionModule } from "../sections/contract/module.js";
import type { SettingsSource, SourcedSecretValue } from "./secret-refs.js";

export interface SectionSecretValue extends SourcedSecretValue {
  section: SectionKey;
}

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

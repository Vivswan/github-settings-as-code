/**
 * Pairs each declared secret-field value (SectionModule.secretValues) with the document's provenance, so orchestrate.ts
 * validates every reference before any section runs and, in apply, resolves them all before the first write.
 * Provenance is one value per DOCUMENT: flows/multi.ts decides it where the document is chosen, and the single-repo
 * flow takes the "operator" default.
 *
 * a target repository's own settings.yml                       -> target
 * the single-repo file, a central file, the defaults document  -> operator
 *
 * The snapshot direction lives here too: snapshotSecretReference mints the reference a snapshot
 * writes for a live secret whose value GitHub never reveals.
 */

import type { SectionKey, SettingsFile } from "../schema.js";
import type { SectionModule } from "../sections/contract/module.js";
import { type SettingsSource, type SourcedSecretValue, validateSecretRef } from "./secret-refs.js";

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

/**
 * The environment variable a snapshot asks the operator to export for one live secret, and the
 * whole-value reference the settings file carries for it: `SECRET_<STORE>_<NAME>`. One reference
 * per store and name, so two stores holding the same secret name never share a variable an apply
 * would write to both. The store leads so the variable stays out of the runner's reserved
 * namespaces (`ACTIONS_*` is reserved); the reference grammar itself proves the mint.
 */
export function snapshotSecretReference(
  store: string,
  secretName: string,
): { variable: string; reference: string } {
  const variable = `SECRET_${store.toUpperCase()}_${secretName}`;
  const reference = `$${variable}`;
  const checked = validateSecretRef(reference, "operator", `the ${store} secret ${secretName}`);
  if (!checked.ok) {
    throw new Error(
      `BUG: the snapshot minted a reference the settings file refuses: ${checked.error}`,
    );
  }
  return { variable, reference };
}

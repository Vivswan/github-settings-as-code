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

/** An environment variable a snapshot asks the operator to export, and its whole-value reference. */
export interface MintedSecretReference {
  readonly variable: string;
  readonly reference: string;
}

/**
 * The one mint behind every reference a snapshot writes: the variable's `$NAME` form, proved by
 * the same grammar and reserved-prefix rule the settings file enforces, so a snapshot can never
 * emit a reference an apply would refuse. `label` names the secret for the BUG prose.
 */
export function mintSecretReference(variable: string, label: string): MintedSecretReference {
  const reference = `$${variable}`;
  const checked = validateSecretRef(reference, "operator", label);
  if (!checked.ok) {
    throw new Error(
      `BUG: the snapshot minted a reference the settings file refuses: ${checked.error}`,
    );
  }
  return { variable, reference };
}

/**
 * `SECRET_` leads so a store named like a runner namespace (`ACTIONS_*`) still mints a legal
 * reference; the store follows so two stores holding one secret name never share a variable.
 */
export function snapshotSecretReference(store: string, secretName: string): MintedSecretReference {
  return mintSecretReference(
    `SECRET_${store.toUpperCase()}_${secretName}`,
    `the ${store} secret ${secretName}`,
  );
}

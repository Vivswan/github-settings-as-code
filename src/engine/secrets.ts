/**
 * Collects the secret references (SectionModule.secretValues) of the sections a run executes, so orchestrate.ts
 * resolves them all in apply before the first write. The document is validated, so every value is a whole-value
 * `$NAME` reference its provenance may carry (engine/validate.ts refused the rest, a target-authored reference
 * included), and the collection names variables.
 *
 * The snapshot direction lives here too: snapshotSecretReference mints the reference a snapshot
 * writes for a live secret whose value GitHub never reveals.
 */

import type { SectionKey } from "../schema.js";
import type { SectionModule } from "../sections/contract/module.js";
import type { ValidatedSettings } from "./orchestrate.js";
import { referenceName, validateSecretRef } from "./secret-refs.js";

/** One variable a section's secret field references, without the `$`. */
export interface SectionSecretReference {
  readonly section: SectionKey;
  readonly name: string;
}

export function collectSecretReferences(
  settings: ValidatedSettings,
  sections: readonly SectionModule[],
): SectionSecretReference[] {
  const out: SectionSecretReference[] = [];
  for (const section of sections) {
    const declared = settings[section.key];
    if (declared === undefined || section.secretValues === undefined) {
      continue;
    }
    for (const { value } of section.secretValues(declared)) {
      out.push({ section: section.key, name: referenceName(value) });
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
function mintSecretReference(variable: string, label: string): MintedSecretReference {
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

/**
 * The one way a test hands a planner its input: through the real validation phase (validateSettingsDoc), so the brand
 * is minted where the engine mints it, and a fixture the validator refuses fails the test naming the problem instead of
 * riding a cast into plan(). Every file-only check runs here, as it does before a run's first write. The value is
 * deep-frozen: the engine hands one document to every section, so a planner that mutated its input would corrupt what
 * the next section (and the report) reads; here that mutation throws instead.
 */

import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import type { SectionKey } from "../../src/schema.js";
import { deepFreeze, type ValidatedInput } from "../../src/sections/contract/module.js";

/**
 * The overload is the typed door: the implementation reads the section back off the validated document, whose value
 * over a generic key is the union of every section's input, and the overload names the one section the key selects.
 * No cast: the brand comes from the validator's own return.
 */
export function validatedInput<K extends SectionKey>(key: K, declared: unknown): ValidatedInput<K>;
export function validatedInput(key: SectionKey, declared: unknown): ValidatedInput<SectionKey> {
  const verdict = validateSettingsDoc(
    { [key]: declared },
    "test fixture",
    SectionSelection.ALL,
    silentIo(),
  );
  if (verdict.isErr()) {
    throw new Error(`test fixture failed validation: ${describeProblem(verdict.error)}`);
  }
  const value = verdict.value[key];
  if (value === undefined) {
    throw new Error(
      `BUG: the validated document carries no "${key}" section although the fixture declared one; validation dropped it`,
    );
  }
  deepFreeze(value);
  return value;
}

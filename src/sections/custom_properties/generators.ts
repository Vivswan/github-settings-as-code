/**
 * The custom_properties section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, mock/state.ts, prng.ts) - the src -> test inversion is
 * deliberate; the bundle entry is src/main.ts, so this file never reaches
 * lib/index.js.
 */

import { type EntriesForm, type Json, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import { CUSTOM_PROPERTY_DEFINITIONS } from "../../../test/e2e/mock/state.js";
import type { Rng } from "../../../test/e2e/prng.js";

/**
 * Custom property values, drawn ONLY from CUSTOM_PROPERTY_DEFINITIONS (the
 * mock's org-level definition fixture, shared with the values PATCH handler)
 * with type-appropriate values, so a generated declaration never trips the
 * undefined-property 422 the oracle does not model. A small null draw
 * exercises the unset path (a declared null over an empty live baseline is
 * simply already-converged).
 */
export function genCustomProperties(rng: Rng): EntriesForm {
  const entries: Json[] = [];
  for (const definition of CUSTOM_PROPERTY_DEFINITIONS) {
    if (!rng.bool(0.6)) {
      continue;
    }
    let value: Json[keyof Json];
    if (rng.bool(0.15)) {
      value = null;
    } else if (definition.value_type === "string") {
      value = rng.pick(["platform", "payments", "infra"]);
    } else if (definition.value_type === "true_false") {
      // Both spellings on purpose: a declared boolean must normalize to the
      // "true"/"false" string GitHub stores.
      value = rng.pick([true, false, "true", "false"] as const);
    } else {
      const allowed = [...(definition.allowed_values ?? [])];
      const picked = allowed.slice(0, rng.int(allowed.length) + 1);
      // Sometimes reversed: multi_select compares order-insensitively.
      value = rng.bool(0.5) ? picked : picked.reverse();
    }
    entries.push({ property_name: definition.property_name, value });
  }
  if (entries.length === 0) {
    const definition = rng.pick(
      CUSTOM_PROPERTY_DEFINITIONS.filter((d) => d.value_type === "string"),
    );
    entries.push({ property_name: definition.property_name, value: "platform" });
  }
  return maybeWrapUndeclared(rng, entries);
}

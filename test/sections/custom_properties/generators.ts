/**
 * The custom_properties fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import { type EntriesForm, type Json, maybeWrapUndeclared } from "../../e2e/gen-support.js";
import { CUSTOM_PROPERTY_DEFINITIONS } from "../../e2e/mock/state.js";
import type { Rng } from "../../e2e/prng.js";

/**
 * Values are drawn ONLY from CUSTOM_PROPERTY_DEFINITIONS (the fixture the mock's PATCH handler
 * validates against), so a generated declaration never trips the undefined-property 422 the oracle
 * does not model.
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
      // Both spellings on purpose: a declared boolean must normalize to the "true"/"false" string GitHub stores.
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

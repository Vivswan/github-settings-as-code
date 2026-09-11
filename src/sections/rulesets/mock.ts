/**
 * The rulesets section's mock handler fragment (see test/e2e/mock/sections.ts
 * for the aggregation and the deliberate src -> test import direction).
 */

import {
  asObject,
  invalidRuleTypeResponse,
  type Json,
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const rulesetsMockHandlers: SectionRestHandlers<"rulesets"> = {
  "rulesets.list": ({ state, query }) => ok(slicePage(state.rulesets, query)),
  "rulesets.create": ({ state, body }) => {
    const invalid = invalidRuleTypeResponse(body, "create-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const ruleset: Json = { id: state.nextId++, source_type: "Repository", ...asObject(body) };
    state.rulesets.push(ruleset);
    return { status: 201, body: ruleset };
  },
  "rulesets.get": ({ state, param }) => {
    const id = param("ruleset_id");
    const ruleset = state.rulesets.find((r) => String(r.id) === id);
    if (!ruleset) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(ruleset);
  },
  "rulesets.update": ({ state, param, body }) => {
    const id = param("ruleset_id");
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      // Existence first, like GitHub: an unknown ruleset 404s even when the
      // payload also carries an invalid rule type.
      return { status: 404, body: { message: "Not Found" } };
    }
    const invalid = invalidRuleTypeResponse(body, "update-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const updated: Json = { id: Number(id), source_type: "Repository", ...asObject(body) };
    state.rulesets[index] = updated;
    return ok(updated);
  },
  "rulesets.remove": ({ state, param }) => {
    const id = param("ruleset_id");
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.rulesets.splice(index, 1);
    return noContent();
  },
};

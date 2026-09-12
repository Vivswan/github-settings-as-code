/**
 * The rulesets e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
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

// GitHub returns bypass_actors only to a token with write access to the ruleset (Administration at
// write); every other read omits the KEY, never answering `[]`, and the list never carries it.
function withoutBypassActors(ruleset: Json): Json {
  const { bypass_actors: _hidden, ...visible } = ruleset;
  return visible;
}

// The admin view always carries the key: a ruleset stored without one reads `bypass_actors: []`.
function withBypassActors(ruleset: Json): Json {
  return { bypass_actors: [], ...ruleset };
}

export const rulesetsMockHandlers: SectionRestHandlers<"rulesets"> = {
  "rulesets.list": ({ state, query }) =>
    ok(slicePage(state.rulesets, query).map(withoutBypassActors)),
  "rulesets.create": ({ state, body }) => {
    const invalid = invalidRuleTypeResponse(body, "create-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const ruleset: Json = { id: state.nextId++, source_type: "Repository", ...asObject(body) };
    state.rulesets.push(ruleset);
    return { status: 201, body: withBypassActors(ruleset) };
  },
  "rulesets.get": ({ state, param, grants }) => {
    const id = param("ruleset_id");
    const ruleset = state.rulesets.find((r) => String(r.id) === id);
    if (!ruleset) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(grants("write") ? withBypassActors(ruleset) : withoutBypassActors(ruleset));
  },
  "rulesets.update": ({ state, param, body }) => {
    const id = param("ruleset_id");
    const index = state.rulesets.findIndex((r) => String(r.id) === id);
    if (index < 0) {
      // Existence first, like GitHub: an unknown ruleset 404s even when the payload also carries an invalid rule type.
      return { status: 404, body: { message: "Not Found" } };
    }
    const invalid = invalidRuleTypeResponse(body, "update-a-repository-ruleset");
    if (invalid) {
      return invalid;
    }
    const updated: Json = { id: Number(id), source_type: "Repository", ...asObject(body) };
    state.rulesets[index] = updated;
    return ok(withBypassActors(updated));
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

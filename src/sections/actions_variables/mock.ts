/**
 * actions_variables mock fragment: the section's e2e handlers, registered in
 * test/e2e/mock/sections.ts. Imports only the test-tree leaf seams
 * (support.ts) - the src -> test inversion is deliberate; the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import {
  asObject,
  type Json,
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
  VARIABLE_CANONICAL_KEYS,
  variableName,
} from "../../../test/e2e/mock/support.js";
import { actionsVariablesSection } from "./index.js";

export const actionsVariablesMockHandlers: SectionRestHandlers<"actions_variables"> = {
  "actions_variables.list": ({ state, query }) => {
    // The cap comes from the endpoint DECLARATION, the same single source
    // the client's page loop and the spec-derived pageSize sweep read - so
    // the mock can never clamp at a stale number the section stopped using.
    const page = slicePage(
      state.actions_variables,
      query,
      actionsVariablesSection.endpoints.list.pageSize,
    );
    return ok({ total_count: state.actions_variables.length, variables: page });
  },
  "actions_variables.create": ({ state, body }) => {
    const payload = asObject(body);
    // GitHub stores variable names uppercased regardless of how they are
    // entered (the variables naming rules; the spec examples show uppercase
    // names), so the stored GET shape carries the uppercase name. Payload
    // spread FIRST so passthrough fields the section sends (and later
    // subsetDiffs) are stored and read back; the canonical fields are then
    // normalized over them.
    const variable: Json = {
      ...payload,
      name: variableName(payload),
      value: payload.value ?? "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    state.actions_variables.push(variable);
    // The documented 201 body is an empty object.
    return { status: 201, body: {} };
  },
  "actions_variables.update": ({ state, param, body }) => {
    const name = param("name").toUpperCase();
    const variable = state.actions_variables.find((v) => String(v.name).toUpperCase() === name);
    if (!variable) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.name === "string") {
      variable.name = payload.name.toUpperCase();
    }
    if (payload.value !== undefined) {
      variable.value = payload.value;
    }
    // Passthrough fields update verbatim, mirroring the create path, so a
    // second apply's subsetDiff over them reads back what was written.
    for (const [key, value] of Object.entries(payload)) {
      if (VARIABLE_CANONICAL_KEYS.has(key)) {
        continue;
      }
      variable[key] = value;
    }
    return noContent();
  },
  "actions_variables.remove": ({ state, param }) => {
    const name = param("name").toUpperCase();
    const index = state.actions_variables.findIndex((v) => String(v.name).toUpperCase() === name);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.actions_variables.splice(index, 1);
    return noContent();
  },
};

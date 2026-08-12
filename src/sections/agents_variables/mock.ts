/**
 * agents_variables mock fragment: the section's e2e handlers, registered in
 * test/e2e/mock/sections.ts. Imports only the test-tree leaf seams
 * (support.ts) - the src -> test inversion is deliberate; the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js. The Copilot agents
 * variable store mirrors the actions_variables handlers exactly: same GET
 * shape, same uppercase-stored names, same 30-item page cap read from the
 * endpoint declaration.
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
import { agentsVariablesSection } from "./index.js";

export const agentsVariablesMockHandlers: SectionRestHandlers<"agents_variables"> = {
  "agents_variables.list": ({ state, query }) => {
    const page = slicePage(
      state.agents_variables,
      query,
      agentsVariablesSection.endpoints.list.pageSize,
    );
    return ok({ total_count: state.agents_variables.length, variables: page });
  },
  "agents_variables.create": ({ state, body }) => {
    const payload = asObject(body);
    const variable: Json = {
      ...payload,
      name: variableName(payload),
      value: payload.value ?? "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    state.agents_variables.push(variable);
    // The documented 201 body is an empty object.
    return { status: 201, body: {} };
  },
  "agents_variables.update": ({ state, param, body }) => {
    const name = param("name").toUpperCase();
    const variable = state.agents_variables.find((v) => String(v.name).toUpperCase() === name);
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
  "agents_variables.remove": ({ state, param }) => {
    const name = param("name").toUpperCase();
    const index = state.agents_variables.findIndex((v) => String(v.name).toUpperCase() === name);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.agents_variables.splice(index, 1);
    return noContent();
  },
};

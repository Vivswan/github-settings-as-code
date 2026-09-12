/**
 * A REAL HandlerContext for handler unit tests, built from the declarations so a context under a key its section never
 * declared cannot be constructed; param() keeps the pipeline's loud-if-touched contract (dispatch.ts, paramAccessor).
 */

import { allEndpoints, type SectionEndpointKey } from "../../../src/sections/registry.js";
import { GRADE_RANK, type MaskGrade } from "../schema.js";
import { type MockState, named } from "./state.js";
import type { Handler } from "./support.js";

export function handlerTestContext(
  key: SectionEndpointKey,
  state: MockState,
  opts: {
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    /** The token's grade on the endpoint's permission; write, the mask default, unless a test narrows it. */
    grade?: MaskGrade;
  } = {},
): Parameters<Handler>[0] {
  const endpoint = allEndpoints()[key];
  const params = named(opts.params);
  return {
    state,
    endpoint,
    param: (name: string): string => {
      const value = params[name];
      if (value === undefined) {
        throw new Error(
          `handlerTestContext: no "${name}" param supplied for ${key} (${endpoint.route})`,
        );
      }
      return value;
    },
    query: opts.query ?? {},
    body: opts.body,
    grants: (kind) => GRADE_RANK[opts.grade ?? "write"] >= GRADE_RANK[kind],
  };
}

/**
 * A REAL HandlerContext for handler-level unit tests: the endpoint comes
 * from the section declarations (never fabricated), and param() serves only
 * the tokens the caller supplies, throwing with the declared route otherwise
 * - the same loud-if-touched contract the pipeline's own extraction keeps.
 * Tests import this instead of casting a partial context, so an impossible
 * context (a handler under a key its section never declared) cannot be
 * constructed.
 */

import { allEndpoints } from "../../../src/sections/registry.js";
import type { MockState } from "./state.js";
import type { Handler } from "./support.js";

export function handlerTestContext(
  key: string,
  state: MockState,
  opts: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {},
): Parameters<Handler>[0] {
  const endpoint = allEndpoints()[key];
  if (endpoint === undefined) {
    throw new Error(`handlerTestContext: "${key}" is not a declared section endpoint`);
  }
  return {
    state,
    endpoint,
    param: (name: string): string => {
      const value = opts.params?.[name];
      if (value === undefined) {
        throw new Error(
          `handlerTestContext: no "${name}" param supplied for ${key} (${endpoint.route})`,
        );
      }
      return value;
    },
    query: opts.query ?? {},
    body: opts.body,
  };
}

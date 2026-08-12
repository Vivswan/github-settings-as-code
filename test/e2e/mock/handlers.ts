/**
 * The merged per-endpoint handler tables, one entry per "section.role" key in
 * allEndpoints() / allGraphqlOps(), and the construction-time assertions that
 * pin the merged tables against the declarations in both directions. The
 * entries themselves live in the section fragments (sections.ts, and each
 * moved section's src/sections/<key>/mock.ts).
 */

import {
  allEndpoints,
  allGraphqlOps,
  type TaggedEndpoint,
  type TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import { sectionGraphqlHandlerFragments, sectionHandlerFragments } from "./sections.js";
import type { GraphqlHandler, Handler } from "./support.js";

export const HANDLERS: Record<string, Handler> = sectionHandlerFragments();
export const GRAPHQL_HANDLERS: Record<string, GraphqlHandler> = sectionGraphqlHandlerFragments();

// --- Startup assertions ---------------------------------------------------

/**
 * Where a missing key's handler belongs, read from the declaration's own
 * section tag: the section's fragment (src/sections/<section>/mock.ts) once
 * the section has moved, or mock/sections.ts while it still lives there - so
 * the error names the exact file to edit instead of pointing every
 * contributor at the legacy fragment.
 */
function missingHandlerPointer(missing: Array<[string, { section: string }]>): string {
  return missing
    .map(
      ([key, { section }]) =>
        `${key} (add it in src/sections/${section}/mock.ts, or mock/sections.ts while the section lives there)`,
    )
    .sort()
    .join(", ");
}

/**
 * Every allEndpoints() key MUST have a handler and every handler key MUST
 * exist in allEndpoints(), both directions. Adding a section endpoint without
 * a mock handler (or leaving a stale handler after a route is removed) fails
 * here, at server construction, instead of hiding until a scenario happens to
 * exercise that route. Exported so a unit test can assert on it directly.
 */
export function assertHandlerCompleteness(
  endpoints: Readonly<Record<string, TaggedEndpoint>> = allEndpoints(),
  handlers: Record<string, Handler> = HANDLERS,
): void {
  const endpointKeys = new Set(Object.keys(endpoints));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = Object.entries(endpoints).filter(([key]) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !endpointKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`endpoints with no mock handler: [${missingHandlerPointer(missing)}]`);
    }
    if (extra.length > 0) {
      lines.push(`handlers naming no known endpoint: [${extra.sort().join(", ")}]`);
    }
    throw new Error(
      `E2E MOCK: handler table out of sync with allEndpoints()\n  ${lines.join("\n  ")}`,
    );
  }
}

/**
 * assertHandlerCompleteness for the GraphQL table: every allGraphqlOps() key
 * MUST have a handler and every handler key MUST name a declared operation,
 * both directions, asserted at server construction. Exported with injectable
 * dictionaries so a unit test can drive both failure directions.
 */
export function assertGraphqlHandlerCompleteness(
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): void {
  const opKeys = new Set(Object.keys(ops));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = Object.entries(ops).filter(([key]) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !opKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`GraphQL operations with no mock handler: [${missingHandlerPointer(missing)}]`);
    }
    if (extra.length > 0) {
      lines.push(`GraphQL handlers naming no declared operation: [${extra.sort().join(", ")}]`);
    }
    throw new Error(
      `E2E MOCK: GraphQL handler table out of sync with allGraphqlOps()\n  ${lines.join("\n  ")}`,
    );
  }
}

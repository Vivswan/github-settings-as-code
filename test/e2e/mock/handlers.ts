/**
 * The merged per-endpoint handler tables, one entry per "section.role" key in
 * allEndpoints() / allGraphqlOps(), and the construction-time assertions that
 * pin the merged tables against the declarations in both directions. The
 * entries themselves live in each section's src/sections/<key>/mock.ts,
 * registered per SectionKey in sections.ts. Since the fragment record is a
 * mapped type over SectionKey and each fragment is a Record over its exact
 * key union, both assertions below are unreachable by construction; they
 * stay as runtime backstops behind that type-level claim.
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
 * section tag: the section's fragment in src/sections/<section>/mock.ts -
 * so the error names the exact file to edit.
 */
function missingHandlerPointer(missing: Array<[string, { section: string }]>): string {
  return missing
    .map(([key, { section }]) => `${key} (add it in src/sections/${section}/mock.ts)`)
    .sort()
    .join(", ");
}

/**
 * The one completeness assertion both tables share: every declared key MUST
 * have a handler and every handler key MUST name a declaration, both
 * directions. Only the prose differs per table, so it arrives as arguments.
 */
function assertTableCompleteness(
  declared: Readonly<Record<string, { section: string }>>,
  handlers: Record<string, unknown>,
  prose: { header: string; missing: string; extra: string },
): void {
  const declaredKeys = new Set(Object.keys(declared));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = Object.entries(declared).filter(([key]) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !declaredKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`${prose.missing}: [${missingHandlerPointer(missing)}]`);
    }
    if (extra.length > 0) {
      lines.push(`${prose.extra}: [${extra.sort().join(", ")}]`);
    }
    throw new Error(`E2E MOCK: ${prose.header}\n  ${lines.join("\n  ")}`);
  }
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
  assertTableCompleteness(endpoints, handlers, {
    header: "handler table out of sync with allEndpoints()",
    missing: "endpoints with no mock handler",
    extra: "handlers naming no known endpoint",
  });
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
  assertTableCompleteness(ops, handlers, {
    header: "GraphQL handler table out of sync with allGraphqlOps()",
    missing: "GraphQL operations with no mock handler",
    extra: "GraphQL handlers naming no declared operation",
  });
}

/**
 * The merged handler tables and the assertions pinning them against allEndpoints() / allGraphqlOps() in both directions.
 * The mapped types in sections.ts make both unreachable; they stay as runtime backstops behind that type-level claim.
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

function missingHandlerPointer(missing: Array<[string, { section: string }]>): string {
  return missing
    .map(([key, { section }]) => `${key} (add it in src/sections/${section}/mock.ts)`)
    .sort()
    .join(", ");
}

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

/** Fails at server construction instead of hiding until a scenario happens to exercise the route. Exported for a unit test. */
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

/** The GraphQL table's twin; injectable dictionaries so a unit test can drive both failure directions. */
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

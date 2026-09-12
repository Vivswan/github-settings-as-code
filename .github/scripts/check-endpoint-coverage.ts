/**
 * Endpoint-coverage tripwire: every "section.role" key in allEndpoints() AND allGraphqlOps() must be reached by the
 * curated corpus at least once. A cold route is a blind spot, an endpoint the action can call that no scenario
 * reaches, so a regression there would ship unnoticed.
 *
 * `bun .github/scripts/check-endpoint-coverage.ts` fails on any cold route, naming it.
 */

import {
  endpointMethod,
  endpointPath,
  matchesTemplate,
} from "../../src/sections/contract/endpoints.js";
import { allEndpoints, allGraphqlOps } from "../../src/sections/registry.js";
import type { LoggedRequest } from "../../test/e2e/mock/contract.js";
import { runScenario } from "../../test/e2e/runner.js";
import { loadScenarios, scenarioRoots } from "../../test/e2e/schema.js";

type Route =
  | { kind: "rest"; key: string; method: string; path: string }
  | { kind: "graphql"; key: string; opName: string };

export function registeredRoutes(): Route[] {
  return [
    ...Object.entries(allEndpoints()).map(
      ([key, endpoint]): Route => ({
        kind: "rest",
        key,
        method: endpointMethod(endpoint.route),
        path: endpointPath(endpoint.route),
      }),
    ),
    ...Object.entries(allGraphqlOps()).map(
      ([key, op]): Route => ({ kind: "graphql", key, opName: op.name }),
    ),
  ];
}

export function recordHits(
  requests: readonly LoggedRequest[],
  routes: Route[],
  hit: Set<string>,
): void {
  for (const request of requests) {
    for (const route of routes) {
      if (hit.has(route.key)) {
        continue;
      }
      const matched =
        route.kind === "graphql"
          ? request.graphql?.operationName === route.opName
          : route.method === request.method && matchesTemplate(route.path, request.pathname);
      if (matched) {
        hit.add(route.key);
      }
    }
  }
}

export function coldRoutes(hit: ReadonlySet<string>, routes: Route[]): string[] {
  return routes
    .filter((route) => !hit.has(route.key))
    .map((route) => route.key)
    .sort();
}

async function main(): Promise<number> {
  const routes = registeredRoutes();
  const hit = new Set<string>();

  const roots = scenarioRoots();
  const scenarios = loadScenarios(roots);
  if (scenarios.length === 0) {
    console.error(`no scenarios found under ${roots.join(", ")}`);
    return 1;
  }
  for (const scenario of scenarios) {
    // A scenario's own pass/fail is the corpus job's concern; here only its reached routes matter. runScenario
    // returns a report (with the request log) even for a failing scenario, so a THROW is the one path that loses the
    // routes it did reach and can turn a real hit into a cold route: name the scenario loudly, never swallow it.
    try {
      const report = await runScenario(scenario);
      recordHits(report.requests, routes, hit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `coverage: scenario "${scenario.name}" threw during its run, so its routes are unattributed: ${message}`,
      );
    }
  }

  const cold = coldRoutes(hit, routes);
  console.log(`endpoint coverage: ${routes.length - cold.length}/${routes.length} routes hit`);
  if (cold.length > 0) {
    console.error(
      `cold routes never exercised by the corpus (add a scenario that reaches each):\n  ${cold.join("\n  ")}`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

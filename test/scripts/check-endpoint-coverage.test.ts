import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import {
  coldRoutes,
  type RouteRegistry,
  recordHits,
  registeredRoutes,
} from "../../.github/scripts/check-endpoint-coverage.js";
import type { LoggedRequest } from "../../test/e2e/mock/contract.js";

const ROUTES = [
  { kind: "rest", key: "labels.list", method: "GET", path: "/repos/{owner}/{repo}/labels" },
  { kind: "rest", key: "labels.create", method: "POST", path: "/repos/{owner}/{repo}/labels" },
  {
    kind: "rest",
    key: "labels.update",
    method: "PATCH",
    path: "/repos/{owner}/{repo}/labels/{name}",
  },
  { kind: "rest", key: "teams.org", method: "GET", path: "/orgs/{org}" },
  { kind: "graphql", key: "repository.gToggles", opName: "RepoToggles" },
  { kind: "graphql", key: "environments.gPin", opName: "PinEnvironment" },
] satisfies Parameters<typeof recordHits>[1];

function req(method: string, pathname: string): LoggedRequest {
  return { method, pathname, query: "", status: 200 };
}

describe("registeredRoutes", () => {
  // The gate's one negative control: a registry that regressed to nothing would otherwise read "0/0 routes hit" and exit 0.
  test.each<[name: string, registry: RouteRegistry, result: ReturnType<typeof registeredRoutes>]>([
    [
      "an empty registry is refused naming the fix",
      { endpoints: {}, graphqlOps: {} },
      err(
        "no routes registered: allEndpoints() and allGraphqlOps() returned nothing, so the coverage gate would pass vacuously; fix the registry (src/sections/registry.ts) or the import in .github/scripts/check-endpoint-coverage.ts",
      ),
    ],
    [
      "a populated registry is split into key, method, and path template, REST before GraphQL",
      {
        endpoints: { "labels.list": { route: "GET /repos/{owner}/{repo}/labels" } },
        graphqlOps: { "repository.gToggles": { name: "RepoToggles" } },
      },
      ok([
        { kind: "rest", key: "labels.list", method: "GET", path: "/repos/{owner}/{repo}/labels" },
        { kind: "graphql", key: "repository.gToggles", opName: "RepoToggles" },
      ]),
    ],
  ])("%s", (_name, registry, result) => {
    expect(registeredRoutes(registry)).toEqual(result);
  });
});

describe("recordHits", () => {
  test("attributes each request to the route with its method and path template, accumulating across calls", () => {
    const hit = new Set<string>();
    recordHits([req("GET", "/repos/o/r/labels"), req("GET", "/repos/o/r/unknown")], ROUTES, hit);
    expect(hit).toEqual(new Set(["labels.list"]));
    // A route already hit precedes the ones these requests reach, so a scan that stops at it misses them.
    recordHits(
      [
        req("POST", "/repos/o/r/labels"),
        req("PATCH", "/repos/o/r/labels/bug"),
        req("GET", "/orgs/acme"),
      ],
      ROUTES,
      hit,
    );
    expect(hit).toEqual(new Set(["labels.list", "labels.create", "labels.update", "teams.org"]));
  });

  test("a GraphQL request attributes by the logged operationName, never the path", () => {
    // Two GraphQL routes share the one path, so a match on the path would attribute both.
    const hit = new Set<string>();
    recordHits(
      [
        { ...req("POST", "/graphql"), graphql: { operationName: "RepoToggles", kind: "read" } },
        // A /graphql request that resolved no operation attributes nothing.
        req("POST", "/graphql"),
      ],
      ROUTES,
      hit,
    );
    expect(hit).toEqual(new Set(["repository.gToggles"]));
  });
});

describe("coldRoutes", () => {
  test("names every route no request reached, sorted by key", () => {
    // The cold routes sit in ROUTES as labels.create, teams.org, repository.gToggles, environments.gPin: not key order.
    const hit = new Set(["labels.list", "labels.update"]);
    expect(coldRoutes(hit, ROUTES)).toEqual([
      "environments.gPin",
      "labels.create",
      "repository.gToggles",
      "teams.org",
    ]);
  });
});

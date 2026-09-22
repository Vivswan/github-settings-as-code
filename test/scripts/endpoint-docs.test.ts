import { describe, expect, test } from "bun:test";
import { schema as published } from "@octokit/graphql-schema";
import { buildSchema, type GraphQLObjectType, isObjectType } from "graphql";
import {
  ENDPOINT_DOCS,
  ENDPOINT_DOCS_PATH,
  type EndpointDocs,
  resolveAnchors,
  type SpecOperations,
} from "../../.github/scripts/endpoint-docs.js";
import { UNDOCUMENTED_ROUTES } from "../../src/upstream-gaps/index.js";

describe("resolveAnchors", () => {
  const spec: SpecOperations = {
    "/repos/{owner}/{repo}/labels": {
      get: { externalDocs: { url: "https://docs.github.com/rest/issues/labels#list-labels" } },
      post: {},
    },
    "/repos/{owner}/{repo}/pages": {
      get: {
        externalDocs: { url: "https://docs.github.com/rest/pages/pages#get-a-apiname-pages-site" },
      },
    },
  };
  const hand: EndpointDocs = {
    rest: {
      "POST /repos/{owner}/{repo}/labels": "https://docs.github.com/en/rest/issues/labels#create",
    },
    graphql: {
      PinEnvironment:
        "https://docs.github.com/en/graphql/reference/deployments#mutation-pinenvironment",
    },
  };
  const routes = [
    "GET /repos/{owner}/{repo}/labels",
    "POST /repos/{owner}/{repo}/labels",
    "GET /repos/{owner}/{repo}/pages",
  ];

  test("a documented route takes the descriptor's link in the served spelling, an undocumented one the hand page", () => {
    // A route whose descriptor operation exists without externalDocs (the POST) counts as undocumented.
    expect(resolveAnchors(spec, hand, routes, ["PinEnvironment"])).toEqual({
      rest: {
        "GET /repos/{owner}/{repo}/labels":
          "https://docs.github.com/en/rest/issues/labels#list-labels",
        "POST /repos/{owner}/{repo}/labels": "https://docs.github.com/en/rest/issues/labels#create",
        "GET /repos/{owner}/{repo}/pages":
          "https://docs.github.com/en/rest/pages/pages#get-a-github-pages-site",
      },
      graphql: {
        PinEnvironment:
          "https://docs.github.com/en/graphql/reference/deployments#mutation-pinenvironment",
      },
    });
  });

  test.each<
    [label: string, hand: EndpointDocs, routes: string[], operations: string[], problem: string]
  >([
    [
      "a declared route with a page in neither place",
      hand,
      [...routes, "DELETE /repos/{owner}/{repo}/labels/{name}"],
      ["PinEnvironment"],
      `"DELETE /repos/{owner}/{repo}/labels/{name}" has no page: the descriptor does not document it, so add one under rest: in ${ENDPOINT_DOCS_PATH}`,
    ],
    [
      "a hand page for a route the descriptor documents",
      {
        ...hand,
        rest: { ...hand.rest, "GET /repos/{owner}/{repo}/labels": "https://docs.github.com/en/x" },
      },
      routes,
      ["PinEnvironment"],
      `"GET /repos/{owner}/{repo}/labels" has a page in both the descriptor and ${ENDPOINT_DOCS_PATH}; delete the hand entry`,
    ],
    [
      "a hand page for a route no section declares",
      {
        ...hand,
        rest: { ...hand.rest, "PUT /repos/{owner}/{repo}/topics": "https://docs.github.com/en/x" },
      },
      routes,
      ["PinEnvironment"],
      `${ENDPOINT_DOCS_PATH} names "PUT /repos/{owner}/{repo}/topics" under rest:, which no section declares; delete the entry`,
    ],
    [
      "a declared operation without a page",
      hand,
      routes,
      ["PinEnvironment", "ReorderEnvironment"],
      `the GraphQL operation "ReorderEnvironment" has no page; add one under graphql: in ${ENDPOINT_DOCS_PATH}`,
    ],
    [
      "a hand page for an operation no section declares",
      hand,
      routes,
      [],
      `${ENDPOINT_DOCS_PATH} names "PinEnvironment" under graphql:, which no section declares; delete the entry`,
    ],
  ])("fails naming %s", (_, handPages, declaredRoutes, operations, problem) => {
    expect(() => resolveAnchors(spec, handPages, declaredRoutes, operations)).toThrow(problem);
  });

  test("every problem is reported in one failure, not the first alone", () => {
    expect(() =>
      resolveAnchors(spec, { rest: {}, graphql: {} }, routes, ["PinEnvironment"]),
    ).toThrow(
      /"POST \/repos\/\{owner\}\/\{repo\}\/labels" has no page[\s\S]*"PinEnvironment" has no page/,
    );
  });
});

describe("endpoint-docs.yml against the registry and the descriptor", () => {
  test("the hand file holds only the undocumented routes", () => {
    // The hand REST pages are exactly the routes the descriptor omits: the upstream gaps' undocumented routes.
    expect(Object.keys(ENDPOINT_DOCS.rest).sort()).toEqual(
      [...new Set<string>(UNDOCUMENTED_ROUTES)].sort(),
    );
  });

  test("a GraphQL page is a category-page anchor on an entry the schema declares", () => {
    // docs.github.com anchors each reference entry as <kind>-<lowercased name> on a category page. A name the schema
    // does not declare is a link that 404s. The category itself comes from a @docsCategory directive the introspected
    // schema @octokit/graphql-schema ships cannot carry, so a wrong category page is not caught here.
    const schema = buildSchema(published.idl, { assumeValid: true });
    const fields = (type: GraphQLObjectType | null | undefined) =>
      new Set(Object.keys(type?.getFields() ?? {}).map((name) => name.toLowerCase()));
    const declared: Record<string, ReadonlySet<string>> = {
      mutation: fields(schema.getMutationType()),
      query: fields(schema.getQueryType()),
      object: new Set(
        Object.values(schema.getTypeMap())
          .filter(isObjectType)
          .map((type) => type.name.toLowerCase()),
      ),
    };
    const anchor =
      /^https:\/\/docs\.github\.com\/en\/graphql\/reference\/[a-z-]+#(mutation|query|object)-([a-z0-9]+)$/;
    /** "ok", or why the URL is wrong. */
    const verdict = (url: string): string => {
      const match = anchor.exec(url);
      if (match === null) {
        return "not a category-page anchor";
      }
      const [, kind, name] = match;
      return declared[kind ?? ""]?.has(name ?? "")
        ? "ok"
        : `the schema declares no ${kind} named "${name}"`;
    };
    // Controls: the right page passes; an undeclared name and the retired flat page each fail.
    const base = "https://docs.github.com/en/graphql/reference/";
    expect(verdict(`${base}deployments#mutation-pinenvironment`)).toBe("ok");
    expect(verdict(`${base}users#query-user`)).toBe("ok");
    expect(verdict(`${base}repos#object-repository`)).toBe("ok");
    expect(verdict(`${base}deployments#mutation-pinenvironments`)).toBe(
      'the schema declares no mutation named "pinenvironments"',
    );
    expect(verdict(`${base}mutations#pinenvironment`)).toBe("not a category-page anchor");
    for (const [name, url] of Object.entries(ENDPOINT_DOCS.graphql)) {
      expect(verdict(url), `${name}: ${url}`).toBe("ok");
    }
  });
});

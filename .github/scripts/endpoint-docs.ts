/**
 * The docs.github.com page behind every REST route and GraphQL operation the sections declare, for the coverage
 * page's Endpoints cells (gen-docs.ts). REST pages are the OpenAPI descriptor's own externalDocs links;
 * endpoint-docs.yml beside this file holds only what the descriptor lacks: the routes GitHub does not document and
 * every GraphQL operation. resolveAnchors() fails the docs build by name on a declared call with no page, a hand
 * entry the descriptor already covers, and a hand entry no section declares.
 */

import { join } from "node:path";
import { z } from "zod";
import { readDocsYaml } from "../../src/sections/contract/docs.js";
import { allEndpoints, allGraphqlOps } from "../../src/sections/registry.js";
import { loadSpec } from "../../test/e2e/openapi/validate.js";

const DOCS_URL = z.string().url().startsWith("https://docs.github.com/en/");

/** A route as a declaration spells it ("METHOD /path/{param}") and a GraphQL operation's wire name. */
const ROUTE = /^(?:GET|POST|PUT|PATCH|DELETE) \/\S+$/;
const OPERATION = /^[A-Z][A-Za-z0-9]*$/;

export const EndpointDocs = z
  .strictObject({
    rest: z
      .record(z.string().regex(ROUTE, 'a route is "METHOD /path/{param}"'), DOCS_URL)
      .readonly(),
    graphql: z
      .record(z.string().regex(OPERATION, "an operation name is UpperCamelCase"), DOCS_URL)
      .readonly(),
  })
  .readonly();
export type EndpointDocs = z.infer<typeof EndpointDocs>;

export const ENDPOINT_DOCS_PATH = ".github/scripts/endpoint-docs.yml";

export const ENDPOINT_DOCS = readDocsYaml(
  join(import.meta.dir, "endpoint-docs.yml"),
  EndpointDocs,
).match(
  (docs) => docs,
  (problem) => {
    throw new Error(problem);
  },
);

/** The page of every declared route and operation, resolved; the renderer reads these and nothing else. */
export interface EndpointAnchors {
  readonly rest: Readonly<Record<string, string>>;
  readonly graphql: Readonly<Record<string, string>>;
}

/** The descriptor as far as the anchors read it: `paths[path][method].externalDocs.url`. */
export type SpecOperations = Readonly<
  Record<string, Readonly<Record<string, { readonly externalDocs?: { readonly url: string } }>>>
>;

/** The descriptor's link in the spelling docs.github.com serves: the locale added, the Pages placeholder rendered. */
export function renderedDocsUrl(url: string): string {
  return url
    .replace("https://docs.github.com/rest/", "https://docs.github.com/en/rest/")
    .replace("apiname", "github");
}

export function resolveAnchors(
  spec: SpecOperations,
  hand: EndpointDocs,
  routes: readonly string[],
  operations: readonly string[],
): EndpointAnchors {
  const problems: string[] = [];
  const rest: Record<string, string> = {};
  for (const route of routes) {
    const space = route.indexOf(" ");
    const documented =
      spec[route.slice(space + 1)]?.[route.slice(0, space).toLowerCase()]?.externalDocs?.url;
    const byHand = hand.rest[route];
    if (documented !== undefined && byHand !== undefined) {
      problems.push(
        `"${route}" has a page in both the descriptor and ${ENDPOINT_DOCS_PATH}; delete the hand entry`,
      );
    } else if (documented !== undefined) {
      rest[route] = renderedDocsUrl(documented);
    } else if (byHand !== undefined) {
      rest[route] = byHand;
    } else {
      problems.push(
        `"${route}" has no page: the descriptor does not document it, so add one under rest: in ${ENDPOINT_DOCS_PATH}`,
      );
    }
  }
  for (const route of Object.keys(hand.rest)) {
    if (!routes.includes(route)) {
      problems.push(
        `${ENDPOINT_DOCS_PATH} names "${route}" under rest:, which no section declares; delete the entry`,
      );
    }
  }
  const graphql: Record<string, string> = {};
  for (const name of operations) {
    const byHand = hand.graphql[name];
    if (byHand === undefined) {
      problems.push(
        `the GraphQL operation "${name}" has no page; add one under graphql: in ${ENDPOINT_DOCS_PATH}`,
      );
    } else {
      graphql[name] = byHand;
    }
  }
  for (const name of Object.keys(hand.graphql)) {
    if (!operations.includes(name)) {
      problems.push(
        `${ENDPOINT_DOCS_PATH} names "${name}" under graphql:, which no section declares; delete the entry`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`endpoint-docs:\n  ${problems.join("\n  ")}`);
  }
  return { rest, graphql };
}

/** The distinct routes and operation names the sections declare, in registry order. */
export function declaredCalls(): { routes: string[]; operations: string[] } {
  return {
    routes: [...new Set(Object.values(allEndpoints()).map((endpoint) => endpoint.route))],
    operations: [...new Set(Object.values(allGraphqlOps()).map((op) => op.name))],
  };
}

export const ENDPOINT_ANCHORS: EndpointAnchors = (() => {
  const { routes, operations } = declaredCalls();
  return resolveAnchors(loadSpec().paths, ENDPOINT_DOCS, routes, operations);
})();

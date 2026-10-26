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

/** One kind's pages by call, and every problem met resolving them. */
interface Resolved {
  readonly pages: Record<string, string>;
  readonly problems: string[];
}

/** The descriptor's link in the spelling docs.github.com serves: the locale added, the Pages placeholder rendered. */
export function renderedDocsUrl(url: string): string {
  return url
    .replace("https://docs.github.com/rest/", "https://docs.github.com/en/rest/")
    .replace("apiname", "github");
}

/** Each declared route's page: the descriptor's, else the hand entry; both or neither is a problem, as is a hand entry no section declares. */
function resolveRest(
  spec: SpecOperations,
  hand: EndpointDocs,
  routes: readonly string[],
): Resolved {
  const pages: Record<string, string> = {};
  const problems: string[] = [];
  for (const route of routes) {
    const space = route.indexOf(" ");
    const documented =
      spec[route.slice(space + 1)]?.[route.slice(0, space).toLowerCase()]?.externalDocs?.url;
    const byHand = hand.rest[route];
    if (documented !== undefined && byHand !== undefined) {
      problems.push(
        `"${route}" has a page in both the descriptor and ${ENDPOINT_DOCS_PATH}; delete the hand entry`,
      );
      continue;
    }
    if (documented !== undefined) {
      pages[route] = renderedDocsUrl(documented);
      continue;
    }
    if (byHand !== undefined) {
      pages[route] = byHand;
      continue;
    }
    problems.push(
      `"${route}" has no page: the descriptor does not document it, so add one under rest: in ${ENDPOINT_DOCS_PATH}`,
    );
  }
  for (const route of Object.keys(hand.rest)) {
    if (!routes.includes(route)) {
      problems.push(
        `${ENDPOINT_DOCS_PATH} names "${route}" under rest:, which no section declares; delete the entry`,
      );
    }
  }
  return { pages, problems };
}

/** Each declared operation's page, which only the hand file holds; a missing one and a hand entry no section declares are problems. */
function resolveGraphql(hand: EndpointDocs, operations: readonly string[]): Resolved {
  const pages: Record<string, string> = {};
  const problems: string[] = [];
  for (const name of operations) {
    const byHand = hand.graphql[name];
    if (byHand === undefined) {
      problems.push(
        `the GraphQL operation "${name}" has no page; add one under graphql: in ${ENDPOINT_DOCS_PATH}`,
      );
      continue;
    }
    pages[name] = byHand;
  }
  for (const name of Object.keys(hand.graphql)) {
    if (!operations.includes(name)) {
      problems.push(
        `${ENDPOINT_DOCS_PATH} names "${name}" under graphql:, which no section declares; delete the entry`,
      );
    }
  }
  return { pages, problems };
}

export function resolveAnchors(
  spec: SpecOperations,
  hand: EndpointDocs,
  routes: readonly string[],
  operations: readonly string[],
): EndpointAnchors {
  const rest = resolveRest(spec, hand, routes);
  const graphql = resolveGraphql(hand, operations);
  const problems = [...rest.problems, ...graphql.problems];
  if (problems.length > 0) {
    throw new Error(`endpoint-docs:\n  ${problems.join("\n  ")}`);
  }
  return { rest: rest.pages, graphql: graphql.pages };
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

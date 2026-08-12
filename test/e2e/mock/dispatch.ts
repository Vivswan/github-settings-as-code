/**
 * Request-to-declaration resolution: match a REST request against the route
 * templates allEndpoints() declares (extracting the named params handlers
 * read), dispatch a GraphQL body by operationName, attribute requests and
 * logged requests to their section/endpoint for the runner's assertions, and
 * the status-realism rule every handler response must obey.
 */

import type { SectionKey } from "../../../src/schema.js";
import {
  endpointMethod,
  endpointPath,
  pathSegments,
} from "../../../src/sections/contract/endpoints.js";
import {
  allEndpoints,
  allGraphqlOps,
  type SectionEndpointKey,
  type TaggedEndpoint,
  type TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import type { LoggedRequest } from "./contract.js";

/**
 * Find the endpoint whose method and path template match this request. Returns
 * the "section.role" key, the tagged endpoint, and the named params the
 * template extracted, or null when nothing matches.
 */
export function matchEndpoint(
  method: string,
  pathname: string,
): { key: string; endpoint: TaggedEndpoint; params: Record<string, string> } | null {
  for (const [key, endpoint] of Object.entries(allEndpoints())) {
    if (endpointMethod(endpoint.route) !== method) {
      continue;
    }
    const params = matchTemplateParams(endpointPath(endpoint.route), pathname);
    if (params !== null) {
      return { key, endpoint, params };
    }
  }
  return null;
}

/**
 * The named `{token}` params a route template extracts from a concrete path,
 * URL-decoded, or null when the path does not match. The SAME walk
 * matchesTemplate (src/sections/contract/endpoints.ts) proves, kept here so the match
 * proof is not thrown away: the params handlers read come from the exact
 * declaration that routed the request.
 */
function matchTemplateParams(
  template: string,
  concretePath: string,
): Record<string, string> | null {
  const templateSegs = pathSegments(template);
  const pathSegs = pathSegments(concretePath);
  if (templateSegs.length !== pathSegs.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < templateSegs.length; i++) {
    const token = templateSegs[i] as string;
    const segment = pathSegs[i] as string;
    if (token.startsWith("{") && token.endsWith("}")) {
      // A malformed percent escape (e.g. %ZZ) cannot decode to a param value;
      // treat the path as matching no route, so it fails as a loud no-route
      // violation instead of an unhandled URIError.
      try {
        params[token.slice(1, -1)] = decodeURIComponent(segment);
      } catch {
        return null;
      }
    } else if (token !== segment) {
      return null;
    }
  }
  return params;
}

/**
 * The HandlerContext.param accessor over one matched route's extracted
 * params: a handler asking for a `{token}` its own route never declares is a
 * mock design bug, thrown loudly with every fact needed to fix it.
 */
export function paramAccessor(
  key: string,
  endpoint: TaggedEndpoint,
  params: Record<string, string>,
): (name: string) => string {
  return (name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(
        `E2E MOCK BUG: handler "${key}" asked for path param "{${name}}" that its route "${endpoint.route}" does not declare (declared: ${Object.keys(params).join(", ") || "(none)"})`,
      );
    }
    return value;
  };
}

/**
 * The declared GraphQL operation dispatched for a request body's
 * operationName, or null when the body carries none or the name is unknown.
 * Shared by the pipeline's dispatch and sectionForRequest's attribution.
 */
export function graphqlOpForBody(
  body: unknown,
  ops: Readonly<Record<string, TaggedGraphqlOp>>,
): { key: string; op: TaggedGraphqlOp } | null {
  const name = (body as { operationName?: unknown } | undefined)?.operationName;
  if (typeof name !== "string") {
    return null;
  }
  for (const [key, op] of Object.entries(ops)) {
    if (op.name === name) {
      return { key, op };
    }
  }
  return null;
}

/**
 * The section a request belongs to, or null when it matches no section
 * endpoint (core routes, unknown paths). A /graphql request attributes by its
 * body's operationName, so `body` must be supplied to resolve those. The
 * runner's apply-idempotence check uses it to attribute a second-apply write
 * to its section, so the compare-before-write subset can be held to write
 * silence.
 */
export function sectionForRequest(
  method: string,
  pathname: string,
  body?: unknown,
): SectionKey | null {
  if (pathname === "/graphql") {
    return graphqlOpForBody(body, allGraphqlOps())?.op.section ?? null;
  }
  return matchEndpoint(method, pathname)?.endpoint.section ?? null;
}

/**
 * True when a logged request mutated (or would mutate) live state. The HTTP
 * method decides for REST; for GraphQL - where every call is a POST - the
 * dispatched operation's DECLARED kind decides, so a GraphQL read never
 * counts as a write in the runner's idempotence and check-mode assertions.
 */
export function isWriteRequest(request: Pick<LoggedRequest, "method" | "graphql">): boolean {
  if (request.graphql) {
    return request.graphql.kind === "write";
  }
  return request.method !== "GET";
}

/**
 * The declared endpoint a request resolves to, or null for core/unknown
 * paths. The runner's always-rewrite check reads its `alwaysRewrite` flag,
 * so the required-rewrite set derives from the declarations - per ENDPOINT,
 * where the property lives, not per section.
 */
export function endpointForRequest(method: string, pathname: string): TaggedEndpoint | null {
  return matchEndpoint(method, pathname)?.endpoint ?? null;
}

/**
 * The target slug a request addresses, parsed from the path. Section endpoints
 * spell it `/repos/{owner}/{repo}/...`; the team endpoints spell it as the
 * trailing `.../repos/{owner}/{repo}`; the disambiguation probe is exactly
 * `/repos/{owner}/{repo}`. Returns null when no slug is present (e.g.
 * `/orgs/{org}` alone), so the caller falls back to the admin repo's state.
 */
export function slugFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const reposIndex = segments.lastIndexOf("repos");
  if (reposIndex >= 0 && segments.length >= reposIndex + 3) {
    const owner = segments[reposIndex + 1];
    const name = segments[reposIndex + 2];
    if (owner && name) {
      return `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
    }
  }
  return null;
}

/**
 * The status-realism rule a handler must obey, and the reason it is not simply
 * "declared statuses only": a handler may answer any status the endpoint
 * DECLARES, plus any UNdeclared error status (>= 400). GitHub itself returns
 * error statuses an endpoint's happy-path docs never enumerate (a 404 for a
 * missing label on update/remove, a 409 for a conflicting create), and every
 * such error classifies through the engine's generic throwFor path, so the
 * mock modeling them is realism, not a contract break. What a handler must
 * NEVER invent is an undeclared SUCCESS/redirect (2xx/3xx): those drive the
 * section's success branches, so an undeclared one would exercise a code path
 * the endpoint declaration says cannot happen. Declaring the error status
 * instead is deliberately avoided - a declared >= 400 status feeds
 * toleratedStatuses(), so declaring e.g. 404 on labels.update would silently
 * make that error tolerated if the call site ever moved to tryCall.
 *
 * This rule governs HANDLER responses only. Transport-level faults (the fault
 * barrier's rate-limit 403 / 429, the server_error 5xx rotation, and the
 * connection_drop status 0) fire BEFORE any handler and deliberately bypass
 * this invariant: they model wire failures GitHub returns on any endpoint
 * regardless of its declared statuses.
 */
export function statusAllowed(key: string, status: number): boolean {
  return declaredStatuses(key).has(status) || status >= 400;
}

/** The declared status set for an endpoint (drives statusAllowed and tests). */
export function declaredStatuses(key: string): Set<number> {
  const all = allEndpoints();
  if (!Object.hasOwn(all, key)) {
    throw new Error(`BUG: no endpoint "${key}"`);
  }
  // The hasOwn check above is the runtime proof behind the narrowing (a bare
  // `in` would admit prototype keys like "toString"): callers hand dynamic
  // strings (handler-table iteration), so the union is restored here at the
  // one lookup boundary.
  const endpoint = all[key as SectionEndpointKey];
  return new Set(Object.keys(endpoint.statuses).map(Number));
}

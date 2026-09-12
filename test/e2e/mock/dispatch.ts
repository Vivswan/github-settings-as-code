/** Request-to-declaration resolution: section REST routes are matched against the templates allEndpoints() declares, never a hand table. */

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
 * Mirrors the walk of matchesTemplate (src/sections/contract/endpoints.ts), plus the decode below, so the params a handler
 * reads come from the exact declaration that routed the request.
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
      // A malformed percent escape (%ZZ) fails as a loud no-route violation instead of an unhandled URIError.
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

export function paramAccessor(
  key: string,
  endpoint: TaggedEndpoint,
  params: Record<string, string>,
): (name: string) => string {
  return (name) => {
    // hasOwn, not an index read: params is a plain object, so params.toString is a function and no throw.
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      throw new Error(
        `E2E MOCK BUG: handler "${key}" asked for path param "{${name}}" that its route "${endpoint.route}" does not declare (declared: ${Object.keys(params).join(", ") || "(none)"})`,
      );
    }
    return value;
  };
}

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
 * For GraphQL, where every call is a POST, the declared kind decides, so a GraphQL read never counts as a write in the
 * runner's idempotence and check-mode assertions.
 */
export function isWriteRequest(request: Pick<LoggedRequest, "method" | "graphql">): boolean {
  if (request.graphql) {
    return request.graphql.kind === "write";
  }
  return request.method !== "GET";
}

/** The apply-idempotence proof reads `alwaysRewrite` off this: per ENDPOINT, where the property lives, not per section. */
export function endpointForRequest(method: string, pathname: string): TaggedEndpoint | null {
  return matchEndpoint(method, pathname)?.endpoint ?? null;
}

/**
 * Null when no slug is present (`/orgs/{org}` alone), so the caller falls back to the shared org state.
 *   /repos/{owner}/{repo}/...                        -> section endpoints and the bare repository probe
 *   /orgs/{org}/teams/{slug}/repos/{owner}/{repo}    -> the team endpoints, slug in the trailing pair
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
 * Any declared status plus any undeclared error: GitHub returns errors the docs never enumerate (404 updating a missing
 * label, 409 on a conflicting create), while an undeclared 2xx/3xx would drive a section branch the declaration rules out.
 * Declaring the error instead is avoided: a declared 4xx feeds toleratedStatuses(), so a declared 404 on labels.update
 * would turn tolerated if its call site moved to tryCall.
 */
export function statusAllowed(key: string, status: number): boolean {
  return declaredStatuses(key).has(status) || status >= 400;
}

export function declaredStatuses(key: string): Set<number> {
  const all = allEndpoints();
  if (!Object.hasOwn(all, key)) {
    throw new Error(`BUG: no endpoint "${key}"`);
  }
  // hasOwn is the runtime proof behind the cast: a bare `in` admits prototype keys like "toString", and callers hand
  // dynamic strings from handler-table iteration.
  const endpoint = all[key as SectionEndpointKey];
  return new Set(Object.keys(endpoint.statuses).map(Number));
}

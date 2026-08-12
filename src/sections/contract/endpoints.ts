/** REST endpoint declarations: routes, tolerated statuses, and path expansion. */

import type { Endpoints } from "@octokit/types";
import type { RepoRef } from "../../discovery/targets.js";
import type { SupplementalRoute } from "../../upstream-gaps/index.js";
import type { SectionPermission } from "./permissions.js";

/**
 * A GitHub REST route as octokit spells it: "METHOD /path/{param}". Using
 * `keyof Endpoints` means a typo'd path or a wrong method does not compile.
 */
export type Route = keyof Endpoints | SupplementalRoute;

/**
 * The statuses a hint may key: the payload-rejection classes throwFor's
 * generic branch renders. 403 and 404 are excluded - the permission branch
 * swallows them before hints are read (and a public "none" endpoint's
 * 403/404 is never about a grant); ambiguity on those statuses belongs in
 * `denialHint`.
 */
export type HintableStatus = 400 | 412 | 422;

/**
 * One REST endpoint a section may call. `route` is octokit's canonical
 * "METHOD /path/{param}" string. `statuses` maps each HTTP status the handler
 * treats as a normal (non-throwing) outcome to a short plain-prose meaning;
 * the >= 400 keys are the tolerated errors (see toleratedStatuses), and the
 * meanings are consumable by the e2e mock and its violation messages.
 * Handlers pass these declarations to the request helpers, which build the
 * concrete path via expand(), so a section can never call a path it has not
 * declared.
 */
export interface EndpointDecl {
  readonly route: Route;
  readonly statuses: Readonly<Record<number, string>>;
  /**
   * Overrides the section's permission for this one endpoint. "none" means
   * the endpoint is public (no token permission needed). Omit it when the
   * endpoint requires the section's own permission (the common case) - an
   * override equal to the section permission is redundant. Downstream
   * consumers resolve the effective permission via endpointPermission().
   */
  readonly permission?: SectionPermission | "none";
  /**
   * True for an advisory READ whose non-404 failures are tolerated (the section
   * proceeds without it rather than failing). The e2e mock derives its
   * advisory-read exemption from this flag via allEndpoints(), so the exemption
   * stays in one place - the declaration - instead of a hard-coded list.
   */
  readonly advisory?: boolean;
  /**
   * Advice for known 4xx failure classes, appended by throwFor to that
   * status's generic rejection message. Payloads pass through verbatim
   * (GitHub stays the authority on valid values), so a hint names the
   * failure CLASS and points at the endpoint documentation; it never lists
   * valid values that could go stale. One or two sentences, no trailing
   * period.
   */
  readonly hints?: Readonly<Partial<Record<HintableStatus, string>>>;
  /**
   * Appended to the PermissionDenied message (which never reads `hints`) for
   * an endpoint whose 403/404 is ambiguous - it can mean something other
   * than a missing token grant (e.g. Git LFS disabled account-wide). One
   * sentence, no trailing period.
   */
  readonly denialHint?: string;
  /**
   * True for a WRITE the section issues for every declared entry on EVERY
   * apply by contract - the sealed secret PUTs, whose values cannot be read
   * back, so the unconditional re-write is what propagates a rotated source
   * value. This is a property of the ENDPOINT, not its section: environments
   * carries a passthrough PUT and always-rewrite secret PUTs side by side.
   * The e2e apply-idempotence proof derives its required-rewrite set from
   * this flag, so the contract lives on the declaration it describes.
   */
  readonly alwaysRewrite?: true;
  /**
   * The access grade GitHub gates this endpoint at, when it differs from the
   * method-derived one (GET = read). Codespaces repository secrets are the
   * known case: the fine-grained permission gates even the list and
   * public-key READS at write. endpointKind() consults this, so the e2e
   * mock's permission gate and the fuzz oracle model the real gating - a
   * read-only grant then denies those reads exactly as production does.
   */
  readonly accessGrade?: "write";
  /**
   * The largest per_page this LIST endpoint accepts, when it is smaller than
   * the standard 100 (the Actions variables list caps at 30). The page loop
   * requests exactly this many per page and treats a shorter page as the
   * last one, so a larger request that GitHub would silently clamp cannot
   * truncate the walk after page one. Omit on endpoints that take the
   * standard 100.
   */
  readonly pageSize?: number;
}

/** The method half of a route ("PATCH /repos/..." -> "PATCH"). */
export function endpointMethod(route: Route): string {
  return route.slice(0, route.indexOf(" "));
}

/** The path-template half of a route ("PATCH /repos/{owner}/..." -> "/repos/{owner}/..."). */
export function endpointPath(route: Route): string {
  return route.slice(route.indexOf(" ") + 1);
}

/**
 * read for GET, write for every mutating method - unless the declaration
 * carries an accessGrade override (GitHub gates some reads at write).
 */
export function endpointKind(endpoint: EndpointDecl): "read" | "write" {
  return endpoint.accessGrade ?? (endpointMethod(endpoint.route) === "GET" ? "read" : "write");
}

/**
 * The path-parameter names a route declares, minus `owner` and `repo` (which
 * expand() fills from the SectionContext). A call site must supply exactly
 * these; the helpers use it to make `params` compiler-required and typo-proof.
 */
export type PathParams<R extends string> = R extends `${string}{${infer T}}${infer Rest}`
  ? (T extends "owner" | "repo" ? never : T) | PathParams<Rest>
  : never;

/**
 * The declared statuses that are error responses (>= 400). These ARE the
 * tolerated errors by definition: a status the endpoint declares as a normal
 * outcome must not throw. tryCall and probeAbsent default their tolerated set
 * to this, so the declaration is the single source and no call site restates
 * it.
 */
export function toleratedStatuses(endpoint: EndpointDecl): number[] {
  return Object.keys(endpoint.statuses)
    .map(Number)
    .filter((status) => status >= 400);
}

/**
 * Split a path into segments, dropping any query string and the leading
 * slash. Shared by the template matcher and its callers (the e2e mock's
 * dispatcher included) so every consumer strips the query the same way.
 */
export function pathSegments(path: string): string[] {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.split("/").filter((segment) => segment.length > 0);
}

/**
 * True when a concrete path (query already irrelevant) matches a route's
 * path template. Every `{token}` consumes exactly one segment (octokit
 * routes spell owner and repo as separate one-segment params); literal
 * segments must match exactly. Exported for the e2e mock server and
 * USED_PATHS derivation, which route by template.
 */
export function matchesTemplate(template: string, concretePath: string): boolean {
  const templateSegs = pathSegments(template);
  const pathSegs = pathSegments(concretePath);
  if (templateSegs.length !== pathSegs.length) {
    return false;
  }
  for (let i = 0; i < templateSegs.length; i++) {
    const token = templateSegs[i] as string;
    const isParam = token.startsWith("{") && token.endsWith("}");
    if (!isParam && token !== pathSegs[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Build the concrete request path from an endpoint's route: `{owner}` and
 * `{repo}` fill from the context's parsed RepoRef (both one segment); every
 * other `{token}` fills from params. All are URL-encoded in
 * this single place. A missing param or an unused (extra) param is a handler
 * bug, so throw loudly. `query`, when given, is appended as an encoded query
 * string. Only the RepoRef half of the context is read, so non-section
 * callers (the private-report module) can pass a bare `{ repo }` pair.
 */
export function expand(
  endpoint: EndpointDecl,
  ctx: { repo: RepoRef },
  params?: Readonly<Record<string, string>>,
  query?: Readonly<Record<string, string>>,
): string {
  const route = endpoint.route;
  const supplied = new Set(Object.keys(params ?? {}));
  const path = endpointPath(route).replace(/{([a-z_]+)}/g, (_match, token: string) => {
    if (token === "owner") {
      return encodeURIComponent(ctx.repo.owner);
    }
    if (token === "repo") {
      return encodeURIComponent(ctx.repo.name);
    }
    const value = params?.[token];
    if (value === undefined) {
      throw new Error(`BUG: ${route} needs a "${token}" param, but none was supplied`);
    }
    supplied.delete(token);
    return encodeURIComponent(value);
  });
  if (supplied.size > 0) {
    throw new Error(
      `BUG: ${route} was given unused param(s) [${[...supplied].join(", ")}]; they match no {token} in the route`,
    );
  }
  if (query && Object.keys(query).length > 0) {
    const qs = Object.entries(query)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${path}?${qs}`;
  }
  return path;
}

/**
 * The $owner/$repo variables every repo-addressed GraphQL READ takes, read
 * off the context's parsed RepoRef in the one place expand() reads the REST
 * path halves - so no GraphQL section ever re-derives them.
 */
export function repoVariables(ctx: { repo: RepoRef }): {
  owner: string;
  repo: string;
} {
  return { owner: ctx.repo.owner, repo: ctx.repo.name };
}

import type { Endpoints } from "@octokit/types";
import type { RepoRef } from "../../discovery/targets.js";
import type { SupplementalRoute } from "../../upstream-gaps/index.js";
import type { SectionPermission } from "./permissions.js";

/** `keyof Endpoints` makes a typo'd path or wrong method a compile error; SupplementalRoute covers routes octokit lags (src/upstream-gaps). */
export type Route = keyof Endpoints | SupplementalRoute;

/**
 * 403 and 404 are excluded: throwFor's permission branch swallows them for a granted operation (where
 * `denialHint` carries any ambiguity), and a public ("none") operation's 403/404 is never a payload rejection.
 */
export type HintableStatus = 400 | 412 | 422;

type GetRoute = Extract<Route, `GET ${string}`>;

/**
 * `statuses` keys are the outcomes the handler treats as normal (the e2e mock reads the keys); its 4xx keys
 * other than 401 and 429 are the tolerated errors (toleratedStatuses). The request helpers build paths from
 * these declarations via expand(), so a section can never call a path it has not declared.
 */
export type EndpointDecl =
  | (EndpointDeclFields & {
      readonly route: GetRoute;
      readonly permission?: SectionPermission | "none";
      readonly accessGrade?: never;
      readonly alwaysRewrite?: never;
      readonly unverifiable?: never;
      /**
       * Omitted, the read is available to plan(), so check mode and preflight may meet it. "execution" gates it
       * behind the ExecTools token only a thunk receives (ReadPort in ./plan.ts), so check mode never issues it.
       *
       *   e2e mock          -> treats an execution read in check mode as a violation
       *   denialPosture()   -> rejects a primaryRead on it: no denied first read can be classified from it
       */
      readonly phase?: "execution";
    })
  | (EndpointDeclFields &
      Recurrence & {
        readonly route: Exclude<Route, GetRoute>;
        /** Overrides the section's permission; "none" means public. Resolved by endpointPermission(). */
        readonly permission?: SectionPermission | "none";
        readonly accessGrade?: never;
        readonly phase?: never;
      })
  | GatedReadDecl;

/**
 * A WRITE's behaviour on a converged second apply, at most one flag: `alwaysRewrite` recurs by
 * contract (sealed secret PUTs, the interaction-limits re-arm, the Git LFS toggle, the check suite
 * PATCH); `unverifiable` may recur, carrying a value GitHub never echoes back. The e2e idempotence proof reads both.
 */
type Recurrence =
  | { readonly alwaysRewrite?: never; readonly unverifiable?: never }
  | { readonly alwaysRewrite: true; readonly unverifiable?: never }
  | { readonly alwaysRewrite?: never; readonly unverifiable: true };

/**
 * A GET GitHub gates at WRITE (the Codespaces secrets GETs), read by endpointKind().
 * A public endpoint has no grant to gate, so `permission: "none"` is not representable.
 */
export interface GatedReadDecl extends EndpointDeclFields {
  readonly route: GetRoute;
  readonly permission?: SectionPermission;
  readonly accessGrade: "write";
  readonly alwaysRewrite?: never;
  readonly unverifiable?: never;
  readonly phase?: never;
}

interface EndpointDeclFields {
  readonly statuses: Readonly<Record<number, string>>;
  /**
   * By default an advisory READ's failures come back as { error } instead of aborting the section; a rate
   * limit still throws, and an explicit `tolerate` narrows the set (declaredTolerance). The e2e mock
   * derives its advisory-read exemption from this flag via allEndpoints().
   */
  readonly advisory?: boolean;
  /**
   * Payloads pass through verbatim, so a hint names the failure CLASS and points at the docs, never valid
   * values that could go stale; throwFor appends it to the status's rejection message. Style: one or two sentences, no trailing period.
   */
  readonly hints?: Readonly<Partial<Record<HintableStatus, string>>>;
  /**
   * Appended to the PermissionDenied message (which never reads `hints`) when a 403/404 can mean
   * something other than a missing grant (Git LFS disabled account-wide). One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /**
   * When GitHub caps per_page below the standard 100 (the Actions variables list: 30). The page loop
   * requests exactly this many and treats a shorter page as the last, so a request GitHub would silently
   * clamp cannot truncate the walk after page one.
   */
  readonly pageSize?: number;
  /**
   * The section's PRIMARY READ and what a fine-grained 404 on it means: "denied" classifies as
   * PermissionDenied and stops the section (an advisory read only exposes tryCall, which returns it as
   * { error }), "absent" reads as a missing resource and proceeds. At most one per section; the read port
   * (ReadPort in ./plan.ts) and denialPosture() read it.
   */
  readonly primaryRead?: { readonly notFound: "denied" | "absent" };
}

export function endpointMethod(route: Route): string {
  return route.slice(0, route.indexOf(" "));
}

export function endpointPath(route: Route): string {
  return route.slice(route.indexOf(" ") + 1);
}

/** An accessGrade override wins: GitHub gates some reads at write. */
export function endpointKind(endpoint: EndpointDecl): "read" | "write" {
  return endpoint.accessGrade ?? (endpointMethod(endpoint.route) === "GET" ? "read" : "write");
}

/** Minus `owner` and `repo`, which expand() fills from the context; the helpers make `params` compiler-required and typo-proof from it. */
export type PathParams<R extends string> = R extends `${string}{${infer T}}${infer Rest}`
  ? (T extends "owner" | "repo" ? never : T) | PathParams<Rest>
  : never;

/**
 * Excluded from every declared tolerance (they describe the credential or the transport, not the resource);
 * an advisory read still absorbs a 401, and a rate limit is caught per request.
 */
type TransportStatus = 401 | 429;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/** toleratedStatuses() is the runtime twin. */
export type DeclaredErrorStatus<E extends EndpointDecl> = {
  [S in keyof E["statuses"] & number]: S extends TransportStatus
    ? never
    : `${S}` extends `4${Digit}${Digit}`
      ? S
      : never;
}[keyof E["statuses"] & number];

/**
 * A status the endpoint declares as a normal outcome must not throw, so the tolerant helpers default to
 * this set and no call site restates the declaration.
 */
export function toleratedStatuses(endpoint: EndpointDecl): number[] {
  return Object.keys(endpoint.statuses)
    .filter((key) => /^4\d\d$/.test(key))
    .map(Number)
    .filter((status) => status !== 401 && status !== 429);
}

/** Shared with the e2e mock's dispatcher so every consumer strips the query the same way. */
export function pathSegments(path: string): string[] {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.split("/").filter((segment) => segment.length > 0);
}

/**
 * Every `{token}` consumes exactly one segment (octokit spells owner and repo as separate params).
 * The e2e mock, its OpenAPI validator, and .github/scripts/check-endpoint-coverage.ts route by template through it.
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
 * The one place a SECTION's path values are URL-encoded (github/repo-file.ts encodes its own). Only the
 * RepoRef half of the context is read, so non-section callers (the private-report module) can pass a bare `{ repo }`.
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

/** Read off the parsed RepoRef where expand() reads the REST halves, so no GraphQL section re-derives them. */
export function repoVariables(ctx: { repo: RepoRef }): {
  owner: string;
  repo: string;
} {
  return { owner: ctx.repo.owner, repo: ctx.repo.name };
}

import type { Endpoints } from "@octokit/types";
import type { RepoRef } from "../../discovery/targets.js";
import type { SupplementalRoute } from "../../generated/upstream-gaps.js";
import type { SectionPermission } from "./permissions.js";

/** `keyof Endpoints` makes a typo'd path or wrong method a compile error; SupplementalRoute covers routes octokit lags (src/upstream-gaps). */
export type Route = keyof Endpoints | SupplementalRoute;

/**
 * The statuses failureFor's permission branch swallows for a granted operation. A `hints` key on one is
 * dead advice (HintableStatus excludes them); `denialHint` carries an ambiguity, and `rejections` claims
 * back the one message GitHub reserves for a definite meaning.
 */
type DenialStatus = 403 | 404;

/** A public ("none") operation's 403/404 is never a payload rejection either, so the exclusion holds for it too. */
export type HintableStatus = 400 | 412 | 422;

/**
 * A response whose status a denial shares but whose exact message GitHub reserves for one definite
 * meaning: the protection PUT's 404 "Branch not found". failureFor classifies a match ahead of its
 * permission branch as a hard section error, so no on-missing-permission policy can skip it and the
 * grant advice never renders for it. The message must be one no denial body spells; the registry
 * test pins every declaration against the e2e mock's denial responses.
 */
export interface DefinitiveRejection {
  /** A denial's status (403 or 404); the message is what tells the rejection apart. */
  readonly status: DenialStatus;

  /** Compared whole, never as a substring: "Not Found" is a fine-grained denial. */
  readonly message: string;

  /** What to fix, as a lowercase clause without a trailing period; failureFor starts a sentence with it. */
  readonly advice: string;
}

type GetRoute = Extract<Route, `GET ${string}`>;

/** Overrides the section's permission; "none" means public. Resolved by endpointPermission(). */
type PermissionOverride = SectionPermission | "none";

/**
 * A read's phase. Omitted, the read is available to plan(), so check mode and preflight may meet it. "execution"
 * gates it behind the ExecTools token only a thunk receives (ReadPort in ./plan.ts), so check mode never issues it.
 *
 *   e2e mock          -> treats an execution read in check mode as a violation
 *   denialPosture()   -> rejects a primaryRead on it: no denied first read can be classified from it
 */
export type ReadPhase = "execution";

/**
 * The request helpers build paths from these declarations via expand(), so a section can never call a path it has
 * not declared.
 */
export type EndpointDecl =
  | (EndpointDeclFields & {
      readonly route: GetRoute;
      readonly permission?: PermissionOverride;
      readonly accessGrade?: never;
      readonly alwaysRewrite?: never;
      readonly unverifiable?: never;
      readonly phase?: ReadPhase;
    })
  | (EndpointDeclFields &
      Recurrence & {
        readonly route: Exclude<Route, GetRoute>;
        readonly permission?: PermissionOverride;
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
  readonly phase?: ReadPhase;
}

/**
 * The fields every arm of EndpointDecl shares. `primaryRead` marks the section's one primary read and what a
 * fine-grained 404 on it means; the read port (ReadPort in ./plan.ts) and denialPosture() read it.
 *
 *   notFound: "denied"  -> a permission-denied failure that stops the section (an advisory read exposes only tryCall, which returns it as { error })
 *   notFound: "absent"  -> a missing resource; the section proceeds
 */
interface EndpointDeclFields {
  /** Keyed by the outcomes the handler treats as normal (the e2e mock reads the keys); the 4xx keys other than 401 and 429 are the tolerated errors (toleratedStatuses). */
  readonly statuses: Readonly<Record<number, string>>;

  /** A read whose failures come back as { error } instead of ending the section (a rate limit still throws; declaredTolerance narrows); the e2e mock's denial barrier exempts it. */
  readonly advisory?: boolean;

  /** Appended by failureFor to a rejection's message; since payloads pass through verbatim, a hint names the failure CLASS and points at the docs, never values that could go stale (no trailing period). */
  readonly hints?: Readonly<Partial<Record<HintableStatus, string>>>;

  /** Appended to a denial's message when its 403/404 can mean more than a missing grant (Git LFS disabled account-wide); a body that tells the readings apart is a `rejections` entry instead (no trailing period). */
  readonly denialHint?: string;

  /** The endpoint's definitive rejections (see DefinitiveRejection); the e2e mock serves the same declarations. */
  readonly rejections?: readonly DefinitiveRejection[];

  /** GitHub's per_page cap where it is below 100 (the Actions variables list: 30); the page loop asks for exactly this many, so a silently clamped request cannot truncate the walk after page one. */
  readonly pageSize?: number;

  /** The section's one primary read, with what its fine-grained 404 means (the rows above). */
  readonly primaryRead?: { readonly notFound: "denied" | "absent" };
}

export function matchesRejection(
  rejection: DefinitiveRejection,
  error: { status: number; message: string },
): boolean {
  return error.status === rejection.status && error.message === rejection.message;
}

/** The declaration an error matches, if the endpoint declares one; a withheld message matches nothing. */
export function definitiveRejection(
  endpoint: EndpointDecl,
  error: { status: number; message: string },
): DefinitiveRejection | undefined {
  return endpoint.rejections?.find((rejection) => matchesRejection(rejection, error));
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
    return `${path}?${new URLSearchParams(query)}`;
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

/** Shared section-handler contract and error classification. */

import type { Endpoints } from "@octokit/types";
import { z } from "zod";
import type { ApiError, GithubClient } from "../github/api.js";
import { isPermissionError, isRateLimitError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import type {
  MustBeNever,
  SectionKey,
  SettingsFile,
  UndeclaredPolicy,
  UndeclaredPolicyList,
  UndeclaredPolicySection,
} from "../schema.js";

export class PermissionDenied extends Error {
  constructor(
    readonly section: string,
    readonly detail: string,
    /** The HTTP status that raised the denial, for the redacted view's safe code. */
    readonly status: number,
  ) {
    super(`${section}: ${detail}`);
  }
}

export interface SectionContext {
  api: GithubClient;
  repo: string; // owner/name
  owner: string;
  check: boolean;
  /**
   * Resolve a whole-value `$NAME` secret reference to its plaintext. Present
   * only in apply mode: the engine resolves EVERY declared secret value up
   * front (after the preflight barrier, before the first mutation of any
   * section) and registers each plaintext with output masking before any
   * handler runs, so a handler only ever looks up an already-resolved name.
   * Absent in check mode and during preflight, where references are
   * validated for syntax only and the environment is never read.
   */
  resolveSecret?: (reference: string) => string;
}

export interface SectionResult {
  /** Mutations performed (apply mode) or that WOULD be performed. */
  changes: string[];
  /** Drift lines (check mode). */
  drift: string[];
  /** Informational notes (unmanaged resources left alone, skips). */
  notes: string[];
}

/** A fine-grained-PAT permission resource under Repository permissions. */
export type PatResource =
  | "administration"
  | "issues"
  | "environments"
  | "actions"
  | "pages"
  | "code_scanning_alerts"
  | "contents"
  | "variables"
  | "webhooks"
  | "secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "custom_properties"
  | "secret_scanning_alerts"
  | "agent_secrets"
  | "agent_variables"
  | "checks";

/**
 * The machine-readable permission a section requires. `repo` lists the
 * fine-grained-PAT Repository permissions where ANY one grants access;
 * `org` names the extra Organization permission a section needs (teams).
 */
export interface SectionPermission {
  /** Fine-grained PAT repository permissions; ANY one of these grants access. */
  readonly repo: readonly [PatResource, ...PatResource[]];
  /** Additional organization permission required (teams only). */
  readonly org?: "members";
}

/** Human-facing label for each PAT resource, as shown in the token UI. */
const RESOURCE_LABEL: Record<PatResource, string> = {
  administration: "Administration",
  issues: "Issues",
  environments: "Environments",
  actions: "Actions",
  pages: "Pages",
  code_scanning_alerts: "Code scanning alerts",
  contents: "Contents",
  variables: "Variables",
  webhooks: "Webhooks",
  secrets: "Secrets",
  dependabot_secrets: "Dependabot secrets",
  codespaces_secrets: "Codespaces secrets",
  custom_properties: "Custom properties",
  secret_scanning_alerts: "Secret scanning alerts",
  agent_secrets: "Agent secrets",
  agent_variables: "Agent variables",
  checks: "Checks",
};

/** Human-facing label for each PAT organization resource. */
const RESOURCE_LABEL_ORG: Record<NonNullable<SectionPermission["org"]>, string> = {
  members: "Members",
};

/**
 * Render a SectionPermission into the grant prose used verbatim in
 * permission errors. `caveat`, when given, is appended after "; ". `access`
 * names the level the advice asks for: section grants keep the "write"
 * default (a section both reads and writes), while a denial on an endpoint
 * with its own permission override passes the level the SECTION needs on
 * that permission (overrideAdviceLevel: read unless a sibling endpoint
 * writes with it), so the advice never asks for a broader grant than the
 * section can use - nor a narrower one than it will need next. The default
 * output is user-facing error prose: the EXPECTED_GRANT snapshot in
 * test/sections/registry.test.ts pins every section's grant character for
 * character, and the README's Sections table mirrors those grants.
 */
export function grantFor(
  permission: SectionPermission,
  caveat?: string,
  access: "read" | "write" = "write",
): string {
  const level = access === "read" ? "read" : "read and write";
  const resources = permission.repo.map((resource) => `"${RESOURCE_LABEL[resource]}"`).join(" or ");
  const repoClause = permission.org
    ? `${resources} (${level}) under its Repository permissions`
    : `${resources} (${level}) under the PAT's Repository permissions`;
  const orgClause = permission.org
    ? `"${RESOURCE_LABEL_ORG[permission.org]}" (read) under the PAT's Organization permissions and `
    : "";
  const grant = `grant ${orgClause}${repoClause}`;
  return caveat ? `${grant}; ${caveat}` : grant;
}

/**
 * Routes GitHub documents but the pinned @octokit/types release does not
 * carry yet (its release cadence trails the API). Only the route STRING is
 * consumed (never octokit's parameter/response typing), so a literal union
 * is enough. The _SupplementalRoutesStillMissing pin below turns the
 * per-bump audit into a compile error: delete entries the upstream
 * Endpoints map has gained.
 */
type SupplementalRoute =
  | "GET /repos/{owner}/{repo}/actions/cache/retention-limit"
  | "PUT /repos/{owner}/{repo}/actions/cache/retention-limit"
  | "GET /repos/{owner}/{repo}/actions/cache/storage-limit"
  | "PUT /repos/{owner}/{repo}/actions/cache/storage-limit"
  | "PUT /repos/{owner}/{repo}/lfs"
  | "DELETE /repos/{owner}/{repo}/lfs"
  | "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns"
  | "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns"
  | "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}"
  | "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns"
  | "GET /repos/{owner}/{repo}/agents/secrets"
  | "GET /repos/{owner}/{repo}/agents/secrets/public-key"
  | "PUT /repos/{owner}/{repo}/agents/secrets/{secret_name}"
  | "DELETE /repos/{owner}/{repo}/agents/secrets/{secret_name}"
  | "GET /repos/{owner}/{repo}/agents/variables"
  | "POST /repos/{owner}/{repo}/agents/variables"
  | "PATCH /repos/{owner}/{repo}/agents/variables/{name}"
  | "DELETE /repos/{owner}/{repo}/agents/variables/{name}"
  | "GET /repos/{owner}/{repo}/code-quality/setup"
  | "PATCH /repos/{owner}/{repo}/code-quality/setup"
  | "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap"
  | "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap"
  | "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list"
  | "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list"
  | "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list";

/**
 * The audit above, enforced by the compiler: a supplemental route that HAS
 * landed in the pinned @octokit/types Endpoints map fails here on the bump,
 * naming the entry to delete (the _UnlistedSection idiom from schema.ts).
 */
type _SupplementalRoutesStillMissing = MustBeNever<Extract<SupplementalRoute, keyof Endpoints>>;

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

/** The name half of an "owner/name" slug (expand()'s `{repo}` fill). */
export function repoNameOf(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
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
 * The GraphQL error classes GitHub delivers in an errors[] entry's `type`
 * field, as far as this system models them. The runtime array feeds the e2e
 * validator's known-type check; the type derives from it.
 */
export const GRAPHQL_ERROR_TYPES = [
  "FORBIDDEN",
  "INSUFFICIENT_SCOPES",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UNPROCESSABLE",
] as const;

export type GraphqlErrorType = (typeof GRAPHQL_ERROR_TYPES)[number];

/**
 * The subset of GraphQL error types a section may DECLARE as tolerated
 * outcomes. RATE_LIMITED is deliberately absent (throttling is a transport
 * concern every operation handles identically, never a per-operation
 * outcome), as is INSUFFICIENT_SCOPES (a wrong token, which no section
 * outcome can tolerate; the transport folds it into the 403 class).
 */
export const GRAPHQL_TOLERABLE_ERRORS = ["FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE"] as const;

export type GraphqlTolerableError = (typeof GRAPHQL_TOLERABLE_ERRORS)[number];

/**
 * The connection a paginated read walks: `path` leads from the data root to
 * the connection field (e.g. ["repository", "branchProtectionRules"]), which
 * must select `nodes { ... }` and `pageInfo { hasNextPage endCursor }`, and
 * the query must declare a `$cursor` variable feeding the connection's
 * `after` argument (allGraphqlOps asserts both at construction).
 */
export interface GraphqlConnectionDecl {
  readonly path: readonly [string, ...string[]];
}

/**
 * The facets shared by both kinds of GraphQL operation; see GraphqlOpDecl.
 * `V` is the operation's variables shape, carried by the type-only
 * `_variables` marker (never set at runtime; covariant, so a concretely
 * typed declaration still erases to the metadata consumers' default) so the
 * request helpers type-check call-site variables against the declaration.
 */
interface GraphqlOpCommon<V extends Record<string, unknown>> {
  readonly name: string;
  readonly outcomes: Readonly<{ ok: string } & Partial<Record<GraphqlTolerableError, string>>>;
  /**
   * Overrides the section's permission for this one operation, exactly like
   * EndpointDecl.permission: "none" means public, omitted means the section's
   * own permission applies.
   */
  readonly permission?: SectionPermission | "none";
  /**
   * True for an advisory READ whose non-404 failures are tolerated, mirroring
   * EndpointDecl.advisory (the e2e mock derives its denial-barrier exemption
   * from it).
   */
  readonly advisory?: boolean;
  /**
   * Appended to the PermissionDenied message for an operation whose
   * FORBIDDEN/NOT_FOUND can mean something other than a missing token grant.
   * One sentence, no trailing period.
   */
  readonly denialHint?: string;
  /**
   * Never present: GraphQL rejections carry no HTTP status for a hint to key
   * on, and the `never` makes declaring one a compile error instead of a
   * silently ignored field (see FailingOp).
   */
  readonly hints?: never;
  /** Type-only marker for `V`; never set at runtime. */
  readonly _variables?: V;
}

/**
 * One GraphQL operation a section may issue, the sibling of EndpointDecl.
 * Extends the transport-level GraphqlOp structurally, so a declaration passes
 * straight to GithubClient.tryGraphql.
 *
 * `name` is the wire dispatch key - the operationName sent with every call,
 * globally unique across sections (allGraphqlOps asserts it), which is what
 * lets the mock, the coverage tripwire, and the scenario expectations address
 * the operation without parsing the query. `kind` is declared explicitly and
 * NEVER derived from the POST method every GraphQL call shares: it drives the
 * preflight read-only guard, the mock's permission gate, and the fuzz oracle -
 * and the union pins each kind to its operation type (`query ...` /
 * `mutation ...`), so a mutation declared "read" does not compile. The query
 * is a single named operation whose name equals `name`; a repo-addressed READ
 * must take $owner/$repo variables (the mock routes multi-repo reads by
 * them), and a mutation addresses its target through self-describing node
 * ids. `outcomes` mirrors EndpointDecl.statuses: "ok" documents the success
 * meaning, and each declared error type is a TOLERATED outcome
 * (tryCallGraphql returns it as { error } instead of throwing). Only a read
 * may declare a `connection` (pagination is a read concern).
 *
 * Declare each operation as an ANNOTATED const
 * (`const OP: GraphqlOpDecl<{owner: string; repo: string}> = {...}`) and pass
 * that const to the request helpers: the annotation is what carries `V` (via
 * the type-only `_variables` marker), so a call site with missing or
 * misnamed variables fails to compile. A declaration reached through a
 * widened dictionary (`section.graphql.role`) erases `V` to the permissive
 * default - the same erasure a widened EndpointDecl record applies to its
 * statuses - so helpers must be fed the consts, not dictionary lookups.
 */
export type GraphqlOpDecl<V extends Record<string, unknown> = Record<string, unknown>> =
  | (GraphqlOpCommon<V> & {
      readonly kind: "read";
      readonly query: `query ${string}`;
      readonly connection?: GraphqlConnectionDecl;
    })
  | (GraphqlOpCommon<V> & {
      readonly kind: "write";
      readonly query: `mutation ${string}`;
      readonly connection?: never;
    });

/**
 * The variables shape a declaration carries (via the `_variables` marker),
 * recovered from the concrete declaration type so the request helpers infer
 * it from the `op` argument alone - inferring from the variables argument
 * would let a typo'd call site WIDEN the shape instead of failing.
 */
export type GraphqlVariablesOf<O extends GraphqlOpDecl> = O extends {
  readonly _variables?: infer V;
}
  ? Extract<V, Record<string, unknown>>
  : Record<string, unknown>;

/**
 * The declared error types of a GraphQL operation - its tolerated outcomes,
 * exactly as toleratedStatuses reads an EndpointDecl's >= 400 statuses. The
 * declaration is the single source; tryCallGraphql defaults to this set.
 */
export function toleratedGraphqlErrors(op: GraphqlOpDecl): GraphqlTolerableError[] {
  return GRAPHQL_TOLERABLE_ERRORS.filter((type) => op.outcomes[type] !== undefined);
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
 * The declaration behind a failing request, as error classification reads
 * it: a REST endpoint or a GraphQL operation. An honest union rather than a
 * structural facet - `{}` must not satisfy it - and the GraphqlOpDecl arm's
 * `hints?: never` makes a hint on a GraphQL operation (which has no HTTP
 * status for it to key on) a compile error. throwFor and endpointPermission
 * take this, so both kinds classify through one code path.
 */
export type FailingOp = EndpointDecl | GraphqlOpDecl;

/**
 * The permission this endpoint or GraphQL operation actually requires: its
 * own override when one is declared, otherwise the section's permission.
 * "none" means public. The single place downstream consumers (e.g. the e2e
 * mock's permission gate) resolve the effective permission, so section vs
 * per-operation precedence lives in one spot.
 */
export function endpointPermission(
  section: SectionMeta,
  op: FailingOp,
): SectionPermission | "none" {
  return op.permission ?? section.permission;
}

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
 * slash. Shared by the template matcher and its callers so both strip the
 * query the same way.
 */
function pathSegments(path: string): string[] {
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
 * Build the concrete request path from an endpoint's route: `{owner}` fills
 * from ctx.owner and `{repo}` from the name half of ctx.repo (both one
 * segment); every other `{token}` fills from params. All are URL-encoded in
 * this single place. A missing param or an unused (extra) param is a handler
 * bug, so throw loudly. `query`, when given, is appended as an encoded query
 * string. Only the owner/repo halves of the context are read, so non-section
 * callers (the private-report module) can pass a bare pair.
 */
export function expand(
  endpoint: EndpointDecl,
  ctx: Pick<SectionContext, "owner" | "repo">,
  params?: Readonly<Record<string, string>>,
  query?: Readonly<Record<string, string>>,
): string {
  const route = endpoint.route;
  const repoName = repoNameOf(ctx.repo);
  const supplied = new Set(Object.keys(params ?? {}));
  const path = endpointPath(route).replace(/{([a-z_]+)}/g, (_match, token: string) => {
    if (token === "owner") {
      return encodeURIComponent(ctx.owner);
    }
    if (token === "repo") {
      return encodeURIComponent(repoName);
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
 * The $owner/$repo variables every repo-addressed GraphQL READ takes, derived
 * from the context in the one place expand() derives the REST path halves -
 * so the name-half slice cannot be copy-pasted into each GraphQL section.
 */
export function repoVariables(ctx: Pick<SectionContext, "owner" | "repo">): {
  owner: string;
  repo: string;
} {
  return { owner: ctx.owner, repo: repoNameOf(ctx.repo) };
}

/**
 * The identity every helper needs to classify an error: the section's key
 * and its fine-grained-PAT grant advice. Handlers pass `this`, so the
 * advice always travels with the section that owns it.
 */
export interface SectionMeta<K extends SectionKey = SectionKey> {
  readonly key: K;
  /**
   * The machine-readable permission this section requires, from which its
   * grant prose is derived via sectionGrant.
   */
  readonly permission: SectionPermission;
  /**
   * Extra prose sectionGrant appends to the derived grant advice, for a
   * section whose denials need more than the permission grant (an ambiguous
   * 403, a per-key permission override). Omit it when the derived grant
   * says everything.
   */
  readonly grantCaveat?: string;
  /**
   * Every REST endpoint this section may call, keyed by role (list, create,
   * update, remove, probe, ...). Handlers build their paths by passing these
   * declarations to the request helpers; the mock server and USED_PATHS
   * derivation iterate Object.values(...).
   */
  readonly endpoints: Readonly<Record<string, EndpointDecl>>;
  /**
   * Every GraphQL operation this section may issue, keyed by role exactly
   * like `endpoints`. Handlers pass these declarations to the GraphQL
   * request helpers; the mock's dispatch table, the coverage tripwire, and
   * the fuzz oracle iterate allGraphqlOps(). Omitted by REST-only sections.
   */
  readonly graphql?: Readonly<Record<string, GraphqlOpDecl>>;
  /**
   * The DEFAULT policy for live resources this section does NOT declare, the
   * single source the README Sections table and COVERAGE derive their
   * deletion claims from. Which sections sit in each bucket is read off the
   * registry (./registry.ts), not restated here. For the sections that
   * enumerate sibling resources, the settings file can override the default
   * per run with the wrapped `{undeclared, entries}` form (see
   * undeclaredPolicy below):
   * - "delete": the section lists live resources and DELETES undeclared ones
   *   by default; `undeclared: keep` softens that to notes.
   * - "keep": the section lists live resources but KEEPS undeclared ones by
   *   default, surfacing each as a note; `undeclared: delete` hardens that
   *   to deletion.
   * - "untouched": the section never enumerates sibling resources, so an
   *   undeclared one is simply never seen and no policy applies.
   *
   * The conditional type makes the pairing unrepresentable to get wrong: a
   * section in UNDECLARED_POLICY_SECTIONS must say "delete" or "keep",
   * and one outside it must say "untouched" - so defaultUndeclaredPolicy
   * can never be reached for a section the merge does not normalize.
   */
  readonly undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
}

/**
 * A section's fine-grained-PAT grant advice, used verbatim in permission
 * errors: the prose grantFor derives from the section's permission, plus its
 * caveat when one is declared. The README's "Sections" table mirrors these
 * in its PAT permission column.
 */
export function sectionGrant(section: Pick<SectionMeta, "permission" | "grantCaveat">): string {
  return grantFor(section.permission, section.grantCaveat);
}

/**
 * One entry in the flattened REST + GraphQL view of sectionOperations():
 * `wire` says whether the request READS or WRITES on the wire (a GET or a
 * query vs a mutating method or a mutation), `grade` the access level GitHub
 * gates it at (endpointKind, so an accessGrade override write-gates a wire
 * read; a GraphQL operation's kind is both), and `permission` the effective
 * permission (endpointPermission).
 */
export interface SectionOperation {
  readonly wire: "read" | "write";
  readonly grade: "read" | "write";
  readonly permission: SectionPermission | "none";
}

/**
 * Every operation a section may issue - its REST endpoints and GraphQL
 * operations flattened into one list. Consumers deriving cross-cutting facts
 * from "everything this section can call" (overrideAdviceLevel below, the
 * fuzz oracle's no-read and write-gated section sets, the registry
 * mixed-grade guard, the README PAT-form and permissions-doc sweeps) walk
 * THIS view instead of section.endpoints alone, so a derivation can never
 * quietly ignore the GraphQL dictionary. The _OperationDictionariesFlattened
 * pin below keeps the flattening total: a new operation dictionary on
 * SectionMeta fails to compile until it is folded in here.
 */
export function sectionOperations(section: SectionMeta): SectionOperation[] {
  return [
    ...Object.values(section.endpoints).map((endpoint) => ({
      wire: endpointMethod(endpoint.route) === "GET" ? ("read" as const) : ("write" as const),
      grade: endpointKind(endpoint),
      permission: endpointPermission(section, endpoint),
    })),
    ...Object.values(section.graphql ?? {}).map((op) => ({
      wire: op.kind,
      grade: op.kind,
      permission: endpointPermission(section, op),
    })),
  ];
}

/** The SectionMeta properties sectionOperations flattens. */
type FlattenedOperationDictionaries = "endpoints" | "graphql";

/** Every SectionMeta property holding a dictionary of operation declarations. */
type OperationDictionaryKeys = {
  [K in keyof SectionMeta]-?: NonNullable<SectionMeta[K]> extends Readonly<
    Record<string, FailingOp>
  >
    ? K
    : never;
}[keyof SectionMeta];

/**
 * The compile-time pin behind sectionOperations' completeness claim: a new
 * operation dictionary added to SectionMeta lands in OperationDictionaryKeys
 * structurally and fails here until sectionOperations (and the list above)
 * flatten it - the _UnlistedSection idiom from schema.ts. The structural
 * match sees `Readonly<Record<string, ...>>` properties (the form both
 * dictionaries use today); a dictionary declared as a named interface would
 * evade it, so keep the record form on any future operation dictionary.
 */
type _OperationDictionariesFlattened = MustBeNever<
  Exclude<OperationDictionaryKeys, FlattenedOperationDictionaries>
>;

/**
 * One settings section, self-contained: identity and grant advice
 * (SectionMeta), the loose shape validation accepts for its declared
 * value, and the handler. Modules register in ./registry.ts.
 */
export interface SectionModule<K extends SectionKey = SectionKey> extends SectionMeta<K> {
  /**
   * Loose zod shape for the declared value: only the natural keys the
   * handler needs are checked, and unknown fields pass through untouched,
   * so validation does not fight the passthrough-first forward-compatibility
   * tenet. The sanctioned exceptions are STRICT nested sub-shapes for
   * values whose endpoint offers no passthrough destination (actions.cache,
   * where each key is the entire body of its own endpoint, and the
   * environment secrets and deployment_protection_rules entries, whose
   * write bodies are built from the named fields alone), where an extra
   * key can only be a typo.
   */
  shape: z.ZodType;
  /**
   * Declared only on CLOSED sections - those whose API calls never forward
   * extra entry keys (collaborators, teams, workflows), where an
   * unrecognized key is always a typo that would otherwise apply
   * "successfully" and never converge. Consumed by validateSectionShapes,
   * so the rejection happens during upfront document validation, BEFORE any
   * section has written anything. Open passthrough sections must NOT
   * declare this: their extra keys genuinely reach GitHub, and future API
   * fields have to keep working. The conditional type enforces both edges:
   * `known` may only name real entry keys from SettingsFile, and a
   * non-list section cannot declare a closedSurface at all (the property
   * collapses to never). EntryOf sees through the wrapped
   * `{undeclared, entries}` form, so a closed section that also takes the
   * policy knob (collaborators) keeps its closed-surface validation in both
   * forms.
   */
  closedSurface?: [EntryOf<NonNullable<SettingsFile[K]>>] extends [never]
    ? never
    : {
        /** Every entry key the section recognizes. */
        known: readonly (keyof EntryOf<NonNullable<SettingsFile[K]>> & string)[];
        /** The entry's natural key, to name it in the error. */
        describe: (entry: EntryOf<NonNullable<SettingsFile[K]>>) => string;
        /** What the unrecognized key would silently do, as message prose. */
        consequence: string;
      };
  /**
   * The declared values of this section's DESIGNATED SECRET FIELDS (e.g.
   * every webhooks entry's config.secret), extracted from the raw declared
   * value. Declared only by sections that carry secret fields. The engine
   * collects these before any section runs: it validates each value as a
   * whole-value `$NAME` reference (syntax only in check mode and preflight)
   * and, in apply mode, resolves them all up front - masking every
   * plaintext - so ctx.resolveSecret never misses. Values are returned raw;
   * nothing here reads the environment.
   */
  secretValues?(declared: unknown): string[];
  run(ctx: SectionContext, desired: unknown): Promise<SectionResult>;
}

/** The loose "any YAML mapping" shape for passthrough-heavy sections. */
export const anyRecord = z.record(z.string(), z.unknown());

/**
 * The entry type of a list section's declared value, whichever form it
 * takes: a plain entry array, or the wrapped `{undeclared, entries}` form.
 * Distributes over the union, so a knobbed section (whose SettingsFile type
 * is that union) resolves to its one entry type; a non-list section
 * resolves to never.
 */
export type EntryOf<T> = T extends readonly (infer E)[]
  ? E
  : T extends { entries: readonly (infer E)[] }
    ? E
    : never;

/**
 * Unwrap a list section's declared value into its policy and entries. The
 * plain array form takes `defaultPolicy`; the wrapped form's explicit
 * `undeclared` wins, and an omitted one falls back to the same default. The
 * default is a REQUIRED parameter on purpose: a nested list in a future
 * feature cannot derive its default from its section's undeclaredDefault,
 * so the call site always says which default applies. Entries are returned
 * by reference, not cloned.
 */
export function undeclaredPolicy<E>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  defaultPolicy: UndeclaredPolicy,
): { policy: UndeclaredPolicy; entries: readonly E[] } {
  if (Array.isArray(declared)) {
    return { policy: defaultPolicy, entries: declared };
  }
  const wrapped = declared as UndeclaredPolicyList<E>;
  return { policy: wrapped.undeclared ?? defaultPolicy, entries: wrapped.entries };
}

/**
 * The section-level default for undeclaredPolicy, read off the section's own
 * undeclaredDefault declaration so the two can never disagree. The parameter
 * type restricts callers to the knobbed sections, where the conditional
 * undeclaredDefault type already excludes "untouched" - asking for a
 * non-enumerating section's default is a compile error, not a runtime BUG.
 */
export function defaultUndeclaredPolicy(
  section: SectionMeta<UndeclaredPolicySection>,
): UndeclaredPolicy {
  return section.undeclaredDefault;
}

/**
 * The zod shape for a knobbed list section: the union of the plain entry
 * array and the strict `{undeclared, entries}` wrapper. Routed by container
 * type instead of z.union so a failing entry keeps its precise issue path
 * (`labels[2].name`, or `labels.entries[2].name` in the wrapped form) - a
 * plain union collapses every failure into one pathless "Invalid input".
 * The wrapper is strictObject because it is this action's own vocabulary
 * (nothing in it passes through to GitHub), so an unrecognized key can only
 * be a typo.
 */
export function undeclaredPolicyShape(list: z.ZodType): z.ZodType {
  const wrapper = z.strictObject({
    undeclared: z.enum(["keep", "delete"]).optional(),
    entries: list,
  });
  return z
    .custom<unknown>(() => true)
    .superRefine((value, ctx) => {
      const shape = Array.isArray(value)
        ? list
        : typeof value === "object" && value !== null
          ? wrapper
          : null;
      if (shape === null) {
        ctx.addIssue({
          code: "custom",
          message:
            'Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "undeclared" policy)',
        });
        return;
      }
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue });
        }
      }
    });
}

export function emptyResult(): SectionResult {
  return { changes: [], drift: [], notes: [] };
}

/**
 * The trailing options argument for a request helper, whose optionality
 * depends on the route. When the route has no path params (owner/repo
 * aside), the options object is optional and `params` is forbidden. When
 * the route has params, the options object is REQUIRED and must carry
 * `params` with exactly the route's keys. Modeling this as a rest tuple
 * (not an optional object param) is what makes omitting the whole argument
 * a compile error for a route that needs params - the `[never]` trick alone
 * cannot forbid an omitted argument. `Extra` carries per-helper extras
 * (query/payload/tolerate/accept).
 */
export type OptsArg<E extends EndpointDecl, Extra> = [PathParams<E["route"]>] extends [never]
  ? [opts?: { params?: undefined } & Extra]
  : [opts: { params: Readonly<Record<PathParams<E["route"]>, string>> } & Extra];

/**
 * Call the API; convert permission failures into PermissionDenied (handled
 * by the orchestrator's partial-success policy), everything else into a
 * hard error carrying the API's message verbatim. The path is built from
 * the endpoint declaration, so a section can only ever call what it
 * declares, with exactly the params the route requires.
 */
export async function call<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    { query?: Readonly<Record<string, string>>; payload?: unknown; describe?: string }
  >
): Promise<unknown> {
  const opts = args[0];
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  const result = await ctx.api.tryRequest(method, path, opts?.payload);
  if ("error" in result) {
    throwFor(section, method, path, result.error, {
      operation: opts?.describe,
      op: endpoint,
    });
  }
  return result.data;
}

/**
 * Like call(), but tolerated error statuses come back as { error } for the
 * caller to interpret (e.g. a 409 that means "drift" or "in progress", not
 * failure); every other error classifies through throwFor. Tolerated
 * statuses default to the endpoint's declared >= 400 statuses; pass an
 * explicit `tolerate` only to tolerate FEWER than declared.
 */
export async function tryCall<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      payload?: unknown;
      tolerate?: readonly (keyof E["statuses"] & number)[];
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { error: ApiError }> {
  const opts = args[0];
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  const tolerate: readonly number[] = opts?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest(method, path, opts?.payload);
  if ("error" in result && !tolerate.includes(result.error.status)) {
    throwFor(section, method, path, result.error, {
      operation: opts?.describe,
      op: endpoint,
    });
  }
  return result;
}

/**
 * GET a resource whose absence is a normal state: tolerated statuses come
 * back as { missing: true }, every other error classifies through throwFor.
 * The shared idiom behind "does this branch/site/environment/toggle exist"
 * probes. Tolerated statuses default to the endpoint's declared >= 400
 * statuses; pass an explicit `tolerate` only to tolerate FEWER than declared.
 */
export async function probeAbsent<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<
    E,
    {
      query?: Readonly<Record<string, string>>;
      tolerate?: readonly (keyof E["statuses"] & number)[];
      accept?: string;
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { missing: true }> {
  const options = args[0];
  const path = expand(endpoint, ctx, options?.params, options?.query);
  const tolerate: readonly number[] = options?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest("GET", path, undefined, { accept: options?.accept });
  if ("error" in result) {
    if (tolerate.includes(result.error.status)) {
      return { missing: true };
    }
    throwFor(section, "GET", path, result.error, {
      operation: options?.describe,
      op: endpoint,
    });
  }
  return { data: result.data };
}

/**
 * Section-flavored pagination: delegate the page loop to github/paginate,
 * classify errors through throwFor; `extract` adapts the response shape
 * (bare array, or a {total_count, <key>: []} envelope).
 */
async function listPages(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: EndpointDecl,
  path: string,
  extract: (data: unknown) => unknown[] | null,
  shape: string,
): Promise<unknown[]> {
  const result = await paginate(ctx.api, path, extract, undefined, endpoint.pageSize);
  if ("error" in result) {
    throwFor(section, "GET", path, result.error, { op: endpoint });
  }
  if ("malformed" in result) {
    throw new Error(
      `${section.key}: GET ${path} returned a JSON value without ${shape}, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return result.items;
}

/** GET every page of a bare-array list endpoint. */
export async function listAll<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
): Promise<unknown[]> {
  const opts = args[0];
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  return listPages(
    ctx,
    section,
    endpoint,
    path,
    (data) => (Array.isArray(data) ? data : null),
    "a list",
  );
}

/**
 * Like listAll, for endpoints that wrap the list in an envelope object
 * (e.g. GET /actions/workflows returns {total_count, workflows: []}).
 */
export async function listAllEnveloped<E extends EndpointDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  endpoint: E,
  envelopeKey: string,
  ...args: OptsArg<E, { query?: Readonly<Record<string, string>> }>
): Promise<unknown[]> {
  const opts = args[0];
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  return listPages(
    ctx,
    section,
    endpoint,
    path,
    (data) => {
      const chunk = (data as Record<string, unknown> | null)?.[envelopeKey];
      return Array.isArray(chunk) ? chunk : null;
    },
    `a "${envelopeKey}" list`,
  );
}

/**
 * Issue a GraphQL operation; convert permission failures into
 * PermissionDenied, everything else into a hard error carrying the API's
 * message - the GraphQL sibling of call(). The failing request renders as
 * `GRAPHQL <opName>` where a REST error shows its method and path. The
 * variables are typed by the declaration's own `V`, so a call site cannot
 * omit or misname what the query expects.
 */
export async function callGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: { describe?: string },
): Promise<Record<string, unknown>> {
  const result = await ctx.api.tryGraphql(op, variables, ctx.repo);
  if ("error" in result) {
    throwFor(section, "GRAPHQL", op.name, result.error, { operation: opts?.describe, op });
  }
  return result.data;
}

/**
 * Whether an ApiError is tolerable under a set of declared error types: it
 * must carry the transport's graphqlTypes (an untyped or HTTP-level failure
 * is never tolerable) and EVERY observed type must be declared - the HTTP
 * status is a lossy fold (a mixed [FORBIDDEN, UNPROCESSABLE] response and a
 * pure FORBIDDEN both land on 403), so only the full type set can say what
 * actually happened. RATE_LIMITED and INSUFFICIENT_SCOPES can never appear
 * in `tolerate` (the type excludes them), so both always classify through
 * throwFor.
 */
function graphqlErrorTolerated(
  error: ApiError,
  tolerate: readonly GraphqlTolerableError[],
): boolean {
  const observed = error.graphqlTypes;
  return (
    observed !== undefined &&
    observed.length > 0 &&
    observed.every((type) => (tolerate as readonly string[]).includes(type))
  );
}

/**
 * Like callGraphql, but tolerated error types come back as { error } for the
 * caller to interpret; every other error classifies through throwFor. The
 * tolerated set defaults to the operation's declared error outcomes; pass an
 * explicit `tolerate` only to tolerate FEWER than declared. Tolerance reads
 * the error's OBSERVED GraphQL types (see graphqlErrorTolerated), never the
 * folded HTTP status.
 */
export async function tryCallGraphql<O extends GraphqlOpDecl>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
  opts?: {
    tolerate?: readonly (keyof O["outcomes"] & GraphqlTolerableError)[];
    describe?: string;
  },
): Promise<{ data: Record<string, unknown> } | { error: ApiError }> {
  const declared = toleratedGraphqlErrors(op);
  const tolerate: readonly GraphqlTolerableError[] = opts?.tolerate ?? declared;
  // The keyof-outcomes typing cannot pin the DECLARED subset (keyof a Partial
  // record names every possible key), so the subset rule is enforced here: an
  // explicit tolerate may only narrow, never smuggle in an undeclared type.
  const undeclared = tolerate.filter((type) => !declared.includes(type));
  if (undeclared.length > 0) {
    throw new Error(
      `BUG: tryCallGraphql for ${op.name} was told to tolerate [${undeclared.join(", ")}], which the operation's outcomes do not declare; declare the outcome or drop it from tolerate`,
    );
  }
  const result = await ctx.api.tryGraphql(op, variables, ctx.repo);
  if ("error" in result) {
    if (!graphqlErrorTolerated(result.error, tolerate)) {
      throwFor(section, "GRAPHQL", op.name, result.error, { operation: opts?.describe, op });
    }
  }
  return result;
}

/**
 * Collect every node of a GraphQL connection, the sibling of listAll: the
 * cursor loop lives here so paging behavior cannot drift between sections.
 * The operation must declare its `connection` (the type requires it), whose
 * `path` walks from the data root to the connection field selecting
 * `nodes { ... }` and `pageInfo { hasNextPage endCursor }`; the loop owns the
 * `$cursor` variable, passing null first and the previous page's endCursor
 * after, so the caller's variables must not carry one. The operation's
 * DECLARED error outcomes are tolerated exactly as tryCallGraphql tolerates
 * them, coming back as { error } for the caller to interpret (the
 * environments pins read declares NOT_FOUND, so a fine-grained denial reads
 * as an absent resource - the probeAbsent posture) - but only on the FIRST
 * page: absence describes the whole resource, and a tolerated type arriving
 * mid-walk means the connection vanished under the loop, a broken walk that
 * classifies through throwFor like any other error. An operation declaring
 * no error outcomes always resolves { items }.
 */
export async function listGraphqlConnection<
  O extends GraphqlOpDecl & { connection: GraphqlConnectionDecl },
>(
  ctx: SectionContext,
  section: SectionMeta,
  op: O,
  variables: Readonly<GraphqlVariablesOf<O>>,
): Promise<{ items: unknown[] } | { error: ApiError }> {
  if (!op.query.includes("$cursor")) {
    throw new Error(
      `BUG: GRAPHQL ${op.name} is paginated through listGraphqlConnection but its query declares no $cursor variable`,
    );
  }
  if ("cursor" in variables) {
    throw new Error(
      `BUG: GRAPHQL ${op.name} was given a "cursor" variable, but the connection loop owns the cursor; drop it from the call site`,
    );
  }
  const path = op.connection.path;
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await ctx.api.tryGraphql(op, { ...variables, cursor }, ctx.repo);
    if ("error" in result) {
      if (cursor === null && graphqlErrorTolerated(result.error, toleratedGraphqlErrors(op))) {
        return result;
      }
      throwFor(section, "GRAPHQL", op.name, result.error, { op });
    }
    const connection = path.reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | null)?.[key],
      result.data,
    ) as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | null;
    const nodes = connection?.nodes;
    const pageInfo = connection?.pageInfo;
    if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") {
      throw new Error(
        `${section.key}: GRAPHQL ${op.name} returned a response without a "${path.join(".")}" connection carrying nodes and pageInfo{hasNextPage, endCursor}, so the list cannot be paginated. The operation's query must select both under that path`,
      );
    }
    items.push(...nodes);
    if (!pageInfo.hasNextPage) {
      return { items };
    }
    const endCursor = pageInfo.endCursor;
    if (typeof endCursor !== "string" || endCursor === cursor) {
      // hasNextPage without a fresh endCursor can only loop forever; treat it
      // as the same broken-connection shape as a missing pageInfo.
      throw new Error(
        `${section.key}: GRAPHQL ${op.name} reported hasNextPage without a new endCursor at "${path.join(".")}", so the pagination cannot advance. The operation's query must select pageInfo{hasNextPage, endCursor}`,
      );
    }
    cursor = endCursor;
  }
}

/**
 * Reject two declared entries that resolve to the same natural key; they
 * would fight each other on every run instead of converging.
 */
export function rejectDuplicates<T>(
  section: SectionMeta,
  items: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = keyOf(item);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `${section.key}: the settings file declares both "${first}" and "${describe(item)}", which name the same ${section.key} entry. Keep exactly one entry per resource`,
      );
    }
    seen.set(key, describe(item));
  }
}

/**
 * Structural equality of two effective endpoint permissions. The override
 * declarations are separate object literals (the OIDC pair declares two
 * distinct {repo: ["actions"]} values), so reference equality cannot group
 * them; compare the repo resources as a set plus the org grant.
 */
function samePermission(a: SectionPermission | "none", b: SectionPermission | "none"): boolean {
  if (a === "none" || b === "none") {
    return a === b;
  }
  if (a.org !== b.org || a.repo.length !== b.repo.length) {
    return false;
  }
  const sortedA = [...a.repo].sort();
  const sortedB = [...b.repo].sort();
  return sortedA.every((resource, index) => resource === sortedB[index]);
}

/**
 * The access level denial advice should ask for on an override permission:
 * "write" when ANY of the section's endpoints or GraphQL operations carrying
 * that same effective permission is write-graded, else "read". Grading by
 * the SECTION's need rather than the failing operation keeps the fix to one
 * round trip: the apply-mode preflight probes with reads, so a read-level
 * advice on a permission the section also writes with (the OIDC GET/PUT
 * pair) would have the user grant read, pass preflight, and then fail again
 * on the write. A permission the section only reads with (the branch-policy
 * list; its write siblings live on a different permission) still advises
 * read.
 */
export function overrideAdviceLevel(
  section: SectionMeta,
  effective: SectionPermission,
): "read" | "write" {
  return sectionOperations(section).some(
    (operation) => samePermission(operation.permission, effective) && operation.grade === "write",
  )
    ? "write"
    : "read";
}

export function throwFor(
  section: SectionMeta,
  method: string,
  path: string,
  error: ApiError,
  context?: {
    operation?: string;
    /**
     * The declaration behind the failing request - a REST EndpointDecl or a
     * GraphqlOpDecl (a GraphQL failure renders `GRAPHQL <opName>` in the
     * method/path slot). Supplies the status hints and denial hint, and
     * resolves the EFFECTIVE permission: an operation with a permission
     * override renders its own grant advice instead of the section's, and a
     * public operation ("none") cannot be a missing-grant failure at all, so
     * its 403/404 takes the generic branch.
     */
    op?: FailingOp;
  },
): never {
  // "creating ruleset "x" failed - POST /repos/...": the operation label says
  // WHAT was being done in settings-file terms; the raw method/path stays so
  // the failing request is still identifiable.
  const operation = context?.operation ? `${context.operation} failed - ` : "";
  const cause = `${operation}${method} ${path}: ${error.status} ${error.message}`;
  if (isRateLimitError(error)) {
    // Includes primary and secondary rate limits delivered as 403; those
    // must not be mistaken for missing permissions.
    throw new Error(
      `${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    );
  }
  const effective = context?.op ? endpointPermission(section, context.op) : undefined;
  if (isPermissionError(error) && effective !== "none") {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    // An operation whose 403/404 is AMBIGUOUS (it can mean something other
    // than a missing grant) says so here, right where the user reads the
    // grant advice.
    const denialHint = context?.op?.denialHint ? `. Note: ${context.op.denialHint}` : "";
    // The section's grant prose carries its caveats, so it stays the default;
    // an operation override names a DIFFERENT permission, so only then is the
    // advice re-derived from the override - at the level the SECTION needs
    // on that permission (see overrideAdviceLevel), so a denied read never
    // asks for a write grant the section cannot use, and never advises a
    // read grant a sibling write on the same permission would outgrow.
    const grant =
      effective !== undefined && effective !== section.permission
        ? grantFor(effective, undefined, overrideAdviceLevel(section, effective))
        : sectionGrant(section);
    throw new PermissionDenied(
      section.key,
      `the token was denied ${cause}${alsoMissing}. To fix, ${grant}${denialHint}`,
      error.status,
    );
  }
  if (error.status >= 500) {
    throw new Error(
      `${section.key}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`,
    );
  }
  if (error.status === 401) {
    throw new Error(
      `${section.key}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`,
    );
  }
  const advice = context?.op?.hints?.[error.status as HintableStatus];
  const hint = advice ? `. ${advice}` : "";
  const docs = error.documentationUrl
    ? `. The fields and values this endpoint accepts are documented at ${error.documentationUrl}`
    : "";
  throw new Error(
    `${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above${hint}${docs}`,
  );
}

/** Shared section-handler contract and error classification. */

import type { Endpoints } from "@octokit/types";
import { z } from "zod";
import type { ApiError, GithubClient } from "../github/api.js";
import { isPermissionError, isRateLimitError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import type {
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
    readonly status?: number,
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
  | "codespaces_secrets";

/**
 * The machine-readable permission a section requires. `repo` lists the
 * fine-grained-PAT Repository permissions where ANY one grants access;
 * `org` names the extra Organization permission a section needs (teams).
 */
export interface SectionPermission {
  /** Fine-grained PAT repository permissions; ANY one of these grants access. */
  repo: readonly [PatResource, ...PatResource[]];
  /** Additional organization permission required (teams only). */
  org?: "members";
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
};

/** Human-facing label for each PAT organization resource. */
const RESOURCE_LABEL_ORG: Record<NonNullable<SectionPermission["org"]>, string> = {
  members: "Members",
};

/**
 * Render a SectionPermission into the grant prose used verbatim in
 * permission errors. `caveat`, when given, is appended after "; ". The
 * output must stay byte-identical to the hand-written strings this
 * replaces - these are user-facing error prose and the README table mirrors
 * them.
 */
export function grantFor(permission: SectionPermission, caveat?: string): string {
  const resources = permission.repo.map((resource) => `"${RESOURCE_LABEL[resource]}"`).join(" or ");
  const repoClause = permission.org
    ? `${resources} (read and write) under its Repository permissions`
    : `${resources} (read and write) under the PAT's Repository permissions`;
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
 * is enough. Audit on every @octokit/types bump: delete entries the
 * upstream Endpoints map has gained.
 */
type SupplementalRoute =
  | "GET /repos/{owner}/{repo}/actions/cache/retention-limit"
  | "PUT /repos/{owner}/{repo}/actions/cache/retention-limit"
  | "GET /repos/{owner}/{repo}/actions/cache/storage-limit"
  | "PUT /repos/{owner}/{repo}/actions/cache/storage-limit"
  | "PUT /repos/{owner}/{repo}/lfs"
  | "DELETE /repos/{owner}/{repo}/lfs";

/**
 * A GitHub REST route as octokit spells it: "METHOD /path/{param}". Using
 * `keyof Endpoints` means a typo'd path or a wrong method does not compile.
 */
export type Route = keyof Endpoints | SupplementalRoute;

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
  route: Route;
  statuses: Readonly<Record<number, string>>;
  /**
   * Overrides the section's permission for this one endpoint. "none" means
   * the endpoint is public (no token permission needed). Omit it when the
   * endpoint requires the section's own permission (the common case) - an
   * override equal to the section permission is redundant. Downstream
   * consumers resolve the effective permission via endpointPermission().
   */
  permission?: SectionPermission | "none";
  /**
   * True for an advisory READ whose non-404 failures are tolerated (the section
   * proceeds without it rather than failing). The e2e mock derives its
   * advisory-read exemption from this flag via allEndpoints(), so the exemption
   * stays in one place - the declaration - instead of a hard-coded list.
   */
  advisory?: boolean;
  /**
   * Advice for known 4xx failure classes, keyed by the HTTP status each one
   * explains; throwFor appends the matching entry (if any) to that status's
   * generic rejection message, so advice never fires on a status it does not
   * describe. On permission-requiring endpoints 403 and 404 NEVER reach
   * these entries - the permission branch short-circuits first; ambiguity
   * on those statuses belongs in `denialHint` below (a public "none"
   * endpoint's 403/404 does take the generic branch, so the registry.test
   * sweep forbids 403/404 hints outright rather than relying on the
   * short-circuit). Payloads pass through verbatim (GitHub stays the
   * authority on valid values), so a hint names the failure CLASS and
   * points at the endpoint documentation; it never lists valid values that
   * could go stale. One or two sentences, no trailing period.
   */
  hints?: Readonly<Record<number, string>>;
  /**
   * Appended to the PermissionDenied message (which never reads `hints`) for
   * an endpoint whose 403/404 is ambiguous - it can mean something other
   * than a missing token grant (e.g. Git LFS disabled account-wide). One
   * sentence, no trailing period.
   */
  denialHint?: string;
  /**
   * True for a WRITE the section issues for every declared entry on EVERY
   * apply by contract - the sealed secret PUTs, whose values cannot be read
   * back, so the unconditional re-write is what propagates a rotated source
   * value. This is a property of the ENDPOINT, not its section: environments
   * carries a passthrough PUT and always-rewrite secret PUTs side by side.
   * The e2e apply-idempotence proof derives its required-rewrite set from
   * this flag, so the contract lives on the declaration it describes.
   */
  alwaysRewrite?: true;
  /**
   * The access grade GitHub gates this endpoint at, when it differs from the
   * method-derived one (GET = read). Codespaces repository secrets are the
   * known case: the fine-grained permission gates even the list and
   * public-key READS at write. endpointKind() consults this, so the e2e
   * mock's permission gate and the fuzz oracle model the real gating - a
   * read-only grant then denies those reads exactly as production does.
   */
  accessGrade?: "write";
  /**
   * The largest per_page this LIST endpoint accepts, when it is smaller than
   * the standard 100 (the Actions variables list caps at 30). The page loop
   * requests exactly this many per page and treats a shorter page as the
   * last one, so a larger request that GitHub would silently clamp cannot
   * truncate the walk after page one. Omit on endpoints that take the
   * standard 100.
   */
  pageSize?: number;
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
 * The permission this endpoint actually requires: its own override when one
 * is declared, otherwise the section's permission. "none" means public. The
 * single place downstream consumers (e.g. the e2e mock's permission gate)
 * resolve the effective permission, so section vs per-endpoint precedence
 * lives in one spot.
 */
export function endpointPermission(
  section: SectionMeta,
  endpoint: EndpointDecl,
): SectionPermission | "none" {
  return endpoint.permission ?? section.permission;
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
  const repoName = ctx.repo.slice(ctx.repo.indexOf("/") + 1);
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
 * The identity every helper needs to classify an error: the section's key
 * and its fine-grained-PAT grant advice. Handlers pass `this`, so the
 * advice always travels with the section that owns it.
 */
export interface SectionMeta<K extends SectionKey = SectionKey> {
  key: K;
  /**
   * The machine-readable permission this section requires, from which its
   * grant prose is derived via grantFor.
   */
  permission: SectionPermission;
  /**
   * How to grant a fine-grained PAT access to this section's endpoints,
   * used verbatim in permission errors. The README's "Token permissions
   * by section" table mirrors these.
   */
  grant: string;
  /**
   * Every REST endpoint this section may call, keyed by role (list, create,
   * update, remove, probe, ...). Handlers build their paths by passing these
   * declarations to the request helpers; the mock server and USED_PATHS
   * derivation iterate Object.values(...).
   */
  endpoints: Readonly<Record<string, EndpointDecl>>;
  /**
   * The DEFAULT policy for live resources this section does NOT declare, the
   * single source the README Sections table and COVERAGE derive their
   * deletion claims from. For the sections that enumerate sibling resources,
   * the settings file can override the default per run with the wrapped
   * `{undeclared, entries}` form (see undeclaredPolicy below):
   * - "delete": the section lists live resources and DELETES undeclared ones
   *   by default (labels, autolinks, collaborators - though the owner is
   *   always exempt - and actions_variables); `undeclared: keep` softens
   *   that to notes.
   * - "keep": the section lists live resources but KEEPS undeclared ones by
   *   default, surfacing each as a note (rulesets, milestones, since removing
   *   them stays a human action); `undeclared: delete` hardens that to
   *   deletion.
   * - "untouched": the section never enumerates sibling resources, so an
   *   undeclared one is simply never seen (repository, branches, environments,
   *   actions, workflows, pages, code_scanning_default_setup, teams,
   *   interaction_limits) and no policy applies.
   *
   * The conditional type makes the pairing unrepresentable to get wrong: a
   * section in UNDECLARED_POLICY_SECTIONS must say "delete" or "keep",
   * and one outside it must say "untouched" - so defaultUndeclaredPolicy
   * can never be reached for a section the merge does not normalize.
   */
  undeclaredDefault: K extends UndeclaredPolicySection ? UndeclaredPolicy : "untouched";
}

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
   * tenet. The sanctioned exception is a STRICT nested sub-object for a
   * value whose endpoint offers no passthrough destination (actions.cache:
   * each key is the entire body of its own endpoint), where an extra key
   * can only be a typo.
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
      endpoint,
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
      tolerate?: number[];
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { error: ApiError }> {
  const opts = args[0];
  const method = endpointMethod(endpoint.route);
  const path = expand(endpoint, ctx, opts?.params, opts?.query);
  const tolerate = opts?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest(method, path, opts?.payload);
  if ("error" in result && !tolerate.includes(result.error.status)) {
    throwFor(section, method, path, result.error, {
      operation: opts?.describe,
      endpoint,
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
      tolerate?: number[];
      accept?: string;
      describe?: string;
    }
  >
): Promise<{ data: unknown } | { missing: true }> {
  const options = args[0];
  const path = expand(endpoint, ctx, options?.params, options?.query);
  const tolerate = options?.tolerate ?? toleratedStatuses(endpoint);
  const result = await ctx.api.tryRequest("GET", path, undefined, { accept: options?.accept });
  if ("error" in result) {
    if (tolerate.includes(result.error.status)) {
      return { missing: true };
    }
    throwFor(section, "GET", path, result.error, {
      operation: options?.describe,
      endpoint,
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
    throwFor(section, "GET", path, result.error, { endpoint });
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

export function throwFor(
  section: SectionMeta,
  method: string,
  path: string,
  error: ApiError,
  context?: {
    operation?: string;
    /**
     * The endpoint declaration behind the failing request. Supplies the
     * status hints and denial hint, and resolves the EFFECTIVE permission:
     * an endpoint with a permission override renders its own grant advice
     * instead of the section's, and a public endpoint ("none") cannot be a
     * missing-grant failure at all, so its 403/404 takes the generic branch.
     */
    endpoint?: EndpointDecl;
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
  const effective = context?.endpoint ? endpointPermission(section, context.endpoint) : undefined;
  if (isPermissionError(error) && effective !== "none") {
    const alsoMissing =
      error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
    // An endpoint whose 403/404 is AMBIGUOUS (it can mean something other
    // than a missing grant) says so here, right where the user reads the
    // grant advice.
    const denialHint = context?.endpoint?.denialHint
      ? `. Note: ${context.endpoint.denialHint}`
      : "";
    // The section's grant prose carries its caveats, so it stays the default;
    // an endpoint override names a DIFFERENT permission, so only then is the
    // advice re-derived from the override.
    const grant =
      effective !== undefined && effective !== section.permission
        ? grantFor(effective)
        : section.grant;
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
  const advice = context?.endpoint?.hints?.[error.status];
  const hint = advice ? `. ${advice}` : "";
  const docs = error.documentationUrl
    ? `. The fields and values this endpoint accepts are documented at ${error.documentationUrl}`
    : "";
  throw new Error(
    `${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above${hint}${docs}`,
  );
}

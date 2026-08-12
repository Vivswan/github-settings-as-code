/**
 * The core-path handlers: the non-section routes the action calls, served by
 * the pipeline (routes.ts) before section matching - the multi-repo discovery
 * listing (GET /user/repos), the settings-file contents fetch, and the
 * private-report issue channel - plus the redaction visibility probe model
 * that both the report delivery rule and the pipeline's denial-barrier
 * exemption read.
 */

import { isIssueChannel } from "../../../src/action/redact.js";
import { MAX_RETRIES } from "../../../src/github/api.js";
import {
  ISSUE_REPORT_PERMISSION,
  MARKER_LABEL,
  MARKER_LABEL_CONFIG,
} from "../../../src/report/issue-report.js";
import { matchesTemplate } from "../../../src/sections/contract/endpoints.js";
import { ADMIN_SLUG, TOKEN_USER_LOGIN } from "../constants.js";
import type { MaskKey, Scenario } from "../schema.js";
import type { CoreFaultKey } from "./chaos.js";
import type { FaultOption, PipelineResult } from "./contract.js";
import { violationResponse } from "./contract.js";
import { denialResponse, effectiveMask, gradeRequirement, grantsAtLeast } from "./grading.js";
import type { MockState, MultiMockState } from "./state.js";
import {
  asObject,
  findLabel,
  type Json,
  type MockResponse,
  nextNumber,
  ok,
  slicePage,
} from "./support.js";

/**
 * The log-less violation pair the core-path handlers return (the pipeline
 * attaches the log entry): one mint, so no handler hand-rolls a drifting
 * copy - the core-path sibling of contract.ts's violationFor.
 */
function coreViolation(message: string): { response: MockResponse; violation: string } {
  return { response: violationResponse(message), violation: message };
}

/**
 * Handle GET /user/repos - multi-repo discovery. In single-repo mode this path
 * is never called, so it answers a loud violation; in multi-repo mode it
 * enumerates the discovery pool, applying the SERVER-SIDE query params the
 * action sends (affiliation always, visibility only for public/private) and
 * paginating, but NOT the client-side filters (archived/fork/topics/exclude),
 * which the action settles itself. The repository probe GET /repos/{o}/{r} is a
 * section endpoint (repository.get), matched before this is consulted.
 */
export function handleUserRepos(
  method: string,
  pathname: string,
  query: Record<string, string>,
  multi: MultiMockState | undefined,
): { response: MockResponse; violation?: string } | null {
  if (!matchesTemplate("/user/repos", pathname)) {
    return null;
  }
  if (!multi) {
    return coreViolation(
      "multi-repo discovery (/user/repos) is not implemented in single-repo mode",
    );
  }
  if (method !== "GET") {
    return coreViolation(`unexpected ${method} on /user/repos`);
  }
  const filtered = applyServerSideDiscovery(multi.discoveryPool, query);
  return { response: ok(slicePage(filtered, query)) };
}

/**
 * The discovery params GitHub filters SERVER-SIDE, mirrored from
 * src/discovery/discover.ts and its test. `visibility` is the only one the
 * fixtures model: the server-side query narrows only coarsely, and the action
 * settles the rest client-side, so the mock must match that split exactly:
 *   - visibility=public  -> the API returns only public repos.
 *   - visibility=private -> the API returns private AND internal repos (there
 *     is no server-side "internal" value); the action drops the internal ones
 *     client-side (discover.test.ts "visibility: private drops internal repos
 *     client-side"). So the mock must NOT drop internal on the private query.
 *   - visibility=internal / all / absent -> no server-side narrowing; the
 *     action filters, so the mock passes the pool through.
 * `affiliation` has no per-repo fixture attribute (every pool repo is treated
 * as owned), so it is a pass-through here. archived/fork/topics/exclude are
 * client-side and must NEVER be pre-filtered.
 */
function applyServerSideDiscovery(pool: Json[], query: Record<string, string>): Json[] {
  const visibility = query.visibility;
  if (visibility === "public") {
    return pool.filter((repo) => (repo.visibility ?? "public") === "public");
  }
  if (visibility === "private") {
    // Private AND internal survive the server-side query; the action narrows.
    return pool.filter((repo) => (repo.visibility ?? "public") !== "public");
  }
  return pool;
}

/**
 * The Accept header value the settings-file fetch sends: getRepoFile requests
 * the raw media type so the body comes back as the file text, not a JSON
 * content object. The mock requires this exact value on the contents route.
 */
export const RAW_CONTENTS_ACCEPT = "application/vnd.github.raw+json";

/**
 * Serve a target slug's settings.yml over the contents endpoint, AFTER the
 * caller has graded the `contents` read permission. A configured slug returns
 * its raw YAML body (the client sent the raw accept header, so the body is the
 * file text verbatim); a slug whose settings are null - or one the multi-state
 * does not know - returns 404, which the action reads as "no settings file" and
 * disambiguates via the repo probe.
 */
export function contentsResponse(multi: MultiMockState, slug: string): MockResponse {
  const yaml = multi.settings.get(slug);
  if (yaml === null || yaml === undefined) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return { status: 200, body: yaml };
}

/** The target slug of a contents request, or null when the path is not one. */
export function contentsSlug(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\//);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

// --- Private-report issue channel (core paths, not a section) --------------
//
// The issue channel delivers the full unredacted report as an issue on the
// target repo. Its routes are NOT section endpoints (report delivery is
// infrastructure that writes even in check mode); they are served inline before
// section matching, exactly like the contents fetch, and gated on the Issues
// permission per ISSUE_REPORT_PERMISSION. GET /user is the fallback creator
// scan and is a user-level call, so it is ungated (it reports TOKEN_USER_LOGIN
// from ../constants.js; the report module reads only `login`). The
// marker-label POST goes through the existing labels.create section route
// (Issues-gated, 422 on duplicate), so it is not modeled here.

/** A repo's proven visibility from its mock state (defaults public via the fixture). */
function visibilityOfState(state: MockState | undefined): string {
  const repo = state?.repo ?? {};
  if (typeof repo.visibility === "string") {
    return repo.visibility;
  }
  return repo.private === true ? "private" : "public";
}

/**
 * Whether the action could PROVE this slug's visibility - the precondition for
 * report delivery. Discovery-supplied slugs need no probe (their visibility came
 * from /user/repos), so they are always provable. An explicit target is probed
 * with one administration-gated repository.get; the probe fails to "unknown"
 * (and delivery is skipped) when administration is denied, or when a fault on
 * repository.get exhausts the probe's retry budget. Modeling this - rather than
 * reading the fixture visibility alone - is what lets the mock reject a delivery
 * the action could never have made.
 */
function probeCanProveVisibility(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  const discovered = (multi?.discoveryPool ?? []).some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  if (discovered) {
    return true;
  }
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  if (!grantsAtLeast(mask, "administration", "read")) {
    return false;
  }
  const probeFault = faults?.find((f) => f.key === "repository.get");
  if (probeFault) {
    const times = probeFault.times ?? 1;
    if (times === "always" || times >= PROBE_RETRY_BUDGET) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the scenario's report channel delivers through the target repo's
 * report issue: `issue` or `issue-on-failure` (isIssueChannel, single-sourced
 * from the action). The two differ only in WHEN they write - `issue-on-failure`
 * reads (and at most closes) on a healthy run - so the mock serves the same
 * issue routes for both and lets the recorded traffic prove the difference.
 */
function usesIssueChannel(scenario: Scenario): boolean {
  const channel = scenario.inputs?.private_report;
  return channel !== undefined && isIssueChannel(channel);
}

/**
 * Whether a slug is a report-DELIVERY target this run: the report channel is
 * an issue channel (see usesIssueChannel), redaction is on, the slug is not
 * the admin repo, its FIXTURE
 * visibility is private or internal, AND the action could actually PROVE that
 * visibility (see probeCanProveVisibility). This mirrors the action's delivery
 * rule exactly - deliver only when PROVEN private/internal, so a probe the
 * scenario denies or faults resolves "unknown" and delivery is skipped. The mock
 * serves the issue-channel routes for a slug only when this holds; report
 * traffic to any other slug (public, non-redacted, OR unknown-because-unprovable)
 * falls through to the normal barrier and section matching, so an accidental or
 * regressed delivery is caught loudly.
 */
function isReportDeliveryTarget(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  if (!usesIssueChannel(scenario)) {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const visibility = visibilityOfState(multi ? multi.repos.get(slug) : undefined);
  if (visibility !== "private" && visibility !== "internal") {
    return false;
  }
  return probeCanProveVisibility(slug, scenario, multi, faults);
}

/** The report issue's html_url, so the run summary can link it. */
function issueUrl(slug: string, number: number): string {
  return `https://github.com/${slug}/issues/${number}`;
}

/** True when this issue object matches the list query's labels/creator/state filters. */
function issueMatchesQuery(issue: Json, query: Record<string, string>): boolean {
  if (query.state && query.state !== "all" && String(issue.state) !== query.state) {
    return false;
  }
  if (query.creator) {
    const login = (issue.user as { login?: unknown } | undefined)?.login;
    if (login !== query.creator) {
      return false;
    }
  }
  if (query.labels) {
    const wanted = query.labels.split(",");
    const have = Array.isArray(issue.labels)
      ? (issue.labels as Json[]).map((l) => String((l as { name?: unknown }).name ?? l))
      : [];
    if (!wanted.every((w) => have.includes(w))) {
      return false;
    }
  }
  return true;
}

/**
 * Expand a label name into the object shape the issues list returns. Only
 * the marker label carries its configured color (the report path is the one
 * that materializes label objects on issues); any other name gets neutral
 * filler.
 */
function labelObject(name: string): Json {
  return {
    name,
    color: name === MARKER_LABEL ? MARKER_LABEL_CONFIG.color : "ededed",
    default: false,
  };
}

/**
 * Resolve the repo state an issue-channel request addresses. An unknown slug is
 * a loud violation the caller returns early - and, matching the section
 * pipeline's unknown-target rule, it is checked BEFORE the fault hook so a
 * fault can never mask it.
 */
function resolveIssueTarget(
  method: string,
  pathname: string,
  slug: string,
  multi: MultiMockState | undefined,
  singleState: MockState | undefined,
): { state: MockState } | { response: MockResponse; violation: string } {
  const repoState = multi ? multi.repos.get(slug) : singleState;
  if (!repoState) {
    return coreViolation(`issue-report request ${method} ${pathname} names no known target slug`);
  }
  return { state: repoState };
}

/**
 * Grade an issue-channel request against the report module's DECLARED
 * permission (single-sourced, so a change to ISSUE_REPORT_PERMISSION flows
 * here), not a hard-coded "issues". Returns the ready-to-send denial, or null
 * when the token is allowed.
 */
function gradeIssueAccess(
  slug: string,
  level: "read" | "write",
  scenario: Scenario,
  multi: MultiMockState | undefined,
): { response: MockResponse; deniedBy: MaskKey } | null {
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  const grading = gradeRequirement(mask, { permission: ISSUE_REPORT_PERMISSION, kind: level });
  if (!grading.allowed) {
    return { response: denialResponse(scenario.denial_style, level), deniedBy: grading.deniedBy };
  }
  return null;
}

/** The core fault key an issue route maps to, or null for an unexpected method. */
function issueRouteKey(method: string, issueNumber: number | undefined): CoreFaultKey | null {
  if (method === "GET" && issueNumber === undefined) {
    return "core.issuesList";
  }
  if (method === "POST" && issueNumber === undefined) {
    return "core.issueCreate";
  }
  if (method === "PATCH" && issueNumber !== undefined) {
    return "core.issuePatch";
  }
  return null;
}

/**
 * The issue channel's decision for one request, one branch per marker: a
 * transport fault passed through verbatim (`faulted`); a HANDLER response
 * tagged with the core route it came from (`coreKey`), so the caller can apply
 * the chaos corruption hook to it; a permission denial (`deniedBy`); or a
 * contract violation (`violation`). Denials and violations carry no coreKey
 * and are never corrupted, matching the section pipeline. Each branch declares
 * the OTHER markers `?: never` (a structural XOR, like RejectionSpec in
 * fuzz.ts): without the exclusions, the union's excess-property check would
 * accept a literal carrying two markers (any property declared on ANY member
 * is legal excess) and the consumer's first check would silently win; with
 * them, a two-marker literal fails to compile. The consumer narrows by marker
 * TRUTHINESS, which the `?: never` optionals make total - `in` checks cannot
 * narrow this shape, since an optional property never rules a member out.
 */
export type IssueReportOutcome =
  | {
      faulted: PipelineResult;
      response?: never;
      coreKey?: never;
      deniedBy?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      coreKey: CoreFaultKey;
      faulted?: never;
      deniedBy?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      deniedBy: MaskKey;
      faulted?: never;
      coreKey?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      violation: string;
      faulted?: never;
      coreKey?: never;
      deniedBy?: never;
    };

/**
 * Serve the private-report issue routes against a repo's `issues` state:
 *   - GET /user                                      -> the token user (ungated)
 *   - GET  /repos/{o}/{r}/issues                      -> list (Issues: read)
 *   - POST /repos/{o}/{r}/issues                      -> create (Issues: write)
 *   - PATCH /repos/{o}/{r}/issues/{issue_number}      -> update (Issues: write)
 * Returns null when the path is not an issue-channel route, so the caller falls
 * through to section matching. Permission denials set `deniedBy` (so the
 * OpenAPI validator skips them and the runner sees the denial). `takeCoreFault`
 * is the pipeline's core-route fault hook, consulted per route after target
 * resolution and before the permission gate (the same order as the section
 * fault barrier) and before any state mutation.
 */
export function handleIssueReport(
  method: string,
  pathname: string,
  query: Record<string, string>,
  body: unknown,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  state: MockState | undefined,
  faults: FaultOption[] | undefined,
  takeCoreFault: (key: CoreFaultKey) => PipelineResult | null,
): IssueReportOutcome | null {
  // GET /user is the fallback creator scan - served only when the run enables
  // an issue channel at all (otherwise it is not report traffic and falls
  // through to a loud no-route violation).
  if (matchesTemplate("/user", pathname)) {
    if (method !== "GET" || !usesIssueChannel(scenario)) {
      return null;
    }
    const faulted = takeCoreFault("core.userGet");
    if (faulted) {
      return { faulted };
    }
    return {
      response: ok({ login: TOKEN_USER_LOGIN, id: 1, type: "User" }),
      coreKey: "core.userGet",
    };
  }
  // The marker-label ensure-create is report infrastructure (it writes even in
  // check mode), so it is served here - BEFORE the check-mode barrier - rather
  // than through the labels.create section route. The bypass is SCOPED: it fires
  // only for the marker label name AND only for a slug that is a report-delivery
  // target this run. A marker POST to any other slug (e.g. a buggy labels-section
  // write of the injected marker in check mode) falls through to the section
  // route and hits the normal check-mode barrier / gating.
  const labelsMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  if (labelsMatch && method === "POST" && asObject(body).name === MARKER_LABEL) {
    const slug = decodeURIComponent(labelsMatch[1] ?? "");
    if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
      return null;
    }
    const resolved = resolveIssueTarget(method, pathname, slug, multi, state);
    if (!("state" in resolved)) {
      return resolved;
    }
    const faulted = takeCoreFault("core.reportLabelCreate");
    if (faulted) {
      return { faulted };
    }
    const denied = gradeIssueAccess(slug, "write", scenario, multi);
    if (denied) {
      return denied;
    }
    const coreKey = "core.reportLabelCreate" as const;
    if (findLabel(resolved.state, MARKER_LABEL)) {
      return { response: { status: 422, body: { message: "Validation Failed" } }, coreKey };
    }
    const payload = asObject(body);
    const label: Json = {
      id: resolved.state.nextId++,
      name: MARKER_LABEL,
      color: payload.color ?? "ededed",
      default: false,
      description: payload.description ?? null,
    };
    resolved.state.labels.push(label);
    return { response: { status: 201, body: label }, coreKey };
  }
  const issuesMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/);
  if (!issuesMatch) {
    return null;
  }
  const slug = decodeURIComponent(issuesMatch[1] ?? "");
  // Scope the issue-route bypass to a report-delivery target: issue traffic to a
  // public/non-redacted slug (accidental delivery) is not served here and falls
  // through to a loud no-route violation at section matching.
  if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
    return null;
  }
  const issueNumber = issuesMatch[2] ? Number(issuesMatch[2]) : undefined;
  const level: "read" | "write" = method === "GET" ? "read" : "write";
  const resolved = resolveIssueTarget(method, pathname, slug, multi, state);
  if (!("state" in resolved)) {
    return resolved;
  }
  const coreKey = issueRouteKey(method, issueNumber);
  if (coreKey) {
    const faulted = takeCoreFault(coreKey);
    if (faulted) {
      return { faulted };
    }
  }
  const denied = gradeIssueAccess(slug, level, scenario, multi);
  if (denied) {
    return denied;
  }
  const repoState = resolved.state;
  if (method === "GET" && issueNumber === undefined) {
    const matched = repoState.issues.filter((issue) => issueMatchesQuery(issue, query));
    return { response: ok(slicePage(matched, query)), coreKey: "core.issuesList" };
  }
  if (method === "POST" && issueNumber === undefined) {
    const payload = asObject(body);
    const number = nextNumber(repoState.issues);
    const labels = Array.isArray(payload.labels)
      ? payload.labels.map((l) => labelObject(String(l)))
      : [];
    const issue: Json = {
      number,
      title: payload.title ?? "",
      body: payload.body ?? "",
      state: "open",
      labels,
      user: { login: TOKEN_USER_LOGIN, id: 1, type: "User" },
      html_url: issueUrl(slug, number),
    };
    repoState.issues.push(issue);
    return { response: { status: 201, body: issue }, coreKey: "core.issueCreate" };
  }
  if (method === "PATCH" && issueNumber !== undefined) {
    const issue = repoState.issues.find((i) => Number(i.number) === issueNumber);
    if (!issue) {
      return {
        response: { status: 404, body: { message: "Not Found" } },
        coreKey: "core.issuePatch",
      };
    }
    const payload = asObject(body);
    if (payload.body !== undefined) {
      issue.body = payload.body;
    }
    if (payload.state !== undefined) {
      issue.state = payload.state;
    }
    // The marker-reattach path PATCHes a labels array (names); apply it the
    // way the create route does, so the repaired label set is observable.
    if (Array.isArray(payload.labels)) {
      issue.labels = payload.labels.map((l) => labelObject(String(l)));
    }
    return { response: ok(issue), coreKey: "core.issuePatch" };
  }
  return coreViolation(`unexpected ${method} on ${pathname}`);
}

// The admin repo the e2e runner runs as (ADMIN_SLUG, its GITHUB_REPOSITORY)
// is imported from ../constants.js; the redaction self carve-out never probes
// that slug, so a repository.get for it is always a section read, never the
// probe.

/**
 * How many wire attempts the visibility probe can make: one plus the client's
 * retry budget, derived from the client's own MAX_RETRIES (src/github/api.ts).
 * Once a slug's repository.get has faulted this many times the probe has
 * exhausted its retries and given up, so the next repository.get is a section
 * read - not a probe retry - and the exemption expires.
 */
export const PROBE_RETRY_BUDGET = 1 + MAX_RETRIES;

/**
 * Whether the redaction visibility probe is EXPECTED to issue a
 * `GET /repos/{slug}` for this target, so its denial may be exempted from the
 * denial barrier. The action probes a slug's visibility (one repository.get,
 * outside the section loop) only when ALL hold:
 *   - the run is multi-repo (the single-repo harness path always targets the
 *     admin repo itself, which the self carve-out never probes);
 *   - the effective policy is redact (the default; `show` never probes);
 *   - the slug is not the admin repo (the self carve-out skips the probe);
 *   - the slug's visibility did not already come from a `/user/repos` discovery
 *     response this run (a discovered slug's visibility is known, so no probe).
 * When a probe is NOT expected, the first (and only) repository.get is the
 * repository section's own check-mode read and MUST arm the barrier.
 */
export function probeExpected(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
): boolean {
  if (!multi) {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const discovered = multi.discoveryPool.some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  return !discovered;
}

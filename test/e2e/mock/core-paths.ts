/**
 * The core-path handlers: the non-section routes the action calls, served by routes.ts before section matching.
 *   GET /user/repos                             -> multi-repo discovery
 *   GET .../contents/{path}, .../git/ref/{ref}  -> the settings-file fetch and the proof that a missing file is missing
 *   /user, .../issues, .../labels (marker POST)  -> the private-report issue channel
 *
 * Also the redaction visibility probe model, read by the report delivery rule and by the pipeline's denial-barrier exemption.
 */

import { MAX_RETRIES } from "../../../src/github/api.js";
import { isIssueChannel } from "../../../src/report/delivery.js";
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

/** The log-less sibling of contract.ts's violationFor; the pipeline attaches the log entry. */
function coreViolation(message: string): { response: MockResponse; violation: string } {
  return { response: violationResponse(message), violation: message };
}

/**
 * Applies only the visibility narrowing GitHub does SERVER-SIDE and paginates; affiliation is a pass-through, and the
 * client-side filters (archived/fork/topics/exclude) are the action's to settle, so pre-filtering them would hide that path.
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
 * Mirrors the server-side split in src/discovery/discover.ts: GitHub has no server-side "internal" value, so the private
 * query returns internal repos too and the action drops them client-side. Dropping them here would hide that path.
 *   visibility=public           -> public only
 *   visibility=private          -> private AND internal
 *   internal / all / absent     -> the pool, unfiltered
 * affiliation is a pass-through: no pool repo carries a fixture attribute for it, so every one counts as owned.
 */
function applyServerSideDiscovery(pool: Json[], query: Record<string, string>): Json[] {
  const visibility = query.visibility;
  if (visibility === "public") {
    return pool.filter((repo) => (repo.visibility ?? "public") === "public");
  }
  if (visibility === "private") {
    return pool.filter((repo) => (repo.visibility ?? "public") !== "public");
  }
  return pool;
}

/** getRepoFile asks for the raw media type so the body is the file text, not a JSON content object; the mock requires exactly this value. */
export const RAW_CONTENTS_ACCEPT = "application/vnd.github.raw+json";

/**
 * Serve a slug's settings.yml raw, after the caller graded the contents read. A null-settings or unknown slug is 404,
 * which the action must then prove is a missing FILE through gitRefResponse.
 */
export function contentsResponse(multi: MultiMockState, slug: string): MockResponse {
  const yaml = multi.settings.get(slug);
  if (yaml === null || yaml === undefined) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return { status: 200, body: yaml };
}

export function contentsSlug(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\//);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

/**
 * The Contents-readability proof after a contents 404: a Contents-gated read whose success does not depend on the file.
 * Parsed as the slug plus the qualified ref ("heads/main").
 */
export function gitRefRequest(pathname: string): { slug: string; ref: string } | null {
  const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/ref\/(.+)$/);
  if (!match) {
    return null;
  }
  return { slug: decodeURIComponent(match[1] ?? ""), ref: decodeURIComponent(match[2] ?? "") };
}

const MOCK_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * The default branch's head ref exists for every known slug, file or not: 200 here plus 404 on contents is the pair that
 * proves the file absent. Any other ref, or an unknown slug, is 404.
 */
export function gitRefResponse(multi: MultiMockState, slug: string, ref: string): MockResponse {
  const defaultBranch = multi.repos.get(slug)?.repo.default_branch;
  if (typeof defaultBranch !== "string" || ref !== `heads/${defaultBranch}`) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return ok({
    ref: `refs/${ref}`,
    node_id: Buffer.from(`MOCKREF:${slug}:${ref}`, "utf8").toString("base64"),
    url: `https://api.github.com/repos/${slug}/git/refs/${ref}`,
    object: {
      type: "commit",
      sha: MOCK_HEAD_SHA,
      url: `https://api.github.com/repos/${slug}/git/commits/${MOCK_HEAD_SHA}`,
    },
  });
}

// --- Private-report issue channel (core paths, not a section) --------------
//
// Report delivery writes even in check mode, so these routes are served before section matching, gated on
// ISSUE_REPORT_PERMISSION. GET /user is a user-level call and ungated; the report module reads only `login`.

/** A repo's proven visibility from its mock state (defaults public via the fixture). */
function visibilityOfState(state: MockState | undefined): string {
  const repo = state?.repo ?? {};
  if (typeof repo.visibility === "string") {
    return repo.visibility;
  }
  return repo.private === true ? "private" : "public";
}

/**
 * The delivery precondition: the action delivers only when it could PROVE the visibility, so a probe the scenario denies
 * or faults past its retry budget resolves "unknown" and the mock rejects a delivery the action could never have made.
 * A discovered slug's visibility came from /user/repos and needs no probe.
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
 * `issue` and `issue-on-failure` differ only in WHEN they write (issue-on-failure reads, and at most closes, on a healthy
 * run), so both get the same routes and the recorded traffic proves the difference.
 */
function usesIssueChannel(scenario: Scenario): boolean {
  const channel = scenario.inputs?.private_report;
  return channel !== undefined && isIssueChannel(channel);
}

/**
 * Mirrors the action's delivery rule: deliver only when PROVEN private or internal. Report traffic to any slug this
 * rejects (public, non-redacted, the admin repo, or unprovable) falls through to section matching, where the issue
 * routes hit a loud no-route violation and a marker POST hits the labels.create barrier and gating.
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

/** Only the marker label carries its configured color: the report path is the one that materializes label objects on issues. */
function labelObject(name: string): Json {
  return {
    name,
    color: name === MARKER_LABEL ? MARKER_LABEL_CONFIG.color : "ededed",
    default: false,
  };
}

/** Checked before the fault hook, matching the section pipeline: a fault must never mask an unknown target. */
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
 * One branch per marker. The `?: never` exclusions make a two-marker literal fail to compile, where the excess-property
 * check would otherwise accept it and the consumer's first truthiness check silently win; consumers test truthiness
 * because `in` cannot narrow an optional property away.
 *   faulted   -> a transport fault, passed through verbatim
 *   coreKey   -> a handler response, tagged so the chaos hook can corrupt it
 *   deniedBy  -> a permission denial, never corrupted
 *   violation -> a contract violation, never corrupted
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
 * Null when the path is not an issue-channel route, so the caller falls through to section matching. `takeCoreFault` is
 * consulted per route after target resolution and before the permission gate and any state mutation, the section order.
 *   GET   /user                            -> the token user (ungated)
 *   POST  /repos/{o}/{r}/labels (marker)   -> ensure-create (Issues: write)
 *   GET   /repos/{o}/{r}/issues            -> list (Issues: read)
 *   POST  /repos/{o}/{r}/issues            -> create (Issues: write)
 *   PATCH /repos/{o}/{r}/issues/{number}   -> update (Issues: write)
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
  // GET /user is report traffic only when the run enables an issue channel; otherwise it falls through to a loud
  // no-route violation.
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
  // The marker-label ensure-create writes even in check mode, so it is served here, before the check-mode barrier, but
  // only for the marker name on a delivery target; any other marker POST falls through to the labels.create section
  // route and its barrier.
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
  // Issue traffic to a non-delivery slug (an accidental delivery) falls through to a loud no-route violation.
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
    // The marker-reattach PATCH sends label names; expanded as on create, so the repaired label set is observable.
    if (Array.isArray(payload.labels)) {
      issue.labels = payload.labels.map((l) => labelObject(String(l)));
    }
    return { response: ok(issue), coreKey: "core.issuePatch" };
  }
  return coreViolation(`unexpected ${method} on ${pathname}`);
}

/**
 * Wire attempts the probe can make, from the client's own MAX_RETRIES. Once a slug's repository.get has faulted this many
 * times the probe has given up, so the next repository.get is not a probe retry and the exemption expires.
 */
export const PROBE_RETRY_BUDGET = 1 + MAX_RETRIES;

/**
 * When no probe is expected, the first repository.get is not the probe and MUST arm the barrier when denied. The action
 * probes a slug's visibility (one repository.get, outside the section loop) only when all hold:
 *   multi-repo run                            (the single-repo harness targets the admin repo, never probed)
 *   policy is redact                          (`show` never probes)
 *   not the admin repo                        (the self carve-out)
 *   not discovered via /user/repos this run   (a discovered slug's visibility is already known)
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

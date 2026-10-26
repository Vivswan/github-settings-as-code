/**
 * The mock GitHub server's request pipeline, pure over a MockState and a Scenario; server.ts is the transport shell.
 * The route table is derived from allEndpoints(), never hand-written; the handlers live one layer down, per
 * "section.role" key in the section fragments (sections.ts) and the core-path handlers (core-paths.ts).
 *
 * The stage order is the contract, the same on both wires:
 *   wire checks -> route match -> check-mode barrier -> target resolution -> fault barrier -> permission gate
 *     -> denial barrier -> body allowlist -> handler -> response guard -> chaos hook
 */

import { isPlainObject } from "../../../src/plain-data.js";
import type { SectionKey } from "../../../src/schema.js";
import { endpointPath, toleratedStatuses } from "../../../src/sections/contract/endpoints.js";
import { toleratedGraphqlErrors } from "../../../src/sections/contract/graphql.js";
import { denialPosture, endpointPermission } from "../../../src/sections/contract/operations.js";
import {
  allGraphqlOps,
  type TaggedEndpoint,
  type TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import type { PermissionMask } from "../scenario.js";
import { applyFault, type CoreFaultKey, takeCorruption, takeFault } from "./chaos.js";
import {
  type LoggedRequest,
  type PipelineOptions,
  type PipelineResult,
  renderRequest,
  violationFor,
} from "./contract.js";
import {
  contentsResponse,
  contentsSlug,
  gitRefRequest,
  gitRefResponse,
  handleIssueReport,
  handleUserRepos,
  PROBE_RETRY_BUDGET,
  probeExpected,
  RAW_CONTENTS_ACCEPT,
} from "./core-paths.js";
import {
  declaredStatuses,
  graphqlOpForBody,
  matchEndpoint,
  paramAccessor,
  requestHeaders,
  slugFromPath,
  statusAllowed,
} from "./dispatch.js";
import {
  denialResponse,
  effectiveMask,
  endpointRequirement,
  gradeRequirement,
  gradeResource,
  graphqlDenialErrors,
  type Requirement,
  SECTION_BY_KEY,
} from "./grading.js";
import { GRAPHQL_HANDLERS, HANDLERS } from "./handlers.js";
import { decodeNodeId, type NodeFamily } from "./node-id.js";
import { acceptedBody } from "./request-body.js";
import type { MockState, MultiMockState } from "./state.js";
import {
  asObject,
  type GraphqlErrorReply,
  type GraphqlHandler,
  type GraphqlHandlerResult,
  type Json,
  type MockResponse,
} from "./support.js";

/** Families carrying the GLOBAL_NODE_SLUG sentinel instead of a repository, so target resolution must not read a slug off them; apps are the one case (a force-push allowance can name a GitHub App, whose id comes from GET /apps/{app_slug}). */
const GLOBAL_NODE_FAMILIES: ReadonlySet<NodeFamily> = new Set(["app"]);

/** The request as server.ts hands it over: the path and query still raw, the base prefix still on. */
interface RawRequest {
  method: string;
  rawPath: string;
  query: Record<string, string>;
  rawQuery: string;
  headers: Headers;
  body: unknown;
}

/** The request past the wire checks, its path stripped of the base prefix. */
interface PipelineRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
}

/** One request's run through the stages: the options, the multi-repo state when there is one, and the base log every stage spells its entry from. */
interface Run {
  options: PipelineOptions;
  multi: MultiMockState | undefined;
  baseLog: LoggedRequest;
}

/** Where a request lands: the state it reaches, the mask it is graded against, and the slug the denial barrier keys on ("" in single-repo mode). */
interface Target {
  state: MockState;
  mask: PermissionMask;
  targetSlug: string;
}

type MatchedEndpoint = NonNullable<ReturnType<typeof matchEndpoint>>;

/** GraphQL mutations nest their target ids under input objects, so a top-level scan would miss them. */
function decodedNodeIds(value: unknown, out: Array<{ slug: string }>): void {
  if (typeof value === "string") {
    const decoded = decodeNodeId(value);
    if (decoded && !GLOBAL_NODE_FAMILIES.has(decoded.family)) {
      out.push(decoded);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      decodedNodeIds(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      decodedNodeIds(item, out);
    }
  }
}

/** The ONE write-to-slug derivation; a violation, never a guess, keeps per-slug masks and state routing exact. */
function resolveMutationTarget(
  opName: string,
  variables: Json,
): { slug: string } | { violation: string } {
  const decoded: Array<{ slug: string }> = [];
  decodedNodeIds(variables, decoded);
  const slugs = [...new Set(decoded.map((id) => id.slug))];
  const first = slugs[0];
  if (first === undefined) {
    return {
      violation: `GraphQL mutation ${opName} carries no decodable mock node id; mutations must address their target through node ids the mock minted`,
    };
  }
  if (slugs.length > 1) {
    return {
      violation: `GraphQL mutation ${opName} carries node ids of several repositories [${slugs.sort().join(", ")}]; one mutation must address one target`,
    };
  }
  return { slug: first };
}

/** A read addresses its target by the $owner/$repo variables the declaration contract requires. */
function resolveReadTarget(
  opName: string,
  variables: Json,
): { slug: string } | { violation: string } {
  const { owner, repo } = variables as { owner?: unknown; repo?: unknown };
  if (typeof owner !== "string" || typeof repo !== "string") {
    return {
      violation: `GraphQL read ${opName} carries no $owner/$repo variables to resolve its target slug`,
    };
  }
  return { slug: `${owner}/${repo}` };
}

/**
 * Target resolution, where the GraphQL leg differs from REST: the path carries no slug.
 *   read     -> the $owner/$repo variables the declaration contract requires
 *   mutation -> the self-describing node ids the mock minted (state.ts); no decodable id is a violation, never a guess
 * A mutation resolves its target in single-repo mode too: a garbage or foreign id must not look green until a multi
 * scenario runs it.
 */
function resolveGraphqlTarget(
  op: TaggedGraphqlOp,
  variables: Json,
  options: PipelineOptions,
): Target | { violation: string } {
  const { scenario, working } = options;
  const target = op.kind === "write" ? resolveMutationTarget(op.name, variables) : null;
  if (target !== null && "violation" in target) {
    return target;
  }

  if (working.mode === "single") {
    if (target !== null && target.slug !== working.state.slug) {
      return {
        violation: `GraphQL mutation ${op.name} carries node ids of "${target.slug}", but this single-repo run serves only "${working.state.slug}"`,
      };
    }
    return { state: working.state, mask: scenario.token_permissions ?? {}, targetSlug: "" };
  }

  const addressed = target ?? resolveReadTarget(op.name, variables);
  if ("violation" in addressed) {
    return addressed;
  }
  const state = working.multi.repos.get(addressed.slug);
  if (!state) {
    return { violation: `GraphQL ${op.name} names no known target slug ("${addressed.slug}")` };
  }
  return {
    state,
    mask: effectiveMask(
      scenario.token_permissions ?? {},
      working.multi.permissions.get(addressed.slug),
    ),
    targetSlug: addressed.slug,
  };
}

/**
 * The denial barrier's shared half for both wires. The `arms` predicate stays at each call site on purpose: tolerated
 * outcomes differ by wire (status subsets vs error types), and the visibility-probe exemption is REST-only.
 */
function denialBarrier(
  options: PipelineOptions,
  log: LoggedRequest,
  section: SectionKey,
  targetSlug: string,
  kind: "read" | "write",
  arms: boolean,
): string | undefined {
  const barrierKey = `${targetSlug}:${section}`;
  if (kind === "read") {
    if (arms) {
      options.deniedReadSections.add(barrierKey);
    }
    return undefined;
  }
  if (!options.deniedReadSections.has(barrierKey)) {
    return undefined;
  }
  const module = SECTION_BY_KEY.get(section);
  const posture = module === undefined ? "(unregistered)" : denialPosture(module);
  return (
    `write to ${renderRequest(log, false)} reached the server after a fatal denied read in the ` +
    `same target+section; the engine's section loop should have aborted at that read (section ` +
    `"${section}" has the "${posture}" 404 posture, style ` +
    `${String(options.scenario.denial_style)})`
  );
}

/** The wire checks and the dispatch: the declared operation the body names, or the violation to answer. */
function parseGraphqlRequest(
  request: { method: string; body: unknown },
  ops: Readonly<Record<string, TaggedGraphqlOp>>,
  violation: (message: string) => PipelineResult,
): { key: string; op: TaggedGraphqlOp; variables: Json } | PipelineResult {
  if (request.method !== "POST") {
    return violation(`GraphQL requests must be POST, got ${request.method}`);
  }
  const body = asObject(request.body);
  if (
    typeof body.query !== "string" ||
    typeof body.operationName !== "string" ||
    !isPlainObject(body.variables)
  ) {
    return violation(
      "GraphQL request body must carry query (string), operationName (string), and variables (object)",
    );
  }
  const dispatched = graphqlOpForBody(body, ops);
  if (!dispatched) {
    return violation(
      `no GraphQL operation named "${String(body.operationName)}" is declared by any section`,
    );
  }
  return { key: dispatched.key, op: dispatched.op, variables: body.variables };
}

/**
 * The permission gate. A GraphQL denial is HTTP 200 on the real wire, with data:null and typed errors[]. A denied read
 * whose error type the operation tolerates reads as "resource absent" and must not arm (the toleratedStatuses mirror);
 * advisory reads are exempt as on REST.
 */
function graphqlDenial(
  op: TaggedGraphqlOp,
  requirement: Requirement,
  target: Target,
  options: PipelineOptions,
  log: LoggedRequest,
): PipelineResult | null {
  const grading = gradeRequirement(target.mask, requirement);
  if (grading.allowed) {
    return null;
  }
  const errors = graphqlDenialErrors(options.scenario.denial_style, op.kind);
  const response: MockResponse = { status: 200, body: { data: null, errors } };
  const denied: LoggedRequest = { ...log, status: 200, deniedBy: grading.deniedBy };
  const arms =
    op.kind === "read" &&
    op.advisory !== true &&
    !toleratedGraphqlErrors(op).includes((errors[0] as GraphqlErrorReply).type);
  const barrierViolation = denialBarrier(
    options,
    denied,
    op.section,
    target.targetSlug,
    op.kind,
    arms,
  );
  return { response, log: denied, violation: barrierViolation };
}

/** Response guard, the status-subset analog: an undeclared error type is a mock design bug, not a scenario outcome. */
function graphqlResponse(
  key: string,
  op: TaggedGraphqlOp,
  result: GraphqlHandlerResult,
): MockResponse | { violation: string } {
  if (result.errors === undefined) {
    return { status: 200, body: { data: result.data } };
  }
  const declared = toleratedGraphqlErrors(op);
  const undeclared = result.errors.filter((entry) => !declared.includes(entry.type));
  if (undeclared.length > 0) {
    return {
      violation: `GraphQL handler "${key}" answered undeclared error type(s) [${undeclared.map((e) => `${e.type}: "${e.message}"`).join(", ")}]; the operation declares only [${declared.join(", ")}] as tolerated outcomes`,
    };
  }
  return { status: 200, body: { data: null, errors: result.errors } };
}

/**
 * The GraphQL leg of the pipeline, in the REST stage order. `ops`/`handlers` are injectable for direct testing;
 * production takes the declared tables.
 */
export function handleGraphqlRequest(
  request: { method: string; body: unknown },
  options: PipelineOptions,
  baseLog: LoggedRequest,
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): PipelineResult {
  const violation = violationFor(baseLog);
  const parsed = parseGraphqlRequest(request, ops, violation);
  if (!("op" in parsed)) {
    return parsed;
  }
  const { key, op, variables } = parsed;
  const graphqlLog: LoggedRequest = {
    ...baseLog,
    graphql: { operationName: op.name, kind: op.kind },
  };

  // Check-mode barrier before the fault barrier: a synthetic fault must not mask the one bug this barrier exists to catch.
  if (options.checkMode && op.kind !== "read") {
    return violationFor(graphqlLog)(`GraphQL write in check mode (${op.name})`);
  }
  if (options.checkMode && op.phase === "execution") {
    return violationFor(graphqlLog)(`GraphQL execution-phase read in check mode (${op.name})`);
  }

  // Target resolution before the fault barrier, so a fault never masks an unknown-target violation.
  const target = resolveGraphqlTarget(op, variables, options);
  if ("violation" in target) {
    return violation(target.violation);
  }

  // Faults address GraphQL operations by the same "section.role" key as REST (assertFaultKeys unions the two).
  const taken = takeFault(key, options);
  if (taken) {
    return applyFault(taken.kind, { ...graphqlLog }, taken.fired);
  }

  const section = SECTION_BY_KEY.get(op.section);
  if (!section) {
    return violation(`BUG: no section module registered for key "${op.section}"`);
  }
  const requirement: Requirement = { permission: endpointPermission(section, op), kind: op.kind };
  const denied = graphqlDenial(op, requirement, target, options, graphqlLog);
  if (denied) {
    return denied;
  }

  const handler = handlers[key];
  if (!handler) {
    // Unreachable after assertGraphqlHandlerCompleteness at construction; loud rather than a silent undefined call.
    return violation(`no GraphQL handler registered for dispatched operation "${key}"`);
  }
  const response = graphqlResponse(key, op, handler({ state: target.state, op, variables }));
  if ("violation" in response) {
    return violation(response.violation);
  }

  const corrupted = takeCorruption(key, options, response, graphqlLog);
  if (corrupted) {
    return corrupted;
  }

  return { response, log: { ...graphqlLog, status: 200 } };
}

/** One core-fault hook, so every core handler consumes the same per-run counts as the section fault barrier. */
function takeCoreFault(coreKey: CoreFaultKey, run: Run): PipelineResult | null {
  const taken = takeFault(coreKey, run.options);
  return taken ? applyFault(taken.kind, { ...run.baseLog }, taken.fired) : null;
}

/**
 * /user/repos is a user-level call, not per-slug gated, so it is served before route matching; its hooks fire only on
 * a legit request, never masking a violation.
 */
function serveUserRepos(request: PipelineRequest, run: Run): PipelineResult | null {
  const userRepos = handleUserRepos(request.method, request.pathname, request.query, run.multi);
  if (!userRepos) {
    return null;
  }
  if (!userRepos.violation) {
    const faulted = takeCoreFault("core.discoveryList", run);
    if (faulted) {
      return faulted;
    }
    const corrupted = takeCorruption(
      "core.discoveryList",
      run.options,
      userRepos.response,
      run.baseLog,
    );
    if (corrupted) {
      return corrupted;
    }
  }
  return {
    response: userRepos.response,
    log: { ...run.baseLog, status: userRepos.response.status },
    violation: userRepos.violation,
  };
}

/**
 * The settings-file fetch and the git ref read are both Contents-gated reads: a Contents-denied slug gets the read
 * denial, which drives the action's 404 disambiguation and its "grant Contents: read" advice.
 */
function contentsDenial(slug: string, multi: MultiMockState, run: Run): PipelineResult | null {
  const { scenario } = run.options;
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi.permissions.get(slug));
  const grading = gradeResource(mask, "contents", "read");
  if (grading.allowed) {
    return null;
  }
  const response = denialResponse(scenario.denial_style, "read");
  return {
    response,
    log: { ...run.baseLog, status: response.status, deniedBy: grading.deniedBy },
  };
}

/**
 * The settings-file fetch. Target before fault hook: an unknown slug must never steal a fault injected for the
 * legitimate target. A known target's fault fires before the permission gate (a wire failure ignores permissions) and
 * after the wire violations.
 */
function serveContents(request: PipelineRequest, run: Run): PipelineResult | null {
  const slug = contentsSlug(request.pathname);
  if (slug === null) {
    return null;
  }
  const { multi, baseLog } = run;
  const violation = violationFor(baseLog);
  if (!multi) {
    return violation("settings-file fetch (contents) is not implemented in single-repo mode");
  }
  if (request.method !== "GET") {
    return violation(`contents fetch must be GET, got ${request.method}`);
  }
  if (request.headers.get("accept") !== RAW_CONTENTS_ACCEPT) {
    return violation(
      `contents fetch must send Accept: ${RAW_CONTENTS_ACCEPT}, got "${request.headers.get("accept") ?? ""}"`,
    );
  }

  const knownTarget = multi.repos.has(slug);
  if (knownTarget) {
    const contentsFault = takeCoreFault("core.contentsGet", run);
    if (contentsFault) {
      return contentsFault;
    }
  }
  const denied = contentsDenial(slug, multi, run);
  if (denied) {
    return denied;
  }

  const response = contentsResponse(multi, slug);
  if (knownTarget) {
    const corrupted = takeCorruption("core.contentsGet", run.options, response, baseLog);
    if (corrupted) {
      return corrupted;
    }
  }
  // The raw body's validation skip is decided by the request's Accept media type in server.ts, not marked here.
  return { response, log: { ...baseLog, status: response.status } };
}

/**
 * The git ref read proves Contents readable after a contents 404; gated on the same grade, so a Contents-denied slug
 * is never mistaken for a fileless one.
 */
function serveGitRef(request: PipelineRequest, run: Run): PipelineResult | null {
  const refRequest = gitRefRequest(request.pathname);
  if (refRequest === null) {
    return null;
  }
  const { multi, baseLog } = run;
  const violation = violationFor(baseLog);
  if (!multi) {
    return violation("git ref read is not implemented in single-repo mode");
  }
  if (request.method !== "GET") {
    return violation(`git ref read must be GET, got ${request.method}`);
  }
  const denied = contentsDenial(refRequest.slug, multi, run);
  if (denied) {
    return denied;
  }
  const response = gitRefResponse(multi, refRequest.slug, refRequest.ref);
  return { response, log: { ...baseLog, status: response.status } };
}

/** Report delivery writes even in check mode, so the issue channel is served before the check-mode barrier. */
function serveIssueReport(request: PipelineRequest, run: Run): PipelineResult | null {
  const { options, multi, baseLog } = run;
  const issueReport = handleIssueReport(request, {
    scenario: options.scenario,
    multi,
    state: options.working.mode === "single" ? options.working.state : undefined,
    faults: options.faults,
    takeCoreFault: (key) => takeCoreFault(key, run),
  });
  if (!issueReport) {
    return null;
  }
  if (issueReport.faulted) {
    return issueReport.faulted;
  }
  if (issueReport.coreKey) {
    const corrupted = takeCorruption(issueReport.coreKey, options, issueReport.response, baseLog);
    if (corrupted) {
      return corrupted;
    }
  }
  return {
    response: issueReport.response,
    log: {
      ...baseLog,
      status: issueReport.response.status,
      ...(issueReport.deniedBy ? { deniedBy: issueReport.deniedBy } : {}),
    },
    ...(issueReport.violation ? { violation: issueReport.violation } : {}),
  };
}

/** The core paths served before section matching, each answering null for a path that is not its own. */
function serveCoreRoute(request: PipelineRequest, run: Run): PipelineResult | null {
  return (
    serveUserRepos(request, run) ??
    serveContents(request, run) ??
    serveGitRef(request, run) ??
    serveIssueReport(request, run)
  );
}

/**
 * Multi-repo routing follows the endpoint's scope; only the bare org probe grades against the global mask alone.
 *   /repos/... endpoint                          -> the slug's MockState, its per-slug mask over the global mask
 *   bare org probe (/orgs/{org})                 -> the shared org state, the global mask
 *   /orgs/{org}/teams/.../repos/{owner}/{repo}   -> the addressed slug's state (the tail names it), the hybrid mask
 * The hybrid mask matches the oracle's orgMask model: GitHub grants administration per ADDRESSED repo (adding a repo
 * to a team needs admin on that repo) while org_members is org-wide.
 */
function resolveRestTarget(
  request: PipelineRequest,
  endpoint: TaggedEndpoint,
  options: PipelineOptions,
): Target | { violation: string } {
  const { scenario, working } = options;
  const global = scenario.token_permissions ?? {};
  if (working.mode === "single") {
    return { state: working.state, mask: global, targetSlug: "" };
  }

  const unknownTarget = `multi-repo request ${request.method} ${request.pathname} names no known target slug`;
  const repoScoped = endpointPath(endpoint.route).startsWith("/repos/");
  const slug = slugFromPath(request.pathname);
  const repoState = slug ? working.multi.repos.get(slug) : undefined;
  if (repoScoped) {
    if (!slug || !repoState) {
      return { violation: unknownTarget };
    }
    return {
      state: repoState,
      mask: effectiveMask(global, working.multi.permissions.get(slug)),
      targetSlug: slug,
    };
  }

  // A team-repo tail naming an unknown slug is a violation: falling back to orgState would let a buggy write
  // silently mutate shared org state.
  if (slug && !repoState) {
    return { violation: unknownTarget };
  }
  if (!slug) {
    return { state: working.multi.orgState, mask: global, targetSlug: "" };
  }
  return {
    state: repoState ?? working.multi.orgState,
    mask: {
      ...effectiveMask(global, working.multi.permissions.get(slug)),
      org_members: global.org_members,
    },
    targetSlug: slug,
  };
}

/**
 * Fault barrier after target resolution (a fault never masks the unknown-target violation) and before the permission
 * gate (a wire failure happens regardless of permissions). A faulted probe attempt spends its retry budget, so the
 * exemption cannot outlast the probe's own retries.
 */
function restFault(key: string, targetSlug: string, run: Run): PipelineResult | null {
  const { options, baseLog } = run;
  const taken = takeFault(key, options);
  if (!taken) {
    return null;
  }
  if (key === "repository.get") {
    options.probeGetFaults.set(targetSlug, (options.probeGetFaults.get(targetSlug) ?? 0) + 1);
  }
  return applyFault(taken.kind, { ...baseLog }, taken.fired);
}

/**
 * The permission gate. The visibility probe's denial must not arm the repository-section barrier: decided against the
 * pre-delivery state, then the delivery is recorded so any later repository.get for the slug is not the probe. A read
 * arms the denial barrier only when the engine itself sees it fail.
 */
function restDenial(
  matched: MatchedEndpoint,
  requirement: Requirement,
  target: Target,
  run: Run,
): PipelineResult | null {
  const { key, endpoint } = matched;
  const { options, multi, baseLog } = run;
  const { scenario } = options;
  const isVisibilityProbe =
    key === "repository.get" &&
    probeExpected(target.targetSlug, scenario, multi) &&
    !options.probeGetDelivered.has(target.targetSlug) &&
    (options.probeGetFaults.get(target.targetSlug) ?? 0) < PROBE_RETRY_BUDGET;
  if (key === "repository.get") {
    options.probeGetDelivered.add(target.targetSlug);
  }

  const grading = gradeRequirement(target.mask, requirement);
  if (grading.allowed) {
    return null;
  }
  const response = denialResponse(scenario.denial_style, requirement.kind);
  const log: LoggedRequest = { ...baseLog, status: response.status, deniedBy: grading.deniedBy };
  const arms =
    requirement.kind === "read" &&
    !isVisibilityProbe &&
    endpoint.advisory !== true &&
    !toleratedStatuses(endpoint).includes(response.status);
  const barrierViolation = denialBarrier(
    options,
    baseLog,
    endpoint.section,
    target.targetSlug,
    requirement.kind,
    arms,
  );
  return { response, log, violation: barrierViolation };
}

/**
 * Body allowlist, handler, response guard, chaos hook. The handler sees only what GitHub keeps of the body
 * (request-body.ts): an undocumented key is dropped on an open body and is the 422 on a closed one, so no handler can
 * echo a key GitHub never stores. The response guard runs before the chaos hook, which deliberately goes
 * off-contract, so statusAllowed holds on every request, not only the ones a curated test drives.
 */
function answerSectionRequest(
  request: PipelineRequest,
  matched: MatchedEndpoint,
  requirement: Requirement,
  target: Target,
  run: Run,
): PipelineResult {
  const { key, endpoint } = matched;
  const { options, baseLog } = run;
  const violation = violationFor(baseLog);
  const handler = HANDLERS[key];
  if (!handler) {
    // Unreachable after assertHandlerCompleteness at construction; loud rather than a silent undefined call.
    return violation(`no handler registered for matched endpoint "${key}"`);
  }

  const accepted = acceptedBody(endpoint.route, request.body);
  const response =
    "rejected" in accepted
      ? accepted.rejected
      : handler({
          state: target.state,
          endpoint,
          param: paramAccessor(key, endpoint, matched.params),
          query: request.query,
          body: accepted.body,
          headers: requestHeaders(request.headers),
          grants: (kind) =>
            gradeRequirement(target.mask, { permission: requirement.permission, kind }).allowed,
        });
  if (!statusAllowed(key, response.status)) {
    return violation(
      `handler "${key}" returned status ${response.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error`,
    );
  }

  const corrupted = takeCorruption(key, options, response, baseLog);
  if (corrupted) {
    return corrupted;
  }

  return {
    response,
    log: {
      ...baseLog,
      status: response.status,
      ...(response.requestOffSpec ? { requestOffSpec: true } : {}),
    },
  };
}

/** The section leg: route match, the check-mode barrier, target resolution, the fault barrier, the permission gate, then the handler. */
function serveSectionRequest(request: PipelineRequest, run: Run): PipelineResult {
  const { options, baseLog } = run;
  const violation = violationFor(baseLog);
  const matched = matchEndpoint(request.method, request.pathname);
  if (!matched) {
    return violation(`no route in routes.ts for ${request.method} ${request.pathname}`);
  }
  const { key, endpoint } = matched;

  // Check-mode barrier before the fault barrier: a write in check mode is the one bug this barrier exists to catch, and
  // a synthetic fault must not mask it.
  if (options.checkMode && request.method !== "GET") {
    return violation(
      `write in check mode: ${request.method} ${request.pathname} (endpoint "${key}")`,
    );
  }
  // Check mode runs no execution thunk, so an execution-phase read arriving here came from a plan() body.
  if (options.checkMode && endpoint.phase === "execution") {
    return violation(
      `execution-phase read in check mode: GET ${request.pathname} (endpoint "${key}")`,
    );
  }

  const target = resolveRestTarget(request, endpoint, options);
  if ("violation" in target) {
    return violation(target.violation);
  }

  const faulted = restFault(key, target.targetSlug, run);
  if (faulted) {
    return faulted;
  }

  const requirement = endpointRequirement(endpoint);
  const denied = restDenial(matched, requirement, target, run);
  if (denied) {
    return denied;
  }

  return answerSectionRequest(request, matched, requirement, target, run);
}

/**
 * The wire checks every request clears first, and the base prefix stripped off its path; the log spells the stripped
 * path even when the prefix check fails, so the violation names the request as the runner reads it.
 */
function admitRequest(
  raw: RawRequest,
  options: PipelineOptions,
): { request: PipelineRequest; run: Run } | PipelineResult {
  const stripped =
    options.basePrefix && raw.rawPath.startsWith(options.basePrefix)
      ? raw.rawPath.slice(options.basePrefix.length) || "/"
      : raw.rawPath;
  const baseLog: LoggedRequest = {
    method: raw.method,
    pathname: stripped,
    query: raw.rawQuery,
    body: raw.body,
    status: 0,
  };
  const violation = violationFor(baseLog);

  if (!raw.headers.get("authorization")) {
    return violation(`request ${raw.method} ${stripped} is missing the Authorization header`);
  }
  if (!raw.headers.get("x-github-api-version")) {
    return violation(
      `request ${raw.method} ${stripped} is missing the x-github-api-version header`,
    );
  }
  if (options.basePrefix && !raw.rawPath.startsWith(options.basePrefix)) {
    return violation(
      `request path "${raw.rawPath}" is missing the required base prefix "${options.basePrefix}"`,
    );
  }

  const { working } = options;
  return {
    request: {
      method: raw.method,
      pathname: stripped,
      query: raw.query,
      headers: raw.headers,
      body: raw.body,
    },
    run: { options, multi: working.mode === "multi" ? working.multi : undefined, baseLog },
  };
}

/** Run the pipeline for one parsed request. Appends nothing to the logs itself: the caller owns the arrays. */
export function runPipeline(raw: RawRequest, options: PipelineOptions): PipelineResult {
  const admitted = admitRequest(raw, options);
  if ("response" in admitted) {
    return admitted;
  }
  const { request, run } = admitted;

  const core = serveCoreRoute(request, run);
  if (core) {
    return core;
  }
  if (request.pathname === "/graphql") {
    return handleGraphqlRequest(
      { method: request.method, body: request.body },
      options,
      run.baseLog,
    );
  }
  return serveSectionRequest(request, run);
}

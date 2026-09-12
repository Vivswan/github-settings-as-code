/**
 * The mock GitHub server's request pipeline, pure over a MockState and a Scenario; server.ts is the transport shell.
 * The route table is derived from allEndpoints(), never hand-written; the handlers live one layer down, per
 * "section.role" key in the section fragments (sections.ts) and the core-path handlers (core-paths.ts).
 *
 * The stage order is the contract, the same on both wires:
 *   wire checks -> route match -> check-mode barrier -> target resolution -> fault barrier -> permission gate
 *     -> denial barrier -> handler -> response guard -> chaos hook
 */

import type { SectionKey } from "../../../src/schema.js";
import { endpointPath, toleratedStatuses } from "../../../src/sections/contract/endpoints.js";
import { toleratedGraphqlErrors } from "../../../src/sections/contract/graphql.js";
import { denialPosture, endpointPermission } from "../../../src/sections/contract/module.js";
import { allGraphqlOps, type TaggedGraphqlOp } from "../../../src/sections/registry.js";
import type { PermissionMask } from "../schema.js";
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
import type { MockState } from "./state.js";
import {
  asObject,
  type GraphqlErrorReply,
  type GraphqlHandler,
  type Json,
  type MockResponse,
} from "./support.js";

/**
 * Global families carry the GLOBAL_NODE_SLUG sentinel instead of a repository, so target resolution must not read a slug
 * off them. Apps are the one case: a force-push allowance can name a GitHub App, whose id comes from GET /apps/{app_slug}.
 */
const GLOBAL_NODE_FAMILIES: ReadonlySet<NodeFamily> = new Set(["app"]);

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

/**
 * The GraphQL leg of the pipeline, in the REST stage order. Target resolution is where it differs: the path carries no slug.
 *   read     -> the $owner/$repo variables the declaration contract requires
 *   mutation -> the self-describing node ids the mock minted (state.ts); no decodable id is a violation, never a guess
 *
 * `ops`/`handlers` are injectable for direct testing; production takes the declared tables.
 */
export function handleGraphqlRequest(
  request: { method: string; body: unknown },
  options: PipelineOptions,
  baseLog: LoggedRequest,
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): PipelineResult {
  const { scenario, working } = options;
  const violation = violationFor(baseLog);

  if (request.method !== "POST") {
    return violation(`GraphQL requests must be POST, got ${request.method}`);
  }
  const body = asObject(request.body);
  if (
    typeof body.query !== "string" ||
    typeof body.operationName !== "string" ||
    typeof body.variables !== "object" ||
    body.variables === null ||
    Array.isArray(body.variables)
  ) {
    return violation(
      "GraphQL request body must carry query (string), operationName (string), and variables (object)",
    );
  }
  const variables = body.variables as Json;

  const dispatched = graphqlOpForBody(body, ops);
  if (!dispatched) {
    return violation(
      `no GraphQL operation named "${String(body.operationName)}" is declared by any section`,
    );
  }
  const { key, op } = dispatched;
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

  // Target resolution before the fault barrier, so a fault never masks an unknown-target violation. A mutation resolves
  // its target in single-repo mode too: a garbage or foreign id must not look green until a multi scenario runs it.
  const target = op.kind === "write" ? resolveMutationTarget(op.name, variables) : null;
  if (target !== null && "violation" in target) {
    return violation(target.violation);
  }
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  let targetSlug = "";
  if (working.mode === "single") {
    state = working.state;
    if (target !== null && target.slug !== state.slug) {
      return violation(
        `GraphQL mutation ${op.name} carries node ids of "${target.slug}", but this single-repo run serves only "${state.slug}"`,
      );
    }
  } else {
    let slug: string;
    if (target !== null) {
      slug = target.slug;
    } else {
      const { owner, repo } = variables as { owner?: unknown; repo?: unknown };
      if (typeof owner !== "string" || typeof repo !== "string") {
        return violation(
          `GraphQL read ${op.name} carries no $owner/$repo variables to resolve its target slug`,
        );
      }
      slug = `${owner}/${repo}`;
    }
    const repoState = working.multi.repos.get(slug);
    if (!repoState) {
      return violation(`GraphQL ${op.name} names no known target slug ("${slug}")`);
    }
    state = repoState;
    mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
    targetSlug = slug;
  }

  // Faults address GraphQL operations by the same "section.role" key as REST (assertFaultKeys unions the two).
  const taken = takeFault(key, options);
  if (taken) {
    return applyFault(taken.kind, { ...graphqlLog }, taken.fired);
  }

  // A GraphQL denial is HTTP 200 on the real wire, with data:null and typed errors[].
  const section = SECTION_BY_KEY.get(op.section);
  if (!section) {
    return violation(`BUG: no section module registered for key "${op.section}"`);
  }
  const requirement: Requirement = {
    permission: endpointPermission(section, op),
    kind: op.kind,
  };
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const errors = graphqlDenialErrors(scenario.denial_style, op.kind);
    const response: MockResponse = { status: 200, body: { data: null, errors } };
    const log: LoggedRequest = { ...graphqlLog, status: 200, deniedBy: grading.deniedBy };
    // A denied read whose error type the operation tolerates reads as "resource absent" and must not arm (the
    // toleratedStatuses mirror); advisory reads are exempt as on REST.
    const arms =
      op.kind === "read" &&
      op.advisory !== true &&
      !toleratedGraphqlErrors(op).includes((errors[0] as GraphqlErrorReply).type);
    const barrierViolation = denialBarrier(options, log, op.section, targetSlug, op.kind, arms);
    return { response, log, violation: barrierViolation };
  }

  const handler = handlers[key];
  if (!handler) {
    // Unreachable after assertGraphqlHandlerCompleteness at construction; loud rather than a silent undefined call.
    return violation(`no GraphQL handler registered for dispatched operation "${key}"`);
  }
  const result = handler({ state, op, variables });

  // Response guard, the status-subset analog: an undeclared error type is a mock design bug, not a scenario outcome.
  if (result.errors !== undefined) {
    const declared = toleratedGraphqlErrors(op);
    const undeclared = result.errors.filter((entry) => !declared.includes(entry.type));
    if (undeclared.length > 0) {
      return violation(
        `GraphQL handler "${key}" answered undeclared error type(s) [${undeclared.map((e) => `${e.type}: "${e.message}"`).join(", ")}]; the operation declares only [${declared.join(", ")}] as tolerated outcomes`,
      );
    }
  }
  const response: MockResponse = {
    status: 200,
    body:
      result.errors !== undefined ? { data: null, errors: result.errors } : { data: result.data },
  };

  const corrupted = takeCorruption(key, options, response, graphqlLog);
  if (corrupted) {
    return corrupted;
  }

  return { response, log: { ...graphqlLog, status: 200 } };
}

/** Run the pipeline for one parsed request. Appends nothing to the logs itself: the caller owns the arrays. */
export function runPipeline(
  request: {
    method: string;
    rawPath: string;
    query: Record<string, string>;
    rawQuery: string;
    headers: Headers;
    body: unknown;
  },
  options: PipelineOptions,
): PipelineResult {
  const { scenario, working } = options;
  const multi = working.mode === "multi" ? working.multi : undefined;
  const singleState = working.mode === "single" ? working.state : undefined;
  const strippedForLog =
    options.basePrefix && request.rawPath.startsWith(options.basePrefix)
      ? request.rawPath.slice(options.basePrefix.length) || "/"
      : request.rawPath;
  const baseLog: LoggedRequest = {
    method: request.method,
    pathname: strippedForLog,
    query: request.rawQuery,
    body: request.body,
    status: 0,
  };
  const violation = violationFor(baseLog);

  if (!request.headers.get("authorization")) {
    return violation(
      `request ${request.method} ${strippedForLog} is missing the Authorization header`,
    );
  }
  if (!request.headers.get("x-github-api-version")) {
    return violation(
      `request ${request.method} ${strippedForLog} is missing the x-github-api-version header`,
    );
  }

  let pathname = request.rawPath;
  if (options.basePrefix) {
    if (!pathname.startsWith(options.basePrefix)) {
      return violation(
        `request path "${pathname}" is missing the required base prefix "${options.basePrefix}"`,
      );
    }
    pathname = pathname.slice(options.basePrefix.length) || "/";
  }

  // One core-fault hook, so every core handler consumes the same per-run counts as the section fault barrier.
  const takeCoreFault = (coreKey: CoreFaultKey): PipelineResult | null => {
    const taken = takeFault(coreKey, options);
    return taken ? applyFault(taken.kind, { ...baseLog }, taken.fired) : null;
  };

  // /user/repos is a user-level call, not per-slug gated, so it is served before route matching; its hooks fire only on
  // a legit request, never masking a violation.
  const userRepos = handleUserRepos(request.method, pathname, request.query, multi);
  if (userRepos) {
    if (!userRepos.violation) {
      const faulted = takeCoreFault("core.discoveryList");
      if (faulted) {
        return faulted;
      }
      const corrupted = takeCorruption("core.discoveryList", options, userRepos.response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    return {
      response: userRepos.response,
      log: { ...baseLog, status: userRepos.response.status },
      violation: userRepos.violation,
    };
  }

  // The settings-file fetch is gated like a section read: a Contents-denied slug gets the read denial, which drives the
  // action's 404 disambiguation and its "grant Contents: read" advice.
  const cSlug = contentsSlug(pathname);
  if (cSlug !== null) {
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
    // Target before fault hook: an unknown slug must never steal a fault injected for the legitimate target. A known
    // target's fault fires before the permission gate (a wire failure ignores permissions) and after the violations above.
    const knownTarget = multi.repos.has(cSlug);
    if (knownTarget) {
      const contentsFault = takeCoreFault("core.contentsGet");
      if (contentsFault) {
        return contentsFault;
      }
    }
    const mask = effectiveMask(scenario.token_permissions ?? {}, multi.permissions.get(cSlug));
    const grading = gradeResource(mask, "contents", "read");
    if (!grading.allowed) {
      const response = denialResponse(scenario.denial_style, "read");
      return { response, log: { ...baseLog, status: response.status, deniedBy: grading.deniedBy } };
    }
    const response = contentsResponse(multi, cSlug);
    if (knownTarget) {
      const corrupted = takeCorruption("core.contentsGet", options, response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    // The raw body's validation skip is decided by the request's Accept media type in server.ts, not marked here.
    return { response, log: { ...baseLog, status: response.status } };
  }

  // The git ref read proves Contents readable after a contents 404; gated on the same grade, so a Contents-denied slug
  // is never mistaken for a fileless one.
  const refRequest = gitRefRequest(pathname);
  if (refRequest !== null) {
    if (!multi) {
      return violation("git ref read is not implemented in single-repo mode");
    }
    if (request.method !== "GET") {
      return violation(`git ref read must be GET, got ${request.method}`);
    }
    const mask = effectiveMask(
      scenario.token_permissions ?? {},
      multi.permissions.get(refRequest.slug),
    );
    const grading = gradeResource(mask, "contents", "read");
    if (!grading.allowed) {
      const response = denialResponse(scenario.denial_style, "read");
      return { response, log: { ...baseLog, status: response.status, deniedBy: grading.deniedBy } };
    }
    const response = gitRefResponse(multi, refRequest.slug, refRequest.ref);
    return { response, log: { ...baseLog, status: response.status } };
  }

  // Report delivery writes even in check mode, so the issue channel is served before the check-mode barrier below.
  const issueReport = handleIssueReport(
    request.method,
    pathname,
    request.query,
    request.body,
    scenario,
    multi,
    singleState,
    options.faults,
    takeCoreFault,
  );
  if (issueReport) {
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

  if (pathname === "/graphql") {
    return handleGraphqlRequest({ method: request.method, body: request.body }, options, baseLog);
  }

  const matched = matchEndpoint(request.method, pathname);
  if (!matched) {
    return violation(`no route in routes.ts for ${request.method} ${pathname}`);
  }
  const { key, endpoint } = matched;

  // Check-mode barrier before the fault barrier: a write in check mode is the one bug this barrier exists to catch, and
  // a synthetic fault must not mask it.
  if (options.checkMode && request.method !== "GET") {
    return violation(`write in check mode: ${request.method} ${pathname} (endpoint "${key}")`);
  }
  // Check mode runs no execution thunk, so an execution-phase read arriving here came from a plan() body.
  if (options.checkMode && endpoint.phase === "execution") {
    return violation(`execution-phase read in check mode: GET ${pathname} (endpoint "${key}")`);
  }

  // Multi-repo routing follows the endpoint's scope; only the bare org probe grades against the global mask alone.
  //   /repos/... endpoint                          -> the slug's MockState, its per-slug mask over the global mask
  //   bare org probe (/orgs/{org})                 -> the shared org state, the global mask
  //   /orgs/{org}/teams/.../repos/{owner}/{repo}   -> the addressed slug's state (the tail names it), the hybrid mask below
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  let targetSlug = "";
  switch (working.mode) {
    case "single": {
      state = working.state;
      break;
    }
    case "multi": {
      const repoScoped = endpointPath(endpoint.route).startsWith("/repos/");
      const slug = slugFromPath(pathname);
      const repoState = slug ? working.multi.repos.get(slug) : undefined;
      if (repoScoped) {
        if (!slug || !repoState) {
          return violation(
            `multi-repo request ${request.method} ${pathname} names no known target slug`,
          );
        }
        state = repoState;
        mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
        targetSlug = slug;
      } else {
        // A team-repo tail naming an unknown slug is a violation: falling back to orgState would let a buggy write
        // silently mutate shared org state.
        if (slug && !repoState) {
          return violation(
            `multi-repo request ${request.method} ${pathname} names no known target slug`,
          );
        }
        state = repoState ?? working.multi.orgState;
        targetSlug = slug ?? "";
        // Hybrid grading, matching the oracle's orgMask model: GitHub grants administration per ADDRESSED repo (adding a
        // repo to a team needs admin on that repo) while org_members is org-wide.
        const global = scenario.token_permissions ?? {};
        if (slug) {
          mask = {
            ...effectiveMask(global, working.multi.permissions.get(slug)),
            org_members: global.org_members,
          };
        } else {
          mask = global;
        }
      }
      break;
    }
  }

  // Fault barrier after target resolution (a fault never masks the unknown-target violation) and before the permission
  // gate (a wire failure happens regardless of permissions).
  const taken = takeFault(key, options);
  if (taken) {
    // A faulted probe attempt spends its retry budget, so the exemption cannot outlast the probe's own retries.
    if (key === "repository.get") {
      options.probeGetFaults.set(targetSlug, (options.probeGetFaults.get(targetSlug) ?? 0) + 1);
    }
    return applyFault(taken.kind, { ...baseLog }, taken.fired);
  }

  // The visibility probe's denial must not arm the repository-section barrier. Decided against the pre-delivery state,
  // then the delivery is recorded so any later repository.get for the slug is not the probe.
  const isVisibilityProbe =
    key === "repository.get" &&
    probeExpected(targetSlug, scenario, multi) &&
    !options.probeGetDelivered.has(targetSlug) &&
    (options.probeGetFaults.get(targetSlug) ?? 0) < PROBE_RETRY_BUDGET;
  if (key === "repository.get") {
    options.probeGetDelivered.add(targetSlug);
  }

  const requirement = endpointRequirement(endpoint);
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const response = denialResponse(scenario.denial_style, requirement.kind);
    const log: LoggedRequest = { ...baseLog, status: response.status, deniedBy: grading.deniedBy };
    // A read arms the denial barrier only when the engine itself sees it fail.
    const arms =
      requirement.kind === "read" &&
      !isVisibilityProbe &&
      endpoint.advisory !== true &&
      !toleratedStatuses(endpoint).includes(response.status);
    const barrierViolation = denialBarrier(
      options,
      baseLog,
      endpoint.section,
      targetSlug,
      requirement.kind,
      arms,
    );
    return { response, log, violation: barrierViolation };
  }

  const handler = HANDLERS[key];
  if (!handler) {
    // Unreachable after assertHandlerCompleteness at construction; loud rather than a silent undefined call.
    return violation(`no handler registered for matched endpoint "${key}"`);
  }
  const response = handler({
    state,
    endpoint,
    param: paramAccessor(key, endpoint, matched.params),
    query: request.query,
    body: request.body,
    grants: (kind) => gradeRequirement(mask, { permission: requirement.permission, kind }).allowed,
  });

  // Before the chaos hook, which deliberately goes off-contract, so statusAllowed holds on every request, not only the
  // ones a curated test drives.
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

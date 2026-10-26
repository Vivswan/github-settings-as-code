/**
 * The ONE place a section's operations touch the API. Operations go through the request helpers so error classification
 * (a denial vs a hard failure, the hints) matches the reads'; a failure comes back as the value the section loop
 * classifies, beside what landed before it.
 */

import { err, ok, type Result } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { GitHubClient } from "../github/api.js";
import { type EndpointDecl, endpointMethod } from "../sections/contract/endpoints.js";
import { type SectionFailure, sectionFailure, thrown } from "../sections/contract/errors.js";
import type { SectionContext, SectionMeta } from "../sections/contract/module.js";
import type { ExecTools, SectionPlan } from "../sections/contract/plan.js";
import {
  callDeclared,
  callGraphql,
  declaredTolerance,
  tryCallDeclared,
} from "../sections/contract/requests.js";

/** `landed` counts the requests GitHub accepted, which the change lines cannot: a change or capture hook can fail after landing. */
interface PlanExecutionBase {
  readonly changes: readonly string[];
  readonly notes: readonly string[];
  readonly landed: number;
}

type PlanExecution =
  | (PlanExecutionBase & { readonly status: "applied" })
  | (PlanExecutionBase & { readonly status: "failed"; readonly failure: SectionFailure });

type PlannedOp = SectionPlan["ops"][number];

/** What the operations of one plan share: the section and the context its requests go out under. */
interface PlanRun {
  readonly ctx: SectionContext;
  readonly section: SectionMeta;
}

/** What one operation's request ended in: a response GitHub accepted, or a tolerated error's note in place of one. */
type Requested =
  | { readonly kind: "landed"; readonly response: unknown }
  | { readonly kind: "tolerated"; readonly note: string };

/**
 * OWN property only: an erased plan carries a bare string role, and an inherited name ("constructor") must read as
 * undeclared, never as a value to call.
 */
function declared<T>(dict: Readonly<Record<string, T>> | undefined, role: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, role) ? dict[role] : undefined;
}

function noop(): void {}

/**
 * The change thunk and capture hook are synchronous by contract: a promise would let the line record before the hook
 * settled and drop its rejection, so a thenable is a bug caught before the line records. A ResultAsync is a thenable
 * too, so the check also refuses a hook that returned one where a Result was due.
 */
function rejectThenable(section: SectionMeta, role: string, hook: string, value: unknown): void {
  const then = (value as { then?: unknown } | null)?.then;
  if (typeof then === "function") {
    // The BUG below is the report; the discarded promise's own rejection must not surface a second time.
    try {
      (then as (onFulfilled: () => void, onRejected: () => void) => unknown).call(
        value,
        noop,
        noop,
      );
    } catch {}
    throw new Error(
      `BUG: ${section.key}: the ${hook} of operation "${role}" returned a promise; it must be synchronous`,
    );
  }
}

/**
 * The mark is the act of resolving: the resolver is the only way a plaintext enters an operation, so an operation
 * whose hooks resolved one issues a secret-carrying request (the contract layer withholds its failure), and one that
 * resolved none cannot carry a secret. A fresh recorder per operation keeps one operation's resolve from marking the next.
 */
function secretRecorder(tools: ExecTools): { exec: ExecTools; resolved: () => boolean } {
  let resolved = false;
  const exec: ExecTools = Object.freeze({
    resolveSecret: (reference: string): string => {
      resolved = true;
      return tools.resolveSecret(reference);
    },
  });
  return { exec, resolved: () => resolved };
}

/** The REST write under the operation's role: its `before` hook, its payload, then the call, a tolerated status answering with the operation's own outcome. */
async function requestDeclared(
  run: PlanRun,
  endpoint: EndpointDecl,
  op: PlannedOp,
  exec: ExecTools,
  resolved: () => boolean,
): Promise<Result<Requested, SectionFailure>> {
  if (endpointMethod(endpoint.route) === "GET") {
    // Only the erased view can name a read; executing it would render a change line for a request that changed nothing.
    throw new Error(
      `BUG: ${run.section.key} planned an operation under role "${op.role}", which is a read endpoint (${endpoint.route}); only write roles are plannable`,
    );
  }

  const before = await op.before?.(exec);
  if (before?.isErr()) {
    return err(before.error);
  }

  const payload = typeof op.payload === "function" ? await op.payload(exec) : ok(op.payload);
  if (payload.isErr()) {
    return err(payload.error);
  }

  const request = {
    params: op.params,
    query: op.query,
    payload: payload.value,
    carriesSecret: resolved(),
    describe: op.describe,
  };
  if (op.tolerate === undefined) {
    const called = await callDeclared(run.ctx, run.section, endpoint, request);
    return called.map((response): Requested => ({ kind: "landed", response }));
  }

  const called = await tryCallDeclared(run.ctx, run.section, endpoint, {
    ...request,
    tolerated: declaredTolerance(endpoint, op.tolerate.statuses),
  });
  if (called.isErr()) {
    return err(called.error);
  }

  const result = called.value;
  if (!("error" in result)) {
    return ok({ kind: "landed", response: result.data });
  }

  const outcome = op.tolerate.outcome(result.error);
  if (outcome.failure !== undefined) {
    return err(sectionFailure("refused", outcome.failure));
  }

  return ok({ kind: "tolerated", note: outcome.note });
}

/** The GraphQL write under the operation's role, once no REST endpoint claims it: its `before` hook, its variables, then the call. */
async function requestGraphql(
  run: PlanRun,
  op: PlannedOp,
  exec: ExecTools,
  resolved: () => boolean,
): Promise<Result<Requested, SectionFailure>> {
  const graphqlOp = declared(run.section.graphql, op.role);
  if (graphqlOp === undefined) {
    throw new Error(
      `BUG: ${run.section.key} planned an operation under role "${op.role}", which names no declared endpoint or GraphQL operation`,
    );
  }

  if (graphqlOp.kind !== "write") {
    throw new Error(
      `BUG: ${run.section.key} planned an operation under role "${op.role}", which is a GraphQL ${graphqlOp.kind} operation; only write roles are plannable`,
    );
  }

  const before = await op.before?.(exec);
  if (before?.isErr()) {
    return err(before.error);
  }

  const variables =
    typeof op.variables === "function" ? await op.variables(exec) : ok(op.variables ?? {});
  if (variables.isErr()) {
    return err(variables.error);
  }

  const called = await callGraphql(run.ctx, run.section, graphqlOp, variables.value, {
    describe: op.describe,
    carriesSecret: resolved(),
  });
  return called.map((response): Requested => ({ kind: "landed", response }));
}

/** One operation's request: the REST endpoint declared under its role, else the GraphQL write (the two role spaces are disjoint). */
async function request(
  run: PlanRun,
  op: PlannedOp,
  exec: ExecTools,
  resolved: () => boolean,
): Promise<Result<Requested, SectionFailure>> {
  if (typeof op.role !== "string") {
    // A number would coerce onto a matching key and a symbol would enter the property-key path.
    throw new Error(
      `BUG: ${run.section.key} planned an operation whose role is a ${typeof op.role}, not the name of a declared write`,
    );
  }

  const endpoint = declared(run.section.endpoints, op.role);
  if (endpoint !== undefined) {
    return requestDeclared(run, endpoint, op, exec, resolved);
  }

  return requestGraphql(run, op, exec, resolved);
}

/** The change lines of a landed request, its capture hook run: a request that landed must render a line. */
function changeLines(
  section: SectionMeta,
  op: PlannedOp,
  response: unknown,
): Result<readonly string[], SectionFailure> {
  const rendered = typeof op.change === "function" ? op.change(response) : ok(op.change);
  rejectThenable(section, op.role, "change thunk", rendered);
  if (rendered.isErr()) {
    return err(rendered.error);
  }

  const lines = rendered.value;
  if (lines.length === 0) {
    throw new Error(
      `BUG: ${section.key}: operation "${op.role}" rendered no change line for a request that landed`,
    );
  }

  const captured = op.capture?.(response);
  rejectThenable(section, op.role, "capture hook", captured);
  if (captured?.isErr()) {
    return err(captured.error);
  }

  return ok(typeof lines === "string" ? [lines] : lines);
}

export async function executePlan(
  plan: SectionPlan,
  section: SectionMeta,
  api: GitHubClient,
  repo: RepoRef,
  tools: ExecTools,
): Promise<PlanExecution> {
  const run: PlanRun = {
    ctx: { api, repo, check: false, resolveSecret: (reference) => tools.resolveSecret(reference) },
    section,
  };
  const changes: string[] = [];
  const notes: string[] = [];
  let landed = 0;
  const failed = (failure: SectionFailure): PlanExecution => ({
    status: "failed",
    changes,
    notes,
    landed,
    failure,
  });
  for (const op of plan.ops) {
    const { exec, resolved } = secretRecorder(tools);
    try {
      const requested = await request(run, op, exec, resolved);
      if (requested.isErr()) {
        return failed(requested.error);
      }

      if (requested.value.kind === "tolerated") {
        notes.push(requested.value.note);
        continue;
      }

      landed++;
      const rendered = changeLines(section, op, requested.value.response);
      if (rendered.isErr()) {
        return failed(rendered.error);
      }

      changes.push(...rendered.value);
    } catch (error) {
      // The client's own throw on an unmarked request, or a BUG invariant: reported beside what landed.
      return failed(thrown(error));
    }
  }

  return { status: "applied", changes, notes, landed };
}

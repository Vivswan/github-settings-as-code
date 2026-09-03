/**
 * The plan executor: the ONE place a section's operations touch the API. Operations run in
 * declaration order through the request helpers, so error classification (PermissionDenied vs hard
 * error, hints, denial hints) matches the reads'; each success renders the operation's change line.
 */

import type { RepoRef } from "../discovery/targets.js";
import type { GithubClient } from "../github/api.js";
import { endpointMethod } from "../sections/contract/endpoints.js";
import type { SectionContext, SectionMeta } from "../sections/contract/module.js";
import type { ExecTools, SectionPlan } from "../sections/contract/plan.js";
import {
  callDeclared,
  callGraphql,
  declaredTolerance,
  tryCallDeclared,
} from "../sections/contract/requests.js";

/**
 * How a plan's execution ended; a failure mid-plan leaves the earlier
 * operations applied. `landed` counts the requests GitHub accepted, which
 * the change lines cannot: a change or capture hook can fail after landing.
 */
interface PlanExecutionBase {
  readonly changes: readonly string[];
  readonly notes: readonly string[];
  readonly landed: number;
}

type PlanExecution =
  | (PlanExecutionBase & { readonly status: "applied" })
  | (PlanExecutionBase & { readonly status: "failed"; readonly error: unknown });

/**
 * A declaration under `role` in `dict`, by OWN property only: an erased plan
 * carries a bare string role, and an inherited name ("constructor", a
 * polluted prototype key) must read as undeclared, never as a value to call.
 */
function declared<T>(dict: Readonly<Record<string, T>> | undefined, role: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, role) ? dict[role] : undefined;
}

function noop(): void {}

/**
 * The change thunk and capture hook are synchronous by contract: a promise
 * here would let the line record before the hook settled and drop its
 * rejection, so a thenable is a bug caught before the line records.
 */
function rejectThenable(section: SectionMeta, role: string, hook: string, value: unknown): void {
  const then = (value as { then?: unknown } | null)?.then;
  if (typeof then === "function") {
    // The BUG below is the report; the discarded promise's own rejection
    // must not surface a second time, and a then() that throws changes nothing.
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
 * Execute every operation of `plan` against `api` under ONE failure rule:
 * the change line records only once request, render, and capture succeeded.
 */
export async function executePlan(
  plan: SectionPlan,
  section: SectionMeta,
  api: GithubClient,
  repo: RepoRef,
  tools: ExecTools,
): Promise<PlanExecution> {
  // Thunks see a frozen projection holding the resolver and nothing else: whatever
  // object the caller passed as tools never reaches section code.
  const exec: ExecTools = Object.freeze({
    resolveSecret: (reference: string): string => tools.resolveSecret(reference),
  });
  const ctx: SectionContext = { api, repo, check: false, resolveSecret: exec.resolveSecret };
  const changes: string[] = [];
  const notes: string[] = [];
  let landed = 0;
  for (const op of plan.ops) {
    try {
      let response: unknown;
      if (typeof op.role !== "string") {
        // Only a string can name a declared role: a number would coerce onto
        // a matching key and a symbol would enter the property-key path.
        throw new Error(
          `BUG: ${section.key} planned an operation whose role is a ${typeof op.role}, not the name of a declared write`,
        );
      }
      const endpoint = declared(section.endpoints, op.role);
      if (endpoint !== undefined) {
        if (endpointMethod(endpoint.route) === "GET") {
          // Only the erased view can name a read; executing it would render
          // a change line for a request that changed nothing.
          throw new Error(
            `BUG: ${section.key} planned an operation under role "${op.role}", which is a read endpoint (${endpoint.route}); only write roles are plannable`,
          );
        }
        const payload = typeof op.payload === "function" ? await op.payload(exec) : op.payload;
        const request = { params: op.params, query: op.query, payload, describe: op.describe };
        if (op.tolerate === undefined) {
          response = await callDeclared(ctx, section, endpoint, request);
        } else {
          const result = await tryCallDeclared(ctx, section, endpoint, {
            ...request,
            tolerated: declaredTolerance(endpoint, op.tolerate.statuses),
          });
          if ("error" in result) {
            const outcome = op.tolerate.outcome(result.error);
            if (outcome.failure !== undefined) {
              throw new Error(outcome.failure);
            }
            notes.push(outcome.note);
            continue;
          }
          response = result.data;
        }
      } else {
        const graphqlOp = declared(section.graphql, op.role);
        if (graphqlOp === undefined) {
          throw new Error(
            `BUG: ${section.key} planned an operation under role "${op.role}", which names no declared endpoint or GraphQL operation`,
          );
        }
        if (graphqlOp.kind !== "write") {
          throw new Error(
            `BUG: ${section.key} planned an operation under role "${op.role}", which is a GraphQL ${graphqlOp.kind} operation; only write roles are plannable`,
          );
        }
        const variables =
          typeof op.variables === "function" ? await op.variables(exec) : op.variables;
        response = await callGraphql(ctx, section, graphqlOp, variables ?? {}, {
          describe: op.describe,
        });
      }
      landed++;
      const lines = typeof op.change === "function" ? op.change(response) : op.change;
      rejectThenable(section, op.role, "change thunk", lines);
      if (lines.length === 0) {
        // The request landed, so apply must have something to report.
        throw new Error(
          `BUG: ${section.key}: operation "${op.role}" rendered no change line for a request that landed`,
        );
      }
      rejectThenable(section, op.role, "capture hook", op.capture?.(response));
      changes.push(...(typeof lines === "string" ? [lines] : lines));
    } catch (error) {
      return { status: "failed", changes, notes, landed, error };
    }
  }
  return { status: "applied", changes, notes, landed };
}

/**
 * The ONE place a section's operations touch the API. Operations go through the request helpers so error classification
 * (a denial vs a hard failure, the hints) matches the reads'; a failure comes back as the value the section loop
 * classifies, beside what landed before it.
 */

import { ok } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { GitHubClient } from "../github/api.js";
import { endpointMethod } from "../sections/contract/endpoints.js";
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

export async function executePlan(
  plan: SectionPlan,
  section: SectionMeta,
  api: GitHubClient,
  repo: RepoRef,
  tools: ExecTools,
): Promise<PlanExecution> {
  const ctx: SectionContext = {
    api,
    repo,
    check: false,
    resolveSecret: (reference) => tools.resolveSecret(reference),
  };
  const changes: string[] = [];
  const notes: string[] = [];
  let landed = 0;
  for (const op of plan.ops) {
    const { exec, resolved } = secretRecorder(tools);
    try {
      let response: unknown;
      if (typeof op.role !== "string") {
        // A number would coerce onto a matching key and a symbol would enter the property-key path.
        throw new Error(
          `BUG: ${section.key} planned an operation whose role is a ${typeof op.role}, not the name of a declared write`,
        );
      }
      const endpoint = declared(section.endpoints, op.role);
      if (endpoint !== undefined) {
        if (endpointMethod(endpoint.route) === "GET") {
          // Only the erased view can name a read; executing it would render a change line for a request that changed nothing.
          throw new Error(
            `BUG: ${section.key} planned an operation under role "${op.role}", which is a read endpoint (${endpoint.route}); only write roles are plannable`,
          );
        }
        const before = await op.before?.(exec);
        if (before?.isErr()) {
          return { status: "failed", changes, notes, landed, failure: before.error };
        }
        const payload = typeof op.payload === "function" ? await op.payload(exec) : ok(op.payload);
        if (payload.isErr()) {
          return { status: "failed", changes, notes, landed, failure: payload.error };
        }
        const request = {
          params: op.params,
          query: op.query,
          payload: payload.value,
          carriesSecret: resolved(),
          describe: op.describe,
        };
        if (op.tolerate === undefined) {
          const called = await callDeclared(ctx, section, endpoint, request);
          if (called.isErr()) {
            return { status: "failed", changes, notes, landed, failure: called.error };
          }
          response = called.value;
        } else {
          const called = await tryCallDeclared(ctx, section, endpoint, {
            ...request,
            tolerated: declaredTolerance(endpoint, op.tolerate.statuses),
          });
          if (called.isErr()) {
            return { status: "failed", changes, notes, landed, failure: called.error };
          }
          const result = called.value;
          if ("error" in result) {
            const outcome = op.tolerate.outcome(result.error);
            if (outcome.failure !== undefined) {
              return {
                status: "failed",
                changes,
                notes,
                landed,
                failure: sectionFailure("refused", outcome.failure),
              };
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
        const before = await op.before?.(exec);
        if (before?.isErr()) {
          return { status: "failed", changes, notes, landed, failure: before.error };
        }
        const variables =
          typeof op.variables === "function" ? await op.variables(exec) : ok(op.variables ?? {});
        if (variables.isErr()) {
          return { status: "failed", changes, notes, landed, failure: variables.error };
        }
        const called = await callGraphql(ctx, section, graphqlOp, variables.value, {
          describe: op.describe,
          carriesSecret: resolved(),
        });
        if (called.isErr()) {
          return { status: "failed", changes, notes, landed, failure: called.error };
        }
        response = called.value;
      }
      landed++;
      const rendered = typeof op.change === "function" ? op.change(response) : ok(op.change);
      rejectThenable(section, op.role, "change thunk", rendered);
      if (rendered.isErr()) {
        return { status: "failed", changes, notes, landed, failure: rendered.error };
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
        return { status: "failed", changes, notes, landed, failure: captured.error };
      }
      changes.push(...(typeof lines === "string" ? [lines] : lines));
    } catch (error) {
      // The client's own throw on an unmarked request, or a BUG invariant: reported beside what landed.
      return { status: "failed", changes, notes, landed, failure: thrown(error) };
    }
  }
  return { status: "applied", changes, notes, landed };
}

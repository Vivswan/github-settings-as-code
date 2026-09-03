/**
 * The plan executor: the ONE place a plan section's operations touch the
 * API. Operations run in declaration order through the same request
 * helpers a run() handler uses, so error classification (PermissionDenied
 * vs hard error, hints, denial hints) is identical across the two
 * contracts; each success renders the operation's change line.
 */

import type { RepoRef } from "../discovery/targets.js";
import type { GithubClient } from "../github/api.js";
import { endpointMethod } from "../sections/contract/endpoints.js";
import type { SectionContext, SectionMeta } from "../sections/contract/module.js";
import type { ExecTools, SectionPlan } from "../sections/contract/plan.js";
import { callDeclared, callGraphql } from "../sections/contract/requests.js";

/**
 * How a plan's execution ended. The API has no transactions, so a failure
 * mid-plan leaves the operations before it applied: both arms carry the
 * change lines rendered so far, and the failed arm carries the error the
 * failing request raised (already classified by the request helpers) for
 * the engine to report exactly as it reports a run() handler's throw.
 */
type PlanExecution =
  | { readonly status: "applied"; readonly changes: readonly string[] }
  | { readonly status: "failed"; readonly changes: readonly string[]; readonly error: unknown };

/**
 * A declaration under `role` in `dict`, by OWN property only: an erased plan
 * carries a bare string role, and an inherited name ("constructor", a
 * polluted prototype key) must read as undeclared, never as a value to call.
 */
function declared<T>(dict: Readonly<Record<string, T>> | undefined, role: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, role) ? dict[role] : undefined;
}

/**
 * Execute every operation of `plan` against `api`, resolving each op's role
 * against the section's declarations - REST endpoints first, then GraphQL
 * operations (the registry asserts the two role spaces are disjoint).
 * Payload and variables thunks seal at this point, with `tools` as their
 * only capability, so a secret is read no earlier than the request that
 * carries it. Stops at the first failing operation.
 */
export async function executePlan(
  plan: SectionPlan,
  section: SectionMeta,
  api: GithubClient,
  repo: RepoRef,
  tools: ExecTools,
): Promise<PlanExecution> {
  // Thunks see a frozen projection holding the resolver and nothing else:
  // whatever the caller passed (the engine hands its apply context, which
  // also carries the client) never reaches section code.
  const exec: ExecTools = Object.freeze({
    resolveSecret: (reference: string): string => tools.resolveSecret(reference),
  });
  const ctx: SectionContext = { api, repo, check: false, resolveSecret: exec.resolveSecret };
  const changes: string[] = [];
  for (const op of plan.ops) {
    try {
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
        const payload = typeof op.payload === "function" ? op.payload(exec) : op.payload;
        await callDeclared(ctx, section, endpoint, {
          params: op.params,
          query: op.query,
          payload,
        });
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
        const variables = typeof op.variables === "function" ? op.variables(exec) : op.variables;
        await callGraphql(ctx, section, graphqlOp, variables ?? {});
      }
    } catch (error) {
      return { status: "failed", changes, error };
    }
    changes.push(op.change);
  }
  return { status: "applied", changes };
}

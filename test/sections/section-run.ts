import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import { type ExecTools, planContext, planDrift } from "../../src/sections/contract/plan.js";

/** The one target every per-section unit test addresses. */
export const REPO = { owner: "o", name: "r", slug: "o/r" } as const;

/** Tools for a section that declares no secret values: any lookup is a bug, exactly as the engine's empty-map resolver treats it. */
export const NO_SECRETS: ExecTools = {
  resolveSecret(reference) {
    throw new Error(
      `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
    );
  },
};

/** Execution tools over a fixed reference -> plaintext table, like the engine's. */
export function secretTools(resolved: Record<string, string>): ExecTools {
  return {
    resolveSecret(reference) {
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

export function sectionRunners<M extends SectionModule>(section: M) {
  type Desired = Parameters<M["plan"]>[1];
  // Calling through the constraint would widen the plan to its erased op type; the section's own plan type is what the suites assert against.
  const plan = (api: GithubClient, desired: Desired) =>
    section.plan(planContext(section, api, REPO), desired) as ReturnType<M["plan"]>;
  const check = async (api: GithubClient, desired: Desired) => {
    const planned = await plan(api, desired);
    return { drift: planDrift(planned), notes: planned.notes };
  };
  const apply = async (api: GithubClient, desired: Desired, tools: ExecTools = NO_SECRETS) => {
    const planned = await plan(api, desired);
    const execution = await executePlan(planned, section, api, REPO, tools);
    if (execution.status === "failed") {
      throw execution.error;
    }
    return { changes: execution.changes, notes: planned.notes };
  };
  return { plan, check, apply };
}

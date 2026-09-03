/**
 * The unit idempotence proof for a plan section: plan against a live fake,
 * execute the plan, plan again over the state the execution left behind,
 * and require the second plan to be empty except for the writes the
 * declarations say recur (alwaysRewrite). The per-section twin of the e2e
 * apply-idempotence proof, runnable in a unit test because the plan
 * contract separates deciding from doing.
 */

import { expect } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { PlanSectionModule } from "../../src/sections/contract/module.js";
import { type ExecTools, planContext, type SectionPlan } from "../../src/sections/contract/plan.js";

/** The one target every per-section unit test addresses. */
export const REPO = { owner: "o", name: "r", slug: "o/r" } as const;

/**
 * Execution tools for a section that declares no secret values: any lookup
 * is a bug, exactly as the engine's empty-map resolver treats it.
 */
const NO_SECRETS: ExecTools = {
  resolveSecret(reference) {
    throw new Error(
      `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
    );
  },
};

/**
 * One planned operation's IDENTITY, as comparing two planning passes needs
 * it: everything but the payload and variables, which a section may build
 * as a thunk (a fresh closure per pass, unequal by reference and opaque to
 * a value comparison). A thunk's identity is that it exists - what it seals
 * is a secret the plan is not allowed to expose - so it folds to a marker.
 */
function identityOf(op: SectionPlan["ops"][number]): unknown {
  const sealed = (value: unknown): unknown => (typeof value === "function" ? "<sealed>" : value);
  return {
    role: op.role,
    params: op.params,
    query: op.query,
    payload: sealed(op.payload),
    variables: sealed(op.variables),
    drift: op.drift,
    change: op.change,
  };
}

/** A plan compared as a value: its operation identities, notes, and drift. */
function shapeOf(plan: SectionPlan): unknown {
  return { ops: plan.ops.map(identityOf), notes: plan.notes, drift: plan.drift };
}

/**
 * Plan, execute, re-plan, execute again. `api` must be a STATEFUL fake (its
 * reads reflect its writes), or the second plan would trivially repeat the
 * first. Three properties are asserted: the second plan carries ONLY the
 * operations the declarations say recur (alwaysRewrite), it carries ALL of
 * them (an unconditional rewrite that stops firing has silently become
 * conditional), and the op-less drift survives both plans - it is by
 * definition what no operation fixes. A third plan after the second
 * execution must match the second, so state is stable, not oscillating.
 * `tools` defaults to a resolver that refuses every lookup, the right
 * posture for a section declaring no secret values; a secret-bearing
 * section passes its own.
 */
export async function provePlanIdempotent<M extends PlanSectionModule>(
  section: M,
  api: GithubClient,
  desired: Parameters<M["plan"]>[1],
  tools: ExecTools = NO_SECRETS,
): Promise<{ first: SectionPlan; second: SectionPlan; changes: readonly string[] }> {
  const plan = async (): Promise<SectionPlan> =>
    section.plan(planContext(section, api, REPO), desired);
  const execute = async (of: SectionPlan): Promise<readonly string[]> => {
    const execution = await executePlan(of, section, api, REPO, tools);
    if (execution.status === "failed") {
      throw execution.error;
    }
    return execution.changes;
  };
  const rewrites = (of: SectionPlan): unknown[] =>
    of.ops.filter((op) => section.endpoints[op.role]?.alwaysRewrite === true).map(identityOf);

  const first = await plan();
  const changes = await execute(first);
  expect(changes).toEqual(first.ops.map((op) => op.change));

  const second = await plan();
  expect(
    second.ops.filter((op) => section.endpoints[op.role]?.alwaysRewrite !== true).map(identityOf),
    `${section.key}: the plan over just-applied state still carries operations that are not alwaysRewrite by declaration, so apply would not converge`,
  ).toEqual([]);
  expect(
    rewrites(second),
    `${section.key}: an alwaysRewrite operation the first plan issued is missing from the second - those writes recur by contract (their value cannot be read back), so a plan that drops one has started comparing state it cannot see`,
  ).toEqual(rewrites(first));
  expect(second.drift).toEqual(first.drift);

  // State stability: executing the converged plan changes nothing a third
  // plan can see.
  await execute(second);
  const third = await plan();
  expect(
    shapeOf(third),
    `${section.key}: re-executing the converged plan changed what the next plan sees, so the section oscillates instead of settling`,
  ).toEqual(shapeOf(second));
  return { first, second, changes };
}

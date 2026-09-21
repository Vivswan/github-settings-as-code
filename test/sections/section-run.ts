import { expect } from "bun:test";
import type { Result } from "neverthrow";
import { executePlan } from "../../src/engine/execute.js";
import type { GitHubClient } from "../../src/github/api.js";
import type { SectionFailure } from "../../src/sections/contract/errors.js";
import type { SectionInput, SectionModule } from "../../src/sections/contract/module.js";
import {
  type ExecTools,
  planContext,
  planDrift,
  type SectionPlan,
} from "../../src/sections/contract/plan.js";
import { validatedInput } from "./validated-input.js";

/**
 * The value of a section Result, or a thrown Error carrying the failure's whole line: the suites that
 * pin a failure's text assert it with `rejects.toThrow(text)`, and a suite that pins the KIND reads the
 * failure itself (failureOf).
 */
export function unwrap<T>(result: Result<T, SectionFailure>): T {
  if (result.isErr()) {
    throw new SectionFailed(result.error);
  }
  return result.value;
}

/** The thrown form unwrap gives a failure: the whole line as the message, the failure itself for a suite that pins its kind. */
export class SectionFailed extends Error {
  constructor(readonly failure: SectionFailure) {
    super(failure.message);
  }
}

/** The kind of the failure unwrap threw; undefined for any other throw. */
export function failureKind(thrown: unknown): SectionFailure["kind"] | undefined {
  return thrown instanceof SectionFailed ? thrown.failure.kind : undefined;
}

/** The promise must reject with a denial unwrap threw; its detail comes back. */
export async function rejectsDenied(promise: Promise<unknown>): Promise<string> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown, "expected a rejection").toBeDefined();
  return deniedDetail(thrown);
}

/** The detail of a denial unwrap threw; any other throw, and any other kind, fails the assertion. */
export function deniedDetail(thrown: unknown): string {
  expect(thrown).toBeInstanceOf(SectionFailed);
  const failure = (thrown as SectionFailed).failure;
  expect(failure.kind).toBe("permission-denied");
  return failure.kind === "permission-denied" ? failure.detail : "";
}

/** The failure a section Result carries; a success is the test's own bug. */
export function failureOf<T>(result: Result<T, SectionFailure>): SectionFailure {
  if (result.isOk()) {
    throw new Error(`expected a failure, got a value: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

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
  type Desired = SectionInput<M["key"]>;
  // Calling through the constraint would widen the plan to its erased op type; the section's own plan type is what the suites assert against.
  type Planned = Awaited<ReturnType<M["plan"]>> extends Result<infer P, SectionFailure> ? P : never;
  const planResult = (api: GitHubClient, desired: Desired) =>
    section.plan(planContext(section, api, REPO), validatedInput(section.key, desired)) as Promise<
      Result<Planned, SectionFailure>
    >;
  const plan = async (api: GitHubClient, desired: Desired): Promise<Planned> =>
    unwrap(await planResult(api, desired));
  const planFailure = async (api: GitHubClient, desired: Desired): Promise<SectionFailure> =>
    failureOf(await planResult(api, desired));
  // The engine's erased view of the same plan, for the helpers that hand it on; the bundled declarations cannot name it.
  const erased = async (api: GitHubClient, desired: Desired): Promise<SectionPlan> =>
    (await plan(api, desired)) as unknown as SectionPlan;
  const check = async (
    api: GitHubClient,
    desired: Desired,
  ): Promise<{ drift: string[]; notes: string[] }> => {
    const planned = await erased(api, desired);
    return { drift: planDrift(planned), notes: planned.notes };
  };
  const apply = async (
    api: GitHubClient,
    desired: Desired,
    tools: ExecTools = NO_SECRETS,
  ): Promise<{ changes: readonly string[]; notes: string[] }> => {
    const planned = await erased(api, desired);
    const execution = await executePlan(planned, section, api, REPO, tools);
    if (execution.status === "failed") {
      throw new Error(execution.failure.message);
    }
    return { changes: execution.changes, notes: planned.notes };
  };
  return { plan, planFailure, check, apply };
}

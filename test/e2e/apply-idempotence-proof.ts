/**
 * The apply-idempotence proof engine, beside its tables file
 * (apply-idempotence.ts, which declares WHICH sections compare before writing
 * and WHICH endpoints always rewrite): the state snapshots, the write
 * classifiers, the corpus-level unconditional-write witness, and
 * assertApplyIdempotent, the re-run driver runScenario invokes for
 * expect.fixpoint: "apply_idempotent". The engine never spawns children
 * itself: the runner hands it a ChildInvoker (its own invoke bound to the
 * scenario's temp dir and mock URL), so the spawn/capture machinery stays in
 * runner.ts and this module stays pure over what a child run produced.
 */

import { isIssueChannel } from "../../src/action/redact.js";
import type { SectionKey } from "../../src/schema.js";
import { ALWAYS_REWRITE_STATE_FAMILIES, COMPARE_BEFORE_WRITE } from "./apply-idempotence.js";
import { type LoggedRequest, renderRequest } from "./mock/contract.js";
import { endpointForRequest, isWriteRequest, sectionForRequest } from "./mock/dispatch.js";
import type { MockHandle } from "./mock/server.js";
import type { MockState } from "./mock/state.js";
import type { Scenario } from "./schema.js";

/** The result of one child process invocation against a running mock. */
export interface Invocation {
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  /** True when the harness's kill timer terminated the child. */
  killedByHarness: boolean;
}

/**
 * One INTERNAL re-run's captured output surfaces: the convergence check, or
 * apply_idempotent's second apply and its final check. Shape-compatible with
 * checkLeaks' observed argument, so an invariant sweeps a re-run exactly the
 * way it sweeps the primary invocation - a leak conditional on check mode or
 * on converged state only ever appears here.
 */
export interface RerunCapture {
  /** Which re-run produced this (e.g. "converges check"). */
  label: string;
  stdout: string;
  stderr: string;
  summary: string;
  outputs: Record<string, string>;
}

/** Capture an internal re-run's surfaces for the report (see RerunCapture). */
export function captureRerun(label: string, run: Invocation): RerunCapture {
  return {
    label,
    stdout: run.stdout,
    stderr: run.stderr,
    summary: run.summary,
    outputs: run.outputs,
  };
}

/**
 * The runner-owned spawn seam the proof engine drives re-runs through:
 * `invoke` runs one child against the SAME mock and temp dir the primary
 * invocation used, and `killNote` renders the harness-kill suffix for an
 * exit-code failure line (the kill cap is the runner's own constant).
 */
export interface ChildInvoker {
  invoke(scenario: Scenario): Promise<Invocation>;
  killNote(run: Invocation): string;
}

/**
 * One labeled entry per mutable state the mock holds: the single-repo state,
 * or every per-slug repo state plus the shared org state in multi mode. The
 * multi settings/permissions maps and the discovery pool are run CONFIG the
 * pipeline never mutates, so they are not part of the stability snapshot.
 */
function mutableStates(handle: MockHandle): Array<[string, MockState]> {
  const working = handle.working;
  switch (working.mode) {
    case "single":
      return [["state", working.state]];
    case "multi":
      return [...working.multi.repos, ["(org)", working.multi.orgState]];
  }
}

/** An always-rewrite family entry with its server-managed updated_at dropped. */
function dropUpdatedAt(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null
    ? { ...(entry as Record<string, unknown>), updated_at: undefined }
    : entry;
}

/**
 * Project one always-rewrite family for the stability snapshot: updated_at is
 * dropped from every item, since these sections legitimately move it on every
 * apply; created_at stays IN, so a delete-and-recreate on the second apply
 * still reads as churn. The repository-level families store a flat item list;
 * environment_secrets nests one list per environment name.
 */
function projectAlwaysRewrite(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropUpdatedAt);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        Array.isArray(nested) ? nested.map(dropUpdatedAt) : nested,
      ]),
    );
  }
  return value;
}

/**
 * Serialize every mutable state family to a "label.family" -> JSON map, so a
 * before/after comparison can name exactly which repo and family moved instead
 * of reporting one opaque inequality. Underscore-prefixed families are mock
 * bookkeeping (e.g. the secret write counter), not repo state. The
 * always-rewrite families (ALWAYS_REWRITE_STATE_FAMILIES, the explicit list
 * in apply-idempotence.ts) drop updated_at via projectAlwaysRewrite.
 */
function snapshotFamilies(handle: MockHandle): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [label, state] of mutableStates(handle)) {
    for (const [family, value] of Object.entries(state)) {
      if (family.startsWith("_")) {
        continue;
      }
      const projected = ALWAYS_REWRITE_STATE_FAMILIES.has(family)
        ? projectAlwaysRewrite(value)
        : value;
      snapshot.set(`${label}.${family}`, JSON.stringify(projected));
    }
  }
  return snapshot;
}

/**
 * The "label.family" keys whose serialized state differs between two
 * snapshots, including keys present on only one side. Exported for direct
 * testing, so the state-stability assertion is provably able to fire.
 */
export function changedFamilies(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

/**
 * Classify the mutating requests a SECOND apply issued, one failure line per
 * offender: a write matching no section endpoint is report/core traffic that
 * has no business in an idempotence re-run, and a write to a
 * compare-before-write section (COMPARE_BEFORE_WRITE) proves the engine's
 * payload and its read-back no longer round-trip - that section diffs live
 * state first, and the live state already matched. Writes to unconditional-PUT
 * sections pass (their state stability is asserted separately). Exported for
 * direct testing, so the zero-write assertion is provably able to fire.
 */
export function secondApplyWriteFailures(writes: LoggedRequest[]): string[] {
  const failures: string[] = [];
  for (const write of writes) {
    const section = sectionForRequest(write.method, write.pathname, write.body);
    if (section === null) {
      failures.push(
        `apply-idempotence: second apply wrote outside any section endpoint: ${renderRequest(write, false)}`,
      );
      continue;
    }
    if (COMPARE_BEFORE_WRITE[section]) {
      failures.push(
        `apply-idempotence: second apply wrote to "${section}" (${renderRequest(write, false)}), but that section compares before writing and the live state already matched`,
      );
    }
  }
  return failures;
}

/**
 * The inverse leg of COMPARE_BEFORE_WRITE: a wrong `true` fails the first
 * idempotence run that touches the section, but a wrong `false` merely
 * weakens the proof (the zero-write assertion above stops binding) without
 * failing anything. So every idempotence re-run accumulates, per
 * false-listed section, how many first- and second-apply writes the CORPUS
 * issued, and the corpus-level verdict demands both a witness and the
 * re-issued writes. Corpus-level on purpose: one scenario can legitimately
 * go second-apply-quiet on a false section (a one-shot removal, a webhook
 * without a declared secret), but across the corpus the unconditional write
 * path must fire somewhere or the `false` is unwitnessed.
 */
export type UnconditionalWriteWitness = Map<SectionKey, { first: number; second: number }>;

/** The witness map THIS process's idempotence re-runs accumulate into. */
const corpusWriteWitness: UnconditionalWriteWitness = new Map();

/**
 * Accumulate one idempotence re-run's writes into a witness map. Pure over
 * its arguments (the corpus map is passed in), so the corpus verdict is
 * provably able to fire - the same testability contract the sibling
 * secondApplyWriteFailures/missingSecondApplyRewrites helpers keep.
 */
export function recordUnconditionalWrites(
  witness: UnconditionalWriteWitness,
  firstWrites: LoggedRequest[],
  secondWrites: LoggedRequest[],
): void {
  const bump = (writes: LoggedRequest[], side: "first" | "second"): void => {
    for (const write of writes) {
      const section = sectionForRequest(write.method, write.pathname, write.body);
      if (section === null || COMPARE_BEFORE_WRITE[section]) {
        continue;
      }
      const counts = witness.get(section) ?? { first: 0, second: 0 };
      counts[side]++;
      witness.set(section, counts);
    }
  };
  bump(firstWrites, "first");
  bump(secondWrites, "second");
}

/**
 * The corpus-level verdict over a witness map, demanded for EVERY
 * false-listed section - one failure line per section that is either
 * unwitnessed (no idempotence re-run wrote to it on a first apply, so
 * nothing contradicts a wrong `false`) or contradicted (its first applies
 * wrote but no second apply ever did). The two messages name opposite
 * remedies: an unwitnessed section needs corpus coverage, a contradicted
 * one needs its table entry flipped.
 */
export function unwitnessedUnconditionalSections(witness: UnconditionalWriteWitness): string[] {
  const failures: string[] = [];
  for (const [section, compares] of Object.entries(COMPARE_BEFORE_WRITE) as Array<
    [SectionKey, boolean]
  >) {
    if (compares) {
      continue;
    }
    const counts = witness.get(section);
    if (counts === undefined || counts.first === 0) {
      failures.push(
        `apply-idempotence corpus: "${section}" is listed as unconditional (COMPARE_BEFORE_WRITE false) but NO apply_idempotent scenario in the corpus writes to it, so a wrong \`false\` would go uncontradicted - declare the section in an apply_idempotent scenario (e.g. apply-idempotent-unconditional.yml)`,
      );
      continue;
    }
    if (counts.second === 0) {
      failures.push(
        `apply-idempotence corpus: "${section}" is listed as unconditional (COMPARE_BEFORE_WRITE false) but its ${counts.first} first-apply write(s) were never re-issued by any second apply - either the section now compares before writing (flip the table entry) or the corpus lost its unconditional-write witness`,
      );
    }
  }
  return failures.sort();
}

/**
 * The verdict over the writes this process recorded. run.ts consults it
 * after the FULL corpus only - a --sections or --scenario slice legitimately
 * starves sections.
 */
export function corpusUnwitnessedUnconditionalSections(): string[] {
  return unwitnessedUnconditionalSections(corpusWriteWitness);
}

/**
 * The always-rewrite half of the idempotence proof: every secret PUT the
 * first apply issued must be issued AGAIN by the second apply, path for path.
 * Which PUTs bind comes from the EndpointDecl `alwaysRewrite` flag (resolved
 * per logged request via endpointForRequest), so the obligation lives on the
 * declaration - per endpoint, not per section, since environments carries a
 * passthrough PUT and always-rewrite secret PUTs side by side. Derived from
 * OBSERVED first-run writes - not from the declared settings - so permission
 * masks, section allowlists, and the defaults merge need no re-modeling
 * here: whatever gating let the first PUT through applies identically to the
 * second run. Exported for direct testing, so the assertion is provably able
 * to fire.
 */
export function missingSecondApplyRewrites(
  firstWrites: LoggedRequest[],
  secondWrites: LoggedRequest[],
): string[] {
  const isAlwaysRewritePut = (request: LoggedRequest): boolean =>
    endpointForRequest(request.method, request.pathname)?.alwaysRewrite === true;
  const secondPuts = new Set(secondWrites.filter(isAlwaysRewritePut).map((r) => r.pathname));
  return [...new Set(firstWrites.filter(isAlwaysRewritePut).map((r) => r.pathname))]
    .filter((pathname) => !secondPuts.has(pathname))
    .sort()
    .map(
      (pathname) =>
        `apply-idempotence: the first apply wrote PUT ${pathname} but the second did not; declared secrets are re-sealed and re-written on EVERY apply (rotation propagation)`,
    );
}

/**
 * The apply-idempotence proof (expect.fixpoint: "apply_idempotent"): re-run
 * the scenario in apply mode against the SAME mutated mock and require apply
 * to be a fixpoint. Three properties, each its own regression class:
 *   - the second apply exits 0: a fresh apply over converged state must not
 *     trip over its own output;
 *   - no compare-before-write section writes (COMPARE_BEFORE_WRITE): those
 *     sections diff live state before writing, so a write here means the
 *     engine's payload and its read-back no longer round-trip;
 *   - the mock state is unchanged family by family: unconditional-PUT sections
 *     may write again, but a second apply must rewrite the SAME state.
 * A final check-mode run then converges (exit 0, zero writes) - the same proof
 * `fixpoint: "converges"` makes, which is why the two proofs are one enum
 * field rather than two booleans.
 *
 * The issue report channels are rejected, not neutralized: their delivery embeds
 * a fresh ISO timestamp (the report issue legitimately moves every run), and
 * both `issue` and `issue-on-failure` inject the marker label into the labels
 * section's declared set - so
 * flipping the channel off for the re-run would change what the labels section
 * deletes, which is a different scenario, not a second run of this one.
 */
export async function assertApplyIdempotent(
  scenario: Scenario,
  handle: MockHandle,
  child: ChildInvoker,
): Promise<{ failures: string[]; reruns: RerunCapture[] }> {
  if (scenario.inputs?.mode === "check") {
    return { failures: ["apply_idempotent requires an apply-mode scenario"], reruns: [] };
  }
  const channel = scenario.inputs?.private_report;
  if (channel !== undefined && isIssueChannel(channel)) {
    return {
      failures: [
        `apply_idempotent cannot run under private_report: ${channel} - the report issue embeds a fresh timestamp (state moves every run) and the injected marker label ties the labels declaration to the channel; use private_report: none or artifact`,
      ],
      reruns: [],
    };
  }
  const failures: string[] = [];
  const reruns: RerunCapture[] = [];
  const rerun: Scenario = { ...scenario, inputs: { ...scenario.inputs, mode: "apply" } };
  const before = snapshotFamilies(handle);
  const requestsBefore = handle.requests.length;
  const violationsBefore = handle.violations.length;

  const second = await child.invoke(rerun);
  reruns.push(captureRerun("apply-idempotence second apply", second));
  if (second.exitCode !== 0) {
    failures.push(
      `apply-idempotence: second apply exited ${second.exitCode}, expected 0${child.killNote(second)}`,
    );
  }
  const secondViolations = handle.violations.slice(violationsBefore);
  if (secondViolations.length > 0) {
    failures.push(`apply-idempotence: mock violations:\n  ${secondViolations.join("\n  ")}`);
  }
  const writes = handle.requests.slice(requestsBefore).filter(isWriteRequest);
  failures.push(...secondApplyWriteFailures(writes));
  const firstWrites = handle.requests.slice(0, requestsBefore).filter(isWriteRequest);
  failures.push(...missingSecondApplyRewrites(firstWrites, writes));
  recordUnconditionalWrites(corpusWriteWitness, firstWrites, writes);
  const changed = changedFamilies(before, snapshotFamilies(handle));
  if (changed.length > 0) {
    failures.push(`apply-idempotence: second apply changed mock state: ${changed.join(", ")}`);
  }

  // A converged apply must read back clean: check mode, exit 0, zero writes.
  const checkRequestsBefore = handle.requests.length;
  const checkViolationsBefore = handle.violations.length;
  handle.enterCheckMode();
  const check = await child.invoke({ ...rerun, inputs: { ...rerun.inputs, mode: "check" } });
  reruns.push(captureRerun("apply-idempotence check", check));
  if (check.exitCode !== 0) {
    failures.push(
      `apply-idempotence: the check run after the second apply exited ${check.exitCode}, expected 0${child.killNote(check)}`,
    );
  }
  const checkWrites = handle.requests.slice(checkRequestsBefore).filter(isWriteRequest);
  if (checkWrites.length > 0) {
    failures.push(
      `apply-idempotence: the check run wrote ${checkWrites.length} time(s): ${checkWrites.map((r) => renderRequest(r, false)).join(", ")}`,
    );
  }
  const checkViolations = handle.violations.slice(checkViolationsBefore);
  if (checkViolations.length > 0) {
    failures.push(
      `apply-idempotence: check-run mock violations:\n  ${checkViolations.join("\n  ")}`,
    );
  }
  return { failures, reruns };
}

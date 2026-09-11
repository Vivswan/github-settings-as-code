/**
 * The fuzz oracle: predicts the CLASS of outcome for a generated scenario from
 * the permission mask, policy, and mode alone, never the drift content.
 * Predicting exact drift would reimplement the engine, and a bug shared by the
 * engine and the oracle would hide. So the oracle asserts only what follows
 * mechanically from the permission and policy model, plus the universal
 * properties every run must satisfy.
 */

import type { OptOutNotice } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import {
  SECTION_KEYS,
  type SectionKey,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "../../src/schema.js";
import {
  type DenialPosture,
  denialPosture,
  planningReads,
  type ReadGating,
  readGating,
} from "../../src/sections/contract/module.js";
import type { SectionPermission } from "../../src/sections/contract/permissions.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { silentIo } from "../io-fake.js";
import {
  type Json,
  LAYERING_DIRECTIVES,
  LAYERING_KEY,
  type LayeringDirective,
  UNDECLARED_KEY,
} from "./gen-support.js";
import {
  displayKeyOf,
  type MergeLayer,
  type MergeScenarioMeta,
  type MultiScenarioMeta,
  type ScenarioMeta,
} from "./generators.js";
import { GRADE_RANK, type MaskGrade, type MaskKey } from "./schema.js";

/** A section outcome the step summary can report. */
type Outcome = "applied" | "clean" | "drift" | "skipped" | "failed" | "excluded";

const PERMISSION_BY_KEY: Record<SectionKey, SectionPermission> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, section.permission]),
) as Record<SectionKey, SectionPermission>;

/**
 * Each section's read gating, from the same declarations the mock's permission
 * gate reads, so mock and oracle cannot disagree. Folded by effectiveGrades.
 */
const READ_GATING: Record<SectionKey, ReadGating> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, readGating(section)]),
) as Record<SectionKey, ReadGating>;

/** Each section's 404 posture off its primaryRead declaration; the mock's denial barrier reads the same. */
const DENIAL_POSTURE: Record<SectionKey, DenialPosture> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, denialPosture(section)]),
) as Record<SectionKey, DenialPosture>;

/**
 * Sections whose resources exist only under an ORGANIZATION owner: on a
 * personal account their handler's org probe 404s and the section no-ops
 * with a note, so check reports clean and apply reports applied - never
 * both in one mode. Derived from the sections' own ownerSensitivity
 * declarations (the same source the registry pins to the org-probe
 * endpoint), so a new org-only section joins the fold without a hand edit
 * here.
 */
const ORG_ONLY_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.ownerSensitivity === "org").map((section) => section.key),
);

/**
 * Sections that declare NO read at all - REST or GraphQL
 * (check_suite_preferences today): check mode issues zero requests for them -
 * the cannot-verify note is not an outcome - so they are ALWAYS clean in
 * check mode no matter what the mask says, and apply-mode preflight has
 * nothing to probe, so the barrier can never arm on them (the denial
 * surfaces mid-apply on the first write instead). Derived through
 * sectionOperations, the same flattened view the mock routes and the
 * write-gate collapse read, so a section gaining a read of EITHER kind
 * drops out automatically. Exported for the fuzz unfaultable battery, whose
 * empty-read-derivation guard stays armed for every section outside this
 * set.
 */
export const NO_READ_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => planningReads(section).length === 0).map((section) => section.key),
);

/** Map a section's repo resources to the mask keys they use (org is separate). */
function repoMaskKeys(permission: SectionPermission): MaskKey[] {
  return [...permission.repo];
}

/**
 * The grade a mask GRANTS a section: the MAX over its repo resources (any one
 * grants), then none if its required org permission is absent; an unlisted
 * resource is write. What the section can DO with it is effectiveGrades' question.
 */
export function sectionGrade(
  key: SectionKey,
  mask: Partial<Record<MaskKey, MaskGrade>>,
  orgMask: Partial<Record<MaskKey, MaskGrade>> = mask,
): MaskGrade {
  const permission = PERMISSION_BY_KEY[key];
  let repoGrade: MaskGrade = "none";
  for (const maskKey of repoMaskKeys(permission)) {
    const grade = mask[maskKey] ?? "write";
    if (GRADE_RANK[grade] > GRADE_RANK[repoGrade]) {
      repoGrade = grade;
    }
  }
  if (permission.org !== "members") {
    return repoGrade;
  }
  // teams also needs org_members, but only as a READ-GATE: the org_members
  // permission gates the organization PROBE (a read), while the team writes go
  // through the repo administration permission. So org_members "none" denies the
  // section outright (grade none); "read" or "write" leaves the repo grade
  // intact (org_members write is NOT required to write teams). Capping the grade
  // by org_members would wrongly downgrade an administration-write + members-read
  // token to read-grade.
  //
  // The org_members gate reads from `orgMask`, which differs from `mask` ONLY in
  // multi-repo mode: the mock grades teams' org-scoped endpoints
  // (PUT /orgs/{org}/teams/.../repos/{owner}/{repo}, which start with /orgs/ not
  // /repos/) against the GLOBAL token mask, never the per-slug overlay. So a
  // per-slug org_members:none does NOT gate teams; the global one does. In
  // single-repo mode orgMask defaults to mask and this is a no-op.
  const orgGrade = orgMask.org_members ?? "write";
  return orgGrade === "none" ? "none" : repoGrade;
}

/**
 * The grades a section may RUN at: the grant folded through its read gating. Only
 * a read grant folds: write-gated collapses to none (the first read is denied),
 * mixed keeps both, since reaching a gated read depends on the declared content.
 */
export function effectiveGrades(grant: MaskGrade, gating: ReadGating): readonly MaskGrade[] {
  if (grant !== "read" || gating === "plain") {
    return [grant];
  }
  return gating === "write-gated" ? ["none"] : ["read", "none"];
}

/** The predicted set of outcomes a section may land in, given the run's shape. */
export interface SectionPrediction {
  key: SectionKey;
  /** The grades the section may run at (effectiveGrades); each contributes to `allowed`. */
  grades: readonly MaskGrade[];
  /** The outcomes the section is allowed to report; the runner must see one. */
  allowed: Set<Outcome>;
  /** True when the section can write under this prediction (drives universals). */
  mayWrite: boolean;
}

/** Every 404 posture a denied read can have (DenialPosture, enumerated). */
const DENIAL_POSTURES: readonly DenialPosture[] = ["denied", "absent"];

/** Predict one section's allowed outcome set under its declared read gating. */
export function predictSection(key: SectionKey, meta: ScenarioMeta): SectionPrediction {
  return predictSectionAt(key, meta, READ_GATING[key]);
}

/**
 * The union of the per-grade predictions over effectiveGrades. A mixed section
 * denied under a READ grant stops at a gated read whose 404 posture may differ
 * from the section's primary read's, so that arm covers both postures.
 *
 * Two folds precede the grades because they decide whether the mask is
 * consulted at all: exclusion (the section never runs) and the org-only
 * no-op on a personal account (the section runs, but never past its
 * ungated org probe).
 */
export function predictSectionAt(
  key: SectionKey,
  meta: ScenarioMeta,
  gating: ReadGating,
): SectionPrediction {
  const grant = sectionGrade(key, meta.mask, meta.orgMask ?? meta.mask);
  const grades = effectiveGrades(grant, gating);
  // A declared section outside the `sections` allowlist never runs: the engine
  // reports it "excluded" before any read (orchestrate.ts), so exclusion folds
  // before EVERYTHING - grades, denial semantics, and witnesses alike. An
  // EMPTY allowlist means unrestricted, mirroring orchestrate.ts's size > 0
  // gate, so only a non-empty list excludes.
  if (
    meta.onlySections !== undefined &&
    meta.onlySections.length > 0 &&
    !meta.onlySections.includes(key)
  ) {
    return { key, grades, allowed: new Set(["excluded"]), mayWrite: false };
  }
  // An org-only section on a personal account no-ops regardless of mask: its
  // org probe (declared permission "none", so no mask key gates it) 404s and
  // the handler returns with only a note, before any gated read or write. The
  // run therefore never meets a denial: by sectionGrade's own convention an
  // ungated resource is graded write, so the section runs write-granted with
  // nothing to write - check reports clean and apply reports applied, never
  // both in one mode, and no consumer (preflight, convergence, the
  // write-denied set) sees the mask's grade, which the run never reached.
  if (ORG_ONLY_SECTIONS.has(key) && meta.ownerKind === "user") {
    return {
      key,
      grades: ["write"],
      allowed: new Set([meta.mode === "check" ? "clean" : "applied"]),
      mayWrite: false,
    };
  }
  const deniedAtGatedRead = gating === "mixed" && grant === "read";
  const arms = grades.flatMap((grade) =>
    grade === "none" && deniedAtGatedRead
      ? DENIAL_POSTURES.map((posture) => predictAtGrade(key, meta, grade, posture))
      : [predictAtGrade(key, meta, grade, DENIAL_POSTURE[key])],
  );
  return {
    key,
    grades,
    allowed: new Set(arms.flatMap((arm) => [...arm.allowed])),
    mayWrite: arms.some((arm) => arm.mayWrite),
  };
}

/**
 * One section's allowed outcomes at ONE grade, from mode, policy, denial style,
 * and the denied read's 404 posture. A seeded live-state WITNESS tightens
 * {clean, drift} to one outcome, but only after the permission/policy fold.
 * The section is known to run and to reach its mask-graded reads here;
 * predictSectionAt folds exclusion and the personal-account no-op first.
 */
function predictAtGrade(
  key: SectionKey,
  meta: ScenarioMeta,
  grade: MaskGrade,
  posture: DenialPosture,
): Pick<SectionPrediction, "allowed" | "mayWrite"> {
  const check = meta.mode === "check";
  const required = meta.requiredSections.includes(key);
  const witness = meta.liveKinds?.[key];
  // A section with no read endpoint makes NO request in check mode, so it is
  // exactly clean regardless of the mask - there is nothing a denial could
  // deny - and no witness kind is modeled for it.
  if (check && NO_READ_SECTIONS.has(key)) {
    return { allowed: new Set(["clean"]), mayWrite: false };
  }

  if (grade === "write") {
    if (witness === "matching") {
      // The live state mirrors every field the handler diffs, so no write is
      // ever attempted: check is exactly clean and apply a no-op applied.
      return { allowed: new Set([check ? "clean" : "applied"]), mayWrite: false };
    }
    if (witness !== undefined) {
      // A seeded drift witness: check MUST report drift (a clean here is a
      // false-negative drift detector); apply writes and reports applied.
      return { allowed: new Set([check ? "drift" : "applied"]), mayWrite: !check };
    }
    return {
      allowed: check ? new Set(["clean", "drift"]) : new Set(["applied"]),
      mayWrite: !check,
    };
  }

  // A denied read reads as a permission error or a missing resource by the denial style and the
  // section's posture. A section with no reads can never be read-denied, whatever the style: its
  // denial surfaces on the apply-mode write, like the fine_grained "absent" model.
  const readsAsDenied =
    grade === "none" &&
    !NO_READ_SECTIONS.has(key) &&
    (meta.denialStyle === 403 || posture === "denied");

  if (grade === "none" && readsAsDenied) {
    // Preflight (or the first read) classifies this as a permission denial.
    if (check) {
      // Check mode: a denied required section fails; otherwise skipped/failed
      // by policy.
      const allowed: Set<Outcome> =
        required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
      return { allowed, mayWrite: false };
    }
    // Apply mode: fail policy or required means the whole run fails at preflight
    // with zero writes; warn means the section is skipped.
    const allowed: Set<Outcome> =
      required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
    return { allowed, mayWrite: false };
  }

  // grade none, fine_grained, absent posture: reads look like missing
  // resources, so check reports clean/drift and apply attempts the first write
  // (which is 403-denied). grade read: reads pass, first write 403-denied.
  if (check) {
    if (witness === "matching") {
      return { allowed: new Set(["clean"]), mayWrite: false };
    }
    if (witness !== undefined) {
      return { allowed: new Set(["drift"]), mayWrite: false };
    }
    return { allowed: new Set(["clean", "drift"]), mayWrite: false };
  }
  if (witness === "matching") {
    // No write is needed, so the missing write grant is never exercised: the
    // section lands applied even though a write would have been denied.
    return { allowed: new Set(["applied"]), mayWrite: false };
  }
  if (witness !== undefined) {
    // The witness forces exactly one write, and every write is denied at this
    // grade: the section can never be a no-op "applied". Mirrors the mid-apply
    // PermissionDenied fold in orchestrate.ts.
    const allowed: Set<Outcome> =
      required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
    return { allowed, mayWrite: false };
  }
  // Apply: a needed write is denied mid-run. A required section (or fail
  // policy) cannot be skipped, so it fails; warn skips a non-required section.
  // A COMPARING section may still land "applied" when no write was actually
  // needed (the live state already matched) - but a no-read section has
  // nothing to compare against, so its write is unconditional AND
  // unavoidable: the denial is guaranteed and "applied" is unreachable.
  const canSilentlyApply = !NO_READ_SECTIONS.has(key);
  const allowed: Set<Outcome> =
    required || meta.policy === "fail"
      ? new Set(canSilentlyApply ? ["applied", "failed"] : ["failed"])
      : new Set(canSilentlyApply ? ["applied", "skipped"] : ["skipped"]);
  // In absent/read cases the section may attempt one write before the denial;
  // that write hits an "absent"-posture family (mock rule 4 tolerates it).
  return { allowed, mayWrite: posture === "absent" };
}

/** The worst-of section rank the engine uses to fold outcomes into a run result. */
const RESULT_RANK: Record<string, number> = {
  clean: 0,
  applied: 0,
  excluded: 0,
  skipped: 1,
  drift: 2,
  failed: 3,
};

/** The whole-run prediction: per-section classes plus run-level constraints. */
export interface RunPrediction {
  sections: SectionPrediction[];
  /** Exit codes the run may produce (a set, since some sections span classes). */
  allowedExitCodes: Set<number>;
  /** No write may occur in check mode, ever (mock rule 3). */
  noWritesInCheck: boolean;
  /** Sections whose denied writes must never mutate state (mock rule 4). */
  writeDeniedSections: SectionKey[];
  /**
   * True when every ACTIVE section is write-granted (convergence expected).
   * Excluded sections never run, so they do not count against this.
   */
  fullyGranted: boolean;
  /**
   * Whether the run aborts at the preflight barrier (apply + fail policy, a denied
   * preflight READ) before rendering any section; "possible" when only a mixed
   * section under a read grant could arm it. Judged by judgePreflightAbort.
   */
  preflightAborts: PreflightAbort;
}

export type PreflightAbort = "no" | "yes" | "possible";

/**
 * Whether a run DID abort at the barrier: the "preflight failed" annotation
 * decides, and a row-less summary table plus the "failed" result must agree with it.
 */
export type AbortVerdict =
  | { kind: "aborted" }
  | { kind: "ran" }
  | { kind: "contradiction"; problem: string };

/**
 * Every table body row the summary rendered, well-formed or not: any pipe
 * line that is neither a header (`| Section |`, `| Repository |`) nor the
 * `|---|` separator. Counted raw so a malformed row cannot pass as "no rows".
 */
function renderedSummaryRows(summary: string): string[] {
  return summary
    .split("\n")
    .filter((line) => /^\|/.test(line) && !/^\|\s*(Section|Repository)\s*\|/.test(line))
    .filter((line) => !/^\|(-+\|)+$/.test(line));
}

export function judgePreflightAbort(
  predicted: PreflightAbort,
  observed: { summary: string; result: string | undefined; stdout: string },
): AbortVerdict {
  const contradiction = (problem: string): AbortVerdict => ({ kind: "contradiction", problem });
  if (!/^::error::preflight failed/m.test(observed.stdout)) {
    return predicted === "yes"
      ? contradiction(
          'a certain preflight abort was predicted, but the run never annotated "preflight failed"',
        )
      : { kind: "ran" };
  }
  const rendered = renderedSummaryRows(observed.summary);
  if (rendered.length > 0 || observed.result !== "failed") {
    return contradiction(
      `the run annotated "preflight failed" yet rendered ${rendered.length} summary row(s) and result "${observed.result}"`,
    );
  }
  return predicted === "no"
    ? contradiction("no preflight abort was predicted, but the run aborted at the barrier")
    : { kind: "aborted" };
}

/** The run-level fold of per-section abort verdicts: any "yes" aborts, else any "possible" may. */
function foldPreflightAbort(verdicts: readonly PreflightAbort[]): PreflightAbort {
  if (verdicts.includes("yes")) {
    return "yes";
  }
  return verdicts.includes("possible") ? "possible" : "no";
}

/** True when the section runs write-granted for certain (its only effective grade is write). */
function writeGranted(section: SectionPrediction): boolean {
  return section.grades.every((grade) => grade === "write");
}

/**
 * Whether preflight (reads only) denies the section: grade none and the denial
 * reads as a permission error (403 style, or "denied" semantics). Two effective
 * grades make it "possible": the probe reaches the gated read only for some content.
 */
export function preflightDeniable(section: SectionPrediction, meta: ScenarioMeta): PreflightAbort {
  // Preflight only probes ACTIVE sections (orchestrate.ts filters by the
  // allowlist first), so an excluded section can never arm the barrier.
  if (section.allowed.has("excluded")) {
    return "no";
  }
  if (NO_READ_SECTIONS.has(section.key)) {
    // No read endpoints: preflight probes nothing, so the barrier cannot arm.
    return "no";
  }
  if (!section.grades.includes("none")) {
    return "no";
  }
  if (section.grades.length > 1) {
    return "possible";
  }
  const posture = DENIAL_POSTURE[section.key];
  return meta.denialStyle === 403 || posture === "denied" ? "yes" : "no";
}

/**
 * Predict the whole run: fold the per-section predictions into the run-level
 * exit-code set and the universal properties. Exit code follows the worst-of
 * ranking (failed or check-mode drift exits 1; everything else 0), computed as
 * a set because some sections' allowed classes span ranks.
 */
export function predictOutcomes(meta: ScenarioMeta): RunPrediction {
  const sections = meta.sections.map((key) => predictSection(key, meta));
  const check = meta.mode === "check";
  const preflightAborts: PreflightAbort =
    !check && meta.policy === "fail"
      ? foldPreflightAbort(sections.map((s) => preflightDeniable(s, meta)))
      : "no";

  // Compute the exit-code set: for each combination of per-section outcomes the
  // classes allow, the worst rank decides the exit. We only need the extremes:
  // the best-case (lowest worst rank) and worst-case (highest) outcomes.
  const exitCodes = new Set<number>();
  for (const pick of [bestOutcomes(sections), worstOutcomes(sections)]) {
    const worst = Math.max(0, ...pick.map((o) => RESULT_RANK[o] ?? 0));
    // Exit 1 on failed (rank 3), or in check mode on drift (rank 2).
    exitCodes.add(worst >= 3 || (check && worst >= 2) ? 1 : 0);
  }

  return {
    sections,
    allowedExitCodes: exitCodes,
    noWritesInCheck: check,
    writeDeniedSections: sections.filter((s) => !writeGranted(s) && !s.mayWrite).map((s) => s.key),
    // Excluded sections never run, so they cannot break convergence or
    // idempotence: fullyGranted quantifies over the sections that WILL run.
    fullyGranted: sections.every((s) => s.allowed.has("excluded") || writeGranted(s)),
    preflightAborts,
  };
}

/** The worst-of rank of an outcome (defaults to 0 for unknown outcomes). */
function rank(outcome: Outcome): number {
  return RESULT_RANK[outcome] ?? 0;
}

/** The best (lowest-rank) outcome each section allows. */
function bestOutcomes(sections: SectionPrediction[]): Outcome[] {
  return sections.map((s) => [...s.allowed].sort((a, b) => rank(a) - rank(b))[0] as Outcome);
}

/** The worst (highest-rank) outcome each section allows. */
function worstOutcomes(sections: SectionPrediction[]): Outcome[] {
  return sections.map((s) => [...s.allowed].sort((a, b) => rank(b) - rank(a))[0] as Outcome);
}

/** The prediction for one multi-repo target: its per-repo run, or "skipped". */
interface RepoPrediction {
  slug: string;
  /**
   * The repos-result KEY the action emits for this target: the
   * "private repository #N" placeholder when redacted, else the slug. The fuzz
   * comparison keys on this, since a redacted target never appears under its
   * real slug.
   */
  displayKey: string;
  /** True when this target is hidden from the public view (drives the leak check). */
  redacted: boolean;
  /**
   * null when this target produces no per-section run: it has no settings file
   * and the scenario has no defaults document (skipped), or its settings read
   * is denied (failed). In both cases `allowedResults` carries the repo-level
   * outcome the action reports.
   */
  run: RunPrediction | null;
  /**
   * The repo-level result strings this target may report. For a target that
   * runs (its own document, or the defaults document) it is the union of its
   * sections' outcomes (plus the multi "partial" alias); for a settings-gated
   * target it is the gate outcome (skipped, or failed).
   */
  allowedResults: Set<string>;
}

/** The whole multi-repo prediction: per-target runs plus the rolled-up exit. */
export interface MultiPrediction {
  repos: RepoPrediction[];
  /** Exit codes the multi run may produce (worst-of over the targets). */
  allowedExitCodes: Set<number>;
  /**
   * Every string that must appear in NO public surface when redaction is active:
   * each redacted target's real slug plus its planted canaries. The leak
   * invariant asserts their absence from stdout/summary/outputs.
   */
  forbidden: string[];
}

/**
 * Fold a per-section outcome into the engine's three roll-up flags, mirroring
 * orchestrate.ts: "failed" sets failed, check-mode "drift" sets drifted, and a
 * "skipped" (warn) or the multi "partial" alias sets partial. Other outcomes
 * (applied/clean/excluded) leave the flags untouched.
 */
function foldFlags(
  outcome: string,
  flags: { failed: boolean; drifted: boolean; partial: boolean },
) {
  if (outcome === "failed") {
    flags.failed = true;
  } else if (outcome === "drift") {
    flags.drifted = true;
  } else if (outcome === "skipped" || outcome === "partial") {
    flags.partial = true;
  }
}

/** The engine's repo-result fold (orchestrate.ts) from the three roll-up flags. */
function repoResultFrom(
  flags: { failed: boolean; drifted: boolean; partial: boolean },
  check: boolean,
): string {
  if (flags.failed) {
    return "failed";
  }
  if (check) {
    return flags.drifted ? "drift" : flags.partial ? "partial" : "clean";
  }
  return flags.partial ? "partial" : "applied";
}

/**
 * Fold OBSERVED section outcomes into the repo result the engine reports,
 * composing the same foldFlags + repoResultFrom mirror predictMulti proves on
 * every multi iteration. The fuzz self-consistency invariant asserts that the
 * `result` output equals this fold over the summary's outcome table.
 */
export function foldSectionOutcomes(outcomes: string[], check: boolean): string {
  const flags = { failed: false, drifted: false, partial: false };
  for (const outcome of outcomes) {
    foldFlags(outcome, flags);
  }
  return repoResultFrom(flags, check);
}

/**
 * The repo-result worst-first order the MULTI rollup folds with, mirroring orchestrate.ts's
 * REPO_RESULTS exactly (multi.ts computes the overall result as worstOf over per-target results).
 * A harness-local mirror, NOT an import: the engine's own order would agree with its own regression.
 */
const MULTI_RESULT_ORDER = ["failed", "drift", "partial", "skipped", "applied", "clean"] as const;

/** The multi rollup fold: the worst result present, mirroring worstOf(). */
export function foldRepoResults(results: string[], check: boolean): string {
  for (const rank of MULTI_RESULT_ORDER) {
    if (results.includes(rank)) {
      return rank;
    }
  }
  return check ? "clean" : "applied";
}

/**
 * The repo-level result strings a per-repo run may report, computed MECHANICALLY
 * by folding the per-section allowed outcomes through the engine's exact
 * roll-up (orchestrate.ts), not a loose union. Each section independently
 * contributes its best-case (does not set a flag) and worst-case (sets its flag)
 * outcome, so the reachable set of (failed, drifted, partial) flag combinations
 * is the product over sections; the result set is repoResultFrom over that
 * product. A preflight-aborting target is always "failed".
 */
function runResultClass(run: RunPrediction): Set<string> {
  const check = run.noWritesInCheck;
  if (run.preflightAborts === "yes") {
    return new Set(["failed"]);
  }
  // Reachable flag combinations: start from all-false and, per section, branch
  // into "contributes its flag" vs "does not", using the section's allowed set.
  let combos: Array<{ failed: boolean; drifted: boolean; partial: boolean }> = [
    { failed: false, drifted: false, partial: false },
  ];
  for (const section of run.sections) {
    const next: typeof combos = [];
    for (const combo of combos) {
      for (const outcome of section.allowed) {
        const branched = { ...combo };
        foldFlags(outcome, branched);
        next.push(branched);
      }
    }
    combos = next;
  }
  const results = new Set<string>();
  for (const combo of combos) {
    results.add(repoResultFrom(combo, check));
  }
  return results;
}

/**
 * Predict a multi-repo run: predict each target independently, then apply the
 * mechanical rollup. A target without a settings file runs the defaults
 * document when the scenario has one (meta.defaults) and is skipped otherwise.
 * A target is settings-gated (no per-section run) when it is skipped or its
 * settings read fails. The run exits 1 when any target fails, or in check mode
 * when any target drifts; skipped targets do not raise the exit alone.
 */
export function predictMulti(meta: MultiScenarioMeta): MultiPrediction {
  const repos: RepoPrediction[] = meta.repos.map((repo) => {
    const common = {
      slug: repo.slug,
      displayKey: displayKeyOf(repo),
      redacted: repo.redaction.kind === "redacted",
    };
    if (repo.target.kind === "missing") {
      // No settings file: the contents read 404s and the default branch's ref
      // read proves the file absent. With a defaults document the target runs
      // it under this slug's mask (none is set: the mock grades it at the
      // default write grade); without one it is skipped.
      if (meta.defaults === undefined) {
        return { ...common, run: null, allowedResults: new Set(["skipped"]) };
      }
      const run = predictOutcomes(meta.defaults);
      return { ...common, run, allowedResults: runResultClass(run) };
    }
    if (repo.target.kind === "raw-invalid") {
      // Raw settings text FAILS before any section runs: an unparseable body
      // dies at the parse gate ("cannot parse <slug>"), a non-mapping one at
      // the top-level validator. Never skipped.
      return { ...common, run: null, allowedResults: new Set(["failed"]) };
    }
    const repoMeta = repo.target.meta;
    // The settings file read itself needs contents, and a denied read gates
    // the whole target before any section runs. The action reads a missing
    // file as such only once the default branch's Contents-gated ref read
    // succeeds (src/github/repo-file.ts); a Contents-denied token fails that
    // proof under every denial style (403 outright, fine_grained on the ref),
    // so the target FAILS - it never reads as fileless and never falls back.
    if ((repoMeta.mask.contents ?? "write") === "none") {
      return { ...common, run: null, allowedResults: new Set(["failed"]) };
    }
    const run = predictOutcomes(repoMeta);
    return { ...common, run, allowedResults: runResultClass(run) };
  });

  // A FATAL core.contentsGet fault (injected by the fuzz iteration) kills the
  // FIRST target's settings fetch, so the victim fails outright - overriding
  // whatever gate its kind would otherwise hit (missing-file skip,
  // contents-denied gate, raw parse gate alike). The key is matched
  // explicitly so a future second core-fault key cannot silently reuse the
  // contents-specific victim rule.
  if (meta.coreFault?.key === "core.contentsGet" && meta.coreFault.fatal && repos.length > 0) {
    const victim = repos[0] as RepoPrediction;
    repos[0] = { ...victim, run: null, allowedResults: new Set(["failed"]) };
  }

  const exitCodes = new Set<number>();
  const perTargetExit = repos.map((r) => {
    if (r.run) {
      return r.run.allowedExitCodes;
    }
    // A settings-gated target: failed raises exit 1, skipped stays 0.
    return r.allowedResults.has("failed") ? new Set([1]) : new Set([0]);
  });
  const anyCanFail = perTargetExit.some((set) => set.has(1));
  const allCanPass = perTargetExit.every((set) => set.has(0));
  if (allCanPass) {
    exitCodes.add(0);
  }
  if (anyCanFail) {
    exitCodes.add(1);
  }
  // The leak invariant's forbidden set: every redacted target's real slug plus
  // its planted canaries. Under `show` nothing is redacted, so the set is empty.
  const forbidden: string[] = [];
  for (const repo of meta.repos) {
    if (repo.redaction.kind === "redacted") {
      forbidden.push(repo.slug, ...repo.redaction.canaries);
    }
  }
  return { repos, allowedExitCodes: exitCodes, forbidden };
}

/** One repo the discovery pool enumerates, as the mock and oracle both see it. */
export interface DiscoveryRepo {
  slug: string;
  archived?: boolean;
  fork?: boolean;
  visibility?: string;
  topics?: string[];
}

/** The discovery-filter inputs, defaulted the same way the action defaults them. */
export interface DiscoveryFilters {
  visibility?: string;
  archived?: string;
  forks?: string;
  topics?: string;
  exclude?: string;
}

/**
 * An INDEPENDENT glob matcher for the exclude filter, deliberately NOT calling
 * src's excludeMatches (which compiles to a RegExp): this is a char-by-char
 * two-pointer matcher with backtracking, so a bug in either implementation
 * surfaces as a disagreement instead of hiding. `*` matches any run (including
 * empty); all other characters match literally, case-insensitively. A pattern
 * with "/" matches the full slug, otherwise the name portion - mirroring the
 * repos-dir <name>.yml vs <owner>/<name>.yml split.
 */
function globMatches(pattern: string, slug: string): boolean {
  const target = (pattern.includes("/") ? slug : (slug.split("/")[1] ?? slug)).toLowerCase();
  const pat = pattern.toLowerCase();
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < target.length) {
    if (p < pat.length && (pat[p] === target[t] || pat[p] === "*")) {
      if (pat[p] === "*") {
        star = p;
        mark = t;
        p++;
      } else {
        p++;
        t++;
      }
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") {
    p++;
  }
  return p === pat.length;
}

/**
 * Predict the set of slugs a `repos: "*"` discovery keeps, by mirroring the
 * action's documented filter rules INDEPENDENTLY (not by calling discoverRepos,
 * so a shared bug cannot hide). Order matches the engine's attribution order:
 * visibility, archived, forks, topics, exclude. The exclude match uses the
 * independent globMatches above rather than src's excludeMatches.
 */
export function predictDiscovery(pool: DiscoveryRepo[], filters: DiscoveryFilters): string[] {
  const visibility = filters.visibility ?? "all";
  const archived = filters.archived ?? "skip";
  const forks = filters.forks ?? "include";
  const topics = (filters.topics ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const exclude = (filters.exclude ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const repo of pool) {
    const vis = repo.visibility ?? "public";
    // Visibility is the net of the server-side query narrowing plus the
    // action's client-side settle: public keeps only public; private keeps
    // only private (the API returns private+internal, the action drops
    // internal); internal keeps only internal; all/absent keeps everything.
    if (visibility === "public" && vis !== "public") {
      continue;
    }
    if (visibility === "private" && vis !== "private") {
      continue;
    }
    if (visibility === "internal" && vis !== "internal") {
      continue;
    }
    if (archived === "skip" && repo.archived) {
      continue;
    }
    if (archived === "only" && !repo.archived) {
      continue;
    }
    if (forks === "exclude" && repo.fork) {
      continue;
    }
    if (forks === "only" && !repo.fork) {
      continue;
    }
    if (topics.length > 0 && !(repo.topics ?? []).some((t) => topics.includes(t.toLowerCase()))) {
      continue;
    }
    if (exclude.some((pattern) => globMatches(pattern, repo.slug))) {
      continue;
    }
    kept.push(repo.slug);
  }
  return kept;
}

// --- mode: merge -------------------------------------------------------------

/**
 * A lower declaration a higher layer's null removed: the engine's notice
 * record, whose wording (describeOptOut) the fuzz shares with the action so
 * the two cannot drift; the oracle computes the layer and the path itself.
 */
export type MergeNotice = OptOutNotice;

/**
 * The merge oracle's verdict: the exact document a valid stack folds to, the
 * layer the boundary refuses, or a fold whose result the post-merge validator
 * rejects (two layers each valid on their own can combine into a document
 * that is not - a lower `allowed_actions: selected` with its allowlist under
 * a higher `allowed_actions: all`).
 */
export type MergePrediction =
  | { kind: "merged"; merged: Json; notices: MergeNotice[] }
  | { kind: "refused"; layer: string }
  | { kind: "invalid"; error: string };

/**
 * A list the merge combines by identity: the keys one entry claims (two
 * entries are one resource when their key sets intersect), whether a matched
 * pair replaces or merges, and the fields of a merged entry that are keyed
 * lists themselves.
 */
interface KeyedList {
  /** Every identity the entry claims, folded; null when it carries none (refused at the boundary). */
  keysOf: (entry: Json) => readonly string[] | null;
  /** The entry field the keys are read from, for naming a keyless entry the fold cannot place. */
  keyField: string;
  combine: "replace" | "merge";
  nested?: Readonly<Record<string, KeyedList>>;
}

/** The keys a label claims: its rename target (or its name), plus its current name when it renames. */
function labelKeys(entry: Json): readonly string[] | null {
  const names = entry.new_name === undefined ? [entry.name] : [entry.new_name, entry.name];
  if (!names.every((name): name is string => typeof name === "string")) {
    return null;
  }
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

/** The one key a field names, when it is a string. */
function singleKey(field: string): KeyedList["keysOf"] {
  return (entry) => (typeof entry[field] === "string" ? [entry[field]] : null);
}

/**
 * The keyed sections in the oracle's OWN words, not read off the section
 * modules: labels claim their case-folded name and rename target and replace
 * wholesale, rulesets pair by exact name and merge key by key, their rules
 * pairing by type and replacing. A module whose layering declaration drifts
 * from this table is a disagreement the fuzz surfaces (oracle.test.ts pins
 * the two against each other by hand, as data).
 */
export const KEYED_MERGE_SECTIONS: Readonly<Partial<Record<UndeclaredPolicySection, KeyedList>>> = {
  labels: { keysOf: labelKeys, keyField: "name", combine: "replace" },
  rulesets: {
    keysOf: singleKey("name"),
    keyField: "name",
    combine: "merge",
    nested: { rules: { keysOf: singleKey("type"), keyField: "type", combine: "replace" } },
  },
};

/**
 * The policy a knobbed section resolves to when no layer set one: the
 * section's own undeclaredDefault declaration, the same data the README's
 * Undeclared-default column renders.
 */
const UNDECLARED_DEFAULTS: Record<UndeclaredPolicySection, "keep" | "delete"> = Object.fromEntries(
  UNDECLARED_POLICY_SECTIONS.map((key) => {
    const section = SECTIONS.find((candidate) => candidate.key === key);
    if (section === undefined || section.undeclaredDefault === "untouched") {
      throw new Error(`${key} is knobbed but declares no keep/delete default`);
    }
    return [key, section.undeclaredDefault];
  }),
) as Record<UndeclaredPolicySection, "keep" | "delete">;

function isMapping(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnobbed(key: string): key is UndeclaredPolicySection {
  return (UNDECLARED_POLICY_SECTIONS as readonly string[]).includes(key);
}

function isDirective(value: unknown): value is LayeringDirective {
  return LAYERING_DIRECTIVES.some((directive) => directive === value);
}

/** A knobbed section's value in wrapper form: a plain list becomes `{entries}`, a wrapper stays. */
function asWrapper(value: unknown): Json {
  return Array.isArray(value) ? { entries: value } : (value as Json);
}

/** Where a notice attributes a deletion: the layer that made it and the path it removed. */
interface Site {
  layer: string;
  notices: MergeNotice[];
}

/**
 * A slot holding what the layers so far said about one key: nothing yet,
 * a null that stayed as written, or a value. The fold is a reduction of a
 * column of contributions (one per layer that mentions the key) into a slot.
 */
type Slot = unknown;

/** The path of a nested key, for the notice that names it. */
function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * The dialect's one sentence about a higher value, applied to a slot:
 * "Plain objects merge key by key; a higher scalar, array, or tagged value
 * replaces; a higher null deletes what a lower layer declared (reported as a
 * notice) and stays as written when nothing below declares the key."
 * `keyedFields` names the fields of two mappings whose lists combine by key
 * (a ruleset's rules) instead of replacing.
 */
function settle(
  slot: Slot,
  higher: unknown,
  path: string,
  site: Site,
  keyedFields?: Readonly<Record<string, KeyedList>>,
): Slot {
  if (higher === null) {
    if (slot !== undefined && slot !== null) {
      site.notices.push({ layer: site.layer, path });
      return undefined;
    }
    return null;
  }
  if (isMapping(slot) && isMapping(higher)) {
    return mergeTrees(slot, higher, path, site, keyedFields);
  }
  return structuredClone(higher);
}

/**
 * Key-by-key: every key either side names, in the lower mapping's order and
 * then the higher's; a key only one side names is taken as is, a key both
 * name is settled. A settled key that came out deleted is absent.
 */
function mergeTrees(
  lower: Json,
  higher: Json,
  path: string,
  site: Site,
  keyedFields?: Readonly<Record<string, KeyedList>>,
): Json {
  const out: Json = {};
  for (const key of new Set([...Object.keys(lower), ...Object.keys(higher)])) {
    if (!(key in higher) || higher[key] === undefined) {
      out[key] = lower[key];
      continue;
    }
    const keyed = keyedFields?.[key];
    const settled =
      keyed !== undefined && Array.isArray(lower[key]) && Array.isArray(higher[key])
        ? unionKeyed(lower[key] as Json[], higher[key] as Json[], keyed, at(path, key), site)
        : settle(lower[key], higher[key], at(path, key), site, undefined);
    if (settled !== undefined) {
      out[key] = settled;
    }
  }
  return out;
}

/** An entry's keys; the boundary refused every keyless entry before the fold runs. */
function keysOrThrow(entry: Json, keyed: KeyedList): readonly string[] {
  const keys = keyed.keysOf(entry);
  if (keys === null) {
    throw new Error(`a keyless ${keyed.keyField} entry reached the fold: ${JSON.stringify(entry)}`);
  }
  return keys;
}

/** Whether two entries are one resource: their key sets intersect. */
function sameResource(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

/**
 * "Unions its entries by identity": a higher entry supersedes every lower
 * entry it matches and stands where the first of them stood, replaced
 * wholesale or merged key by key into that first one with its own keyed
 * fields, per the section's combine. Lower entries nothing matched keep
 * their order; higher entries matching nothing append in theirs. Matching
 * reads the lower list as it stood before this layer, so two higher entries
 * claiming one lower entry between them both take its slot, in their order.
 * A notice from inside a merged entry names it by its INDEX in the higher
 * layer's list (the list the null was written in), never by a key value.
 */
function unionKeyed(
  lower: Json[],
  higher: Json[],
  keyed: KeyedList,
  path: string,
  site: Site,
): Json[] {
  const lowerKeys = lower.map((entry) => keysOrThrow(entry, keyed));
  const higherKeys = higher.map((entry) => keysOrThrow(entry, keyed));
  const slotOf = higherKeys.map((keys) =>
    lowerKeys.findIndex((below) => sameResource(below, keys)),
  );
  const combine = (below: Json, entry: Json, h: number): Json =>
    keyed.combine === "replace"
      ? structuredClone(entry)
      : mergeTrees(below, entry, `${path}[${h}]`, site, keyed.nested);
  const out = lower.flatMap((below, index) => {
    const keys = lowerKeys[index] as readonly string[];
    if (!higherKeys.some((claims) => sameResource(claims, keys))) {
      return [below];
    }
    return higher.flatMap((entry, h) => (slotOf[h] === index ? [combine(below, entry, h)] : []));
  });
  out.push(...higher.flatMap((entry, h) => (slotOf[h] === -1 ? [structuredClone(entry)] : [])));
  return out;
}

/** One layer's mention of a section: the value it wrote and the layer's own file directive. */
interface Contribution {
  layer: string;
  value: unknown;
  fileDirective: LayeringDirective | undefined;
}

/**
 * A knobbed section's column: each contribution is read in wrapper form (a
 * plain list is `{entries}`), its knobs settle over the knobs below (an
 * omitted policy therefore inherits), and its entries union by key when the
 * effective layering says merge and the section has a key and there are
 * entries below to union with; otherwise they replace. A null contribution
 * settles like any other value.
 */
function reduceKnobbed(
  key: UndeclaredPolicySection,
  column: readonly Contribution[],
  run: LayeringDirective,
  notices: MergeNotice[],
): Slot {
  const keyed = KEYED_MERGE_SECTIONS[key];
  let slot: Slot;
  for (const { layer, value, fileDirective } of column) {
    const site: Site = { layer, notices };
    if (value === null) {
      slot = settle(slot, null, key, site);
      continue;
    }
    const { entries, [LAYERING_KEY]: directive, ...knobs } = asWrapper(value);
    const effective = (isDirective(directive) ? directive : undefined) ?? fileDirective ?? run;
    const below = isMapping(slot) ? slot : {};
    const { entries: belowEntries, ...belowKnobs } = below;
    const unite = effective === "merge" && keyed !== undefined && Array.isArray(belowEntries);
    slot = {
      ...mergeTrees(belowKnobs, knobs, key, site),
      entries: unite
        ? unionKeyed(belowEntries as Json[], entries as Json[], keyed, key, site)
        : structuredClone(entries),
    };
  }
  if (isMapping(slot) && Array.isArray(slot.entries) && slot[UNDECLARED_KEY] === undefined) {
    slot[UNDECLARED_KEY] = UNDECLARED_DEFAULTS[key];
  }
  return slot;
}

/**
 * The oracle's own fold, written from the dialect's description rather than
 * the engine: section by section, the column of the layers' contributions to
 * that section (low to high) is reduced into one slot - knobbed sections by
 * reduceKnobbed, every other section by settle - and a slot that ends
 * deleted is absent from the result. `_layering` is a directive the fold
 * consumes (a layer's top-level one governs its knobbed sections, a
 * wrapper's governs its own section), so none survives; private underscore
 * keys are not sections and are not part of the written document either.
 * Assumes every layer is admitted (refusedMergeLayer said so).
 */
export function foldMergeLayers(
  layers: readonly MergeLayer[],
  layering: LayeringDirective,
): { merged: Json; notices: MergeNotice[] } {
  const notices: MergeNotice[] = [];
  const merged: Json = {};
  for (const key of SECTION_KEYS) {
    const column: Contribution[] = layers.flatMap((layer) =>
      layer.doc[key] === undefined
        ? []
        : [
            {
              layer: layer.name,
              value: layer.doc[key],
              fileDirective: isDirective(layer.doc[LAYERING_KEY])
                ? layer.doc[LAYERING_KEY]
                : undefined,
            },
          ],
    );
    if (column.length === 0) {
      continue;
    }
    let slot: Slot;
    if (isKnobbed(key)) {
      slot = reduceKnobbed(key, column, layering, notices);
    } else {
      for (const { layer, value } of column) {
        slot = settle(slot, value, key, { layer, notices });
      }
    }
    if (slot !== undefined) {
      merged[key] = slot;
    }
  }
  return { merged, notices };
}

/**
 * Whether a keyed list declares two entries claiming one key (a label renaming
 * into a sibling's name included) or a keyless entry, at any nesting.
 */
function keyedListRefused(entries: readonly unknown[], keyed: KeyedList): boolean {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isMapping(entry)) {
      return true;
    }
    const keys = keyed.keysOf(entry);
    if (keys === null || keys.some((key) => seen.has(key))) {
      return true;
    }
    for (const key of keys) {
      seen.add(key);
    }
    for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
      const value = entry[field];
      if (Array.isArray(value) && keyedListRefused(value, nested)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The oracle's read of the layer boundary: the first layer (low to high)
 * carrying a directive outside merge|replace (at the file level or on a
 * wrapper), a knobbed section that is neither a list nor an `{entries}`
 * wrapper of mappings, an explicit `merge` on a section without a layering
 * key, or a keyed list with a duplicate or missing key. Undefined when every
 * layer is admitted.
 */
export function refusedMergeLayer(layers: readonly MergeLayer[]): string | undefined {
  for (const layer of layers) {
    const fileDirective = layer.doc[LAYERING_KEY];
    if (fileDirective !== undefined && !isDirective(fileDirective)) {
      return layer.name;
    }
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      const value = layer.doc[key];
      if (value === undefined || value === null) {
        continue;
      }
      const wrapper = asWrapper(value);
      if (!isMapping(wrapper) || !Array.isArray(wrapper.entries)) {
        return layer.name;
      }
      if (!wrapper.entries.every(isMapping)) {
        return layer.name;
      }
      const directive = wrapper[LAYERING_KEY];
      if (directive !== undefined && !isDirective(directive)) {
        return layer.name;
      }
      const keyed = KEYED_MERGE_SECTIONS[key];
      if (keyed === undefined && (directive ?? fileDirective) === "merge") {
        return layer.name;
      }
      if (keyed !== undefined && keyedListRefused(wrapper.entries, keyed)) {
        return layer.name;
      }
    }
  }
  return undefined;
}

/**
 * Predict a mode: merge run: a refused layer fails the run by name before
 * anything is written, a fold the validator rejects fails it naming the
 * merged document, otherwise the run writes exactly the folded document and
 * announces each null deletion. In every case the mock sees no request.
 */
export function predictMerge(meta: MergeScenarioMeta): MergePrediction {
  const refused = refusedMergeLayer(meta.layers);
  if (refused !== undefined) {
    return { kind: "refused", layer: refused };
  }
  const folded = foldMergeLayers(meta.layers, meta.layering);
  // The fold is the oracle's own; whether its result is a valid settings
  // document is the validator's question, the same one the run asks of the
  // document it just folded (cross-field rules the published schema cannot
  // spell, so the generator cannot avoid them by construction).
  const validated = validateSettingsDoc(folded.merged, "merged", new Set(), silentIo());
  if ("error" in validated) {
    return { kind: "invalid", error: validated.error };
  }
  return { kind: "merged", ...folded };
}

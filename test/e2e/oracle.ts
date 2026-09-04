/**
 * The fuzz oracle: predicts the CLASS of outcome for a generated scenario from
 * the permission mask, policy, and mode alone, never the drift content.
 * Predicting exact drift would reimplement the engine, and a bug shared by the
 * engine and the oracle would hide. So the oracle asserts only what follows
 * mechanically from the permission and policy model, plus the universal
 * properties every run must satisfy.
 */

import type { SectionKey } from "../../src/schema.js";
import {
  type DenialPosture,
  denialPosture,
  planningReads,
  type ReadGating,
  readGating,
} from "../../src/sections/contract/module.js";
import type { SectionPermission } from "../../src/sections/contract/permissions.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { displayKeyOf, type MultiScenarioMeta, type ScenarioMeta } from "./generators.js";
import { type DenialStyle, GRADE_RANK, type MaskGrade, type MaskKey } from "./schema.js";

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
 */
export function predictSectionAt(
  key: SectionKey,
  meta: ScenarioMeta,
  gating: ReadGating,
): SectionPrediction {
  const grant = sectionGrade(key, meta.mask, meta.orgMask ?? meta.mask);
  const grades = effectiveGrades(grant, gating);
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
    return { allowed: new Set(["excluded"]), mayWrite: false };
  }
  // An org-only section on a personal account no-ops regardless of mask:
  // its org probe 404s, the section returns with only a note, so check
  // reports clean and apply reports applied - never both in one mode.
  if (ORG_ONLY_SECTIONS.has(key) && meta.ownerKind === "user") {
    return { allowed: new Set([check ? "clean" : "applied"]), mayWrite: false };
  }
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
   * null when this target produces no per-section run: either it has no settings
   * file, or its settings file is unreadable because `contents` is denied. In
   * both cases `allowedResults` carries the repo-level outcome the action reports.
   */
  run: RunPrediction | null;
  /**
   * The repo-level result strings this target may report. For a normal target it
   * is the union of its sections' outcomes (plus the multi "partial" alias); for
   * a skipped/unreadable target it is the settings-gate outcome (skipped, or
   * failed under the 403 style / fail policy).
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
 * The repo-level result when a target's settings file cannot be read because
 * `contents` is denied. The action reads .github/settings.yml through the
 * contents endpoint before any section runs (src/github/repo-file.ts). A denied
 * contents read 404s; the action then probes the repo (an administration-gated
 * GET /repos/{slug}) to disambiguate:
 *   - 403 style: the contents read fails outright, so the target FAILS.
 *   - fine_grained + administration readable: the repo probe succeeds with
 *     pull:true, so the 404 reads as a missing file and the target is SKIPPED.
 *   - fine_grained + administration denied: the repo probe ALSO 404s, so the
 *     read is "visible but unreadable" and the target FAILS.
 */
function settingsGateResult(denialStyle: DenialStyle, adminGrade: MaskGrade): Set<string> {
  if (denialStyle === 403) {
    return new Set(["failed"]);
  }
  return adminGrade === "none" ? new Set(["failed"]) : new Set(["skipped"]);
}

/**
 * Predict a multi-repo run: predict each target independently, then apply the
 * mechanical rollup. A target is settings-gated (no per-section run) when it has
 * no settings file (skipped) or its `contents` grade is none, so the settings
 * file itself is unreadable. The run exits 1 when any target fails, or in check
 * mode when any target drifts; skipped targets do not raise the exit alone.
 */
export function predictMulti(meta: MultiScenarioMeta): MultiPrediction {
  const repos: RepoPrediction[] = meta.repos.map((repo) => {
    const common = {
      slug: repo.slug,
      displayKey: displayKeyOf(repo),
      redacted: repo.redaction.kind === "redacted",
    };
    if (repo.target.kind === "missing") {
      // No settings file: the contents read 404s and the target is skipped.
      return { ...common, run: null, allowedResults: new Set(["skipped"]) };
    }
    if (repo.target.kind === "raw-invalid") {
      // Raw settings text FAILS before any section runs: an unparseable body
      // dies at the parse gate ("cannot parse <slug>"), a non-mapping one at
      // the top-level validator. Never skipped.
      return { ...common, run: null, allowedResults: new Set(["failed"]) };
    }
    const repoMeta = repo.target.meta;
    // The settings file read itself needs contents; a denied contents read
    // gates the whole target before any section runs.
    const contentsGrade = repoMeta.mask.contents ?? "write";
    if (contentsGrade === "none") {
      const adminGrade = repoMeta.mask.administration ?? "write";
      return {
        ...common,
        run: null,
        allowedResults: settingsGateResult(repoMeta.denialStyle, adminGrade),
      };
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

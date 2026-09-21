/**
 * The fuzz oracle predicts the CLASS of outcome for a generated scenario from the permission mask,
 * policy, and mode, plus a seeded live-state witness, never the diff itself: predicting exact drift
 * would reimplement the engine, and a bug the two shared would hide.
 */

import type { RemovalNotice } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import {
  LIST_SECTIONS,
  type ListSection,
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
import {
  type Json,
  LAYERING_DIRECTIVES,
  LAYERING_KEY,
  type LayeringDirective,
  REMOVE_KEY,
  UNDECLARED_KEY,
  UNDECLARED_POLICIES,
  type UndeclaredPolicyWord,
} from "./gen-support.js";
import {
  displayKeyOf,
  type MergeLayer,
  type MergeScenarioMeta,
  type MultiScenarioMeta,
  type ScenarioMeta,
  standaloneViewOf,
} from "./generators.js";
import { GRADE_RANK, type MaskGrade, type MaskKey } from "./schema.js";

/** A section outcome the step summary can report. */
type Outcome = "applied" | "clean" | "drift" | "skipped" | "failed" | "excluded";

const PERMISSION_BY_KEY: Record<SectionKey, SectionPermission> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, section.permission]),
) as Record<SectionKey, SectionPermission>;

/** Each section's read gating, from the same declarations the mock's permission gate reads, so the two cannot disagree. */
const READ_GATING: Record<SectionKey, ReadGating> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, readGating(section)]),
) as Record<SectionKey, ReadGating>;

/** Each section's 404 posture off its primaryRead declaration; the mock's denial barrier reads the same. */
const DENIAL_POSTURE: Record<SectionKey, DenialPosture> = Object.fromEntries(
  SECTIONS.map((section) => [section.key, denialPosture(section)]),
) as Record<SectionKey, DenialPosture>;

/**
 * On a personal account these sections' org probe 404s and the handler no-ops with a note, so check
 * reports clean and apply reports applied, whatever the mask says.
 */
const ORG_ONLY_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => section.ownerSensitivity === "org").map((section) => section.key),
);

/**
 * Sections with no plan-time read, REST or GraphQL (check_suite_preferences today); fuzz.ts's
 * unfaultable battery keeps its empty-read guard armed for every section outside this set.
 *   check mode  -> no request at all, so always clean whatever the mask says
 *   apply mode  -> preflight has nothing to probe, so the barrier never arms; the denial surfaces on the first write
 */
export const NO_READ_SECTIONS: ReadonlySet<SectionKey> = new Set(
  SECTIONS.filter((section) => planningReads(section).length === 0).map((section) => section.key),
);

function repoMaskKeys(permission: SectionPermission): MaskKey[] {
  return [...permission.repo];
}

/** The grade a mask GRANTS a section's repository reads and writes, before its read gating folds it (effectiveGrades). */
export function sectionGrade(
  key: SectionKey,
  mask: Partial<Record<MaskKey, MaskGrade>>,
): MaskGrade {
  const permission = PERMISSION_BY_KEY[key];
  let repoGrade: MaskGrade = "none";
  for (const maskKey of repoMaskKeys(permission)) {
    const grade = mask[maskKey] ?? "write";
    if (GRADE_RANK[grade] > GRADE_RANK[repoGrade]) {
      repoGrade = grade;
    }
  }
  return repoGrade;
}

/**
 * Whether the org gate denies a section's org-scoped requests: org_members gates teams' per-team access probes and
 * its grants, never the repository's team list (GitHub grades that at repository Administration alone, and the
 * section declares it so). A denied probe answers 404 under fine_grained, which the section reads as "no access",
 * so the reads go through and only the writes are denied: the ABSENT posture at grade none, whatever the
 * section's own posture says. The mock takes org_members for teams' /orgs/ endpoints from the GLOBAL mask, not
 * the per-slug overlay (the rest of the mask stays per slug), so the gate reads orgMask (equal to mask outside
 * multi-repo mode).
 */
export function orgGateDenied(
  key: SectionKey,
  orgMask: Partial<Record<MaskKey, MaskGrade>>,
): boolean {
  return PERMISSION_BY_KEY[key].org === "members" && (orgMask.org_members ?? "write") === "none";
}

/**
 * The grades a section may RUN at: a read grant folded through its read gating. Write-gated is
 * denied at its first read; mixed keeps both grades, since reaching the gated read depends on
 * content the oracle never models.
 */
export function effectiveGrades(grant: MaskGrade, gating: ReadGating): readonly MaskGrade[] {
  if (grant !== "read" || gating === "plain") {
    return [grant];
  }
  return gating === "write-gated" ? ["none"] : ["read", "none"];
}

export interface SectionPrediction {
  key: SectionKey;
  /**
   * The grades the section may run at. EMPTY for an excluded section: orchestrate.ts classifies it
   * before preflight and the section loop, so every fold over these grades (preflightDeniable,
   * writeGranted) is vacuous for it and no consumer recognizes "excluded" by hand.
   */
  grades: readonly MaskGrade[];
  /**
   * What a fine-grained 404 on the first read denied at these grades means: the section's own
   * posture, or "absent" when only the org gate is shut (the repository read passes and the
   * org-gated probe's 404 reads as a missing grant). The preflight fold reads it.
   */
  posture: DenialPosture;
  /** The outcomes the section is allowed to report; the runner must see one. */
  allowed: Set<Outcome>;
  /** False folds the section into writeDeniedSections, whose writes the fuzz asserts never mutate state. */
  mayWrite: boolean;
}

const DENIAL_POSTURES: readonly DenialPosture[] = ["denied", "absent"];

export function predictSection(key: SectionKey, meta: ScenarioMeta): SectionPrediction {
  return predictSectionAt(key, meta, READ_GATING[key]);
}

/**
 * A mixed section denied under a READ grant stops at a gated read whose 404 posture may differ from
 * its primary read's, so that arm covers both postures.
 */
export function predictSectionAt(
  key: SectionKey,
  meta: ScenarioMeta,
  gating: ReadGating,
): SectionPrediction {
  // An EMPTY allowlist is unrestricted, mirroring orchestrate.ts's size > 0 gate.
  if (
    meta.onlySections !== undefined &&
    meta.onlySections.length > 0 &&
    !meta.onlySections.includes(key)
  ) {
    return {
      key,
      grades: [],
      posture: DENIAL_POSTURE[key],
      allowed: new Set(["excluded"]),
      mayWrite: false,
    };
  }
  // The org probe is declared permission "none", so no mask key gates it and its 404 is met before
  // any gated read; by sectionGrade's convention an ungated resource grades write.
  if (ORG_ONLY_SECTIONS.has(key) && meta.ownerKind === "user") {
    return {
      key,
      grades: ["write"],
      posture: DENIAL_POSTURE[key],
      allowed: new Set([meta.mode === "check" ? "clean" : "applied"]),
      mayWrite: false,
    };
  }
  const grant = sectionGrade(key, meta.mask);
  const grades = effectiveGrades(grant, gating);
  const deniedAtGatedRead = gating === "mixed" && grant === "read";
  // The repository grant holds but the org gate is shut: the repository reads pass and the org-gated probes are
  // denied, so the section runs at grade none under the absent posture (orgGateDenied). With no repository grant
  // the gated repository read is denied first, under the section's own posture.
  const orgDenied = orgGateDenied(key, meta.orgMask ?? meta.mask) && grant !== "none";
  const posture: DenialPosture = orgDenied ? "absent" : DENIAL_POSTURE[key];
  const arms = orgDenied
    ? [predictAtGrade(key, meta, "none", posture)]
    : grades.flatMap((grade) =>
        grade === "none" && deniedAtGatedRead
          ? DENIAL_POSTURES.map((candidate) => predictAtGrade(key, meta, grade, candidate))
          : [predictAtGrade(key, meta, grade, posture)],
      );
  return {
    key,
    grades: orgDenied ? ["none"] : grades,
    posture,
    allowed: new Set(arms.flatMap((arm) => [...arm.allowed])),
    mayWrite: arms.some((arm) => arm.mayWrite),
  };
}

/**
 * One section's allowed outcomes at ONE grade. A seeded live-state WITNESS tightens {clean, drift}
 * to one outcome, but only after the permission and policy fold: a section that never ran stays denied.
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
  if (check && NO_READ_SECTIONS.has(key)) {
    return { allowed: new Set(["clean"]), mayWrite: false };
  }

  if (grade === "write") {
    if (witness === "matching") {
      // A matching witness mirrors every field the handler diffs, so no write is ever attempted.
      return { allowed: new Set([check ? "clean" : "applied"]), mayWrite: false };
    }
    if (witness !== undefined) {
      // A drift witness: a check-mode clean here is a false-negative drift detector.
      return { allowed: new Set([check ? "drift" : "applied"]), mayWrite: !check };
    }
    return {
      allowed: check ? new Set(["clean", "drift"]) : new Set(["applied"]),
      mayWrite: !check,
    };
  }

  // A section with no reads can never be read-denied under any style: its denial surfaces on the
  // apply-mode write, like the fine_grained "absent" posture.
  const readsAsDenied =
    grade === "none" &&
    !NO_READ_SECTIONS.has(key) &&
    (meta.denialStyle === 403 || posture === "denied");

  if (grade === "none" && readsAsDenied) {
    if (check) {
      const allowed: Set<Outcome> =
        required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
      return { allowed, mayWrite: false };
    }
    const allowed: Set<Outcome> =
      required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
    return { allowed, mayWrite: false };
  }

  // From here the reads go through and only an apply-mode write can be denied.
  //   grade none, absent posture -> the denied reads look like missing resources
  //   grade read                 -> the reads are granted
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
    // No write is needed, so the missing write grant is never exercised.
    return { allowed: new Set(["applied"]), mayWrite: false };
  }
  if (witness !== undefined) {
    // The witness forces one write and every write is denied at this grade, so the section can never
    // be a no-op "applied"; mirrors the mid-apply PermissionDenied fold in orchestrate.ts.
    const allowed: Set<Outcome> =
      required || meta.policy === "fail" ? new Set(["failed"]) : new Set(["skipped"]);
    return { allowed, mayWrite: false };
  }
  // A comparing section may land applied when the live state already matched; a no-read section's
  // write is unconditional, so its denial is certain and "applied" unreachable.
  const canSilentlyApply = !NO_READ_SECTIONS.has(key);
  const allowed: Set<Outcome> =
    required || meta.policy === "fail"
      ? new Set(canSilentlyApply ? ["applied", "failed"] : ["failed"])
      : new Set(canSilentlyApply ? ["applied", "skipped"] : ["skipped"]);
  // An absent-posture section may attempt one write before the denial it then meets.
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

export interface RunPrediction {
  sections: SectionPrediction[];
  /** Exit codes the run may produce (a set, since some sections span classes). */
  allowedExitCodes: Set<number>;
  noWritesInCheck: boolean;
  /** Sections whose denied writes must never mutate state. */
  writeDeniedSections: SectionKey[];
  /** The fixpoint proofs in fuzz.ts run only under this. */
  fullyGranted: boolean;
  /**
   * Whether the run aborts at the preflight barrier (apply + fail policy, a denied preflight READ)
   * before rendering any section; "possible" when only a mixed section under a read grant could arm it.
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

/** Every table body row the summary rendered, well-formed or not, so a malformed row cannot pass as "no rows". */
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

function foldPreflightAbort(verdicts: readonly PreflightAbort[]): PreflightAbort {
  if (verdicts.includes("yes")) {
    return "yes";
  }
  return verdicts.includes("possible") ? "possible" : "no";
}

function writeGranted(section: SectionPrediction): boolean {
  return section.grades.every((grade) => grade === "write");
}

/**
 * Whether preflight (reads only) denies the section. Two effective grades make it "possible": the
 * probe reaches the gated read only for some declared content.
 */
export function preflightDeniable(section: SectionPrediction, meta: ScenarioMeta): PreflightAbort {
  if (NO_READ_SECTIONS.has(section.key)) {
    return "no";
  }
  if (!section.grades.includes("none")) {
    return "no";
  }
  if (section.grades.length > 1) {
    return "possible";
  }
  return meta.denialStyle === 403 || section.posture === "denied" ? "yes" : "no";
}

export function predictOutcomes(meta: ScenarioMeta): RunPrediction {
  const sections = meta.sections.map((key) => predictSection(key, meta));
  const check = meta.mode === "check";
  const preflightAborts: PreflightAbort =
    !check && meta.policy === "fail"
      ? foldPreflightAbort(sections.map((s) => preflightDeniable(s, meta)))
      : "no";

  const exitCodes = new Set<number>();
  for (const pick of [bestOutcomes(sections), worstOutcomes(sections)]) {
    const worst = Math.max(0, ...pick.map((o) => RESULT_RANK[o] ?? 0));
    exitCodes.add(worst >= 3 || (check && worst >= 2) ? 1 : 0);
  }

  return {
    sections,
    allowedExitCodes: exitCodes,
    noWritesInCheck: check,
    writeDeniedSections: sections.filter((s) => !writeGranted(s) && !s.mayWrite).map((s) => s.key),
    fullyGranted: sections.every(writeGranted),
    preflightAborts,
  };
}

function rank(outcome: Outcome): number {
  return RESULT_RANK[outcome] ?? 0;
}

function bestOutcomes(sections: SectionPrediction[]): Outcome[] {
  return sections.map((s) => [...s.allowed].sort((a, b) => rank(a) - rank(b))[0] as Outcome);
}

function worstOutcomes(sections: SectionPrediction[]): Outcome[] {
  return sections.map((s) => [...s.allowed].sort((a, b) => rank(b) - rank(a))[0] as Outcome);
}

interface RepoPrediction {
  slug: string;
  /**
   * The repos-result KEY the action emits: the "private repository #N" placeholder when redacted,
   * else the slug. The fuzz comparison keys on this, since a redacted target never appears under its slug.
   */
  displayKey: string;
  redacted: boolean;
  /** null when the target never runs a section: no settings file and no defaults document, or a gated settings read. */
  run: RunPrediction | null;
  allowedResults: Set<string>;
}

export interface MultiPrediction {
  repos: RepoPrediction[];
  /** Exit codes the multi run may produce (worst-of over the targets). */
  allowedExitCodes: Set<number>;
  /** Every string that must appear on NO public surface: each redacted target's real slug plus its planted canaries. */
  forbidden: string[];
}

/** The engine's roll-up flags (orchestrate.ts), mirrored; the multi "partial" alias also sets partial. */
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
 * OBSERVED section outcomes folded the way the engine folds them; the fuzz self-consistency
 * invariant compares the `result` output against this fold of the summary's outcome table.
 */
export function foldSectionOutcomes(outcomes: string[], check: boolean): string {
  const flags = { failed: false, drifted: false, partial: false };
  for (const outcome of outcomes) {
    foldFlags(outcome, flags);
  }
  return repoResultFrom(flags, check);
}

/**
 * The repo words of outcome.ts's RUN_RESULTS order, mirrored by hand rather than imported: the engine's own order
 * would agree with its own regression.
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

/** Folded through the engine's own roll-up rather than a loose union of the section outcomes. */
function runResultClass(run: RunPrediction): Set<string> {
  const check = run.noWritesInCheck;
  if (run.preflightAborts === "yes") {
    return new Set(["failed"]);
  }
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

export function predictMulti(meta: MultiScenarioMeta): MultiPrediction {
  const repos: RepoPrediction[] = meta.repos.map((repo) => {
    const common = {
      slug: repo.slug,
      displayKey: displayKeyOf(repo),
      redacted: repo.redaction.kind === "redacted",
    };
    if (repo.target.kind === "missing") {
      // A missing target sets no mask, so the defaults document runs at the default write grade.
      if (meta.defaults === undefined) {
        return { ...common, run: null, allowedResults: new Set(["skipped"]) };
      }
      const run = predictOutcomes(meta.defaults);
      return { ...common, run, allowedResults: runResultClass(run) };
    }
    if (repo.target.kind === "raw-invalid") {
      // Raw settings text fails before any section runs, never skipped: unparseable at the parse
      // gate, non-mapping at the top-level validator.
      return { ...common, run: null, allowedResults: new Set(["failed"]) };
    }
    const repoMeta = repo.target.meta;
    // A Contents-denied token fails the target under every denial style: the action proves a file
    // missing through a Contents-gated ref read (src/github/repo-file.ts), so it never reads as fileless.
    if ((repoMeta.mask.contents ?? "write") === "none") {
      return { ...common, run: null, allowedResults: new Set(["failed"]) };
    }
    const run = predictOutcomes(repoMeta);
    return { ...common, run, allowedResults: runResultClass(run) };
  });

  // A FATAL core.contentsGet fault kills the FIRST target's settings fetch, whatever gate its kind
  // would otherwise hit. The key is matched explicitly so a second core-fault key cannot silently
  // reuse this contents-specific victim rule.
  if (meta.coreFault?.key === "core.contentsGet" && meta.coreFault.fatal && repos.length > 0) {
    const victim = repos[0] as RepoPrediction;
    repos[0] = { ...victim, run: null, allowedResults: new Set(["failed"]) };
  }

  const exitCodes = new Set<number>();
  const perTargetExit = repos.map((r) => {
    if (r.run) {
      return r.run.allowedExitCodes;
    }
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
 * An INDEPENDENT glob matcher, deliberately not src's excludeMatches (a RegExp compile), so a bug in
 * either surfaces as a disagreement. A pattern with "/" matches the full slug, otherwise the name
 * portion, mirroring the repos-dir <name>.yml vs <owner>/<name>.yml split.
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
 * The slugs a `repos: "*"` discovery keeps, mirroring the action's documented filter rules
 * INDEPENDENTLY of discoverRepos so a shared bug cannot hide; the filters run in the engine's
 * attribution order.
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
    // private keeps only private: the API returns private+internal and the action drops internal.
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

// --- mode: render -------------------------------------------------------------

/**
 * The engine's own notice record, so the fuzz shares its wording (describeRemoval) with the action;
 * the oracle computes the layer and the path itself.
 */
export type MergeNotice = RemovalNotice;

/**
 * The merge oracle's verdict. Two layers each valid alone can fold into a document the post-merge
 * validator rejects: a lower `allowed_actions: selected` with its allowlist under a higher `allowed_actions: all`.
 */
export type MergePrediction =
  | { kind: "merged"; merged: Json; notices: MergeNotice[] }
  | { kind: "refused"; layer: string }
  | { kind: "invalid"; error: string };

/** A list the merge combines by identity: two entries are one resource when their key sets intersect. */
interface KeyedList {
  /** Every identity the entry claims, folded; null when it carries none (refused at the boundary). */
  keysOf: (entry: Json) => readonly string[] | null;
  /** The entry field the keys are read from, for naming a keyless entry the fold cannot place. */
  keyField: string;
  nested?: Readonly<Record<string, KeyedList>>;
  /** The dotted paths a removal may carry beside `_remove`; the key field's own unless said otherwise. */
  removalPaths?: readonly string[];
}

/** The fold stops at the layer whose removal has nothing to act on; predictMerge turns it into the refused verdict. */
class FoldRefused extends Error {
  constructor(readonly layer: string) {
    super(`layer ${layer} refused`);
  }
}

function isRemovalEntry(entry: unknown): entry is Json {
  return isMapping(entry) && entry[REMOVE_KEY] === true;
}

function removalPathsOf(keyed: KeyedList): readonly string[] {
  return keyed.removalPaths ?? [keyed.keyField];
}

/**
 * Whether a removal carries a path beside the marker and its allowed paths, compared segment by segment (a literal
 * `config.url` key is not the nested one), descending a mapping only along an allowed path.
 */
function removalCarriesExtra(
  entry: Json,
  allowed: readonly (readonly string[])[],
  prefix: readonly string[] = [],
): boolean {
  return Object.entries(entry).some(([field, value]) => {
    const path = [...prefix, field];
    const same = (known: readonly string[]) =>
      known.length === path.length && known.every((segment, i) => segment === path[i]);
    if ((prefix.length === 0 && field === REMOVE_KEY) || allowed.some(same)) {
      return false;
    }
    const container = allowed.some(
      (known) => known.length > path.length && path.every((segment, i) => segment === known[i]),
    );
    return !(container && isMapping(value) && !removalCarriesExtra(value, allowed, path));
  });
}

/** Whether a removal marker sits anywhere in an entry's nested lists: an entry copied whole has nothing for one to act on. */
function carriesNestedRemoval(entry: Json, keyed: KeyedList): boolean {
  for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
    const form = nestedForm(entry[field]);
    if (form === null) {
      continue;
    }
    if (form.entries.some((item) => isRemovalEntry(item) || carriesNestedRemoval(item, nested))) {
      return true;
    }
  }
  return false;
}

function labelKeys(entry: Json): readonly string[] | null {
  const names = entry.new_name === undefined ? [entry.name] : [entry.new_name, entry.name];
  if (!names.every((name): name is string => typeof name === "string")) {
    return null;
  }
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

const same = (name: string): string => name;
const lower = (name: string): string => name.toLowerCase();
const upper = (name: string): string => name.toUpperCase();

/** One string field, read through a dotted path (a webhook's `config.url`), folded as GitHub matches it. */
function keyedBy(field: string, fold: (name: string) => string = same): KeyedList {
  return {
    keyField: field,
    keysOf: (entry) => {
      const value = field.split(".").reduce<unknown>((node, segment) => {
        return isMapping(node) ? node[segment] : undefined;
      }, entry);
      return typeof value === "string" ? [fold(value)] : null;
    },
  };
}

/** A reviewer's key in the oracle's words: its type beside its numeric id, since users and teams number apart. */
const reviewerKeys: KeyedList = {
  keyField: "id",
  keysOf: (entry) =>
    typeof entry.id === "number" && typeof entry.type === "string"
      ? [`${entry.type}:${entry.id}`]
      : null,
  removalPaths: ["type", "id"],
};

/** A workflow path as GitHub lists it: a bare file name lives under .github/workflows/. */
const workflowPath = (path: string): string =>
  path.includes("/") ? path : `.github/workflows/${path}`;

/**
 * Every list section's key in the oracle's OWN words, not read off the section modules, so a module whose
 * layering declaration drifts is a disagreement the fuzz surfaces; oracle.test.ts pins the two as data.
 *
 *   case-folded  -> labels, collaborators, teams, environments (GitHub matches them case-insensitively)
 *   uppercased   -> the secrets and variables families, an environment's variables and secrets (GitHub stores the names uppercase)
 *   by path      -> workflows (a bare file name and its .github/workflows/ spelling are one file)
 *   verbatim     -> everything else
 */
export const KEYED_MERGE_SECTIONS: Readonly<Record<ListSection, KeyedList>> = {
  labels: { keysOf: labelKeys, keyField: "name" },
  rulesets: { ...keyedBy("name"), nested: { rules: keyedBy("type") } },
  environments: {
    ...keyedBy("name", lower),
    nested: {
      variables: keyedBy("name", upper),
      secrets: keyedBy("name", upper),
      deployment_branch_policies: keyedBy("name"),
      deployment_protection_rules: keyedBy("app"),
      reviewers: reviewerKeys,
    },
  },
  branches: keyedBy("name"),
  workflows: keyedBy("path", workflowPath),
  autolinks: keyedBy("key_prefix"),
  actions_secrets: keyedBy("name", upper),
  dependabot_secrets: keyedBy("name", upper),
  codespaces_secrets: keyedBy("name", upper),
  agents_secrets: keyedBy("name", upper),
  collaborators: keyedBy("username", lower),
  teams: keyedBy("name", lower),
  milestones: keyedBy("title"),
  actions_variables: keyedBy("name", upper),
  agents_variables: keyedBy("name", upper),
  webhooks: keyedBy("config.url"),
  custom_properties: keyedBy("property_name"),
  deploy_keys: keyedBy("title"),
  secret_scanning_custom_patterns: keyedBy("name"),
};

const UNDECLARED_DEFAULTS: Record<UndeclaredPolicySection, UndeclaredPolicyWord> =
  Object.fromEntries(
    UNDECLARED_POLICY_SECTIONS.map((key) => {
      const section = SECTIONS.find((candidate) => candidate.key === key);
      if (section === undefined || section.undeclaredDefault === "untouched") {
        throw new Error(`${key} is knobbed but declares no keep/delete default`);
      }
      return [key, section.undeclaredDefault];
    }),
  ) as Record<UndeclaredPolicySection, UndeclaredPolicyWord>;

/**
 * The nested lists that take the knob and their defaults, in the harness's own words (the environments module spells
 * them in src/sections/environments/nested.ts; oracle.test.ts pins the two as data). A nested list absent here
 * (reviewers, a ruleset's rules) takes no policy and stays bare after the fold.
 */
export const NESTED_UNDECLARED_DEFAULTS: Readonly<Record<string, UndeclaredPolicyWord>> = {
  variables: "delete",
  secrets: "keep",
  deployment_branch_policies: "delete",
  deployment_protection_rules: "keep",
};

function isPolicy(value: unknown): value is UndeclaredPolicyWord {
  return UNDECLARED_POLICIES.some((policy) => policy === value);
}

/** A list in either form with its policy explicit: the wrapper's own, else the fold's fallback, else `own`. */
function withPolicy(
  value: unknown,
  fallback: UndeclaredPolicyWord | undefined,
  own: UndeclaredPolicyWord,
): unknown {
  const form = nestedForm(value);
  if (form === null || form.knobs?.[UNDECLARED_KEY] !== undefined) {
    return value;
  }
  // A key present with an explicit undefined is no policy, and must not overwrite the resolved one.
  const { [UNDECLARED_KEY]: _unset, ...knobs } = form.knobs ?? {};
  return { [UNDECLARED_KEY]: fallback ?? own, ...knobs, entries: form.entries };
}

function isMapping(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property's value: an inherited name (`constructor`) is not a document key, as the engine reads it. */
function own(record: Json, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Set an own data property whatever the key; assigning `__proto__` would set the prototype. */
function put(record: Json, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isKnobbed(key: string): key is UndeclaredPolicySection {
  return (UNDECLARED_POLICY_SECTIONS as readonly string[]).includes(key);
}

function isListSection(key: string): key is ListSection {
  return (LIST_SECTIONS as readonly string[]).includes(key);
}

/** A nested list in either form: the bare list, or its `{_undeclared, entries}` wrapper (knobs null for the bare list). */
function nestedForm(value: unknown): { entries: Json[]; knobs: Json | null } | null {
  if (Array.isArray(value)) {
    return { entries: value as Json[], knobs: null };
  }
  if (isMapping(value) && Array.isArray(value.entries)) {
    const { entries, ...knobs } = value;
    return { entries: entries as Json[], knobs };
  }
  return null;
}

function isDirective(value: unknown): value is LayeringDirective {
  return LAYERING_DIRECTIVES.some((directive) => directive === value);
}

function asWrapper(value: unknown): Json {
  return Array.isArray(value) ? { entries: value } : (value as Json);
}

/** The layer a notice attributes a deletion to; the removed path arrives as the settle() parameter. */
interface Site {
  layer: string;
  notices: MergeNotice[];
}

/** What the layers so far said about one key: nothing yet, a null that stayed as written, or a value. */
type Slot = unknown;

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Where a higher value sits inside a keyed entry: the entry's nested lists (top only), at `prefix`. */
interface EntryScope {
  keyed: KeyedList;
  prefix: string;
}

/** The dialect's one sentence about a higher value, transcribed: two mappings merge, anything else (null included) wins whole. */
function settle(slot: Slot, higher: unknown, path: string, site: Site, scope?: EntryScope): Slot {
  if (isMapping(slot) && isMapping(higher)) {
    return mergeTrees(slot, higher, path, site, scope);
  }
  return structuredClone(higher);
}

/**
 * The higher keys settle in the order the higher layer wrote them (that is the order the engine visits them, so
 * notices agree); the result keeps the lower keys' order, the higher-only keys after them.
 */
function mergeTrees(lower: Json, higher: Json, path: string, site: Site, scope?: EntryScope): Json {
  const settledByKey = new Map<string, unknown>();
  for (const key of Object.keys(higher)) {
    const above = own(higher, key);
    const below = own(lower, key);
    if (above === undefined) {
      continue;
    }
    const nested = scope?.prefix === "" ? scope.keyed.nested : undefined;
    const keyed = nested !== undefined && Object.hasOwn(nested, key) ? nested[key] : undefined;
    const within = scope === undefined ? undefined : { ...scope, prefix: at(scope.prefix, key) };
    const lowerForm = keyed === undefined ? null : nestedForm(below);
    const higherForm = keyed === undefined ? null : nestedForm(above);
    if (keyed !== undefined && higherForm !== null && lowerForm === null) {
      // A nested list with nothing below it is copied whole, so a removal among its entries has nothing to act on.
      if (
        higherForm.entries.some((item) => isRemovalEntry(item) || carriesNestedRemoval(item, keyed))
      ) {
        throw new FoldRefused(site.layer);
      }
    }
    // Only a deep merge of two entries reaches a nested keyed list, so its pairs merge field by field too. Two bare
    // lists fold to a bare list; a wrapper on either side keeps the form, its knobs merged like the top-level ones.
    let settled: unknown;
    if (keyed !== undefined && lowerForm !== null && higherForm !== null) {
      const entries = unionKeyed(
        lowerForm.entries,
        higherForm.entries,
        keyed,
        "deep",
        at(path, key),
        site,
      );
      settled =
        lowerForm.knobs === null && higherForm.knobs === null
          ? entries
          : {
              ...mergeTrees(lowerForm.knobs ?? {}, higherForm.knobs ?? {}, at(path, key), site),
              entries,
            };
    } else {
      settled = settle(below, above, at(path, key), site, within);
    }
    settledByKey.set(key, settled);
  }
  const out: Json = {};
  for (const key of new Set([...Object.keys(lower), ...Object.keys(higher)])) {
    const settled = settledByKey.has(key) ? settledByKey.get(key) : own(lower, key);
    if (settled !== undefined) {
      put(out, key, settled);
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

function sameResource(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

/**
 * Matching reads the lower list as it stood before this layer, so two higher entries claiming one
 * lower entry both take its slot, in their order. Only a one-to-one pair merges field by field under
 * deep; an entry claiming or claimed by more than one across the two lists is placed as written, and
 * an entry placed as written may carry no removal in its nested lists. A removal drops the lower entry
 * it claims and is a notice naming its INDEX in the higher layer's list, never a key value; one that
 * claims nothing refuses the layer.
 */
function unionKeyed(
  lower: Json[],
  higher: Json[],
  keyed: KeyedList,
  directive: Exclude<LayeringDirective, "replace">,
  path: string,
  site: Site,
): Json[] {
  const lowerKeys = lower.map((entry) => keysOrThrow(entry, keyed));
  const higherKeys = higher.map((entry) => keysOrThrow(entry, keyed));
  const slotOf = higherKeys.map((keys) =>
    lowerKeys.findIndex((below) => sameResource(below, keys)),
  );
  const out = lower.flatMap((below, index) => {
    const keys = lowerKeys[index] as readonly string[];
    if (!higherKeys.some((claims) => sameResource(claims, keys))) {
      return [below];
    }
    const claimedBy = higherKeys.filter((claims) => sameResource(claims, keys)).length;
    return higher.flatMap((entry, h) => {
      if (slotOf[h] !== index) {
        return [];
      }
      if (isRemovalEntry(entry)) {
        site.notices.push({ layer: site.layer, path: `${path}[${h}]` });
        return [];
      }
      const claimsLower = lowerKeys.filter((claims) =>
        sameResource(claims, higherKeys[h] ?? []),
      ).length;
      const paired = claimedBy === 1 && claimsLower === 1;
      if (directive === "deep" && paired) {
        return [mergeTrees(below, entry, `${path}[${h}]`, site, { keyed, prefix: "" })];
      }
      if (carriesNestedRemoval(entry, keyed)) {
        throw new FoldRefused(site.layer);
      }
      return [structuredClone(entry)];
    });
  });
  for (const [h, entry] of higher.entries()) {
    if (slotOf[h] !== -1) {
      continue;
    }
    if (isRemovalEntry(entry) || carriesNestedRemoval(entry, keyed)) {
      throw new FoldRefused(site.layer);
    }
    out.push(structuredClone(entry));
  }
  return out;
}

interface Contribution {
  layer: string;
  value: unknown;
  fileDirective: LayeringDirective | undefined;
}

/**
 * A list section's column: every layer's entries union under its effective directive. A knobbed section resolves its
 * policy afterwards; a plain list's wrapper carried only the directive, so the fold writes the bare list.
 */
/** One layer's contribution to a list section, folded onto what the layers below built. */
function reduceListStep(
  key: ListSection,
  slot: Slot,
  contribution: Contribution,
  run: LayeringDirective,
  site: Site,
): Slot {
  const keyed = KEYED_MERGE_SECTIONS[key];
  const { layer, value, fileDirective } = contribution;
  if (value === null) {
    return settle(slot, null, key, site);
  }
  const { entries, [LAYERING_KEY]: directive, ...knobs } = asWrapper(value);
  const effective = (isDirective(directive) ? directive : undefined) ?? fileDirective ?? run;
  const below = isMapping(slot) ? slot : {};
  const { entries: belowEntries, ...belowKnobs } = below;
  const unites = effective !== "replace" && Array.isArray(belowEntries);
  // A list written whole (under replace, or with nothing below) gives a removal at any depth nothing to act on.
  if (
    !unites &&
    (entries as Json[]).some((entry) => isRemovalEntry(entry) || carriesNestedRemoval(entry, keyed))
  ) {
    throw new FoldRefused(layer);
  }
  return {
    ...mergeTrees(belowKnobs, knobs, key, site),
    entries: unites
      ? unionKeyed(belowEntries as Json[], entries as Json[], keyed, effective, key, site)
      : structuredClone(entries),
  };
}

/**
 * After the fold: a knobbed section without a policy takes the fallback (the file's `_undeclared`, else the run input),
 * else its default; an environment's nested lists likewise, each wrapped; a plain list sheds the wrapper the directive
 * rode in.
 */
function finishList(
  key: ListSection,
  slot: Slot,
  fallback: UndeclaredPolicyWord | undefined,
): Slot {
  if (!isMapping(slot) || !Array.isArray(slot.entries)) {
    return slot;
  }
  if (key === "environments") {
    slot.entries = (slot.entries as unknown[]).map((entry) => {
      if (!isMapping(entry)) {
        return entry;
      }
      const out: Json = { ...entry };
      for (const [field, own] of Object.entries(NESTED_UNDECLARED_DEFAULTS)) {
        if (Object.hasOwn(out, field)) {
          put(out, field, withPolicy(out[field], fallback, own));
        }
      }
      return out;
    });
  }
  if (isKnobbed(key)) {
    return withPolicy(slot, fallback, UNDECLARED_DEFAULTS[key]) as Slot;
  }
  return Object.keys(slot).every((knob) => knob === "entries") ? slot.entries : slot;
}

function isSectionKey(key: string): key is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * The oracle's own fold, written from the dialect's description rather than the engine; it assumes
 * refusedMergeLayer admitted every layer. Layers fold low to high and, within a layer, its sections in the
 * order the layer wrote them, so a refusal names the layer that carries it and notices come in the order
 * the action prints them. `_layering` is consumed, never written: a layer's top-level directive governs its
 * list sections, a wrapper's governs its own section. A layer's top-level `_undeclared` is consumed too: the highest
 * one set steers the policy of every list without its own, above the run's `undeclared` input.
 */
export function foldMergeLayers(
  layers: readonly MergeLayer[],
  layering: LayeringDirective,
  undeclared: UndeclaredPolicyWord | undefined = undefined,
): { merged: Json; notices: MergeNotice[] } {
  const notices: MergeNotice[] = [];
  const slots = new Map<SectionKey, Slot>();
  let filePolicy: UndeclaredPolicyWord | undefined;
  for (const layer of layers) {
    // The engine admits a layer (its boundary gates) right before folding it, so a lower layer's fold refusal comes
    // before a higher layer's boundary refusal.
    if (refusedAtBoundary(layer, layering)) {
      throw new FoldRefused(layer.name);
    }
    const fileDirective = isDirective(layer.doc[LAYERING_KEY])
      ? layer.doc[LAYERING_KEY]
      : undefined;
    if (isPolicy(layer.doc[UNDECLARED_KEY])) {
      filePolicy = layer.doc[UNDECLARED_KEY];
    }
    const site: Site = { layer: layer.name, notices };
    for (const key of Object.keys(layer.doc)) {
      const value = layer.doc[key];
      if (!isSectionKey(key) || value === undefined) {
        continue;
      }
      const slot = slots.get(key);
      slots.set(
        key,
        isListSection(key)
          ? reduceListStep(key, slot, { layer: layer.name, value, fileDirective }, layering, site)
          : // The higher value wins whole, null included: `pages: null` is Pages off whatever lies below.
            settle(slot, value, key, site),
      );
    }
  }
  const merged: Json = {};
  for (const key of SECTION_KEYS) {
    const slot = slots.get(key);
    if (slot !== undefined) {
      merged[key] = isListSection(key) ? finishList(key, slot, filePolicy ?? undeclared) : slot;
    }
  }
  return { merged, notices };
}

/**
 * Whether a keyed list declares two entries claiming one key (a label renaming into a sibling's name included), a
 * keyless entry, or a malformed removal (a marker that is not true, or fields beside the key), at any nesting; at
 * the top level a removal under an effective `replace` is refused too. What a removal has to act on is the fold's question.
 */
function keyedListRefused(
  entries: readonly unknown[],
  keyed: KeyedList,
  effective: LayeringDirective | undefined,
): boolean {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isMapping(entry)) {
      return true;
    }
    const marker = entry[REMOVE_KEY];
    if (marker !== undefined) {
      if (
        marker !== true ||
        removalCarriesExtra(
          entry,
          removalPathsOf(keyed).map((path) => path.split(".")),
        ) ||
        effective === "replace"
      ) {
        return true;
      }
    }
    const keys = keyed.keysOf(entry);
    if (keys === null || keys.some((key) => seen.has(key))) {
      return true;
    }
    for (const key of keys) {
      seen.add(key);
    }
    for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
      const form = nestedForm(entry[field]);
      if (form !== null && keyedListRefused(form.entries, nested, undefined)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * What the per-layer validation refuses: the validator's own question, asked of the harness's standalone view (the
 * layer minus the two directives), as predictMerge already asks it of the final document. The run validates every
 * layer before any fold, so the first such layer is named; whether a null is legal there is the schema's to say.
 */
function refusedByValidation(layer: MergeLayer): boolean {
  return validateSettingsDoc(
    standaloneViewOf(layer.doc),
    layer.name,
    SectionSelection.ALL,
    silentIo(),
  ).isErr();
}

/**
 * What the fold's boundary refuses as it admits one layer, in the oracle's words: a directive outside its set (the
 * layering, or the file-wide policy), a duplicated key, a malformed removal, a removal under an effective replace.
 * `run` resolves a wrapper's directive.
 */
function refusedAtBoundary(layer: MergeLayer, run: LayeringDirective): boolean {
  const fileDirective = layer.doc[LAYERING_KEY];
  if (fileDirective !== undefined && !isDirective(fileDirective)) {
    return true;
  }
  const filePolicy = layer.doc[UNDECLARED_KEY];
  if (filePolicy !== undefined && !isPolicy(filePolicy)) {
    return true;
  }
  for (const key of LIST_SECTIONS) {
    const value = layer.doc[key];
    if (value === undefined || value === null) {
      continue;
    }
    const wrapper = asWrapper(value);
    if (!isMapping(wrapper) || !Array.isArray(wrapper.entries)) {
      continue;
    }
    const directive = wrapper[LAYERING_KEY];
    if (directive !== undefined && !isDirective(directive)) {
      return true;
    }
    const effective = (isDirective(directive) ? directive : undefined) ?? fileDirective ?? run;
    if (keyedListRefused(wrapper.entries, KEYED_MERGE_SECTIONS[key], effective)) {
      return true;
    }
  }
  return false;
}

/**
 * The layer a stack is refused at before any fold runs, read statically: the validation pass over every layer, then
 * each layer's boundary in order. A removal with nothing to act on is the fold's own refusal (predictMerge).
 */
export function refusedMergeLayer(
  layers: readonly MergeLayer[],
  run: LayeringDirective,
): string | undefined {
  return (
    layers.find(refusedByValidation)?.name ??
    layers.find((layer) => refusedAtBoundary(layer, run))?.name
  );
}

/** A mode: render run never contacts the mock: it is refused, invalid, or written from the fold alone. */
export function predictMerge(meta: MergeScenarioMeta): MergePrediction {
  // The run's order: every layer validated on its own, then admitted and folded one by one.
  const invalid = meta.layers.find(refusedByValidation);
  if (invalid !== undefined) {
    return { kind: "refused", layer: invalid.name };
  }
  let folded: ReturnType<typeof foldMergeLayers>;
  try {
    folded = foldMergeLayers(meta.layers, meta.layering, meta.undeclared);
  } catch (error) {
    if (error instanceof FoldRefused) {
      return { kind: "refused", layer: error.layer };
    }
    throw error;
  }
  // Whether the fold is a valid document is the validator's question, the same one the run asks:
  // cross-field rules the published schema cannot spell, so the generator cannot avoid them by construction.
  const validated = validateSettingsDoc(folded.merged, "merged", SectionSelection.ALL, silentIo());
  if (validated.isErr()) {
    return { kind: "invalid", error: describeProblem(validated.error) };
  }
  return { kind: "merged", ...folded };
}

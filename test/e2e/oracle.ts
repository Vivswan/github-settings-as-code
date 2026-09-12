/**
 * The fuzz oracle predicts the CLASS of outcome for a generated scenario from the permission mask,
 * policy, and mode, plus a seeded live-state witness, never the diff itself: predicting exact drift
 * would reimplement the engine, and a bug the two shared would hide.
 */

import type { OptOutNotice } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
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

/** The grade a mask GRANTS a section, before its read gating folds it (effectiveGrades). */
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
  // org_members gates only the organization PROBE (a read); team writes go through administration,
  // so capping by org_members would wrongly downgrade an administration-write + members-read token.
  // The mock takes org_members for teams' /orgs/ endpoints from the GLOBAL mask, not the per-slug
  // overlay (the rest of the mask stays per slug), so the gate reads orgMask (equal to mask outside
  // multi-repo mode).
  const orgGrade = orgMask.org_members ?? "write";
  return orgGrade === "none" ? "none" : repoGrade;
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
    return { key, grades: [], allowed: new Set(["excluded"]), mayWrite: false };
  }
  // The org probe is declared permission "none", so no mask key gates it and its 404 is met before
  // any gated read; by sectionGrade's convention an ungated resource grades write.
  if (ORG_ONLY_SECTIONS.has(key) && meta.ownerKind === "user") {
    return {
      key,
      grades: ["write"],
      allowed: new Set([meta.mode === "check" ? "clean" : "applied"]),
      mayWrite: false,
    };
  }
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
  const posture = DENIAL_POSTURE[section.key];
  return meta.denialStyle === 403 || posture === "denied" ? "yes" : "no";
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
 * orchestrate.ts's REPO_RESULTS order, mirrored by hand rather than imported: the engine's own order
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

// --- mode: merge -------------------------------------------------------------

/**
 * The engine's own notice record, so the fuzz shares its wording (describeOptOut) with the action;
 * the oracle computes the layer and the path itself.
 */
export type MergeNotice = OptOutNotice;

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
  combine: "replace" | "merge";
  nested?: Readonly<Record<string, KeyedList>>;
}

function labelKeys(entry: Json): readonly string[] | null {
  const names = entry.new_name === undefined ? [entry.name] : [entry.new_name, entry.name];
  if (!names.every((name): name is string => typeof name === "string")) {
    return null;
  }
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

function singleKey(field: string): KeyedList["keysOf"] {
  return (entry) => (typeof entry[field] === "string" ? [entry[field]] : null);
}

/**
 * The keyed sections in the oracle's OWN words, not read off the section modules, so a module whose
 * layering declaration drifts is a disagreement the fuzz surfaces; oracle.test.ts pins the two as data.
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

/**
 * The dialect's one sentence about a higher value, transcribed. `keyedFields` names the fields of two
 * mappings whose lists combine by key (a ruleset's rules) instead of replacing.
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

function sameResource(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

/**
 * Matching reads the lower list as it stood before this layer, so two higher entries claiming one
 * lower entry both take its slot, in their order. A notice inside a merged entry names it by its
 * INDEX in the higher layer's list (where the null was written), never by a key value.
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

interface Contribution {
  layer: string;
  value: unknown;
  fileDirective: LayeringDirective | undefined;
}

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
 * The oracle's own fold, written from the dialect's description rather than the engine; it assumes
 * refusedMergeLayer admitted every layer. `_layering` is consumed, never written: a layer's top-level
 * directive governs its knobbed sections, a wrapper's governs its own section.
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

/** A mode: merge run never contacts the mock: it is refused, invalid, or written from the fold alone. */
export function predictMerge(meta: MergeScenarioMeta): MergePrediction {
  const refused = refusedMergeLayer(meta.layers);
  if (refused !== undefined) {
    return { kind: "refused", layer: refused };
  }
  const folded = foldMergeLayers(meta.layers, meta.layering);
  // Whether the fold is a valid document is the validator's question, the same one the run asks:
  // cross-field rules the published schema cannot spell, so the generator cannot avoid them by construction.
  const validated = validateSettingsDoc(folded.merged, "merged", new Set(), silentIo());
  if (validated.isErr()) {
    return { kind: "invalid", error: describeProblem(validated.error) };
  }
  return { kind: "merged", ...folded };
}

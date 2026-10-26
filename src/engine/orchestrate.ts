/**
 * The per-repository pipeline (active-section filter, preflight barrier, section loop) the single- and multi-repo flows
 * share. All output goes through the Io sink; callers decide how to tag lines per repository.
 */

import { err, ok, type Result } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { GitHubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { isPlainObject, type ProvedPlain } from "../plain-data.js";
import {
  badDirectiveIssue,
  type SettingsProblem,
  singleDocumentRemovalIssue,
  type TopLevelShape,
  unknownDirectivesIssue,
  unknownSectionsIssue,
} from "../problem.js";
import {
  DOCUMENT_DIRECTIVE_KEYS,
  SECTION_KEYS,
  type SectionKey,
  type SettingsFile,
} from "../schema.js";
import type { ValidatedInput } from "../sections/contract/declared.js";
import { type SectionFailure, thrown } from "../sections/contract/errors.js";
import {
  type ExecTools,
  type OnMissingPermission,
  planCheckNotes,
  planContext,
  planDrift,
} from "../sections/contract/plan.js";
import { SECTIONS } from "../sections/registry.js";
import { agree, countNoun } from "../text.js";
import type { MustBeNever, UndeclaredPolicy } from "../types.js";
import { executePlan } from "./execute.js";
import { UNDECLARED_POLICIES } from "./layers.js";
import type { RunOutcome } from "./outcome.js";
import { resolveSecretRefs, type SettingsSource } from "./secret-refs.js";
import { collectSecretReferences, type SectionSecretReference } from "./secrets.js";
import type { SectionSelection } from "./section-selection.js";
import { separateRemovals } from "./separate-removals.js";
import { resolveUndeclaredPolicies } from "./undeclared.js";
import { validateSectionShapes } from "./validate.js";

/**
 * `httpStatus` is the safe code of the permission-denied failure behind a failed or skipped section (the redacted view shows it
 * as `HTTP 403` in place of the hidden detail); the `?: never` pin makes a code on a healthy row unrepresentable, and a
 * generic (non-denial) failure legitimately carries none.
 */
export type SectionOutcome =
  | {
      key: SectionKey;
      status: "applied" | "clean" | "drift" | "excluded";
      detail: string[];
      httpStatus?: never;
    }
  | {
      key: SectionKey;
      status: "failed" | "skipped";
      detail: string[];
      httpStatus?: number;
    };

/** The brand's one minting site is mintValidatedSettings (below validateSettingsDoc), so a RepoRunOptions built from an unvalidated document is a compile error. */
declare const validatedSettings: unique symbol;

/**
 * The PARSED document zod built, never the caller's object. Each section's value reads back as ValidatedInput, the
 * per-section proof every plan() takes, so the document is the only source of planner input.
 */
export type ValidatedSettings = {
  [K in keyof SettingsFile]: K extends SectionKey ? ValidatedInput<K> : SettingsFile[K];
} & { readonly [validatedSettings]: true };

export interface RepoRunOptions {
  repo: RepoRef;
  settings: ValidatedSettings;
  mode: "apply" | "check";
  onMissingPermission: OnMissingPermission;
  sections: SectionSelection;
  secretEnv?: Record<string, string | undefined>;
}

/** What one repository's apply or check ends in; a subset of RunOutcome, pinned below. */
export type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";

type _UnrankedRepoResult = MustBeNever<Exclude<RepoResult, RunOutcome>>;

/** One repository's apply or check; `preflightDenied` is non-empty when the preflight barrier refused to write anything. */
export interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  preflightDenied: string[];
}

/** The keys of the skipped rows, over any mode's section outcomes: only the closed status decides. */
export function skippedSectionKeys(
  outcomes: ReadonlyArray<{ key: SectionKey; status: string }>,
): SectionKey[] {
  return outcomes.filter((o) => o.status === "skipped").map((o) => o.key);
}

export interface ValidateOptions {
  /** The run's `undeclared` input: the fallback for a list whose wrapper and file set no policy, before the list's default. */
  readonly undeclared?: UndeclaredPolicy | undefined;

  /** Who authored the document, "operator" when omitted; the multi-repo flow passes "target" for a target's own settings.yml, so a secret reference in it is refused here, with the rest of the document's problems. */
  readonly secretSource?: SettingsSource | undefined;
}

/** What one section's run ends in: the drift it found (check) or the changes it made (apply), with its notes. */
type Outcome =
  | { check: true; drift: string[]; notes: string[] }
  | { check: false; changes: string[]; notes: string[] };

/** What a section produced before an operation failed, reported with the failure instead of vanishing; `landed` counts accepted requests, which the lines cannot stand in for, since a change thunk can fail after its request landed. */
interface Produced {
  readonly notes: readonly string[];
  readonly changes: readonly string[];
  readonly landed: number;
}

/** A section's plan and execution as a value, beside what it produced on the way. */
interface SectionStep {
  readonly step: Result<Outcome, SectionFailure>;
  readonly produced: Produced;
}

/** What the section loop shares across one repository; `tools` is null in check mode, which builds none. */
interface SectionRun {
  readonly api: GitHubClient;
  readonly repo: RepoRef;
  readonly io: Io;
  readonly opts: RepoRunOptions;
  readonly tools: ExecTools | null;
}

/** A failure the on-missing-permission policy classifies. */
type Denied = Extract<SectionFailure, { kind: "permission-denied" }>;

/**
 * The ONE boundary that turns a raw parsed document into the ValidatedSettings the engine accepts. Unknown top-level
 * keys are errors, except outside a non-empty `sections` allowlist, where they downgrade to a warning; an unknown
 * underscore key is an error under every allowlist, since the underscore names this action's directives and nothing else.
 * The branded document carries every undeclared policy explicit (resolveUndeclaredPolicies), so a planner reads one
 * off its wrapper and never derives it; a rendered document arrives resolved already and passes through unchanged.
 */
export function validateSettingsDoc(
  settings: unknown,
  sourceLabel: string,
  sections: SectionSelection,
  io: Io,
  options: ValidateOptions = {},
): Result<ValidatedSettings, SettingsProblem> {
  if (!isPlainObject(settings)) {
    const shape = nonMappingShape(settings);
    // A YAML tag (!!timestamp, !!set, !!binary) parses to a Date, Set, or Uint8Array: an object with no meaningful
    // keys, which branded valid would turn the document into a silent green no-op.
    return err(
      shape === null
        ? { code: "settings-not-plain-mapping", source: sourceLabel }
        : { code: "settings-not-mapping", source: sourceLabel, shape },
    );
  }
  const knownSections = new Set<string>(SECTION_KEYS);
  const directives = new Set<string>(DOCUMENT_DIRECTIVE_KEYS);
  const allowed: ReadonlySet<string> = sections.only;
  // A misspelled section silently doing nothing would break the loud-failure promise, and so would a misspelled
  // directive: `_layerin: replace` dropped as a private note would merge a layer the author meant to replace.
  const strangers = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !directives.has(key),
  );
  // Every document problem is collected into one list, so one run names every fix: the strange keys first, then
  // what each section's shape found.
  const issues: string[] = [];
  const unknownDirectives = strangers.filter((key) => key.startsWith("_"));
  if (unknownDirectives.length > 0) {
    issues.push(unknownDirectivesIssue(unknownDirectives));
  }
  const directive = (settings as Record<string, unknown>)._undeclared;
  const policy = UNDECLARED_POLICIES.find((value) => value === directive);
  if (directive !== undefined && policy === undefined) {
    issues.push(badDirectiveIssue(directive, UNDECLARED_POLICIES));
  }
  const unknownKeys = strangers.filter((key) => !key.startsWith("_"));
  if (unknownKeys.length > 0) {
    if (allowed.size === 0 || unknownKeys.some((key) => allowed.has(key))) {
      issues.push(unknownSectionsIssue(unknownKeys, SECTION_KEYS));
    } else {
      // A `sections` allowlist lets an older action version coexist with a config written for a newer one.
      const them = agree(unknownKeys.length, "it", "them");
      io.annotate(
        "warning",
        `ignoring unknown top-level ${agree(unknownKeys.length, "section", "sections")} outside the "sections" allowlist: ${unknownKeys.join(", ")}. ` +
          `Upgrade the action to a version that knows ${them}, or remove ${them} from ${sourceLabel}`,
      );
    }
  }
  // `_remove: true` drops a LOWER layer's entry; this document is nobody's higher layer (a layer of a fold arrives as
  // its standalone view, removals already gone). Left to the shapes, an open entry shape would pass the marker to
  // GitHub as a field. The shapes judge the rest, as the fold's per-layer validation does: a removal carries only its
  // key, so judged as written it would fail every other required field, and a closed shape would name the marker again.
  const removals = separateRemovals(settings);
  issues.push(...removals.sites.map(singleDocumentRemovalIssue));
  const shapes = validateSectionShapes(
    (removals.sites.length === 0 ? settings : removals.rest) as Record<string, unknown>,
    sourceLabel,
    options.secretSource ?? "operator",
  );
  if (shapes.isErr()) {
    issues.push(...shapes.error.issues.map(removals.asWritten));
  }
  if (issues.length > 0) {
    return err({ code: "settings-malformed-sections", source: sourceLabel, issues });
  }
  return shapes.map((parsed) => mintValidatedSettings(parsed, policy ?? options.undeclared));
}

/**
 * The one cast to ValidatedSettings, fed only a document validate.ts proved plain and shape-valid; the brand on the
 * parameter is what keeps a raw SettingsFile out. validateSectionShapes copies the sections alone, so the directive
 * validateSettingsDoc admitted is passed in, never re-read.
 */
function mintValidatedSettings(
  proved: ProvedPlain<SettingsFile>,
  policy: UndeclaredPolicy | undefined,
): ValidatedSettings {
  const resolved: Record<string, unknown> = { ...proved };
  resolveUndeclaredPolicies(resolved, policy);
  return resolved as ValidatedSettings;
}

/** A non-mapping document's top level in typeof terms; null for a non-plain object, which has its own problem code. */
function nonMappingShape(value: unknown): TopLevelShape | null {
  if (Array.isArray(value)) {
    return "list";
  }
  if (value === null) {
    return "null";
  }
  const kind = typeof value;
  return kind === "object" ? null : kind;
}

/** A plan section has no write capability, so planning IS the read-only probe; `active` is injectable for tests. */
export async function preflightProbe(
  api: GitHubClient,
  repo: RepoRef,
  active: typeof SECTIONS,
  settings: ValidatedSettings,
): Promise<string[]> {
  const denied: string[] = [];
  for (const section of active) {
    const declared = settings[section.key];
    if (declared === undefined) {
      // `active` is filtered to declared sections; probing nothing silently would let an injected test list pass vacuously.
      throw new Error(
        `BUG: preflightProbe was given section "${section.key}" but the settings document does not declare it; the active list must be filtered to declared sections`,
      );
    }
    // A client throw (an unmarked request's transport error) is not a denial; like every other preflight failure it
    // is left for the section loop, which surfaces it with full context.
    const planned = await section
      .plan(planContext(section, api, repo), declared)
      .catch((error: unknown) => err(thrown(error)));
    if (planned.isErr() && planned.error.kind === "permission-denied") {
      denied.push(`${section.key}: ${planned.error.detail}`);
    }
  }
  return denied;
}

/** The ONE statement of what runs: the preflight filter and the section loop both read it, so they can never disagree. */
function dispositionOf(opts: RepoRunOptions, key: SectionKey): "absent" | "excluded" | "active" {
  if (opts.settings[key] === undefined) {
    return "absent";
  }
  if (opts.sections.only.size > 0 && !opts.sections.only.has(key)) {
    return "excluded";
  }
  return "active";
}

/** The failed rows for secret references the environment could not resolve, each error annotated under its section. */
function secretFailure(
  io: Io,
  slug: string,
  errorsBySection: ReadonlyMap<SectionKey, string[]>,
): RepoRunResult {
  const outcomes: SectionOutcome[] = [];
  for (const [key, errors] of errorsBySection) {
    for (const message of errors) {
      io.annotate("error", `${key}: ${message}`);
    }
    outcomes.push({ key, status: "failed", detail: errors });
  }
  return { repo: slug, result: "failed", outcomes, preflightDenied: [] };
}

/** The referenced variable names by the section declaring them. */
function referencesBySection(
  references: readonly SectionSecretReference[],
): Map<SectionKey, string[]> {
  const bySection = new Map<SectionKey, string[]>();
  for (const { section, name } of references) {
    const list = bySection.get(section) ?? [];
    list.push(name);
    bySection.set(section, list);
  }
  return bySection;
}

/** The resolver the operations read plaintexts through; a reference it never met is a bug, since every declared one was resolved up front. */
function secretResolver(resolved: Readonly<Record<string, string>>): ExecTools {
  return {
    resolveSecret: (reference: string): string => {
      const plaintext = reference.startsWith("$") ? resolved[reference.slice(1)] : undefined;
      if (plaintext === undefined) {
        throw new Error(
          `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
        );
      }
      return plaintext;
    },
  };
}

/**
 * Apply resolves EVERY secret reference after the read-only preflight and before the first mutation, and masks each
 * plaintext before the resolver exists; the errors come back by section. An empty map proves no legitimate lookup exists.
 */
function resolveTools(
  references: readonly SectionSecretReference[],
  secretEnv: Record<string, string | undefined> | undefined,
  io: Io,
): Result<ExecTools, Map<SectionKey, string[]>> {
  const resolved: Record<string, string> = {};
  if (references.length > 0) {
    const env = secretEnv ?? process.env;
    const resolutionErrors = new Map<SectionKey, string[]>();
    const mask = new Set<string>();
    for (const [key, names] of referencesBySection(references)) {
      const resolution = resolveSecretRefs(names, env);
      if (resolution.isErr()) {
        resolutionErrors.set(key, resolution.error);
        continue;
      }
      Object.assign(resolved, resolution.value.values);
      for (const plaintext of resolution.value.mask) {
        mask.add(plaintext);
      }
    }

    if (resolutionErrors.size > 0) {
      return err(resolutionErrors);
    }

    for (const plaintext of mask) {
      io.mask(plaintext);
    }
  }

  return ok(secretResolver(resolved));
}

/**
 * One section's plan and, in apply, its execution, each ending in a value; the catch is for what still throws (the
 * client's own transport error on an unmarked request, a BUG invariant), reported like any other failure.
 */
async function runSection(
  run: SectionRun,
  section: (typeof SECTIONS)[number],
): Promise<SectionStep> {
  const desired = run.opts.settings[section.key];
  if (desired === undefined) {
    // dispositionOf() classified this section active, which requires a declared value; planning on undefined would
    // break plan()'s ValidatedInput contract.
    throw new Error(
      `BUG: section "${section.key}" was classified active but the settings document does not declare it`,
    );
  }

  let produced: Produced = { notes: [], changes: [], landed: 0 };
  try {
    const planned = await section.plan(planContext(section, run.api, run.repo), desired);
    if (planned.isErr()) {
      return { step: err(planned.error), produced };
    }

    const plan = planned.value;
    if (run.tools === null) {
      return {
        step: ok({ check: true, drift: planDrift(plan), notes: planCheckNotes(plan) }),
        produced,
      };
    }

    const execution = await executePlan(plan, section, run.api, run.repo, run.tools);
    const notes = [...plan.notes, ...plan.drift, ...execution.notes];
    produced = { notes, changes: execution.changes, landed: execution.landed };
    if (execution.status === "failed") {
      return { step: err(execution.failure), produced };
    }

    return { step: ok({ check: false, changes: [...execution.changes], notes }), produced };
  } catch (error) {
    return { step: err(thrown(error)), produced };
  }
}

/** Why a denial fails the run whatever the policy: a request landed, or the section is required. */
function denialWhy(landed: number, required: boolean): string {
  if (landed > 0) {
    return ` (${countNoun(landed, "request", "requests")} landed before the denial, so this fails the run whatever the on-missing-permission policy)`;
  }
  if (required) {
    return " (listed in required-sections, so this fails the run)";
  }
  return "";
}

/** A denied section: skipped under warn when nothing landed and the section is not required, else failed, the line saying why the policy did not spare it. */
function deniedOutcome(
  run: SectionRun,
  key: SectionKey,
  failure: Denied,
  landed: number,
  before: readonly string[],
): SectionOutcome {
  const required = run.opts.sections.required.has(key);
  // A denial after some operations landed is a partial mutation, never a skip: the warn policy applies only when nothing was written.
  if (run.opts.onMissingPermission === "warn" && !required && landed === 0) {
    run.io.annotate("warning", `${key}: skipped - ${failure.detail}`);
    return {
      key,
      status: "skipped",
      detail: [...before, failure.detail],
      httpStatus: failure.status,
    };
  }

  const applied = landed > 0 ? "partially applied" : "not applied";
  run.io.annotate("error", `${key}: ${applied}${denialWhy(landed, required)} - ${failure.detail}`);
  return { key, status: "failed", detail: [...before, failure.detail], httpStatus: failure.status };
}

/** A section that failed: what it produced first (its notes and change lines), then the failure as its row. */
function failedOutcome(
  run: SectionRun,
  key: SectionKey,
  failure: SectionFailure,
  produced: Produced,
): SectionOutcome {
  for (const note of produced.notes) {
    run.io.annotate("notice", `${key}: ${note}`);
  }
  for (const line of produced.changes) {
    run.io.log(`${key}: ${line}`);
  }

  const before = [...produced.notes, ...produced.changes];
  if (failure.kind === "permission-denied") {
    return deniedOutcome(run, key, failure, produced.landed, before);
  }

  // failureFor() messages already carry section, cause, and fix; anything else gets the section prefixed. A landed
  // request is a real mutation with or without its line, so say so.
  const prefixed = failure.message.startsWith(`${key}:`)
    ? failure.message
    : `${key}: ${failure.message}`;
  const annotated =
    produced.landed > 0
      ? `${prefixed} (${countNoun(produced.landed, "request", "requests")} landed before this failure, so the repository is partially applied)`
      : prefixed;
  run.io.annotate("error", annotated);
  return { key, status: "failed", detail: [...before, annotated] };
}

/** A section that changed nothing but left notes (a tolerated 409, a personal-account skip) is NOT "already in the desired state"; the notes are shown instead of claiming no changes were needed. */
function appliedDetail(changes: string[], notes: string[]): string[] {
  if (changes.length > 0) {
    return changes;
  }
  if (notes.length > 0) {
    return notes;
  }
  return ["no changes needed"];
}

/** A section that ran: its notes, then its drift lines (check) or change lines (apply) as its row. */
function ranOutcome(io: Io, key: SectionKey, outcome: Outcome): SectionOutcome {
  for (const note of outcome.notes) {
    io.annotate("notice", `${key}: ${note}`);
  }

  if (outcome.check) {
    if (outcome.drift.length === 0) {
      return { key, status: "clean", detail: outcome.notes };
    }
    for (const line of outcome.drift) {
      io.log(`drift: ${line}`);
    }
    return { key, status: "drift", detail: outcome.drift };
  }

  for (const line of outcome.changes) {
    io.log(`${key}: ${line}`);
  }
  return { key, status: "applied", detail: appliedDetail(outcome.changes, outcome.notes) };
}

/** The repository's result from its rows: a failure outranks everything, then drift (check only) or a skipped section, else the mode's healthy word. */
function repoResult(outcomes: readonly SectionOutcome[], check: boolean): RepoResult {
  const has = (status: SectionOutcome["status"]): boolean =>
    outcomes.some((outcome) => outcome.status === status);
  if (has("failed")) {
    return "failed";
  }
  if (check && has("drift")) {
    return "drift";
  }
  if (has("skipped")) {
    return "partial";
  }
  return check ? "clean" : "applied";
}

export async function runForRepo(
  api: GitHubClient,
  opts: RepoRunOptions,
  io: Io,
): Promise<RepoRunResult> {
  const check = opts.mode === "check";
  const repo = opts.repo;
  const settings = opts.settings;
  const active = SECTIONS.filter((section) => dispositionOf(opts, section.key) === "active");

  // Validation judged every secret value's syntax and provenance, in the excluded sections too, so what is collected
  // here is the ACTIVE sections' references, for apply to resolve; check mode reads no environment.
  const secretReferences = collectSecretReferences(settings, active);

  // The API has no transactions, so a mid-apply permission failure would leave settings half-applied: under the strict
  // policy every active section is probed read-only FIRST. A token with read but not write access can still fail
  // mid-apply; the engine is idempotent, so re-running after fixing the token converges.
  if (!check && opts.onMissingPermission === "fail") {
    const denied = await preflightProbe(api, repo, active, settings);
    if (denied.length > 0) {
      for (const line of denied) {
        io.annotate("error", `preflight: ${line}`);
      }
      return { repo: repo.slug, result: "failed", outcomes: [], preflightDenied: denied };
    }
  }

  let tools: ExecTools | null = null;
  if (!check) {
    const resolved = resolveTools(secretReferences, opts.secretEnv, io);
    if (resolved.isErr()) {
      return secretFailure(io, repo.slug, resolved.error);
    }
    tools = resolved.value;
  }

  const run: SectionRun = { api, repo, io, opts, tools };
  const outcomes: SectionOutcome[] = [];
  for (const section of SECTIONS) {
    switch (dispositionOf(opts, section.key)) {
      case "absent":
        continue;
      case "excluded":
        outcomes.push({ key: section.key, status: "excluded", detail: ["excluded by `sections`"] });
        continue;
      case "active":
        break;
    }

    const { step, produced } = await runSection(run, section);
    if (step.isErr()) {
      outcomes.push(failedOutcome(run, section.key, step.error, produced));
      continue;
    }
    outcomes.push(ranOutcome(io, section.key, step.value));
  }

  return { repo: repo.slug, result: repoResult(outcomes, check), outcomes, preflightDenied: [] };
}

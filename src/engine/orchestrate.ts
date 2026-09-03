/**
 * Per-repository orchestration: the section pipeline (active-section filter, preflight barrier,
 * section loop) that drives one repository, so the single- and multi-repo flows share one engine.
 * All output goes through the Io sink; callers decide how (or whether) to tag lines per repository.
 */

import {
  resolveSecretRefs,
  type SettingsSource,
  validateSecretRef,
} from "../action/secret-refs.js";
import type { RepoRef } from "../discovery/targets.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { SECTION_KEYS, type SectionKey, type SettingsFile } from "../schema.js";
import { PermissionDenied } from "../sections/contract/errors.js";
import {
  type ExecTools,
  planCheckNotes,
  planContext,
  planDrift,
} from "../sections/contract/plan.js";
import { SECTIONS } from "../sections/registry.js";
import type { MustBeNever } from "../types.js";
import { executePlan } from "./execute.js";
import { collectSecretValues, type SectionSecretValue } from "./secrets.js";
import { validateSectionShapes } from "./validate.js";

/**
 * One section's end state, discriminated on `status` so an HTTP code can
 * only exist where it means something: `httpStatus` is the safe code of the
 * PermissionDenied behind a failed/skipped section (the redacted view
 * surfaces it as `HTTP 403` in place of the hidden detail), and the
 * `?: never` pin on the healthy arm makes a code on an applied/clean row
 * unrepresentable instead of merely filtered out.
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
      /** Optional: a generic (non-denial) failure legitimately carries none. */
      httpStatus?: number;
    };

/**
 * A settings document that passed validateSettingsDoc, and nothing else: the
 * brand has exactly one construction site (the success return below), so a
 * RepoRunOptions built from an unvalidated document is a compile error - the
 * "validate before run" ordering is carried by the type, not by call-site
 * discipline. The value is the PARSED document validateSectionShapes built
 * from zod's output, never the caller's object.
 */
declare const validatedSettings: unique symbol;
export type ValidatedSettings = SettingsFile & { readonly [validatedSettings]: true };

export interface RepoRunOptions {
  /** The target repository, parsed at the caller's validated boundary. */
  repo: RepoRef;
  settings: ValidatedSettings;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: ReadonlySet<SectionKey>;
  onlySections: ReadonlySet<SectionKey>;
  /**
   * Provenance of one section's secret-field values: which source DOCUMENT
   * contributed the section that survived the merge. Omitted, every value is
   * "operator" (single-repo settings, central files, and the defaults file
   * are operator-authored). The multi-repo remote flow passes
   * targetSecretSource(), built from the target-fetched document BEFORE the
   * defaults merge, so a target-contributed section's references are refused
   * even after the merge folds the documents together.
   */
  secretSource?: (section: SectionKey) => SettingsSource;
  /**
   * The environment secret references resolve from in apply mode. Tests
   * inject a record; production omits it and process.env applies.
   */
  secretEnv?: Record<string, string | undefined>;
}

export type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";

/**
 * Every RepoResult value, in the worst-first ranking worstOf() applies.
 * The single source for the aggregate ranking and for the action.yml
 * `result` output docs (the contract test imports this). The satisfies
 * clause and the exhaustiveness check below keep it locked to RepoResult:
 * a new result value that is not listed here fails to compile.
 */
export const REPO_RESULTS = [
  "failed",
  "drift",
  "partial",
  "skipped",
  "applied",
  "clean",
] as const satisfies readonly RepoResult[];

/** Compile-time lockstep: a RepoResult value missing from REPO_RESULTS fails here. */
type _UnlistedResult = MustBeNever<Exclude<RepoResult, (typeof REPO_RESULTS)[number]>>;

export interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  /** Non-empty when the preflight barrier refused to write anything. */
  preflightDenied: string[];
}

/** The keys of the skipped outcomes, derived at the read site. */
export function skippedSectionKeys(
  outcomes: ReadonlyArray<Pick<SectionOutcome, "key" | "status">>,
): SectionKey[] {
  return outcomes.filter((o) => o.status === "skipped").map((o) => o.key);
}

/**
 * Top-level shape validation for one settings document (the unknown-key
 * policy from run()): the ONE boundary that turns a raw parsed document into
 * a ValidatedSettings the engine will accept. Returns the branded document,
 * or an error message (caller fails the run or the repo); the
 * sections-allowlist case downgrades to a warning. `sourceLabel` names the
 * file the message points at.
 */
export function validateSettingsDoc(
  settings: unknown,
  sourceLabel: string,
  onlySections: ReadonlySet<SectionKey>,
  io: Io,
): { settings: ValidatedSettings } | { error: string } {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return {
      error: `${sourceLabel} must be a YAML mapping of section names to settings, but its top level parsed as ${Array.isArray(settings) ? "a list" : `a ${settings === null ? "null" : typeof settings}`}. Rewrite the top level as "section: ..." keys`,
    };
  }
  // Only a PLAIN mapping may pass: an explicit YAML tag (!!timestamp, !!set,
  // !!binary) parses to a Date/Set/Uint8Array, which is an object with no
  // meaningful keys - branding it valid would turn the document into a
  // silent green no-op (and the merge's own plain-object guard would
  // otherwise be the only thing standing between it and the defaults). The
  // same prototype rule requirePlainMapping applies to section values.
  const proto = Object.getPrototypeOf(settings);
  if (proto !== Object.prototype && proto !== null) {
    return {
      error: `${sourceLabel} must be a plain YAML mapping of section names to settings, but its top level parsed as another type (a YAML-tagged value like !!timestamp parses to a Date). Rewrite the top level as "section: ..." keys`,
    };
  }
  const knownSections = new Set<string>(SECTION_KEYS);
  // The allowlist holds SectionKeys, but the DOCUMENT's unknown keys are
  // arbitrary strings; the widened view keeps the lookup honest without a
  // cast per key.
  const allowed: ReadonlySet<string> = onlySections;
  // A misspelled section silently doing nothing would violate the loud-
  // failure promise; unknown top-level keys are hard errors (prefix custom
  // keys with underscore to keep private notes in the file).
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length > 0) {
    if (onlySections.size === 0 || unknownKeys.some((key) => allowed.has(key))) {
      return {
        error: `unknown top-level section(s) in ${sourceLabel}: ${unknownKeys.join(", ")} (known: ${SECTION_KEYS.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`,
      };
    }
    // A `sections` allowlist lets an older action version coexist with a
    // config written for a newer one: unknown keys OUTSIDE the allowlist
    // are warnings, not errors.
    io.annotate(
      "warning",
      `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${sourceLabel}`,
    );
  }
  const parsed = validateSectionShapes(settings as Record<string, unknown>, sourceLabel);
  if ("error" in parsed) {
    return { error: parsed.error };
  }
  // The one place the brand is minted: everything above proved the document
  // is a mapping of known (or allowlist-tolerated/underscored) sections, and
  // the parsed document holds exactly the known ones as their shapes' output.
  return { settings: parsed.settings as ValidatedSettings };
}

/**
 * Probe every active section by planning it and collect the permission denials as "key: detail"
 * lines; empty means every section is accessible. A plan section has no write capability, so
 * planning IS the read-only probe and the plan is discarded. `active` is injectable for tests.
 */
export async function preflightProbe(
  api: GithubClient,
  repo: RepoRef,
  active: typeof SECTIONS,
  settings: ValidatedSettings,
): Promise<string[]> {
  const denied: string[] = [];
  for (const section of active) {
    const declared = settings[section.key];
    if (declared === undefined) {
      // `active` is filtered to declared sections, so this can only fire on
      // a caller bug (the parameter is injectable for tests); probing
      // nothing silently would make such a test pass vacuously.
      throw new Error(
        `BUG: preflightProbe was given section "${section.key}" but the settings document does not declare it; the active list must be filtered to declared sections`,
      );
    }
    try {
      await section.plan(planContext(section, api, repo), declared);
    } catch (error) {
      if (error instanceof PermissionDenied) {
        denied.push(`${section.key}: ${error.detail}`);
      }
      // Other preflight errors are ignored here; the section loop surfaces
      // them with full context.
    }
  }
  return denied;
}

/** Run the full section pipeline against one repository. */
export async function runForRepo(
  api: GithubClient,
  opts: RepoRunOptions,
  io: Io,
): Promise<RepoRunResult> {
  const check = opts.mode === "check";
  const repo = opts.repo;
  const settings = opts.settings;

  // The ONE statement of what runs: a section is absent (not declared),
  // excluded (declared but outside a non-empty `sections` allowlist), or
  // active. The preflight filter and the section loop below both read this,
  // so the two can never disagree about which sections are live.
  const disposition = (key: SectionKey): "absent" | "excluded" | "active" => {
    if (settings[key] === undefined) {
      return "absent"; // declared-keys-only: absent section = untouched
    }
    if (opts.onlySections.size > 0 && !opts.onlySections.has(key)) {
      return "excluded";
    }
    return "active";
  };
  const active = SECTIONS.filter((section) => disposition(section.key) === "active");

  // Secret references, phase (a): collect every declared secret-field value
  // from the ACTIVE sections (a section excluded by `sections` never runs, so
  // its references must not fail the run) and validate syntax and provenance
  // in BOTH modes, before the preflight barrier. No environment is read here:
  // check mode and preflight see syntax only.
  const secretValues = collectSecretValues(
    settings,
    active,
    opts.secretSource ?? (() => "operator"),
  );
  const secretFailure = (errorsBySection: Map<SectionKey, string[]>): RepoRunResult => {
    const outcomes: SectionOutcome[] = [];
    for (const [key, errors] of errorsBySection) {
      for (const message of errors) {
        io.annotate("error", `${key}: ${message}`);
      }
      outcomes.push({ key, status: "failed", detail: errors });
    }
    return {
      repo: opts.repo.slug,
      result: "failed",
      outcomes,
      preflightDenied: [],
    };
  };
  const pushError = (map: Map<SectionKey, string[]>, key: SectionKey, message: string): void => {
    const list = map.get(key) ?? [];
    list.push(message);
    map.set(key, list);
  };
  const syntaxErrors = new Map<SectionKey, string[]>();
  for (const { section, value, source, label } of secretValues) {
    const checked = validateSecretRef(value, source, label);
    if (!checked.ok) {
      pushError(syntaxErrors, section, checked.error);
    }
  }
  if (syntaxErrors.size > 0) {
    return secretFailure(syntaxErrors);
  }

  // Preflight barrier: the API has no transactions, so a mid-apply
  // permission failure would leave settings half-applied. Under the strict
  // policy, probe every declared section read-only FIRST and refuse to
  // write anything when any of them is inaccessible. (A token with read
  // but not write access can still fail mid-apply; the engine is
  // idempotent, so re-running after fixing the token converges.)
  if (!check && opts.onMissingPermission === "fail") {
    const denied = await preflightProbe(api, repo, active, settings);
    if (denied.length > 0) {
      for (const line of denied) {
        io.annotate("error", `preflight: ${line}`);
      }
      return {
        repo: opts.repo.slug,
        result: "failed",
        outcomes: [],
        preflightDenied: denied,
      };
    }
  }

  // Apply resolves EVERY secret reference up front, after the read-only preflight and before the
  // first mutation, and masks each plaintext before the resolver exists; check mode executes
  // nothing and builds no tools. An empty map in apply proves no legitimate lookup exists.
  let tools: ExecTools | null = null;
  if (!check) {
    const resolved: Record<string, string> = {};
    if (secretValues.length > 0) {
      const env = opts.secretEnv ?? process.env;
      const bySection = new Map<SectionKey, SectionSecretValue[]>();
      for (const value of secretValues) {
        const list = bySection.get(value.section) ?? [];
        list.push(value);
        bySection.set(value.section, list);
      }
      const resolutionErrors = new Map<SectionKey, string[]>();
      const mask = new Set<string>();
      for (const [key, values] of bySection) {
        const resolution = resolveSecretRefs(values, env);
        if (!resolution.ok) {
          resolutionErrors.set(key, resolution.errors);
          continue;
        }
        Object.assign(resolved, resolution.values);
        for (const plaintext of resolution.mask) {
          mask.add(plaintext);
        }
      }
      if (resolutionErrors.size > 0) {
        return secretFailure(resolutionErrors);
      }
      for (const plaintext of mask) {
        io.mask(plaintext);
      }
    }
    tools = {
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

  const outcomes: SectionOutcome[] = [];
  let failed = false;
  let partial = false;
  let drifted = false;

  for (const section of SECTIONS) {
    switch (disposition(section.key)) {
      case "absent":
        continue;
      case "excluded":
        outcomes.push({ key: section.key, status: "excluded", detail: ["excluded by `sections`"] });
        continue;
      case "active":
        break;
    }
    const desired = settings[section.key];
    if (desired === undefined) {
      // disposition() already classified this section "active", which
      // requires a declared value; reaching here is an engine bug, and
      // planning on undefined would violate plan()'s SectionInput contract.
      throw new Error(
        `BUG: section "${section.key}" was classified active but the settings document does not declare it`,
      );
    }
    let result:
      | { check: true; drift: string[]; notes: string[] }
      | { check: false; changes: string[]; notes: string[] };
    // What a plan section produced before an operation failed, reported with
    // the failure instead of vanishing. `landed` counts accepted requests: a
    // change thunk can fail after its request landed, so lines undercount.
    let produced: { notes: readonly string[]; changes: readonly string[]; landed: number } = {
      notes: [],
      changes: [],
      landed: 0,
    };
    try {
      // plan() runs in both modes over the read port; the mode decides
      // what the plan becomes (drift lines plus the cannot-verify notes, or
      // executed changes), and op-less drift surfaces as apply notes.
      const plan = await section.plan(planContext(section, api, repo), desired);
      if (tools === null) {
        result = { check: true, drift: planDrift(plan), notes: planCheckNotes(plan) };
      } else {
        const execution = await executePlan(plan, section, api, repo, tools);
        // The execution's notes are the tolerated operations' outcomes.
        const notes = [...plan.notes, ...plan.drift, ...execution.notes];
        produced = { notes, changes: execution.changes, landed: execution.landed };
        if (execution.status === "failed") {
          // Already classified by the request helpers; the catch below reports it.
          throw execution.error;
        }
        result = { check: false, changes: [...execution.changes], notes };
      }
    } catch (error) {
      for (const note of produced.notes) {
        io.annotate("notice", `${section.key}: ${note}`);
      }
      for (const line of produced.changes) {
        io.log(`${section.key}: ${line}`);
      }
      const before = [...produced.notes, ...produced.changes];
      if (error instanceof PermissionDenied) {
        const required = opts.requiredSections.has(section.key);
        // A denial after some operations landed is a partial mutation, never
        // a skip: the warn policy applies only when nothing was written.
        const landed = produced.landed;
        if (opts.onMissingPermission === "warn" && !required && landed === 0) {
          io.annotate("warning", `${section.key}: skipped - ${error.detail}`);
          outcomes.push({
            key: section.key,
            status: "skipped",
            detail: [...before, error.detail],
            httpStatus: error.status,
          });
          partial = true;
          continue;
        }
        const why =
          landed > 0
            ? ` (${landed} request(s) landed before the denial, so this fails the run whatever the on-missing-permission policy)`
            : required
              ? " (listed in required-sections, so this fails the run)"
              : "";
        io.annotate(
          "error",
          `${section.key}: ${landed > 0 ? "partially applied" : "not applied"}${why} - ${error.detail}`,
        );
        outcomes.push({
          key: section.key,
          status: "failed",
          detail: [...before, error.detail],
          httpStatus: error.status,
        });
        failed = true;
        continue;
      }
      // throwFor()-raised errors already carry section, cause, and fix;
      // prefix anything else so the failing section is still named. A landed
      // request is a real mutation with or without its line, so say so.
      const message = error instanceof Error ? error.message : String(error);
      const prefixed = message.startsWith(`${section.key}:`)
        ? message
        : `${section.key}: ${message}`;
      const annotated =
        produced.landed > 0
          ? `${prefixed} (${produced.landed} request(s) landed before this failure, so the repository is partially applied)`
          : prefixed;
      io.annotate("error", annotated);
      outcomes.push({ key: section.key, status: "failed", detail: [...before, annotated] });
      failed = true;
      continue;
    }
    for (const note of result.notes) {
      io.annotate("notice", `${section.key}: ${note}`);
    }
    // Narrowing on the result's own discriminant lets each branch read only
    // the list its mode can carry: a check-mode result has no changes to misreport.
    if (result.check) {
      if (result.drift.length > 0) {
        drifted = true;
        for (const line of result.drift) {
          io.log(`drift: ${line}`);
        }
        outcomes.push({ key: section.key, status: "drift", detail: result.drift });
      } else {
        outcomes.push({ key: section.key, status: "clean", detail: result.notes });
      }
    } else {
      for (const line of result.changes) {
        io.log(`${section.key}: ${line}`);
      }
      outcomes.push({
        key: section.key,
        status: "applied",
        // A section that changed nothing but left notes (a tolerated 409, a
        // personal-account skip) is NOT "already in the desired state"; show
        // the notes instead of claiming no changes were needed.
        detail:
          result.changes.length > 0
            ? result.changes
            : result.notes.length > 0
              ? result.notes
              : ["no changes needed"],
      });
    }
  }

  const result: RepoResult = failed
    ? "failed"
    : check
      ? drifted
        ? "drift"
        : partial
          ? "partial"
          : "clean"
      : partial
        ? "partial"
        : "applied";

  return {
    repo: opts.repo.slug,
    result,
    outcomes,
    preflightDenied: [],
  };
}

/** Aggregate result across targets: the worst outcome wins. */
export function worstOf(results: Array<{ result: RepoResult }>, check: boolean): RepoResult {
  for (const rank of REPO_RESULTS) {
    if (results.some((r) => r.result === rank)) {
      return rank;
    }
  }
  return check ? "clean" : "applied";
}

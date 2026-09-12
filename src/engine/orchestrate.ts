/**
 * The per-repository pipeline (active-section filter, preflight barrier, section loop) the single- and multi-repo flows
 * share. All output goes through the Io sink; callers decide how to tag lines per repository.
 */

import { err, type Result } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { SettingsProblem, TopLevelShape } from "../problem.js";
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
import { resolveSecretRefs, type SettingsSource, validateSecretRef } from "./secret-refs.js";
import { collectSecretValues, type SectionSecretValue } from "./secrets.js";
import type { SectionSelection } from "./section-selection.js";
import { validateSectionShapes } from "./validate.js";

/**
 * `httpStatus` is the safe code of the PermissionDenied behind a failed or skipped section (the redacted view shows it
 * as `HTTP 403` in place of the hidden detail); the `?: never` pin makes a code on a healthy row unrepresentable.
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
 * The brand has exactly one construction site (validateSettingsDoc's success return), so a RepoRunOptions built from an
 * unvalidated document is a compile error. The value is the PARSED document zod built, never the caller's object.
 */
declare const validatedSettings: unique symbol;
export type ValidatedSettings = SettingsFile & { readonly [validatedSettings]: true };

export interface RepoRunOptions {
  repo: RepoRef;
  settings: ValidatedSettings;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  sections: SectionSelection;
  /** Omitted, "operator". The multi-repo flow passes "target" for a target's own settings.yml, so its secret references are refused. */
  secretSource?: SettingsSource;
  secretEnv?: Record<string, string | undefined>;
}

export type RepoResult = "applied" | "partial" | "clean" | "drift" | "failed" | "skipped";

/**
 * Worst-first, the ranking worstOf() applies; the single source for the action.yml `result` output docs too (the
 * contract test imports it). The lockstep below keeps it locked to RepoResult.
 */
export const REPO_RESULTS = [
  "failed",
  "drift",
  "partial",
  "skipped",
  "applied",
  "clean",
] as const satisfies readonly RepoResult[];

type _UnlistedResult = MustBeNever<Exclude<RepoResult, (typeof REPO_RESULTS)[number]>>;

export interface RepoRunResult {
  repo: string;
  result: RepoResult;
  outcomes: SectionOutcome[];
  /** Non-empty when the preflight barrier refused to write anything. */
  preflightDenied: string[];
}

export function skippedSectionKeys(
  outcomes: ReadonlyArray<Pick<SectionOutcome, "key" | "status">>,
): SectionKey[] {
  return outcomes.filter((o) => o.status === "skipped").map((o) => o.key);
}

/**
 * How the on-missing-permission policy classifies a denied section that has written nothing: warn
 * skips it, fail fails it, and a required section fails whatever the policy. The one statement the
 * apply/check pipeline and the snapshot pipeline (./snapshot.ts) both read.
 */
export function deniedSectionStatus(
  policy: "fail" | "warn",
  required: boolean,
): "skipped" | "failed" {
  return policy === "warn" && !required ? "skipped" : "failed";
}

/**
 * The ONE boundary that turns a raw parsed document into the ValidatedSettings the engine accepts. Unknown top-level
 * keys are errors, except outside a non-empty `sections` allowlist, where they downgrade to a warning.
 */
export function validateSettingsDoc(
  settings: unknown,
  sourceLabel: string,
  onlySections: ReadonlySet<SectionKey>,
  io: Io,
): Result<ValidatedSettings, SettingsProblem> {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return err({
      code: "settings-not-mapping",
      source: sourceLabel,
      shape: nonMappingShape(settings),
    });
  }
  // A YAML tag (!!timestamp, !!set, !!binary) parses to a Date, Set, or Uint8Array: an object with no meaningful keys,
  // which branded valid would turn the document into a silent green no-op.
  const proto = Object.getPrototypeOf(settings);
  if (proto !== Object.prototype && proto !== null) {
    return err({ code: "settings-not-plain-mapping", source: sourceLabel });
  }
  const knownSections = new Set<string>(SECTION_KEYS);
  const allowed: ReadonlySet<string> = onlySections;
  // A misspelled section silently doing nothing would break the loud-failure promise; underscore-prefixed keys are the
  // sanctioned place for private notes.
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length > 0) {
    if (onlySections.size === 0 || unknownKeys.some((key) => allowed.has(key))) {
      return err({
        code: "settings-unknown-sections",
        source: sourceLabel,
        unknown: unknownKeys,
        known: SECTION_KEYS,
      });
    }
    // A `sections` allowlist lets an older action version coexist with a config written for a newer one.
    io.annotate(
      "warning",
      `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${sourceLabel}`,
    );
  }
  return validateSectionShapes(settings as Record<string, unknown>, sourceLabel).map(
    (parsed) => parsed as ValidatedSettings,
  );
}

/** A non-mapping document's top level in typeof terms; the only object left by the caller's guard is null. */
function nonMappingShape(value: unknown): TopLevelShape {
  if (Array.isArray(value)) {
    return "list";
  }
  const kind = typeof value;
  return kind === "object" ? "null" : kind;
}

/** A plan section has no write capability, so planning IS the read-only probe; `active` is injectable for tests. */
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
      // `active` is filtered to declared sections; probing nothing silently would let an injected test list pass vacuously.
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
      // Other preflight errors are left for the section loop, which surfaces them with full context.
    }
  }
  return denied;
}

export async function runForRepo(
  api: GithubClient,
  opts: RepoRunOptions,
  io: Io,
): Promise<RepoRunResult> {
  const check = opts.mode === "check";
  const repo = opts.repo;
  const settings = opts.settings;

  // The ONE statement of what runs: the preflight filter and the section loop both read it, so they can never disagree.
  const disposition = (key: SectionKey): "absent" | "excluded" | "active" => {
    if (settings[key] === undefined) {
      return "absent";
    }
    if (opts.sections.only.size > 0 && !opts.sections.only.has(key)) {
      return "excluded";
    }
    return "active";
  };
  const active = SECTIONS.filter((section) => disposition(section.key) === "active");

  // Secret references are collected from the ACTIVE sections only (an excluded section's references must not fail the
  // run) and their syntax and provenance checked in BOTH modes, before the preflight barrier and with no environment read.
  const secretValues = collectSecretValues(settings, active, opts.secretSource ?? "operator");
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

  // The API has no transactions, so a mid-apply permission failure would leave settings half-applied: under the strict
  // policy every active section is probed read-only FIRST. A token with read but not write access can still fail
  // mid-apply; the engine is idempotent, so re-running after fixing the token converges.
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

  // Apply resolves EVERY secret reference after the read-only preflight and before the first mutation, and masks each
  // plaintext before the resolver exists; check mode builds no tools. An empty map in apply proves no legitimate lookup exists.
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
      // disposition() classified this section active, which requires a declared value; planning on undefined would
      // break plan()'s SectionInput contract.
      throw new Error(
        `BUG: section "${section.key}" was classified active but the settings document does not declare it`,
      );
    }
    let result:
      | { check: true; drift: string[]; notes: string[] }
      | { check: false; changes: string[]; notes: string[] };
    // What the section produced before an operation failed, reported with the failure instead of vanishing. `landed`
    // counts accepted requests: a change thunk can fail after its request landed, so the lines cannot stand in for it.
    let produced: { notes: readonly string[]; changes: readonly string[]; landed: number } = {
      notes: [],
      changes: [],
      landed: 0,
    };
    try {
      const plan = await section.plan(planContext(section, api, repo), desired);
      if (tools === null) {
        result = { check: true, drift: planDrift(plan), notes: planCheckNotes(plan) };
      } else {
        const execution = await executePlan(plan, section, api, repo, tools);
        const notes = [...plan.notes, ...plan.drift, ...execution.notes];
        produced = { notes, changes: execution.changes, landed: execution.landed };
        if (execution.status === "failed") {
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
        const required = opts.sections.required.has(section.key);
        // A denial after some operations landed is a partial mutation, never a skip: the warn policy applies only when nothing was written.
        const landed = produced.landed;
        if (landed === 0 && deniedSectionStatus(opts.onMissingPermission, required) === "skipped") {
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
      // throwFor()-raised errors already carry section, cause, and fix; anything else gets the section prefixed. A landed
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
        // A section that changed nothing but left notes (a tolerated 409, a personal-account skip) is NOT "already in
        // the desired state"; the notes are shown instead of claiming no changes were needed.
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

export function worstOf(results: Array<{ result: RepoResult }>, check: boolean): RepoResult {
  for (const rank of REPO_RESULTS) {
    if (results.some((r) => r.result === rank)) {
      return rank;
    }
  }
  return check ? "clean" : "applied";
}

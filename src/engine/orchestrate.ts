/**
 * Per-repository orchestration: the section pipeline (active-section
 * filter, preflight barrier, section loop) extracted from run() so the
 * same engine drives one repo (legacy mode) or many (multi-repo mode).
 * All output goes through the Io sink; the engine emits unprefixed lines
 * and callers decide how (or whether) to tag them per repository.
 */

import {
  resolveSecretRefs,
  type SettingsSource,
  validateSecretRef,
} from "../action/secret-refs.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { type MustBeNever, SECTION_KEYS, type SectionKey, type SettingsFile } from "../schema.js";
import { PermissionDenied, type SectionContext, type SectionResult } from "../sections/contract.js";
import { SECTIONS } from "../sections/registry.js";
import { collectSecretValues, type SectionSecretValue } from "./secrets.js";
import { validateSectionShapes } from "./validate.js";

export interface SectionOutcome {
  key: string;
  status: "applied" | "clean" | "drift" | "skipped" | "excluded" | "failed";
  detail: string[];
  /**
   * The HTTP status behind a denial, when one raised it. The redacted view
   * surfaces this safe code (`HTTP 403`) in place of the hidden detail.
   */
  httpStatus?: number;
}

export interface RepoRunOptions {
  repo: string; // owner/name
  settings: SettingsFile;
  mode: "apply" | "check";
  onMissingPermission: "fail" | "warn";
  requiredSections: Set<string>;
  onlySections: Set<string>;
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
): string[] {
  return outcomes.filter((o) => o.status === "skipped").map((o) => o.key);
}

/**
 * Top-level shape validation for one settings document (the unknown-key
 * policy from run()). Returns an error message (caller fails the run or
 * the repo) or null; the sections-allowlist case downgrades to a warning.
 * `sourceLabel` names the file the message points at.
 */
export function validateSettingsDoc(
  settings: unknown,
  sourceLabel: string,
  onlySections: Set<string>,
  io: Io,
): string | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return `${sourceLabel} must be a YAML mapping of section names to settings, but its top level parsed as ${Array.isArray(settings) ? "a list" : `a ${settings === null ? "null" : typeof settings}`}. Rewrite the top level as "section: ..." keys`;
  }
  const knownSections = new Set<string>(SECTION_KEYS);
  // A misspelled section silently doing nothing would violate the loud-
  // failure promise; unknown top-level keys are hard errors (prefix custom
  // keys with underscore to keep private notes in the file).
  const unknownKeys = Object.keys(settings).filter(
    (key) => !knownSections.has(key) && !key.startsWith("_"),
  );
  if (unknownKeys.length > 0) {
    if (onlySections.size === 0 || unknownKeys.some((key) => onlySections.has(key))) {
      return `unknown top-level section(s) in ${sourceLabel}: ${unknownKeys.join(", ")} (known: ${SECTION_KEYS.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`;
    }
    // A `sections` allowlist lets an older action version coexist with a
    // config written for a newer one: unknown keys OUTSIDE the allowlist
    // are warnings, not errors.
    io.annotate(
      "warning",
      `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${sourceLabel}`,
    );
  }
  return validateSectionShapes(settings as Record<string, unknown>, sourceLabel);
}

/**
 * Thrown by readOnlyClient when a section handler attempts a mutation in a
 * read-only phase. A dedicated class because the preflight barrier must NOT
 * swallow it like an ordinary probe error: an ordinary error resurfaces on
 * the apply pass with full context, but a check-mode write is legitimate-
 * looking under apply, so swallowing it here would hide the bug forever.
 */
export class ReadOnlyViolation extends Error {}

/**
 * A GithubClient that refuses every mutation: non-GET REST requests and
 * GraphQL writes both throw ReadOnlyViolation, reads pass through to `api`
 * untouched. The belt over the check-is-read-only convention, worn in BOTH
 * read-only phases: the preflight barrier's probes, and the whole of check
 * mode (runForRepo wraps the context client), so a handler that (wrongly)
 * mutated under check cannot touch the repo. Exported so the refusal is
 * directly testable.
 */
export function readOnlyClient(api: GithubClient): GithubClient {
  return {
    tryRequest(method, path, payload, options) {
      if (method !== "GET") {
        throw new ReadOnlyViolation(
          `${method} ${path} was attempted in check mode, but section handlers must be read-only in check mode; this is a bug in the section handler`,
        );
      }
      return api.tryRequest(method, path, payload, options);
    },
    tryGraphql(op, variables, slug) {
      if (op.kind !== "read") {
        throw new ReadOnlyViolation(
          `GRAPHQL ${op.name} (a ${op.kind} operation) was attempted in check mode, but section handlers must be read-only in check mode; this is a bug in the section handler`,
        );
      }
      return api.tryGraphql(op, variables, slug);
    },
  };
}

/**
 * Probe every active section read-only and collect the permission denials
 * as "key: detail" lines. Empty means every section is accessible. Exported
 * with the injectable `active` list so the ReadOnlyViolation rethrow is
 * directly testable against a synthetic section.
 */
export async function preflightProbe(
  api: GithubClient,
  ctx: SectionContext,
  active: typeof SECTIONS,
  settings: SettingsFile,
): Promise<string[]> {
  const probeApi = readOnlyClient(api);
  const denied: string[] = [];
  for (const section of active) {
    try {
      await section.run(
        { ...ctx, api: probeApi, check: true },
        settings[section.key as keyof SettingsFile],
      );
    } catch (error) {
      if (error instanceof PermissionDenied) {
        denied.push(`${section.key}: ${error.detail}`);
        continue;
      }
      if (error instanceof ReadOnlyViolation) {
        // A write attempt during the read-only probe is a section-handler
        // bug the APPLY pass can never resurface (the same write is
        // legitimate there), so it must fail the run loudly instead of
        // being ignored like an ordinary probe error.
        throw new Error(`preflight: ${section.key}: ${error.message}`);
      }
      // Other non-permission preflight errors are ignored here; the apply
      // pass will surface them with full context.
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
  const [owner] = opts.repo.split("/");
  const check = opts.mode === "check";
  const ctx: SectionContext = {
    // Check mode is a read-only phase end to end, so the context client
    // itself refuses mutations - the same belt the preflight probe wears.
    api: check ? readOnlyClient(api) : api,
    repo: opts.repo,
    owner: owner ?? "",
    check,
  };
  const settings = opts.settings;

  const active = SECTIONS.filter((section) => {
    if (settings[section.key as keyof SettingsFile] === undefined) {
      return false;
    }
    return opts.onlySections.size === 0 || opts.onlySections.has(section.key);
  });

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
  const secretFailure = (errorsBySection: Map<string, string[]>): RepoRunResult => {
    const outcomes: SectionOutcome[] = [];
    for (const [key, errors] of errorsBySection) {
      for (const message of errors) {
        io.annotate("error", `${key}: ${message}`);
      }
      outcomes.push({ key, status: "failed", detail: errors });
    }
    return {
      repo: opts.repo,
      result: "failed",
      outcomes,
      preflightDenied: [],
    };
  };
  const pushError = (map: Map<string, string[]>, key: string, message: string): void => {
    const list = map.get(key) ?? [];
    list.push(message);
    map.set(key, list);
  };
  const syntaxErrors = new Map<string, string[]>();
  for (const { section, value, source } of secretValues) {
    const checked = validateSecretRef(value, source);
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
  if (!ctx.check && opts.onMissingPermission === "fail") {
    const denied = await preflightProbe(api, ctx, active, settings);
    if (denied.length > 0) {
      for (const line of denied) {
        io.annotate("error", `preflight: ${line}`);
      }
      return {
        repo: opts.repo,
        result: "failed",
        outcomes: [],
        preflightDenied: denied,
      };
    }
  }

  // Secret references, phase (b), apply mode only: resolve EVERY reference
  // up front - after the preflight barrier (which is read-only and needs no
  // secrets) and before the first mutation of ANY section, so an unset or
  // empty variable fails the repository cleanly with zero writes. Every
  // resolved plaintext is registered with output masking BEFORE the resolver
  // exists, so no handler can use a value the masker has not seen.
  let resolveSecret: SectionContext["resolveSecret"];
  if (!ctx.check && secretValues.length > 0) {
    const env = opts.secretEnv ?? process.env;
    const bySection = new Map<string, SectionSecretValue[]>();
    for (const value of secretValues) {
      const list = bySection.get(value.section) ?? [];
      list.push(value);
      bySection.set(value.section, list);
    }
    const resolutionErrors = new Map<string, string[]>();
    const resolved: Record<string, string> = {};
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
    resolveSecret = (reference: string): string => {
      const plaintext = reference.startsWith("$") ? resolved[reference.slice(1)] : undefined;
      if (plaintext === undefined) {
        throw new Error(
          `BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`,
        );
      }
      return plaintext;
    };
  }
  const runCtx: SectionContext = resolveSecret === undefined ? ctx : { ...ctx, resolveSecret };

  const outcomes: SectionOutcome[] = [];
  let failed = false;
  let partial = false;
  let drifted = false;

  for (const section of SECTIONS) {
    const desired = settings[section.key as keyof SettingsFile];
    if (desired === undefined) {
      continue; // declared-keys-only: absent section = untouched
    }
    if (opts.onlySections.size > 0 && !opts.onlySections.has(section.key)) {
      outcomes.push({ key: section.key, status: "excluded", detail: ["excluded by `sections`"] });
      continue;
    }
    let result: SectionResult;
    try {
      result = await section.run(runCtx, desired);
    } catch (error) {
      if (error instanceof PermissionDenied) {
        const required = opts.requiredSections.has(section.key);
        if (opts.onMissingPermission === "warn" && !required) {
          io.annotate("warning", `${section.key}: skipped - ${error.detail}`);
          outcomes.push({
            key: section.key,
            status: "skipped",
            detail: [error.detail],
            httpStatus: error.status,
          });
          partial = true;
          continue;
        }
        io.annotate(
          "error",
          `${section.key}: not applied${required ? " (listed in required-sections, so this fails the run)" : ""} - ${error.detail}`,
        );
        outcomes.push({
          key: section.key,
          status: "failed",
          detail: [error.detail],
          httpStatus: error.status,
        });
        failed = true;
        continue;
      }
      // throwFor()-raised errors already carry section, cause, and fix;
      // prefix anything else so the failing section is still named.
      const message = error instanceof Error ? error.message : String(error);
      const annotated = message.startsWith(`${section.key}:`)
        ? message
        : `${section.key}: ${message}`;
      io.annotate("error", annotated);
      outcomes.push({ key: section.key, status: "failed", detail: [annotated] });
      failed = true;
      continue;
    }
    for (const note of result.notes) {
      io.annotate("notice", `${section.key}: ${note}`);
    }
    if (ctx.check) {
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
    : ctx.check
      ? drifted
        ? "drift"
        : partial
          ? "partial"
          : "clean"
      : partial
        ? "partial"
        : "applied";

  return {
    repo: opts.repo,
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

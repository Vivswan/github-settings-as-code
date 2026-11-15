/**
 * The pattern name is immutable upstream (the PATCH takes no name field), so a renamed entry is a
 * create under the new name while the old pattern follows the undeclared policy. Bespoke, not on
 * listSection: creates and deletes are bulk writes over the collection path, and the PATCH carries a version.
 *
 * undeclared pattern  -> KEPT by default: removing a pattern disposes of its alerts
 * every DELETE        -> post_delete_action "resolve_alerts", never delete_alerts: a settings change must not destroy alert history
 * PATCH and DELETE    -> carry custom_pattern_version when GitHub supplies one; a pattern edited between read and write answers 412
 */

import { isDeepStrictEqual } from "node:util";
import { ok, Result } from "neverthrow";
import { z } from "zod";
import { isPlainObject } from "../../plain-data.js";
import { agree } from "../../text.js";
import type { UndeclaredPolicy } from "../../types.js";
import {
  missingDrift,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/drift.js";
import { type EndpointDecl, expand } from "../contract/endpoints.js";
import type { SectionFailure } from "../contract/errors.js";
import { identifiedBy } from "../contract/keyed-list.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  type SectionMeta,
  type SectionModule,
  type SectionSnapshot,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { Item, Pinned } from "../contract/pin.js";
import { hasDrift, type PlannedOp, type SectionPlan } from "../contract/plan.js";
import { knobbed, routed } from "../shared/schema-helpers.js";
import { knobbedSnapshot, projectOntoSchema } from "../shared/snapshot-helpers.js";
import { SecretScanningPatternConfig } from "./schema.js";

const key = "secret_scanning_custom_patterns";

const permission: SectionPermission = { repo: ["secret_scanning_alerts"] };

export const UPDATABLE_KEYS = [
  "pattern",
  "start_delimiter",
  "end_delimiter",
  "must_match",
  "must_not_match",
] as const;
type UpdatableKey = (typeof UPDATABLE_KEYS)[number];

/** Every route's denial hint: secret scanning switched off answers the same 404 as a missing grant. */
const NOT_ENABLED_HINT =
  "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";

/** Exported so the troubleshooting guide's verbatim quote is test-pinned. */
export const STALE_VERSION_HINT =
  "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run";

/** The update and the remove both carry custom_pattern_version, so both can answer the 412 their hint names. */
const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: { 200: "the custom-pattern list" },
    denialHint: NOT_ENABLED_HINT,
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: {
      201: "patterns created",
      422: "GitHub refused a declared pattern, as a validation_errors map keyed by the pattern's index in the request",
    },
    denialHint: NOT_ENABLED_HINT,
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}",
    statuses: { 200: "pattern updated" },
    hints: { 412: STALE_VERSION_HINT },
    denialHint: NOT_ENABLED_HINT,
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: { 204: "patterns deleted" },
    hints: { 412: STALE_VERSION_HINT },
    denialHint: NOT_ENABLED_HINT,
  },
} as const satisfies Record<string, EndpointDecl>;

type PatternOp = PlannedOp<typeof ENDPOINTS>;

interface LivePattern {
  id: number;
  name: string;
  version: string | undefined;
  fields: Partial<Record<UpdatableKey, unknown>>;
}

// A null or absent version is the API's own version-less form (no optimistic concurrency), but a PRESENT value of any other type must not bypass it.
const LivePatternEntry = z.looseObject({
  id: z.number(),
  name: z.string(),
  custom_pattern_version: z.string().nullish(),
});

type _LivePatternEntryPin = Pinned<typeof LivePatternEntry, Item<typeof ENDPOINTS.list>>;

/** One entry of the bulk create's 422 map, exactly as the API description spells it (every field optional); strict, so an entry carrying anything else is shown as sent. */
const PatternRefusal = z.strictObject({
  errors: z
    .array(z.strictObject({ code: z.string().optional(), message: z.string().optional() }))
    .optional(),
});

/** The key of a 422 map entry that can name a pattern of the request: a zero-based index in its one decimal spelling. */
const REQUEST_INDEX = /^(0|[1-9]\d*)$/;

/** How much of an answer GitHub sent outside the described shape one failure line carries. */
const AS_SENT_LIMIT = 300;

function liveFrom(entry: z.infer<typeof LivePatternEntry>): LivePattern {
  const fields: Partial<Record<UpdatableKey, unknown>> = {};
  for (const key of UPDATABLE_KEYS) {
    if (entry[key] !== undefined) {
      fields[key] = entry[key];
    }
  }
  return {
    id: entry.id,
    name: entry.name,
    version:
      typeof entry.custom_pattern_version === "string" ? entry.custom_pattern_version : undefined,
    fields,
  };
}

function declaredFields(declared: SecretScanningPatternConfig): Record<string, string | string[]> {
  return Object.fromEntries(
    UPDATABLE_KEYS.flatMap((key) => {
      const value = declared[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function createBody(declared: SecretScanningPatternConfig): Record<string, string | string[]> {
  return { name: declared.name, pattern: declared.pattern, ...declaredFields(declared) };
}

function deleteBody(pattern: LivePattern): { pattern_id: number; custom_pattern_version?: string } {
  return pattern.version === undefined
    ? { pattern_id: pattern.id }
    : { pattern_id: pattern.id, custom_pattern_version: pattern.version };
}

/** The GET marks the lists nullable, so a live null/absent LIST equals a declared [], or [] would PATCH on every run. */
function matches(declaredValue: string | string[], liveValue: unknown): boolean {
  const liveComparable =
    Array.isArray(declaredValue) && (liveValue === undefined || liveValue === null)
      ? []
      : liveValue;
  return isDeepStrictEqual(liveComparable, declaredValue);
}

function patternsByName<T extends { id: number; name: string }>(
  section: SectionMeta,
  live: readonly T[],
): Result<Map<string, T>, SectionFailure> {
  return liveByIdentity(
    section,
    "secret scanning custom pattern",
    live,
    (p) => p.name,
    (p) => liveIdentity(p.name, { pattern_id: p.id }),
  );
}

/** The PATCH for a declared pattern whose live fields diverge, or undefined when every declared field matches. */
function updateOp(
  entry: SecretScanningPatternConfig,
  existing: LivePattern,
): PatternOp | undefined {
  const divergent = Object.entries(declaredFields(entry)).filter(
    ([field, value]) => !matches(value, existing.fields[field as UpdatableKey]),
  );
  const drift = divergent.map(([field, value]) => {
    const liveValue = existing.fields[field as UpdatableKey];
    // JSON.stringify(undefined) is not a string; spell absence out.
    const liveRendered = liveValue === undefined ? "(absent)" : JSON.stringify(liveValue);
    return valueDrift(`${key}[${entry.name}].${field}`, JSON.stringify(value), liveRendered);
  });
  if (!hasDrift(drift)) {
    return undefined;
  }

  return {
    role: "update",
    params: { pattern_id: String(existing.id) },
    // The PATCH body REQUIRES the version key but accepts null: a version-less live pattern
    // writes without the concurrency check.
    payload: {
      custom_pattern_version: existing.version ?? null,
      ...Object.fromEntries(divergent),
    },
    describe: `updating secret scanning pattern "${existing.name}"`,
    drift,
    change: `updated secret scanning custom pattern "${existing.name}"`,
  };
}

/** A value GitHub sent outside the described shape, as JSON, cut where the line would stop being readable. */
function asSent(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > AS_SENT_LIMIT
    ? `${text.slice(0, AS_SENT_LIMIT)}... (cut at ${AS_SENT_LIMIT} characters)`
    : text;
}

/** One pattern's refusal under its settings-file label: a clause per error, the bare label without one, the entry as sent when it is outside the shape. */
function patternRefusal(label: string, entry: unknown): string[] {
  const read = PatternRefusal.safeParse(entry);
  if (!read.success) {
    return [`${label}: ${asSent(entry)}`];
  }

  const { errors = [] } = read.data;
  if (errors.length === 0) {
    return [label];
  }

  return errors.map(({ code, message }) => {
    const coded = code === undefined ? "" : ` (${code})`;
    const said = message === undefined ? "" : `: ${message}`;
    return `${label}${coded}${said}`;
  });
}

/**
 * What a bulk create's 422 body says, split by whether it names a pattern of the request; undefined when the body
 * has no validation_errors at all. GitHub alone judges a pattern's regular expressions, so nothing it answers is
 * dropped: whatever is not the described shape, or under no request index, is carried as sent and blames no pattern.
 */
function createRefusals(
  body: string,
  toCreate: readonly SecretScanningPatternConfig[],
): { named: string[]; unnamed: string[] } | undefined {
  const parsed: unknown = Result.fromThrowable(JSON.parse)(body).unwrapOr(undefined);
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "validation_errors")) {
    return undefined;
  }

  const sent = parsed.validation_errors;
  if (!isPlainObject(sent) || Object.keys(sent).length === 0) {
    return { named: [], unnamed: [`validation_errors: ${asSent(sent)}`] };
  }

  const named: string[] = [];
  const unnamed: string[] = [];
  for (const [index, entry] of Object.entries(sent)) {
    const pattern = REQUEST_INDEX.test(index) ? toCreate[Number(index)] : undefined;
    if (pattern === undefined) {
      unnamed.push(`validation_errors[${JSON.stringify(index)}]: ${asSent(entry)}`);
      continue;
    }

    named.push(...patternRefusal(`${key}[${pattern.name}]`, entry));
  }

  return { named, unnamed };
}

/** The sentences a create's 422 line ends in: the named refusals with their fix, then what GitHub tied to no pattern. */
function createRefusalAdvice(refusals: ReturnType<typeof createRefusals>): string {
  if (refusals === undefined) {
    return "GitHub did not say which pattern it refused; check the regular expressions of the patterns named above";
  }

  const { named, unnamed } = refusals;
  const sentences: string[] = [];
  if (named.length > 0) {
    sentences.push(
      `GitHub refused ${named.join("; ")}`,
      "Fix each named pattern in the settings file to satisfy GitHub's message",
    );
  }
  if (unnamed.length > 0) {
    sentences.push(
      `GitHub ${named.length > 0 ? "also " : ""}answered, tied to no pattern of the request: ${unnamed.join("; ")}`,
    );
  }
  if (named.length === 0) {
    sentences.push("Check the regular expressions of the patterns named above");
  }

  return sentences.join(". ");
}

/** The one bulk create, its drift and change lines one per pattern; undefined with nothing to create. */
function createOp(
  toCreate: readonly SecretScanningPatternConfig[],
  path: string,
): PatternOp | undefined {
  const [first, ...rest] = toCreate;
  if (first === undefined) {
    return undefined;
  }

  const missing = (p: SecretScanningPatternConfig): string => missingDrift(`${key}[${p.name}]`);
  const created = (p: SecretScanningPatternConfig): string =>
    `created secret scanning custom pattern "${p.name}"`;
  const describe = `creating secret scanning ${agree(toCreate.length, "pattern", "patterns")} ${toCreate.map((p) => `"${p.name}"`).join(", ")}`;
  return {
    role: "create",
    payload: { patterns: toCreate.map(createBody) },
    describe,
    drift: [missing(first), ...rest.map(missing)],
    tolerate: {
      statuses: [422],
      outcome: (error) => {
        const advice = createRefusalAdvice(createRefusals(error.body, toCreate));
        const docs = error.documentationUrl
          ? `. The fields and values this endpoint accepts are documented at ${error.documentationUrl}`
          : "";
        return {
          failure: `${key}: ${describe} failed - POST ${path}: ${error.status} ${error.message}. ${advice}${docs}`,
        };
      },
    },
    change: () => ok([created(first), ...rest.map(created)] as const),
  };
}

/** The one bulk delete of the undeclared patterns, their alerts resolved; undefined with nothing to delete. */
function deleteOp(
  toDelete: readonly LivePattern[],
  listDefault: UndeclaredPolicy,
): PatternOp | undefined {
  const [first, ...rest] = toDelete;
  if (first === undefined) {
    return undefined;
  }

  const undeclared = (p: LivePattern): string =>
    undeclaredDrift(listDefault, {
      label: `${key}[${p.name}]`,
      action: "DELETE it and resolve its alerts",
    });
  const deleted = (p: LivePattern): string =>
    `DELETED undeclared secret scanning custom pattern "${p.name}" (alerts resolved, not deleted)`;
  // post_delete_action is ALWAYS "resolve_alerts": this action never destroys alert history
  // (upstream defaults to delete_alerts), and there is no user knob.
  return {
    role: "remove",
    payload: { patterns: toDelete.map(deleteBody), post_delete_action: "resolve_alerts" },
    describe: `deleting undeclared secret scanning ${agree(toDelete.length, "pattern", "patterns")} ${toDelete.map((p) => `"${p.name}"`).join(", ")}`,
    drift: [undeclared(first), ...rest.map(undeclared)],
    change: () => ok([deleted(first), ...rest.map(deleted)] as const),
  };
}

/** The declared walk: an entry with no live pattern goes to the bulk create, the rest PATCH where their fields diverge. */
function declaredWrites(
  desired: readonly SecretScanningPatternConfig[],
  liveByName: ReadonlyMap<string, LivePattern>,
): { toCreate: SecretScanningPatternConfig[]; updates: PatternOp[] } {
  const toCreate: SecretScanningPatternConfig[] = [];
  const updates: PatternOp[] = [];
  for (const entry of desired) {
    const existing = liveByName.get(entry.name);
    if (existing === undefined) {
      toCreate.push(entry);
      continue;
    }

    const update = updateOp(entry, existing);
    if (update !== undefined) {
      updates.push(update);
    }
  }

  return { toCreate, updates };
}

/** The live patterns nobody declared, for the bulk delete; under the keep policy each earns a note on `plan` instead. */
function undeclaredPatterns(
  live: readonly LivePattern[],
  declaredNames: ReadonlySet<string>,
  policy: UndeclaredPolicy,
  plan: SectionPlan<PatternOp>,
): LivePattern[] {
  const toDelete: LivePattern[] = [];
  for (const pattern of live) {
    if (declaredNames.has(pattern.name)) {
      continue;
    }

    if (policy === "keep") {
      plan.notes.push(
        undeclaredNote({
          subject: `secret scanning custom pattern "${pattern.name}"`,
          action: "DELETE it (its alerts are then resolved, not deleted)",
        }),
      );
      continue;
    }

    toDelete.push(pattern);
  }

  return toDelete;
}

export const secretScanningPatternsSection = {
  // Verbatim: GitHub matches pattern names exactly.
  ...identifiedBy(key, "name", "custom pattern"),
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: routed(knobbed(SecretScanningPatternConfig)),
  // The POST/PATCH bodies carry only the six declared fields, so an extra key has no destination and can only be a typo.
  closedSurface: {
    known: {
      name: true,
      pattern: true,
      start_delimiter: true,
      end_delimiter: true,
      must_match: true,
      must_not_match: true,
    },
    consequence:
      'the pattern endpoints accept no other field - in particular "state" and "push_protection_enabled" are read-only through this API surface - so the key would be dropped silently and never converge',
  },
  async plan(ctx, declared) {
    const listDefault = defaultUndeclaredPolicy(this);
    const { policy, entries: desired } = undeclaredPolicy(declared, listDefault);
    return ctx.read.list
      .listAll(LivePatternEntry)
      .map((entries) => entries.map(liveFrom))
      .andThen((live) =>
        patternsByName(this, live).map((liveByName) => {
          const declaredNames = new Set(desired.map((p) => p.name));
          const plan: SectionPlan<PatternOp> = { ops: [], notes: [], drift: [] };
          const { toCreate, updates } = declaredWrites(desired, liveByName);
          const toDelete = undeclaredPatterns(live, declaredNames, policy, plan);

          const create = createOp(toCreate, expand(ENDPOINTS.create, ctx));
          if (create !== undefined) {
            plan.ops.push(create);
          }
          plan.ops.push(...updates);
          const remove = deleteOp(toDelete, listDefault);
          if (remove !== undefined) {
            plan.ops.push(remove);
          }

          return plan;
        }),
      );
  },
  async snapshot(ctx) {
    return ctx.read.list.listAll(LivePatternEntry).andThen((live) => {
      if (live.length === 0) {
        return ok<SectionSnapshot<typeof key>, SectionFailure>({ value: undefined, notes: [] });
      }
      return patternsByName(this, live).map((): SectionSnapshot<typeof key> => {
        const entries = live.map((pattern) =>
          projectOntoSchema(SecretScanningPatternConfig, pattern),
        );
        return { value: knobbedSnapshot(this, entries), notes: [] };
      });
    });
  },
} satisfies SectionModule<"secret_scanning_custom_patterns", typeof ENDPOINTS>;

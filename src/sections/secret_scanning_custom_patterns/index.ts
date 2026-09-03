/**
 * `secret_scanning_custom_patterns:` section - repository-level secret
 * scanning custom patterns, matched by exact name. The name is immutable
 * upstream (the update PATCH takes no name field), so a renamed entry is
 * created under the new name while the old pattern follows the undeclared
 * policy: deleted under `undeclared: delete`, kept and noted under the
 * default keep. Undeclared patterns are KEPT by default:
 * removing a pattern disposes of its alerts, so deletion stays a human
 * opt-in through the wrapped `undeclared: delete` form. Every delete this
 * action issues asks GitHub to RESOLVE the pattern's alerts
 * (post_delete_action: "resolve_alerts"), never to delete them: a settings
 * change must not destroy alert history, and resolved alerts keep the
 * audit trail.
 *
 * Writes ride the pattern's custom_pattern_version (optimistic
 * concurrency) whenever GitHub supplies one: the list GET carries each live
 * pattern's version, the PATCH/DELETE send it back, and a pattern edited on
 * GitHub between this run's read and its write answers 412 instead of
 * clobbering the edit. A version-less live pattern (the GET marks the field
 * optional and nullable) writes without the check, as the API allows.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, type PlannedOp, type SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { SecretScanningPatternConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["secret_scanning_alerts"] };

/** The subset of the known entry keys the update PATCH accepts (everything but the immutable name). */
const UPDATABLE_KEYS = [
  "pattern",
  "start_delimiter",
  "end_delimiter",
  "must_match",
  "must_not_match",
] as const;
type UpdatableKey = (typeof UPDATABLE_KEYS)[number];

/**
 * A 403/404 on this family is ambiguous: it can also mean secret scanning
 * itself is off for the repository, not that the token lacks the grant.
 */
const NOT_ENABLED_HINT =
  "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";

/**
 * The 412 advice both versioned writes share (see the module doc); exported
 * so the troubleshooting guide's verbatim quote is test-pinned.
 */
export const STALE_VERSION_HINT =
  "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: { 200: "the custom-pattern list" },
    denialHint: NOT_ENABLED_HINT,
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: { 201: "patterns created" },
    hints: {
      422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern",
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

/** The live GET-shape fields the planner reads; parsed at the boundary below. */
interface LivePattern {
  id: number;
  name: string;
  version: string | undefined;
  fields: Partial<Record<UpdatableKey, unknown>>;
}

/**
 * One live list entry, parsed loudly at the boundary: an entry without a string name or a
 * numeric id cannot be reconciled at all. The version is genuinely optional (a version-less
 * pattern forgoes optimistic concurrency), but a PRESENT non-string one must not bypass it.
 */
const LivePatternEntry = z.looseObject({
  id: z.number(),
  name: z.string(),
  custom_pattern_version: z.string().nullish(),
});

/** Project one parsed entry onto the fields the reconciliation reads. */
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

/** The declared updatable fields of an entry, as the write bodies carry them. */
function declaredFields(declared: SecretScanningPatternConfig): Record<string, string | string[]> {
  return Object.fromEntries(
    UPDATABLE_KEYS.flatMap((key) => {
      const value = declared[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** The bulk-create entry for one declared pattern: name, pattern, and the declared optionals. */
function createBody(declared: SecretScanningPatternConfig): Record<string, string | string[]> {
  return { name: declared.name, pattern: declared.pattern, ...declaredFields(declared) };
}

/** The bulk-delete entry for one live pattern; a version-less pattern omits the optional version. */
function deleteBody(pattern: LivePattern): { pattern_id: number; custom_pattern_version?: string } {
  return pattern.version === undefined
    ? { pattern_id: pattern.id }
    : { pattern_id: pattern.id, custom_pattern_version: pattern.version };
}

/**
 * Whether a declared value matches its live counterpart: serialized, so the must_match lists
 * compare in order like every full-payload list. A live null/absent LIST equals a declared []
 * (the GET marks the lists nullable, so [] against null would otherwise PATCH on every run).
 */
function matches(declaredValue: string | string[], liveValue: unknown): boolean {
  const liveComparable =
    Array.isArray(declaredValue) && (liveValue === undefined || liveValue === null)
      ? []
      : liveValue;
  return JSON.stringify(liveComparable) === JSON.stringify(declaredValue);
}

const key = "secret_scanning_custom_patterns";

export const secretScanningPatternsSection = {
  key,
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(SecretScanningPatternConfig)),
  // Closed surface: the POST/PATCH bodies carry only the six declared
  // fields, so an extra key has no destination and can only be a typo.
  closedSurface: {
    known: {
      name: true,
      pattern: true,
      start_delimiter: true,
      end_delimiter: true,
      must_match: true,
      must_not_match: true,
    },
    describe: (p) => p.name,
    consequence:
      'the pattern endpoints accept no other field - in particular "state" and "push_protection_enabled" are read-only through this API surface - so the key would be dropped silently and never converge',
  },
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (p) => p.name,
      (p) => p.name,
    );
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LivePatternEntry),
      await ctx.read.list.listAll(),
    ).map(liveFrom);
    const liveByName = new Map(live.map((p) => [p.name, p]));
    const declaredNames = new Set(desired.map((p) => p.name));

    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    // Only DECLARED fields are compared: an omitted optional keeps whatever
    // the live pattern carries. Each PATCH sends the live version plus only
    // the divergent fields; the missing patterns share ONE bulk POST.
    const toCreate: SecretScanningPatternConfig[] = [];
    const updates: PlannedOp<typeof ENDPOINTS>[] = [];
    for (const entry of desired) {
      const existing = liveByName.get(entry.name);
      if (existing === undefined) {
        toCreate.push(entry);
        continue;
      }
      const divergent = Object.entries(declaredFields(entry)).filter(
        ([field, value]) => !matches(value, existing.fields[field as UpdatableKey]),
      );
      const drift = divergent.map(([field, value]) => {
        const liveValue = existing.fields[field as UpdatableKey];
        // JSON.stringify(undefined) is not a string; spell absence out.
        const liveRendered = liveValue === undefined ? "(absent)" : JSON.stringify(liveValue);
        return `${key}[${entry.name}].${field}: declared ${JSON.stringify(value)} != live ${liveRendered}; apply will set the declared value`;
      });
      if (!hasDrift(drift)) {
        continue;
      }
      updates.push({
        role: "update",
        params: { pattern_id: String(existing.id) },
        // The PATCH body REQUIRES the version key but accepts null: a
        // version-less live pattern writes without the concurrency check.
        payload: {
          custom_pattern_version: existing.version ?? null,
          ...Object.fromEntries(divergent),
        },
        describe: `updating secret scanning pattern "${existing.name}"`,
        drift,
        change: `updated secret scanning custom pattern "${existing.name}"`,
      });
    }

    // No rename inference: a declared name matching nothing is a create even
    // when an undeclared live pattern carries identical fields.
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

    const [firstCreate, ...restCreate] = toCreate;
    if (firstCreate !== undefined) {
      const missing = (p: SecretScanningPatternConfig): string =>
        `${key}[${p.name}]: missing - declared in the settings file but not on the repo; apply will create it`;
      const created = (p: SecretScanningPatternConfig): string =>
        `created secret scanning custom pattern "${p.name}"`;
      plan.ops.push({
        role: "create",
        payload: { patterns: toCreate.map(createBody) },
        describe: `creating secret scanning pattern(s) ${toCreate.map((p) => `"${p.name}"`).join(", ")}`,
        drift: [missing(firstCreate), ...restCreate.map(missing)],
        change: () => [created(firstCreate), ...restCreate.map(created)] as const,
      });
    }
    plan.ops.push(...updates);
    const [firstDelete, ...restDelete] = toDelete;
    if (firstDelete !== undefined) {
      const undeclared = (p: LivePattern): string =>
        undeclaredDrift(defaultUndeclaredPolicy(this), {
          label: `${key}[${p.name}]`,
          action: "DELETE it and resolve its alerts",
        });
      const deleted = (p: LivePattern): string =>
        `DELETED undeclared secret scanning custom pattern "${p.name}" (alerts resolved, not deleted)`;
      // ONE bulk DELETE. post_delete_action is ALWAYS "resolve_alerts", by
      // policy: this action never destroys alert history (upstream defaults
      // to delete_alerts), and there is no user knob.
      plan.ops.push({
        role: "remove",
        payload: { patterns: toDelete.map(deleteBody), post_delete_action: "resolve_alerts" },
        describe: `deleting undeclared secret scanning pattern(s) ${toDelete.map((p) => `"${p.name}"`).join(", ")}`,
        drift: [undeclared(firstDelete), ...restDelete.map(undeclared)],
        change: () => [deleted(firstDelete), ...restDelete.map(deleted)] as const,
      });
    }
    return plan;
  },
} satisfies SectionModule<"secret_scanning_custom_patterns", typeof ENDPOINTS>;

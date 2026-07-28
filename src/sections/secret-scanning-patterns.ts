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
 * concurrency): the list GET supplies each live pattern's version, and the
 * PATCH/DELETE send it back, so a pattern edited on GitHub between this
 * run's read and its write answers 412 instead of clobbering the edit.
 */

import { z } from "zod";
import type { MustBeNever, SecretScanningPatternConfig, UndeclaredPolicyList } from "../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  emptyResult,
  grantFor,
  listAll,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
  undeclaredPolicyShape,
} from "./contract.js";

const permission: SectionPermission = { repo: ["secret_scanning_alerts"] };

const KNOWN_KEYS = [
  "name",
  "pattern",
  "start_delimiter",
  "end_delimiter",
  "must_match",
  "must_not_match",
] as const;
/** Compile-time lockstep: a SecretScanningPatternConfig field missing from KNOWN_KEYS fails here. */
type _AllKeysKnown = MustBeNever<
  Exclude<keyof SecretScanningPatternConfig, (typeof KNOWN_KEYS)[number]>
>;

/** The subset of KNOWN_KEYS the update PATCH accepts (everything but the immutable name). */
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

/** The 412 advice both versioned writes share (see the module doc). */
const STALE_VERSION_HINT =
  "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    statuses: { 200: "the custom-pattern list" },
    denialHint: NOT_ENABLED_HINT,
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

/** The live GET-shape fields the handler reads; extracted loudly below. */
interface LivePattern {
  id: number;
  name: string;
  version: string | undefined;
  fields: Partial<Record<UpdatableKey, unknown>>;
}

/**
 * Extract the fields the handler needs from one live list entry, loudly: an
 * entry without a string name or a numeric id cannot be reconciled at all,
 * so it is a contract violation, not something to skip. The version is
 * optional HERE (the GET marks it optional); the write paths demand it via
 * requireVersion, only when a write actually needs it.
 */
function liveFrom(entry: unknown): LivePattern {
  const raw = (entry ?? {}) as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.id !== "number") {
    throw new Error(
      `secret_scanning_custom_patterns: the custom-pattern list returned an entry without a string "name" and numeric "id" (got ${JSON.stringify(entry)}). Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  const fields: Partial<Record<UpdatableKey, unknown>> = {};
  for (const key of UPDATABLE_KEYS) {
    if (raw[key] !== undefined) {
      fields[key] = raw[key];
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    version:
      typeof raw.custom_pattern_version === "string" ? raw.custom_pattern_version : undefined,
    fields,
  };
}

/** The version a PATCH/DELETE must send; its absence from the GET is a contract violation. */
function requireVersion(live: LivePattern): string {
  if (live.version === undefined) {
    throw new Error(
      `secret_scanning_custom_patterns: the custom-pattern list returned "${live.name}" without a string "custom_pattern_version", which the update/delete calls require. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return live.version;
}

/** The POST body entry for one declared pattern: name, pattern, and the declared optionals. */
function createBody(declared: SecretScanningPatternConfig): Record<string, unknown> {
  const body: Record<string, unknown> = { name: declared.name, pattern: declared.pattern };
  for (const key of UPDATABLE_KEYS) {
    if (declared[key] !== undefined) {
      body[key] = declared[key];
    }
  }
  return body;
}

export const secretScanningPatternsSection: SectionModule<"secret_scanning_custom_patterns"> = {
  key: "secret_scanning_custom_patterns",
  undeclaredDefault: "keep",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: undeclaredPolicyShape(
    z.array(
      z.looseObject({
        name: z.string(),
        pattern: z.string(),
        start_delimiter: z.string().optional(),
        end_delimiter: z.string().optional(),
        must_match: z.array(z.string()).optional(),
        must_not_match: z.array(z.string()).optional(),
      }),
    ),
  ),
  // Closed surface: the POST/PATCH bodies carry only the six declared
  // fields, so an extra key has no destination and can only be a typo.
  closedSurface: {
    known: KNOWN_KEYS,
    describe: (p) => p.name,
    consequence:
      'the pattern endpoints accept no other field - in particular "state" and "push_protection_enabled" are read-only through this API surface - so the key would be dropped silently and never converge',
  },
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const { policy, entries: desired } = undeclaredPolicy(
      desiredRaw as
        | SecretScanningPatternConfig[]
        | UndeclaredPolicyList<SecretScanningPatternConfig>,
      defaultUndeclaredPolicy(this),
    );
    rejectDuplicates(
      this,
      desired,
      (p) => p.name,
      (p) => p.name,
    );
    const live = (await listAll(ctx, this, ENDPOINTS.list)).map(liveFrom);
    const liveByName = new Map(live.map((p) => [p.name, p]));

    // Resolve EVERYTHING before the first write - liveFrom and
    // requireVersion throw on a contract violation, and both run in THIS
    // planning pass - so a failure between the bulk POST, the PATCHes, and
    // the bulk DELETE can only be GitHub's own rejection, never a
    // half-applied run this section could have avoided.
    const toCreate: SecretScanningPatternConfig[] = [];
    const toUpdate: Array<{
      live: LivePattern;
      version: string;
      divergent: Record<string, unknown>;
    }> = [];
    const declaredNames = new Set(desired.map((p) => p.name));

    for (const declared of desired) {
      const existing = liveByName.get(declared.name);
      if (!existing) {
        toCreate.push(declared);
        if (ctx.check) {
          result.drift.push(
            `secret_scanning_custom_patterns[${declared.name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        }
        continue;
      }
      // Only DECLARED fields are compared: an omitted optional keeps
      // whatever the live pattern carries, per the declared-keys-only tenet.
      // The must_match/must_not_match lists compare in order (serialized),
      // like every other full-payload list in this action - except that a
      // live null/absent LIST equals a declared []: the GET marks the
      // lists nullable, so without this a declared [] against a null would
      // PATCH [] on every run (forever, if GitHub stores [] back as null).
      // A declared [] against a live ["a"] still clears it.
      const divergent: Record<string, unknown> = {};
      for (const key of UPDATABLE_KEYS) {
        const declaredValue = declared[key];
        if (declaredValue === undefined) {
          continue;
        }
        const liveValue = existing.fields[key];
        const liveComparable =
          Array.isArray(declaredValue) && (liveValue === undefined || liveValue === null)
            ? []
            : liveValue;
        if (JSON.stringify(liveComparable) === JSON.stringify(declaredValue)) {
          continue;
        }
        divergent[key] = declaredValue;
        if (ctx.check) {
          result.drift.push(
            `secret_scanning_custom_patterns[${declared.name}].${key}: declared ${JSON.stringify(declaredValue)} != live ${JSON.stringify(liveValue)}; apply will set the declared value`,
          );
        }
      }
      if (Object.keys(divergent).length > 0) {
        toUpdate.push({ live: existing, version: requireVersion(existing), divergent });
      }
    }

    // Undeclared live patterns - a renamed-away one included: a declared
    // name matching nothing stays a create even when an undeclared live
    // pattern carries identical fields (no rename inference; the name is
    // the identity). The version is required in BOTH modes: check would
    // otherwise print a clean will-DELETE drift line for a version-less
    // pattern that apply then throws on.
    const toDelete: Array<{ live: LivePattern; version: string }> = [];
    for (const pattern of live) {
      if (declaredNames.has(pattern.name)) {
        continue;
      }
      if (policy === "keep") {
        result.notes.push(
          `secret scanning custom pattern "${pattern.name}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it (its alerts are then resolved, not deleted)`,
        );
        continue;
      }
      const version = requireVersion(pattern);
      if (ctx.check) {
        result.drift.push(
          `secret_scanning_custom_patterns[${pattern.name}]: undeclared - not in the settings file, so apply will DELETE it and resolve its alerts; add it to the settings file to keep it`,
        );
      } else {
        toDelete.push({ live: pattern, version });
      }
    }
    if (ctx.check) {
      return result;
    }

    if (toCreate.length > 0) {
      // ONE bulk POST for every missing pattern.
      await call(ctx, this, ENDPOINTS.create, {
        payload: { patterns: toCreate.map(createBody) },
        describe: `creating secret scanning pattern(s) ${toCreate.map((p) => `"${p.name}"`).join(", ")}`,
      });
      for (const declared of toCreate) {
        result.changes.push(`created secret scanning custom pattern "${declared.name}"`);
      }
    }
    for (const { live: existing, version, divergent } of toUpdate) {
      await call(ctx, this, ENDPOINTS.update, {
        params: { pattern_id: String(existing.id) },
        payload: { custom_pattern_version: version, ...divergent },
        describe: `updating secret scanning pattern "${existing.name}"`,
      });
      result.changes.push(`updated secret scanning custom pattern "${existing.name}"`);
    }
    if (toDelete.length > 0) {
      // ONE bulk DELETE. post_delete_action is ALWAYS "resolve_alerts", by
      // policy: this action never destroys alert history (upstream defaults
      // to delete_alerts), and there is no user knob.
      await call(ctx, this, ENDPOINTS.remove, {
        payload: {
          patterns: toDelete.map((p) => ({
            pattern_id: p.live.id,
            custom_pattern_version: p.version,
          })),
          post_delete_action: "resolve_alerts",
        },
        describe: `deleting undeclared secret scanning pattern(s) ${toDelete.map((p) => `"${p.live.name}"`).join(", ")}`,
      });
      for (const pattern of toDelete) {
        result.changes.push(
          `DELETED undeclared secret scanning custom pattern "${pattern.live.name}" (alerts resolved, not deleted)`,
        );
      }
    }
    return result;
  },
};

/**
 * The wording every section shares for drift lines and notes, so a line reads alike whichever section
 * wrote it.
 */

import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { UNDECLARED_POLICIES } from "../shared/schema-helpers.js";

/** The policy type in ../../types.ts is zod-free and spells the values itself; both pins fail when the two sets part. */
type _PolicyComplete = MustBeNever<Exclude<(typeof UNDECLARED_POLICIES)[number], UndeclaredPolicy>>;
type _PolicySound = MustBeNever<Exclude<UndeclaredPolicy, (typeof UNDECLARED_POLICIES)[number]>>;

/**
 * The ONE wording for a declared value check mode cannot compare (a secret GitHub never echoes, a
 * toggle with no read endpoint, a duration GitHub reports only as its computed expiry): why, what
 * stays unverified, and what apply does about it on every run.
 */
export function cannotVerifyNote(
  label: string,
  opts: {
    /** Why GitHub cannot show the value ("GitHub never reveals a webhook secret"). */
    why: string;
    /** What stays unverified ("the declared value", "them"). */
    what: string;
    /** Apply's every-run verb phrase ("re-sends it", "re-asserts the declared preferences"). */
    reasserts: string;
  },
): string {
  return `${label}: ${opts.why}, so check mode cannot verify ${opts.what}; apply ${opts.reasserts} on every run`;
}

/**
 * A validated document arrives with every knobbed list in wrapper form and its policy explicit
 * (resolveUndeclaredPolicies in engine/undeclared.ts runs at the fold and in the validator), so at run time the
 * wrapper's `_undeclared` is what a planner reads. `defaultPolicy` is REQUIRED all the same: it is the list's
 * own default, which the drift prose names and which a plan() called on a raw declaration (a test) falls back
 * to, and a nested list cannot derive it from its section's undeclaredDefault. Entries are returned by reference.
 */
export function undeclaredPolicy<E>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  defaultPolicy: UndeclaredPolicy,
): { policy: UndeclaredPolicy; entries: readonly E[] } {
  if (Array.isArray(declared)) {
    return { policy: defaultPolicy, entries: declared };
  }
  const wrapped = declared as UndeclaredPolicyList<E>;
  return { policy: wrapped._undeclared ?? defaultPolicy, entries: wrapped.entries };
}

/**
 * Only the WORDS live here, so the keep-note cannot drift between sections; which branch runs stays in
 * each section's own control flow on purpose.
 */
export function undeclaredNote(opts: {
  /** The subject naming the live resource: `label "stale"`, `autolink JIRA-`. */
  subject: string;
  /** How the resource presents; the common case is the default. */
  state?: string;
  /** The pronoun for "add ... to the settings file" ("it" unless plural). */
  add?: string;
  /** What adding it would manage ("it", or "their access" for people). */
  manage?: string;
  /** What `_undeclared: delete` would make apply do, with any consequence. */
  action: string;
}): string {
  const state = opts.state ?? "exists on the repo but is not declared";
  const add = opts.add ?? "it";
  const manage = opts.manage ?? "it";
  return `${opts.subject} ${state} in the settings file; kept under "_undeclared: keep" - add ${add} to the settings file to manage ${manage}, or set "_undeclared: delete" to have apply ${opts.action}`;
}

/**
 * The drift line for a field whose live value differs, operands always in this order: declared first,
 * live second. Both arrive rendered (JSON.stringify, or a section's own spelling such as "unset").
 */
export function valueDrift(
  label: string,
  declared: string,
  live: string,
  opts: {
    /** Qualifies the live value, in parentheses: a raw state behind the compared one, why order counts. */
    qualifier?: string;
    /** The apply clause; null when a generic line beside it already names the remedy (a recreate's field lines). */
    remedy?: string | null;
  } = {},
): string {
  const qualifier = opts.qualifier === undefined ? "" : ` (${opts.qualifier})`;
  const remedy =
    opts.remedy === null ? "" : `; ${opts.remedy ?? "apply will set the declared value"}`;
  return `${label}: declared ${declared} != live ${live}${qualifier}${remedy}`;
}

/**
 * The knob clause derives from the list's DEFAULT policy so it can never contradict the section: under a
 * keep default this branch is reachable only because the file set `_undeclared: delete`, so the line says
 * so. Pass the same default the policy was unwrapped with.
 */
export function undeclaredDrift(
  listDefault: UndeclaredPolicy,
  opts: {
    /** The drift-line prefix with the natural key: `labels[stale]`. */
    label: string;
    /** What apply will do, with any consequence worth naming. */
    action: string;
    /** When "not in the settings file" understates it (a PENDING INVITATION rather than a collaborator); the knob clause follows it. */
    state?: string;
    /** The pronoun for "add ... to the settings file" ("it" unless plural). */
    add?: string;
    /** What adding it would keep ("it", or "their access" for people). */
    keep?: string;
  },
): string {
  const knob = listDefault === "keep" ? ' and "_undeclared: delete" is set' : "";
  const state = opts.state ?? "not in the settings file";
  const add = opts.add ?? "it";
  const keep = opts.keep ?? "it";
  return `${opts.label}: undeclared - ${state}${knob}, so apply will ${opts.action}; add ${add} to the settings file to keep ${keep}`;
}

/**
 * The drift line for a declared resource the live side lacks. `where` completes "but not ..." when "on the
 * repo" understates it ("on the environment", "enabled on the environment"); `action` when apply does more
 * than create it.
 */
export function missingDrift(
  label: string,
  opts: { where?: string; action?: string } = {},
): string {
  return `${label}: missing - declared in the settings file but not ${opts.where ?? "on the repo"}; apply will ${opts.action ?? "create it"}`;
}

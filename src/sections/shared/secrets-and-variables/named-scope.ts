/**
 * The frame the secrets engine (./secrets-engine.ts) and the variables engine (./variables-engine.ts) both fill:
 * the words a scope renders with, the uppercase fold GitHub matches names by, the duplicate-name refusal, the
 * duplicate-live index, and the plan over one scope (list, index, the declared pass, the undeclared pass). What a
 * value IS (sealed and write-only, or readable and compared) stays in the engine: it decides the declared pass's
 * ops and notes, so each engine writes that pass and hands it in.
 */

import { err, ok, type Result } from "neverthrow";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../../types.js";
import type { SectionFailure } from "../../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../../contract/live.js";
import {
  type DeclaredIssue,
  duplicateFieldIssues,
  missingDrift,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
} from "../../contract/module.js";
import { paramsWith, type SectionPlan } from "../../contract/plan.js";

export type AnyPlannedOp = SectionPlan["ops"][number];

export interface Named {
  readonly name: string;
}

/** The words a scope supplies; a nested scope names its home so the lines say where the value lives. */
export interface ScopeProse {
  /** The drift-line prefix, e.g. "actions_secrets" or "environments[prod].variables". */
  label: string;
  /** The noun for notes ("Actions secret"; a nested scope says "prod environment secret"). */
  noun: string;
  /** Where the values live when "the repo" understates it ("the environment"). */
  where?: string;
  /** Appended to change and describe lines (` in environment "prod"`). */
  suffix?: string;
}

/** The matching key for a secret or variable name: GitHub stores and compares uppercase. */
export function upperKey(name: string): string {
  return name.toUpperCase();
}

/**
 * GitHub folds two names equal uppercased into one value, so the last write would silently win on every run.
 * Every scope's validate hook runs it over its declared value in either form (the plan trusts the document);
 * `what` names the resource ("secret", `variable of the "prod" environment`).
 */
export function duplicateNameIssues<E extends Named>(
  declared: readonly E[] | UndeclaredPolicyList<E>,
  what: string,
): DeclaredIssue[] {
  return duplicateFieldIssues(declared, { field: "name", fold: upperKey }, what);
}

/**
 * The live items by their uppercase key, under the duplicate-live guard: the plan and every snapshot over a
 * secrets or variables list index through it, so none can read a pair GitHub folds into one value as two.
 */
export function liveByName<Live extends Named>(
  section: SectionMeta,
  noun: string,
  live: readonly Live[],
): Result<Map<string, Live>, SectionFailure> {
  return liveByIdentity(
    section,
    noun,
    live,
    (item) => upperKey(item.name),
    (item) => liveIdentity(item.name),
  );
}

function homeOf(scope: ScopeProse): string {
  return scope.where ?? "the repo";
}

/** The drift line of a declared name the list lacks; `name` is spelled as the engine's lines spell it. */
export function missingNamedDrift(scope: ScopeProse, name: string): string {
  return missingDrift(`${scope.label}[${name}]`, { where: `on ${homeOf(scope)}` });
}

export interface UndeclaredDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  readonly drift: readonly [string];
  readonly change: string;
}

/** The DELETE mapper under a scope's role name; `token` is the route's name placeholder, `params` the rest. */
export function undeclaredRemoval<
  Role extends string,
  Params extends Readonly<Record<string, string>> | undefined,
  Token extends string,
>(role: Role, params: Params, token: Token) {
  return ({ name, ...deletion }: UndeclaredDeletion) => ({
    role,
    params: paramsWith(params, token, name),
    ...deletion,
  });
}

/** `Remove` is the section's exact PlannedOp arm, so a wrong role or params fails to compile. */
export interface NamedScope<Live extends Named, Remove extends AnyPlannedOp> extends ScopeProse {
  /** The parsed identities of the enveloped list, all pages. */
  readonly list: () => PromiseLike<Result<Live[], SectionFailure>>;
  /**
   * The planned DELETE of an undeclared live item; function-valued so a builder demanding an unsupplied
   * facet fails.
   */
  readonly remove: (deletion: UndeclaredDeletion) => Remove;
}

export interface NamedPlanOpts<Entry extends Named> {
  entries: readonly Entry[];
  policy: UndeclaredPolicy;
  /**
   * The DEFAULT `policy` was unwrapped against (the section's undeclaredDefault, or environments'
   * fixed nested default); undeclaredDrift derives its knob clause from it.
   */
  defaultPolicy: UndeclaredPolicy;
}

/** The words the undeclared pass renders one kind with; a deleted secret's value is gone, a variable's is not. */
export interface UndeclaredWords {
  /** The noun of the change and describe lines (`DELETED undeclared <what> "NAME"`). */
  readonly what: string;
  /** The keep-note's apply clause, after "to have apply". */
  readonly noteAction: string;
  /** The drift line's apply clause, after "so apply will". */
  readonly driftAction: string;
}

/** What one engine's declared pass yields; its ops and notes lead the plan, ahead of the undeclared pass's. */
export interface DeclaredPass<Op extends AnyPlannedOp> {
  readonly ops: readonly Op[];
  readonly notes: readonly string[];
}

/**
 * One scope's plan. `liveOf` answers the declared pass with the listed item a declared entry names, whatever
 * casing the file uses; the undeclared pass then keeps or DELETEs every listed item the entries omit.
 */
export async function planNamed<
  Entry extends Named,
  Live extends Named,
  Op extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
>(
  section: SectionMeta,
  scope: NamedScope<Live, Remove>,
  opts: NamedPlanOpts<Entry>,
  words: UndeclaredWords,
  declared: (liveOf: (entry: Entry) => Live | undefined) => DeclaredPass<Op>,
): Promise<Result<SectionPlan<Op | Remove>, SectionFailure>> {
  const { entries, policy, defaultPolicy } = opts;
  const suffix = scope.suffix ?? "";

  const indexed = (await scope.list()).andThen((live) => liveByName(section, scope.noun, live));
  if (indexed.isErr()) {
    return err(indexed.error);
  }
  const liveByKey = indexed.value;
  const pass = declared((entry) => liveByKey.get(upperKey(entry.name)));
  const plan: SectionPlan<Op | Remove> = { ops: [...pass.ops], notes: [...pass.notes], drift: [] };

  const declaredKeys = new Set(entries.map((entry) => upperKey(entry.name)));
  for (const live of liveByKey.values()) {
    if (declaredKeys.has(upperKey(live.name))) {
      continue;
    }
    if (policy === "keep") {
      plan.notes.push(
        undeclaredNote({
          subject: `${scope.noun} "${live.name}"`,
          state: `exists on ${homeOf(scope)} but is not declared`,
          action: words.noteAction,
        }),
      );
    } else {
      plan.ops.push(
        scope.remove({
          name: live.name,
          describe: `deleting undeclared ${words.what} "${live.name}"${suffix}`,
          drift: [
            undeclaredDrift(defaultPolicy, {
              label: `${scope.label}[${live.name}]`,
              action: words.driftAction,
            }),
          ],
          change: `DELETED undeclared ${words.what} "${live.name}"${suffix}`,
        }),
      );
    }
  }
  return ok(plan);
}

/**
 * Value reconciliation over route-free scopes: names match uppercased, and extra declared fields pass
 * through. The two repo families (./repo-variables.ts) and the environments section's nested variables
 * (../environments/nested.ts) plan through it.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import type { SectionFailure } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  type DeclaredIssue,
  duplicateFieldIssues,
  missingDrift,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
  valueDrift,
} from "../contract/module.js";
import { type PlainData, plainData, type SectionPlan } from "../contract/plan.js";

/** Case-insensitive key for variable names (GitHub stores them uppercased). */
export function variableKey(name: string): string {
  return name.toUpperCase();
}

export const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
export type LiveVariable = z.infer<typeof LiveVariable>;

type AnyPlannedOp = SectionPlan["ops"][number];

type PlainPayload = PlainData;

/** The index signature types the passthrough fields as plain data, so spreading them into a body needs no cast. */
export interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: PlainPayload | undefined;
}

/** The words a scope supplies; a nested scope names its home so the lines say where the variable lives. */
interface VariablesScopeProse {
  /** The drift-line prefix, e.g. "actions_variables" or "environments[prod].variables". */
  label: string;
  /** The noun for notes and change lines ("Actions variable"). */
  noun: string;
  /** Where the variables live when "the repo" understates it ("the environment"). */
  where?: string;
  /** Appended to change and describe lines (` in environment "prod"`). */
  suffix?: string;
}

interface VariableCreate {
  readonly payload: PlainPayload;
  readonly drift: readonly [string];
  readonly change: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
}

interface VariableUpdate {
  /** The LIVE name addresses the request path: it names what exists, whatever casing the file uses. */
  readonly liveName: string;
  readonly payload: PlainPayload;
  readonly drift: readonly [string, ...string[]];
  readonly change: string;
  readonly describe: string;
}

interface VariableDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  readonly drift: readonly [string];
  readonly change: string;
  readonly describe: string;
}

/** The type parameters are the section's exact PlannedOp arms, so a wrong role fails to compile. */
export interface VariablesPlanScope<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
> extends VariablesScopeProse {
  /** The parsed {name, value} identities of the enveloped list, all pages. */
  readonly list: () => PromiseLike<Result<LiveVariable[], SectionFailure>>;
  /** The planned POST; the builders are function-valued so one demanding an unsupplied facet fails. */
  readonly create: (write: VariableCreate) => Create;
  readonly update: (write: VariableUpdate) => Update;
  readonly remove: (deletion: VariableDeletion) => Remove;
}

/**
 * Variable names are case-insensitive on GitHub, so two entries differing only in case name one variable.
 * Every scope's validate hook runs it over its declared value in either form (planVariables trusts the
 * document); `what` names the resource ("variable", `variable of the "prod" environment`).
 */
export function duplicateVariableNameIssues(
  declared: readonly VariableEntry[] | UndeclaredPolicyList<VariableEntry>,
  what: string,
): DeclaredIssue[] {
  return duplicateFieldIssues(declared, { field: "name", fold: variableKey }, what);
}

/**
 * The live variables by their uppercase key, under the duplicate-live guard: plan() and every
 * snapshot over a variables list index through it, so none can read a pair GitHub folds into one
 * variable as two.
 */
export function liveVariablesByKey(
  section: SectionMeta,
  noun: string,
  live: readonly LiveVariable[],
): Result<Map<string, LiveVariable>, SectionFailure> {
  return liveByIdentity(
    section,
    noun,
    live,
    (variable) => variableKey(variable.name),
    (variable) => liveIdentity(variable.name),
  );
}

function undeclaredVariableNote(scope: VariablesScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.where ?? "the repo"} but is not declared`,
    action: "DELETE it",
  });
}

function undeclaredVariableDrift(
  scope: VariablesScopeProse,
  defaultPolicy: UndeclaredPolicy,
  liveName: string,
): string {
  return undeclaredDrift(defaultPolicy, {
    label: `${scope.label}[${liveName}]`,
    action: "DELETE it",
  });
}

export async function planVariables<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
>(
  section: SectionMeta,
  scope: VariablesPlanScope<Create, Update, Remove>,
  opts: {
    entries: readonly VariableEntry[];
    policy: UndeclaredPolicy;
    /**
     * The DEFAULT `policy` was unwrapped against (the section's undeclaredDefault, or environments'
     * fixed nested default); undeclaredDrift derives its knob clause from it.
     */
    defaultPolicy: UndeclaredPolicy;
  },
): Promise<Result<SectionPlan<Create | Update | Remove>, SectionFailure>> {
  const { entries, policy, defaultPolicy } = opts;
  const suffix = scope.suffix ?? "";
  const plan: SectionPlan<Create | Update | Remove> = { ops: [], notes: [], drift: [] };

  const indexed = (await scope.list()).andThen((live) =>
    liveVariablesByKey(section, scope.noun, live),
  );
  if (indexed.isErr()) {
    return err(indexed.error);
  }
  const liveByKey = indexed.value;
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));

  for (const variable of entries) {
    const label = `${scope.label}[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      plan.ops.push(
        scope.create({
          payload: plainData({ name: variable.name, value: variable.value, ...extraKeys }),
          drift: [missingDrift(label, { where: `on ${scope.where ?? "the repo"}` })],
          change: `created ${scope.noun} "${variable.name}"${suffix}`,
          describe: `creating ${scope.noun} "${variable.name}"${suffix}`,
        }),
      );
      continue;
    }

    // GitHub stores the name uppercased whatever casing the file uses, so the live name never drifts; only the value and passthrough fields can.
    const [first, ...rest] = [
      ...(existing.value !== variable.value
        ? [
            valueDrift(
              `${label}.value`,
              JSON.stringify(variable.value),
              JSON.stringify(existing.value),
            ),
          ]
        : []),
      ...subsetDiff(extraKeys, existing, label),
    ];
    if (first === undefined) {
      continue;
    }
    const phantom = phantomKeys(extraKeys, existing);
    if (phantom.length > 0) {
      plan.notes.push(phantomNote(label, phantom, "variable", "this update will re-run"));
    }
    plan.ops.push(
      scope.update({
        liveName: existing.name,
        payload: plainData({ value: variable.value, ...extraKeys }),
        drift: [first, ...rest],
        change: `updated ${scope.noun} "${variable.name}"${suffix}`,
        describe: `updating ${scope.noun} "${variable.name}"${suffix}`,
      }),
    );
  }

  for (const variable of liveByKey.values()) {
    if (declaredKeys.has(variableKey(variable.name))) {
      continue;
    }
    if (policy === "keep") {
      plan.notes.push(undeclaredVariableNote(scope, variable.name));
    } else {
      plan.ops.push(
        scope.remove({
          name: variable.name,
          drift: [undeclaredVariableDrift(scope, defaultPolicy, variable.name)],
          change: `DELETED undeclared ${scope.noun} "${variable.name}"${suffix}`,
          describe: `deleting undeclared ${scope.noun} "${variable.name}"${suffix}`,
        }),
      );
    }
  }
  return ok(plan);
}

/** Value reconciliation over route-free scopes: names match uppercased, and extra declared fields pass through. */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { liveByIdentity } from "../contract/live.js";
import { type SectionMeta, undeclaredDrift, undeclaredNote } from "../contract/module.js";
import type { ExecTools, SectionPlan } from "../contract/plan.js";

/** Case-insensitive key for variable names (GitHub stores them uppercased). */
export function variableKey(name: string): string {
  return name.toUpperCase();
}

export const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
export type LiveVariable = z.infer<typeof LiveVariable>;

type AnyPlannedOp = SectionPlan["ops"][number];

type PlainPayload = Exclude<NonNullable<AnyPlannedOp["payload"]>, (exec: ExecTools) => unknown>;

/** The index signature types the passthrough fields as plain data, so spreading them into a body needs no cast. */
export interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: PlainPayload | undefined;
}

interface VariablesScopeProse {
  /** The drift-line prefix, e.g. "actions_variables" or "environments[prod].variables". */
  label: string;
  /** The noun for notes and change lines ("Actions variable"). */
  noun: string;
}

interface VariableCreate {
  readonly payload: PlainPayload;
  readonly drift: readonly [string];
  readonly change: string;
}

interface VariableUpdate {
  /** The LIVE name addresses the request path: it names what exists, whatever casing the file uses. */
  readonly liveName: string;
  readonly payload: PlainPayload;
  readonly drift: readonly [string, ...string[]];
  readonly change: string;
}

interface VariableDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  readonly drift: readonly [string];
  readonly change: string;
}

/** The type parameters are the section's exact PlannedOp arms, so a wrong role fails to compile. */
export interface VariablesPlanScope<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
> extends VariablesScopeProse {
  /** The parsed {name, value} identities of the enveloped list, all pages. */
  readonly list: () => Promise<LiveVariable[]>;
  /** The planned POST; the builders are function-valued so one demanding an unsupplied facet fails. */
  readonly create: (write: VariableCreate) => Create;
  readonly update: (write: VariableUpdate) => Update;
  readonly remove: (deletion: VariableDeletion) => Remove;
}

function missingVariableDrift(label: string): string {
  return `${label}: missing - declared in the settings file but not on the repo; apply will create it`;
}

function valueDriftLine(label: string, declared: string, live: string): string {
  return `${label}.value: declared ${JSON.stringify(declared)} != live ${JSON.stringify(live)}; apply will set the declared value`;
}

function undeclaredVariableNote(scope: VariablesScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: "exists on the repo but is not declared",
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

function liveVariablesByKey(
  section: SectionMeta,
  scope: VariablesScopeProse,
  live: readonly LiveVariable[],
): Map<string, LiveVariable> {
  return liveByIdentity(
    section,
    scope.noun,
    live,
    (variable) => variableKey(variable.name),
    (variable) => variable.name,
  );
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
): Promise<SectionPlan<Create | Update | Remove>> {
  const { entries, policy, defaultPolicy } = opts;
  const plan: SectionPlan<Create | Update | Remove> = { ops: [], notes: [], drift: [] };

  const liveByKey = liveVariablesByKey(section, scope, await scope.list());
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));

  for (const variable of entries) {
    const label = `${scope.label}[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      plan.ops.push(
        scope.create({
          payload: { name: variable.name, value: variable.value, ...extraKeys },
          drift: [missingVariableDrift(label)],
          change: `created ${scope.noun} "${variable.name}"`,
        }),
      );
      continue;
    }

    // GitHub stores the name uppercased whatever casing the file uses, so the live name never drifts; only the value and passthrough fields can.
    const [first, ...rest] = [
      ...(existing.value !== variable.value
        ? [valueDriftLine(label, variable.value, existing.value)]
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
        payload: { value: variable.value, ...extraKeys },
        drift: [first, ...rest],
        change: `updated ${scope.noun} "${variable.name}"`,
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
          change: `DELETED undeclared ${scope.noun} "${variable.name}"`,
        }),
      );
    }
  }
  return plan;
}

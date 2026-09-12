/** Value reconciliation over route-free scopes: names match uppercased, and extra declared fields pass through. */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { undeclaredDrift, undeclaredNote } from "../contract/module.js";
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
  /** The noun for notes and change lines ("Actions variable"; a nested scope says "variable"). */
  noun: string;
  /** Where a missing variable would be created, for drift prose; "the repo" by default. */
  home?: string;
  /** Where an undeclared variable exists, for the keep-note; "the repo" by default. */
  keepHome?: string;
  /** Appended to create/update change lines (` in environment "prod"`); "" by default. */
  changeSuffix?: string;
  /** Appended to DELETE change lines (` from environment "prod"`); "" by default. */
  removeSuffix?: string;
}

interface VariableCreate {
  readonly name: string;
  readonly payload: PlainPayload;
  readonly drift: readonly [string];
  readonly change: string;
}

interface VariableUpdate {
  /** The LIVE name addresses the request (the path names what exists); the declared name is prose. */
  readonly names: { readonly declared: string; readonly live: string };
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

function missingVariableDrift(scope: VariablesScopeProse, label: string): string {
  return `${label}: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}

function valueDriftLine(label: string, declared: string, live: string): string {
  return `${label}.value: declared ${JSON.stringify(declared)} != live ${JSON.stringify(live)}; apply will set the declared value`;
}

function undeclaredVariableNote(scope: VariablesScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.keepHome ?? "the repo"} but is not declared`,
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

function liveVariablesByKey(live: readonly LiveVariable[]): Map<string, LiveVariable> {
  const liveByKey = new Map<string, LiveVariable>();
  for (const variable of live) {
    liveByKey.set(variableKey(variable.name), variable);
  }
  return liveByKey;
}

export async function planVariables<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
>(
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
  const changeSuffix = scope.changeSuffix ?? "";
  const removeSuffix = scope.removeSuffix ?? "";
  const plan: SectionPlan<Create | Update | Remove> = { ops: [], notes: [], drift: [] };

  const liveByKey = liveVariablesByKey(await scope.list());
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));

  for (const variable of entries) {
    const label = `${scope.label}[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      plan.ops.push(
        scope.create({
          name: variable.name,
          payload: { name: variable.name, value: variable.value, ...extraKeys },
          drift: [missingVariableDrift(scope, label)],
          change: `created ${scope.noun} "${variable.name}"${changeSuffix}`,
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
        names: { declared: variable.name, live: existing.name },
        payload: { value: variable.value, ...extraKeys },
        drift: [first, ...rest],
        change: `updated ${scope.noun} "${variable.name}"${changeSuffix}`,
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
          change: `DELETED undeclared ${scope.noun} "${variable.name}"${removeSuffix}`,
        }),
      );
    }
  }
  return plan;
}

/**
 * The shared variables engine: value reconciliation (names match uppercased;
 * extra declared fields pass through) over route-free scopes the section
 * builds: planVariables() returns the operations, and the section places
 * each under its own role.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { undeclaredDrift, undeclaredNote } from "../contract/module.js";
import type { ExecTools, SectionPlan } from "../contract/plan.js";

/** Case-insensitive key for variable names (GitHub stores them uppercased). */
export function variableKey(name: string): string {
  return name.toUpperCase();
}

/** The fields of a live variable the engine reads; extras ride along. */
export const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
export type LiveVariable = z.infer<typeof LiveVariable>;

/**
 * A planned operation as the engine hands it back to a section: the erased
 * view, which every section's literal PlannedOp is assignable to.
 */
type AnyPlannedOp = SectionPlan["ops"][number];

/**
 * The JSON-plain request data a planned operation may carry: the contract's
 * payload type minus its execution-time thunk arm.
 */
type PlainPayload = Exclude<NonNullable<AnyPlannedOp["payload"]>, (exec: ExecTools) => unknown>;

/**
 * One declared entry; the index signature carries the passthrough fields,
 * typed as the plain data a YAML value always is, so spreading them into a
 * request body needs no cast.
 */
export interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: PlainPayload | undefined;
}

/** How a scope names itself in output. */
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

/** The facets of one planned POST creating a declared variable the repo lacks. */
interface VariableCreate {
  /** The declared name, for describe prose (the body carries it too). */
  readonly name: string;
  /** name, value, and every declared passthrough field. */
  readonly payload: PlainPayload;
  readonly drift: readonly [string];
  readonly change: string;
}

/** The facets of one planned PATCH converging a live variable on its declaration. */
interface VariableUpdate {
  /** The LIVE name addresses the request (the path names what exists); the declared name is prose. */
  readonly names: { readonly declared: string; readonly live: string };
  /** value and every declared passthrough field. */
  readonly payload: PlainPayload;
  readonly drift: readonly [string, ...string[]];
  readonly change: string;
}

/** The facets of one planned DELETE of an undeclared live variable. */
interface VariableDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  readonly drift: readonly [string];
  readonly change: string;
}

/**
 * The plan contract's scope: the read over the section's typed port, and
 * builders placing each write under the section's own role (the type
 * parameters are its exact PlannedOp arms, so a wrong role fails to compile).
 */
export interface VariablesPlanScope<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
> extends VariablesScopeProse {
  /** The parsed {name, value} identities of the enveloped list, all pages. */
  readonly list: () => Promise<LiveVariable[]>;
  /** The planned POST; the builders are function-valued so one demanding an unsupplied facet fails. */
  readonly create: (write: VariableCreate) => Create;
  /** The planned PATCH of one live variable that diverged from its declaration. */
  readonly update: (write: VariableUpdate) => Update;
  /** The planned DELETE of one undeclared live variable. */
  readonly remove: (deletion: VariableDeletion) => Remove;
}

/** The check-mode line for a declared variable the listing does not carry. */
function missingVariableDrift(scope: VariablesScopeProse, label: string): string {
  return `${label}: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}

/** The check-mode line for a live value that diverged from the declaration. */
function valueDriftLine(label: string, declared: string, live: string): string {
  return `${label}.value: declared ${JSON.stringify(declared)} != live ${JSON.stringify(live)}; apply will set the declared value`;
}

/** The keep-note for a live variable the settings file does not declare. */
function undeclaredVariableNote(scope: VariablesScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.keepHome ?? "the repo"} but is not declared`,
    action: "DELETE it",
  });
}

/** The deletion drift for a live variable the settings file does not declare. */
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

/**
 * Plan one scope: a POST per missing variable, a PATCH per divergent one
 * (each carrying exactly the drift it resolves, plus a phantom-key note for
 * keys the live variable lacks), and a keep-note or DELETE per undeclared one.
 */
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
     * The DEFAULT the caller unwrapped `policy` against (the section's
     * undeclaredDefault, or environments' fixed nested default), from which
     * undeclaredDrift derives its explicit-knob clause.
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
          // Declared fields beyond name and value pass through verbatim.
          payload: { name: variable.name, value: variable.value, ...extraKeys },
          drift: [missingVariableDrift(scope, label)],
          change: `created ${scope.noun} "${variable.name}"${changeSuffix}`,
        }),
      );
      continue;
    }

    // The live name never drifts against the declaration: GitHub stores it
    // uppercased whatever casing the file uses, so only the value (and any
    // declared passthrough fields) can diverge.
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

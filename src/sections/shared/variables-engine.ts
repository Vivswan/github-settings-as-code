/**
 * Value reconciliation over route-free scopes: names match uppercased, and extra declared fields pass
 * through. The two repo families (./repo-variables.ts) and the environments section's nested variables
 * (../environments/nested.ts) plan through it; the frame is ./named-scope.ts.
 */

import type { Result } from "neverthrow";
import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { SectionFailure } from "../contract/errors.js";
import { type SectionMeta, valueDrift } from "../contract/module.js";
import { type PlainData, paramsWith, type SectionPlan } from "../contract/plan.js";
import {
  type AnyPlannedOp,
  missingNamedDrift,
  type NamedPlanOpts,
  type NamedScope,
  planNamed,
  undeclaredRemoval,
} from "./named-scope.js";

export const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
export type LiveVariable = z.infer<typeof LiveVariable>;

type PlainPayload = PlainData;

/** The index signature types the passthrough fields as plain data, so spreading them into a body needs no cast. */
export interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: PlainPayload | undefined;
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

/** The type parameters are the section's exact PlannedOp arms, so a wrong role fails to compile. */
export interface VariablesPlanScope<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
> extends NamedScope<LiveVariable, Remove> {
  /** The planned POST; the builders are function-valued so one demanding an unsupplied facet fails. */
  readonly create: (write: VariableCreate) => Create;
  readonly update: (write: VariableUpdate) => Update;
}

/** The scope's three mappers under its role names; `params` is what its routes take beyond the `{name}` token. */
export function variableOps<
  Create extends string,
  Update extends string,
  Remove extends string,
  Params extends Readonly<Record<string, string>> | undefined,
>(roles: { create: Create; update: Update; remove: Remove }, params: Params) {
  return {
    create: (write: VariableCreate) => ({ role: roles.create, params, ...write }),
    update: ({ liveName, ...write }: VariableUpdate) => ({
      role: roles.update,
      params: paramsWith(params, "name", liveName),
      ...write,
    }),
    remove: undeclaredRemoval(roles.remove, params, "name"),
  };
}

export function planVariables<
  Create extends AnyPlannedOp,
  Update extends AnyPlannedOp,
  Remove extends AnyPlannedOp,
>(
  section: SectionMeta,
  scope: VariablesPlanScope<Create, Update, Remove>,
  opts: NamedPlanOpts<VariableEntry>,
): Promise<Result<SectionPlan<Create | Update | Remove>, SectionFailure>> {
  const suffix = scope.suffix ?? "";
  // A variable is recreatable configuration, so its lines name no consequence beyond the DELETE.
  const words = { what: scope.noun, noteAction: "DELETE it", driftAction: "DELETE it" };
  return planNamed(section, scope, opts, words, (liveOf) => {
    const ops: (Create | Update)[] = [];
    const notes: string[] = [];
    for (const variable of opts.entries) {
      const label = `${scope.label}[${variable.name}]`;
      const existing = liveOf(variable);
      const { name: _name, value: _value, ...extraKeys } = variable;
      if (!existing) {
        ops.push(
          scope.create({
            payload: { name: variable.name, value: variable.value, ...extraKeys },
            drift: [missingNamedDrift(scope, variable.name)],
            change: `created ${scope.noun} "${variable.name}"${suffix}`,
            describe: `creating ${scope.noun} "${variable.name}"${suffix}`,
          }),
        );
        continue;
      }

      // GitHub stores the name uppercased whatever casing the file uses, so the live name never drifts;
      // only the value and passthrough fields can.
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
        notes.push(phantomNote(label, phantom, "variable", "this update will re-run"));
      }
      ops.push(
        scope.update({
          liveName: existing.name,
          payload: { value: variable.value, ...extraKeys },
          drift: [first, ...rest],
          change: `updated ${scope.noun} "${variable.name}"${suffix}`,
          describe: `updating ${scope.noun} "${variable.name}"${suffix}`,
        }),
      );
    }
    return { ops, notes };
  });
}

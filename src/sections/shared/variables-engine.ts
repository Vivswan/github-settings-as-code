/**
 * The shared variables engine: value-based reconciliation for GitHub's
 * name-keyed variable families - repository Actions and Copilot agents
 * variables, plus per-environment Actions variables. Each family exposes the
 * same four operations - an enveloped list, a POST create, a PATCH update, a
 * DELETE - differing only in route, so a consuming section keeps its own
 * EndpointDecls (which also drive the mock routes and USED_PATHS) and hands
 * the engine a VariablesScope carrying four TYPED operation closures built
 * against those literal routes; the closures are where the per-route params
 * contract typechecks, and the engine itself never sees a route. The nested
 * family (environment variables) builds ONE scope PER ENVIRONMENT, its
 * closures closing over the environment name.
 *
 * The semantics the engine encodes, shared by every family:
 * - Values are plain text by design: variables are readable configuration,
 *   which is what makes check-mode diffing possible; secrets are write-only
 *   material and deliberately the secrets engine's job.
 * - GitHub stores variable names uppercased regardless of how they are
 *   entered, so matching compares uppercased names (variableKey) and the
 *   live name never drifts against the declaration - only the value (and
 *   declared passthrough fields) can diverge.
 * - Declared fields beyond {name, value} pass through verbatim, so future
 *   variable fields keep working; phantomKeys warns when a declared key does
 *   not exist on the live variable.
 *
 * Selector fan-out for this file is declared in SHARED_FAN_OUT
 * (.github/scripts/changed-sections.ts).
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import {
  type SectionContext,
  type SectionMeta,
  type SectionRun,
  undeclaredDrift,
  undeclaredNote,
} from "../contract/module.js";

/** Case-insensitive key for variable names (GitHub stores them uppercased). */
export function variableKey(name: string): string {
  return name.toUpperCase();
}

/** The fields of a live variable the engine reads; extras ride along. */
export const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
export type LiveVariable = z.infer<typeof LiveVariable>;

/**
 * One declared variable entry, as every family's settings shape spells it.
 * The index signature carries the passthrough fields: everything beyond the
 * named keys rides into the write bodies verbatim.
 */
export interface VariableEntry {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: unknown;
}

/**
 * The four operations every variable family exposes, as closures the
 * consuming section builds against its own literal EndpointDecls (so params
 * are compile-checked where the routes are known). Describe prose lives in
 * the closures too, so each family keeps its own wording. The nested scope
 * (environment variables) closes over its extra path param here.
 */
export interface VariablesScopeOps {
  /** The parsed {name, value} identities of the enveloped list, all pages. */
  list(ctx: SectionContext, section: SectionMeta): Promise<LiveVariable[]>;
  /** POST one new variable; the payload carries name, value, and passthrough fields. */
  create(
    ctx: SectionContext,
    section: SectionMeta,
    name: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * PATCH one existing variable. The LIVE name addresses the request (same
   * variable under GitHub's case-insensitive matching, and the path always
   * names what exists); the declared name is for describe prose.
   */
  update(
    ctx: SectionContext,
    section: SectionMeta,
    names: { declared: string; live: string },
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  /** DELETE one variable by its live name. */
  remove(ctx: SectionContext, section: SectionMeta, liveName: string): Promise<unknown>;
}

/** One variable scope: a family's operations plus how to name it in output. */
export interface VariablesScope {
  /** The drift-line prefix, e.g. "actions_variables" or "environments[prod].variables". */
  label: string;
  /**
   * The noun for notes and change lines, e.g. "Actions variable". The
   * per-environment scope says the bare "variable" - its lines place the
   * write with the suffixes below instead.
   */
  noun: string;
  /**
   * Where a missing declared variable would be created, for drift prose;
   * defaults to "the repo" (the repository-level families). The nested scope
   * says "the environment".
   */
  home?: string;
  /**
   * Where an undeclared live variable exists, for the keep-note; defaults to
   * "the repo". The nested scope names its environment ('environment "prod"').
   */
  keepHome?: string;
  /**
   * Appended to create/update change lines to place the write, e.g.
   * ` in environment "prod"`; defaults to "" for the repository-level
   * families.
   */
  changeSuffix?: string;
  /**
   * Appended to DELETE change lines, e.g. ` from environment "prod"`;
   * defaults to "" for the repository-level families.
   */
  removeSuffix?: string;
  ops: VariablesScopeOps;
}

/**
 * Reconcile one variable scope into the caller's run: create missing
 * declared variables, update divergent values (and declared passthrough
 * fields), and handle live undeclared ones per the policy - a keep-note
 * under "keep", drift or DELETE otherwise. Lines land directly on
 * `run.result` - the caller's own accumulator - so the nested scope
 * (environment variables) needs no result merging, and this engine can
 * never pair a check context with an apply result.
 */
export async function reconcileVariables(
  run: SectionRun,
  section: SectionMeta,
  scope: VariablesScope,
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
): Promise<void> {
  const { entries, policy, defaultPolicy } = opts;
  const home = scope.home ?? "the repo";
  const keepHome = scope.keepHome ?? "the repo";
  const changeSuffix = scope.changeSuffix ?? "";
  const removeSuffix = scope.removeSuffix ?? "";

  const live = await scope.ops.list(run.ctx, section);
  const liveByKey = new Map<string, LiveVariable>();
  for (const variable of live) {
    liveByKey.set(variableKey(variable.name), variable);
  }
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));

  for (const variable of entries) {
    const label = `${scope.label}[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      if (run.check) {
        run.result.drift.push(
          `${label}: missing - declared in the settings file but not on ${home}; apply will create it`,
        );
      } else {
        await scope.ops.create(run.ctx, section, variable.name, {
          name: variable.name,
          value: variable.value,
          ...extraKeys, // future variable fields pass through verbatim
        });
        run.result.changes.push(`created ${scope.noun} "${variable.name}"${changeSuffix}`);
      }
      continue;
    }

    // The live name never drifts against the declaration: GitHub stores it
    // uppercased whatever casing the file uses, so only the value (and any
    // declared passthrough fields) can diverge.
    const valueDrift = existing.value !== variable.value;
    const extraDrift = subsetDiff(extraKeys, existing, label);
    if (!valueDrift && extraDrift.length === 0) {
      continue;
    }
    if (run.check) {
      if (valueDrift) {
        run.result.drift.push(
          `${label}.value: declared ${JSON.stringify(variable.value)} != live ${JSON.stringify(existing.value)}; apply will set the declared value`,
        );
      }
      run.result.drift.push(...extraDrift);
    } else {
      const phantom = phantomKeys(extraKeys, existing);
      if (phantom.length > 0) {
        run.result.notes.push(phantomNote(label, phantom, "variable", "this update will re-run"));
      }
      await scope.ops.update(
        run.ctx,
        section,
        { declared: variable.name, live: existing.name },
        {
          value: variable.value,
          ...extraKeys, // future variable fields pass through verbatim
        },
      );
      run.result.changes.push(`updated ${scope.noun} "${variable.name}"${changeSuffix}`);
    }
  }

  for (const variable of liveByKey.values()) {
    if (declaredKeys.has(variableKey(variable.name))) {
      continue;
    }
    if (policy === "keep") {
      run.result.notes.push(
        undeclaredNote({
          subject: `${scope.noun} "${variable.name}"`,
          state: `exists on ${keepHome} but is not declared`,
          action: "DELETE it",
        }),
      );
    } else if (run.check) {
      run.result.drift.push(
        undeclaredDrift(defaultPolicy, {
          label: `${scope.label}[${variable.name}]`,
          action: "DELETE it",
        }),
      );
    } else {
      await scope.ops.remove(run.ctx, section, variable.name);
      run.result.changes.push(`DELETED undeclared ${scope.noun} "${variable.name}"${removeSuffix}`);
    }
  }
}

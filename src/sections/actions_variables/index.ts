/**
 * `actions_variables:` section - GitHub Actions repository variables,
 * upserted by case-insensitive name and DELETED loudly when undeclared (the
 * wrapped `undeclared: keep` form softens that to notes). Values are plain
 * text by design: variables are readable configuration, which is what makes
 * check-mode diffing possible; secrets are write-only material and
 * deliberately not this section. GitHub stores variable names uppercased
 * regardless of how they are entered, so matching and duplicate rejection
 * compare uppercased names.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { SettingsFile } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  listAllEnveloped,
  loosen,
  parseLive,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";

/** Case-insensitive key for variable names (GitHub stores them uppercased). */
export function variableKey(name: string): string {
  return name.toUpperCase();
}

/** The fields of a live variable this section reads; extras ride along. */
const LiveVariable = z.looseObject({ name: z.string(), value: z.string() });
type LiveVariable = z.infer<typeof LiveVariable>;

const permission: SectionPermission = { repo: ["variables"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/actions/variables",
    statuses: { 200: "the Actions variables list" },
    // This list endpoint caps per_page at 30 (not the standard 100); asking
    // for more would be silently clamped and truncate the walk to one page.
    pageSize: 30,
  },
  create: {
    route: "POST /repos/{owner}/{repo}/actions/variables",
    statuses: { 201: "variable created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/actions/variables/{name}",
    statuses: { 204: "variable updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/actions/variables/{name}",
    statuses: { 204: "variable deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const actionsVariablesSection = {
  key: "actions_variables",
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.actions_variables),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // Variable names are case-insensitive on GitHub, so two entries differing
    // only in case name the same variable and would fight on every run.
    rejectDuplicates(
      this,
      desired,
      (variable) => variableKey(variable.name),
      (variable) => variable.name,
    );
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveVariable),
      await listAllEnveloped(ctx, this, ENDPOINTS.list, "variables"),
    );
    const liveByKey = new Map<string, LiveVariable>();
    for (const variable of live) {
      liveByKey.set(variableKey(variable.name), variable);
    }

    const declaredKeys = new Set<string>();
    for (const variable of desired) {
      declaredKeys.add(variableKey(variable.name));
      const existing = liveByKey.get(variableKey(variable.name));
      const { name: _name, value: _value, ...extraKeys } = variable;
      if (!existing) {
        if (run.check) {
          run.result.drift.push(
            `actions_variables[${variable.name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, {
            payload: {
              name: variable.name,
              value: variable.value,
              ...extraKeys, // future variable fields pass through verbatim
            },
          });
          run.result.changes.push(`created Actions variable "${variable.name}"`);
        }
        continue;
      }

      // The live name never drifts against the declaration: GitHub stores it
      // uppercased whatever casing the file uses, so only the value (and any
      // declared passthrough fields) can diverge.
      const valueDrift = existing.value !== variable.value;
      const extraDrift = subsetDiff(extraKeys, existing, `actions_variables[${variable.name}]`);
      if (!valueDrift && extraDrift.length === 0) {
        continue;
      }
      if (run.check) {
        if (valueDrift) {
          run.result.drift.push(
            `actions_variables[${variable.name}].value: declared ${JSON.stringify(variable.value)} != live ${JSON.stringify(existing.value)}; apply will set the declared value`,
          );
        }
        run.result.drift.push(...extraDrift);
      } else {
        const phantom = phantomKeys(extraKeys, existing);
        if (phantom.length > 0) {
          run.result.notes.push(
            phantomNote(
              `actions_variables[${variable.name}]`,
              phantom,
              "variable",
              "this update will re-run",
            ),
          );
        }
        await call(ctx, this, ENDPOINTS.update, {
          params: { name: existing.name },
          payload: {
            value: variable.value,
            ...extraKeys, // future variable fields pass through verbatim
          },
        });
        run.result.changes.push(`updated Actions variable "${variable.name}"`);
      }
    }

    // Undeclared variables are deleted by default, loudly on purpose; the
    // wrapped `undeclared: keep` form downgrades each to a note.
    for (const variable of liveByKey.values()) {
      if (declaredKeys.has(variableKey(variable.name))) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          `Actions variable "${variable.name}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
        );
      } else if (run.check) {
        run.result.drift.push(
          `actions_variables[${variable.name}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, { params: { name: variable.name } });
        run.result.changes.push(`DELETED undeclared Actions variable "${variable.name}"`);
      }
    }
    return run.result;
  },
} satisfies SectionModule<"actions_variables">;

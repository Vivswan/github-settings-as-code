/**
 * `check_suite_preferences:` section - per-GitHub-App auto_trigger_checks toggles. GitHub exposes
 * NO read endpoint, so the plan reads nothing and its one op is an alwaysRewrite PATCH.
 */

import type { EndpointDecl } from "../contract/endpoints.js";
import { loosen, type SectionModule, writeOnlyCheckNote } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { type PlannedOp, plainData, type SectionPlan } from "../contract/plan.js";
import { CheckSuitePreferencesConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["checks"] };

const ENDPOINTS = {
  update: {
    route: "PATCH /repos/{owner}/{repo}/check-suites/preferences",
    statuses: { 200: "the resulting preferences plus the repository" },
    // No GET exists to compare against, so the write recurs by contract.
    alwaysRewrite: true,
  },
} as const satisfies Record<string, EndpointDecl>;

export const checkSuitePreferencesSection = {
  key: "check_suite_preferences",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat:
    "the token owner must be a repository administrator, and with no read endpoint there is nothing to preflight - a denied write surfaces only after other sections' writes landed",
  endpoints: ENDPOINTS,
  // Loose on purpose: the PATCH forwards the object verbatim, so future
  // fields ride along at both levels; only the natural pair is checked.
  shape: loosen(CheckSuitePreferencesConfig),
  async plan(_ctx, desired) {
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    // Derived, not restated: writeOnlyCheckNote proves against ENDPOINTS
    // that no read exists, so this claim cannot outlive the declarations.
    plan.notes.push(
      writeOnlyCheckNote(this, {
        resource: "check suite preferences",
        reasserts: "the declared preferences",
      }),
    );
    plan.ops.push({
      role: "update",
      payload: plainData(desired),
      describe: "setting check suite preferences",
      drift: [],
      change: (response) => {
        // Counts the ECHOED preferences (what GitHub now holds); the declared
        // list is the fallback only when the echo loses its shape.
        const echoed = (response as { preferences?: { auto_trigger_checks?: unknown } } | null)
          ?.preferences?.auto_trigger_checks;
        const count = Array.isArray(echoed) ? echoed.length : desired.auto_trigger_checks.length;
        return `applied check suite preferences (${count} auto_trigger_checks ${count === 1 ? "entry" : "entries"})`;
      },
    });
    return plan;
  },
} satisfies SectionModule<"check_suite_preferences", typeof ENDPOINTS>;

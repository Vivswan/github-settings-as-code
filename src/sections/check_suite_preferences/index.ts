/**
 * `check_suite_preferences:` section - per-GitHub-App auto_trigger_checks
 * toggles controlling whether pushes automatically create check suites.
 * GitHub exposes NO read endpoint for these preferences, so the section is
 * write-only end to end: check mode emits one cannot-verify note and issues
 * no request, and apply re-asserts the declared preferences with one PATCH
 * on every run (the 200 echoes the resulting preferences).
 */

import { type CheckSuitePreferencesConfig, SettingsFile } from "../../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  loosen,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "../contract.js";

const permission: SectionPermission = { repo: ["checks"] };

const ENDPOINTS = {
  update: {
    route: "PATCH /repos/{owner}/{repo}/check-suites/preferences",
    statuses: { 200: "the resulting preferences plus the repository" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const checkSuitePreferencesSection: SectionModule<"check_suite_preferences"> = {
  key: "check_suite_preferences",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat:
    "the token owner must be a repository administrator, and with no read endpoint there is nothing to preflight - a denied write surfaces only after other sections' writes landed",
  endpoints: ENDPOINTS,
  // Loose on purpose: the PATCH forwards the object verbatim, so future
  // fields ride along at both levels; only the natural pair is checked.
  shape: loosen(SettingsFile.shape.check_suite_preferences),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as CheckSuitePreferencesConfig;

    if (ctx.check) {
      result.notes.push(
        "check_suite_preferences: GitHub exposes no read endpoint for check suite preferences, so check mode cannot verify them; apply re-asserts the declared preferences on every run",
      );
      return result;
    }

    const data = (await call(ctx, this, ENDPOINTS.update, {
      payload: desired,
      describe: "setting check suite preferences",
    })) as { preferences?: { auto_trigger_checks?: unknown } } | null;
    // The change line reads the ECHOED preferences (what GitHub now holds),
    // falling back to the declared list only if the echo loses its shape.
    const echoed = data?.preferences?.auto_trigger_checks;
    const applied = Array.isArray(echoed) ? echoed : desired.auto_trigger_checks;
    const count = applied.length;
    result.changes.push(
      `applied check suite preferences (${count} auto_trigger_checks ${count === 1 ? "entry" : "entries"})`,
    );
    return result;
  },
};

/**
 * `check_suite_preferences:` section - per-GitHub-App auto_trigger_checks
 * toggles controlling whether pushes automatically create check suites.
 * GitHub exposes NO read endpoint for these preferences, so the section is
 * write-only end to end: check mode emits one cannot-verify note and issues
 * no request, and apply re-asserts the declared preferences with one PATCH
 * on every run (the 200 echoes the resulting preferences).
 */

import {
  beginRun,
  call,
  type EndpointDecl,
  loosen,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  writeOnlyCheckNote,
} from "../contract.js";
import { CheckSuitePreferencesConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["checks"] };

const ENDPOINTS = {
  update: {
    route: "PATCH /repos/{owner}/{repo}/check-suites/preferences",
    statuses: { 200: "the resulting preferences plus the repository" },
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
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);

    if (run.check) {
      // Derived, not restated: writeOnlyCheckNote proves against ENDPOINTS
      // that no read exists, so this claim cannot outlive the declarations.
      run.result.notes.push(
        writeOnlyCheckNote(this, {
          resource: "check suite preferences",
          reasserts: "the declared preferences",
        }),
      );
      return run.result;
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
    run.result.changes.push(
      `applied check suite preferences (${count} auto_trigger_checks ${count === 1 ? "entry" : "entries"})`,
    );
    return run.result;
  },
} satisfies SectionModule<"check_suite_preferences">;

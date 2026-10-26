/**
 * The mock's self carve-out, the generators' redaction model, and the runner's child environment all key on
 * these exact strings. Scenario .yml fixtures cannot import them, so the curated scenarios that seed them spell them out.
 */

import { join } from "node:path";
import { ROOT } from "../root.js";

/** Where the runner dumps a failing scenario's replay bundle; workflow yaml spells the path by hand, and test/workflows/nightly-workflows.test.ts holds it to this. */
export const ARTIFACTS_DIR = join(ROOT, "test", "e2e", ".artifacts");

/** The owner half of the admin slug; the generators spell it into every target slug they mint. */
export const ADMIN_OWNER = "e2e-owner";

/** The name half of the admin slug. */
export const ADMIN_REPO = "e2e-repo";

/** The repository a single-repo run targets and a multi-repo run runs from (its GITHUB_REPOSITORY), so a multi target with this slug is never redacted. */
export const ADMIN_SLUG = `${ADMIN_OWNER}/${ADMIN_REPO}`;

/** The creator the mock stamps on issues the report channel creates; the action never reads it. */
export const TOKEN_USER_LOGIN = "e2e-token-user";

/** Both what childEnv feeds the action and what the leak sweep hunts on every public surface; it may be a substring of no other identity constant a run renders (TOKEN_USER_LOGIN nearly was), and foundation.test.ts pins that. */
export const E2E_TOKEN = "e2e-inert-token";

/** Marks the mock's own contract-violation replies apart from GitHub-shaped error bodies; lives here so validate.ts reads it without a runtime edge into the mock. */
export const VIOLATION_PREFIX = "E2E MOCK VIOLATION:";

/** The files the runner itself keeps at the root of the child's working directory; a snapshot destination may not start with one, or the run would overwrite it or the dir form's walk would collect it. */
export const RUNNER_ROOT_FILES = {
  settings: "settings.yml",
  output: "output.txt",
  summary: "summary.md",
  rendered: "rendered.yml",
  defaults: "defaults.yml",
} as const;

/** The mode: render layer files, layerFile(i), reserved beside the root files for the same reason. */
export const LAYER_FILE_PREFIX = "layer-";

export function layerFile(index: number): string {
  return `${LAYER_FILE_PREFIX}${index}.yml`;
}

/**
 * The mock's self carve-out, the generators' redaction model, and the runner's child environment all key on
 * these exact strings. Scenario .yml fixtures cannot import them, so the curated scenarios that seed them spell them out.
 */

import { join } from "node:path";
import { ROOT } from "../root.js";

/** Where the runner dumps a failing scenario's replay bundle; the nightlies upload this directory and the filed issue cites it. */
export const ARTIFACTS_DIR = join(ROOT, "test", "e2e", ".artifacts");

export const ADMIN_OWNER = "e2e-owner";
export const ADMIN_REPO = "e2e-repo";
export const ADMIN_SLUG = `${ADMIN_OWNER}/${ADMIN_REPO}`;

/** The creator the mock stamps on issues the report channel creates; the action never reads it. */
export const TOKEN_USER_LOGIN = "e2e-token-user";

/**
 * Both what childEnv feeds the action and what the leak sweep hunts on every public surface, so the
 * invariant cannot drift from the token in use. It must not be a substring of any other identity constant
 * a run renders (TOKEN_USER_LOGIN nearly was), or the sweep false-positives; foundation.test.ts pins that.
 */
export const E2E_TOKEN = "e2e-inert-token";

/**
 * Marks the mock's own contract-violation replies so the runner and the OpenAPI validator can tell them
 * from GitHub-shaped error bodies. Lives here so validate.ts reads it without a runtime edge into the mock.
 */
export const VIOLATION_PREFIX = "E2E MOCK VIOLATION:";

/**
 * The files the runner itself keeps at the root of the child's working directory. A snapshot
 * destination may not start with one of them: the run would overwrite a harness file, or the dir
 * form's walk would collect it as a written snapshot. layerFile(i) names a mode: merge layer.
 */
export const RUNNER_ROOT_FILES = {
  settings: "settings.yml",
  output: "output.txt",
  summary: "summary.md",
  merged: "merged.yml",
  defaults: "defaults.yml",
} as const;
export const LAYER_FILE_PREFIX = "layer-";
export function layerFile(index: number): string {
  return `${LAYER_FILE_PREFIX}${index}.yml`;
}

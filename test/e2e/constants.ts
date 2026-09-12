/**
 * The mock's self carve-out, the generators' redaction model, and the runner's child environment all key on
 * these exact strings. Scenario .yml fixtures cannot import them, so the curated scenarios that seed them spell them out.
 */

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

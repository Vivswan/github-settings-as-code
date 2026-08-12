/**
 * Harness-wide identity constants: the admin/self repo the runner runs as
 * (GITHUB_REPOSITORY) and the login the mock's GET /user reports. The mock's
 * self carve-out, the generators' redaction model, and the runner's child
 * environment all key on these exact strings, so every consumer imports them
 * from here instead of restating the literals.
 *
 * Scenario .yml fixtures cannot import a module, so the curated scenarios
 * that seed these strings (e.g. the multi-report issue-reuse pair) still
 * spell them out; a scenario-load check in the harness pins the marker-label
 * fixture data the same way.
 */

export const ADMIN_OWNER = "e2e-owner";
export const ADMIN_REPO = "e2e-repo";
export const ADMIN_SLUG = `${ADMIN_OWNER}/${ADMIN_REPO}`;

/** The token user GET /user reports; the report module reads only `login`. */
export const TOKEN_USER_LOGIN = "e2e-token-user";

/**
 * The inert token every e2e child run authenticates with (INPUT_TOKEN). The
 * one constant is both what the runner's childEnv feeds the action and what
 * its centralized leak sweep hunts on every public surface, so the
 * token-leak invariant can never drift from the token actually in use. The
 * literal must not be a substring of any other harness identity constant a
 * run may legitimately render (TOKEN_USER_LOGIN very nearly was), or the
 * sweep would false-positive on the fixture; the disjointness test in
 * foundation.test.ts enforces that.
 */
export const E2E_TOKEN = "e2e-inert-token";

/**
 * The marker every mock-originated contract-violation reply carries in its
 * message, so the runner and the OpenAPI validator can tell the mock's own
 * loud failures from GitHub-shaped error bodies. Single-sourced here, in the
 * harness's dependency-free identity module, so the validator can read it
 * without any runtime edge into the mock pipeline (validate.ts used to keep
 * a deliberately unlinked copy for exactly that isolation).
 */
export const VIOLATION_PREFIX = "E2E MOCK VIOLATION:";

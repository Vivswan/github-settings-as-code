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

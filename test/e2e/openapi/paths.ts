/**
 * Every REST path template the action can reach, derived from the endpoint declarations. The trim
 * script (.github/scripts/trim-openapi.ts) imports USED_PATHS to slice the published spec down to
 * what the mock must model, so this file stays dependency-light and re-derives nothing.
 */

import { ISSUE_REPORT_ENDPOINTS } from "../../../src/report/issue-report.js";
import { endpointPath } from "../../../src/sections/contract/endpoints.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import { UNDOCUMENTED_ROUTES } from "../../../src/upstream-gaps/index.js";

/**
 * Paths the action calls outside the section handlers (the repo probe is also repository.get and
 * collapses on dedup). The issue-channel paths are not listed: they derive from
 * ISSUE_REPORT_ENDPOINTS below.
 *   /repos/{owner}/{repo}                    -> the repository probe
 *   /repos/{owner}/{repo}/contents/{path}    -> the settings.yml read
 *   /repos/{owner}/{repo}/git/ref/{ref}      -> proves a settings.yml absent (Contents-gated)
 *   /user/repos                              -> multi-repo discovery
 */
const CORE_PATHS: readonly string[] = [
  "/repos/{owner}/{repo}",
  "/repos/{owner}/{repo}/contents/{path}",
  "/repos/{owner}/{repo}/git/ref/{ref}",
  "/user/repos",
];

/**
 * Real endpoints GitHub's descriptor does not document (src/upstream-gaps/ holds them), kept out of USED_PATHS so
 * trim-openapi does not hard-error while the e2e validator exempts the exact METHOD+path pairs. Staleness fails in both directions:
 *   an entry is no longer a declared endpoint path  -> excludeUndocumented() throws
 *   upstream starts documenting one                 -> trim-openapi.ts errors; retire the gap file
 */
export const UNDOCUMENTED_PATHS: readonly string[] = [
  ...new Set(UNDOCUMENTED_ROUTES.map(endpointPath)),
];

/** Exported so validate.test.ts can pin the stale-entry throw directly. */
export function excludeUndocumented(
  paths: ReadonlySet<string>,
  undocumented: readonly string[],
): string[] {
  const remaining = new Set(paths);
  for (const entry of undocumented) {
    if (!remaining.has(entry)) {
      throw new Error(
        `UNDOCUMENTED_PATHS entry "${entry}" is not a declared endpoint path; the owning gap file in src/upstream-gaps/ names a route no endpoint declares - fix or delete that gap file`,
      );
    }
    remaining.delete(entry);
  }
  return [...remaining].sort();
}

/** Method is dropped on purpose: OpenAPI keys paths by path, so GET and PUT on one resource are one entry. */
export const USED_PATHS: readonly string[] = (() => {
  const paths = new Set<string>(CORE_PATHS);
  for (const endpoint of Object.values(allEndpoints())) {
    paths.add(endpointPath(endpoint.route));
  }
  for (const endpoint of Object.values(ISSUE_REPORT_ENDPOINTS)) {
    paths.add(endpointPath(endpoint.route));
  }
  return excludeUndocumented(paths, UNDOCUMENTED_PATHS);
})();

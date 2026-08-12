/**
 * The complete set of REST path templates the action can reach, derived from
 * the section endpoint dictionary, the private-report issue-channel endpoint
 * dictionary, plus the handful of non-section "core" calls (repo probe,
 * settings-file fetch, multi-repo discovery). A later phase's OpenAPI trim
 * script imports USED_PATHS to slice the published spec down to exactly what the
 * mock must model, so this stays dependency-light: it pulls from the endpoint
 * declarations only, and re-derives nothing they already declare.
 */

import { ISSUE_REPORT_ENDPOINTS } from "../../../src/report/issue-report.js";
import { endpointPath } from "../../../src/sections/contract.js";
import { allEndpoints } from "../../../src/sections/registry.js";
import { UNDOCUMENTED_ROUTES } from "../../../src/upstream-gaps/index.js";

/**
 * Path templates the action calls outside any section: the repository probe
 * that opens every run, the Contents fetch that reads settings.yml, and the
 * discovery listing that expands a multi-repo target. Kept here because no
 * SectionModule owns them. The private-report issue-channel paths are NOT hand
 * listed here - they derive from ISSUE_REPORT_ENDPOINTS below, single-sourced
 * from the report module (its marker-label create reuses the labels section's
 * path, so that one collapses into the section paths on dedup).
 */
export const CORE_PATHS: readonly string[] = [
  "/repos/{owner}/{repo}",
  "/repos/{owner}/{repo}/contents/{path}",
  "/user/repos",
];

/**
 * Routes the action calls that GitHub's api.github.com OpenAPI descriptor
 * does not document (verified absent at the pinned UPSTREAM_REF; the
 * endpoints are real: https://docs.github.com/en/rest/repos/lfs), derived
 * from the gap files in src/upstream-gaps/ the descriptor lacks (octokit-kind
 * gaps with documentedInSpec: false, and every spec-only gap).
 * Their paths are excluded from USED_PATHS so trim-openapi does not
 * hard-error, and the e2e validator exempts exactly these METHOD+path pairs
 * from the unknown-route check - an unlisted method on the same path still
 * fails. Staleness is checked in both directions: excludeUndocumented()
 * below throws when an entry is no longer a declared endpoint path, and
 * trim-openapi.ts errors when the upstream descriptor starts documenting one
 * (retire the gap: delete a spec-only file, or flip documentedInSpec on an
 * octokit-kind one, then regenerate the index and re-run).
 */
export { UNDOCUMENTED_ROUTES };

/** The distinct path templates of UNDOCUMENTED_ROUTES. */
export const UNDOCUMENTED_PATHS: readonly string[] = [
  ...new Set(UNDOCUMENTED_ROUTES.map(endpointPath)),
];

/**
 * Remove the undocumented paths from a derived path set, throwing on a
 * stale entry (one that is not a declared endpoint path anymore). Exported
 * so the staleness contract is directly testable.
 */
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

/**
 * Every distinct path half of every section endpoint AND every issue-report
 * endpoint, unioned with CORE_PATHS and deduped, minus UNDOCUMENTED_PATHS.
 * Method is intentionally dropped: two routes that share a path (e.g. GET and
 * PUT on the same resource) collapse to one entry, which is what the OpenAPI
 * trim wants (paths are keyed by path, not by method).
 */
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

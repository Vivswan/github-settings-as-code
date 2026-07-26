/**
 * `repository:` section - PATCH passthrough for repo fields, plus the
 * settings that live on their own endpoints in the REST API even though
 * the Probot schema nests them here: topics and the feature toggles.
 */

import { subsetDiff } from "../engine/diff.js";
import {
  anyRecord,
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  probeAbsent,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "./contract.js";

/** Topics: accept a comma-separated string or an array; lowercase, dedupe. */
export function normalizeTopics(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "")
        .split(",")
        .map((t) => t.trim());
  return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}

/** One boolean settings key backed by PUT/DELETE on its own sub-resource. */
interface FeatureToggle {
  key: string;
  label: string;
  put: EndpointDecl;
  remove: EndpointDecl;
}

/**
 * A toggle whose state can also be read back. The GET's declared >= 400
 * statuses are the "not enabled" statuses; the DELETE's are the "already off
 * or not applicable here" statuses, so the handler reads tolerances straight
 * off these declarations. All entries are typed as the concrete ENDPOINTS
 * members (via `satisfies` on the arrays below) so their routes carry no
 * path params and the request helpers accept them with no params argument.
 * A toggle NOT in this list (Git LFS: GitHub exposes no read endpoint) gets
 * a cannot-verify note in check mode, and apply re-asserts it blindly.
 */
interface ReadableToggle extends FeatureToggle {
  get: EndpointDecl;
  /** Read the enabled state from a successful GET. */
  isEnabled: (data: unknown) => boolean;
}

const permission: SectionPermission = { repo: ["administration"] };

/**
 * The LFS endpoints' 403 is ambiguous three ways: LFS disabled account-wide,
 * disabled for the root of the repository network, or (on organization
 * repositories) a credential without billing access - none of which a token
 * grant fixes.
 */
const LFS_DENIAL_HINT =
  "a 403 here can also mean Git LFS is disabled account-wide or for the root of this repository network, or that the credential lacks billing access (organization repositories need an organization owner or billing manager), rather than a missing token grant";

// The repo-level endpoints plus each security toggle's own GET/PUT/DELETE
// triple, all in one dictionary so the mock server and USED_PATHS derivation
// see every path this section can touch. FEATURE_TOGGLES below points its
// handler logic at these same entries, so declaration and use cannot drift.
const ENDPOINTS = {
  get: { route: "GET /repos/{owner}/{repo}", statuses: { 200: "the repository" } },
  update: { route: "PATCH /repos/{owner}/{repo}", statuses: { 200: "repository fields patched" } },
  topics: { route: "PUT /repos/{owner}/{repo}/topics", statuses: { 200: "topics replaced" } },
  vulnerabilityAlertsGet: {
    route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts are enabled", 404: "vulnerability alerts are disabled" },
  },
  vulnerabilityAlertsPut: {
    route: "PUT /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts enabled" },
  },
  vulnerabilityAlertsRemove: {
    route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts",
    statuses: { 204: "vulnerability alerts disabled" },
  },
  automatedSecurityFixesGet: {
    route: "GET /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 200: "the automated security fixes state", 404: "the feature is not enabled" },
  },
  automatedSecurityFixesPut: {
    route: "PUT /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 204: "automated security fixes enabled" },
  },
  automatedSecurityFixesRemove: {
    route: "DELETE /repos/{owner}/{repo}/automated-security-fixes",
    statuses: { 204: "automated security fixes disabled" },
  },
  privateVulnerabilityReportingGet: {
    route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: {
      200: "the private vulnerability reporting state readable from the body",
      404: "the feature is not applicable on this repository (observed: private repos); read as not enabled",
      422: "the same condition as 404, alternate answer",
    },
  },
  privateVulnerabilityReportingPut: {
    route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: { 204: "private vulnerability reporting enabled" },
  },
  privateVulnerabilityReportingRemove: {
    route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting",
    statuses: {
      204: "private vulnerability reporting disabled",
      404: "the feature is not applicable, so it is already off",
      422: "the same condition as 404, alternate answer",
    },
  },
  lfsPut: {
    route: "PUT /repos/{owner}/{repo}/lfs",
    statuses: { 202: "Git LFS enabled (GitHub processes the change asynchronously)" },
    denialHint: LFS_DENIAL_HINT,
  },
  lfsRemove: {
    route: "DELETE /repos/{owner}/{repo}/lfs",
    statuses: { 204: "Git LFS disabled" },
    denialHint: LFS_DENIAL_HINT,
  },
} as const satisfies Record<string, EndpointDecl>;

const READABLE_TOGGLES = [
  {
    key: "enable_vulnerability_alerts",
    label: "vulnerability alerts",
    get: ENDPOINTS.vulnerabilityAlertsGet,
    put: ENDPOINTS.vulnerabilityAlertsPut,
    remove: ENDPOINTS.vulnerabilityAlertsRemove,
    // A 204 empty body means enabled.
    isEnabled: () => true,
  },
  {
    key: "enable_automated_security_fixes",
    label: "automated security fixes",
    get: ENDPOINTS.automatedSecurityFixesGet,
    put: ENDPOINTS.automatedSecurityFixesPut,
    remove: ENDPOINTS.automatedSecurityFixesRemove,
    // A 204 empty body means enabled; a JSON body carries {enabled}.
    isEnabled: (data) => data === null || (data as { enabled?: boolean })?.enabled !== false,
  },
  {
    key: "enable_private_vulnerability_reporting",
    label: "private vulnerability reporting",
    get: ENDPOINTS.privateVulnerabilityReportingGet,
    put: ENDPOINTS.privateVulnerabilityReportingPut,
    remove: ENDPOINTS.privateVulnerabilityReportingRemove,
    isEnabled: (data) => (data as { enabled?: boolean } | null)?.enabled === true,
  },
] satisfies readonly ReadableToggle[];

const WRITE_ONLY_TOGGLES = [
  {
    key: "enable_git_lfs",
    label: "Git LFS",
    put: ENDPOINTS.lfsPut,
    remove: ENDPOINTS.lfsRemove,
  },
] satisfies readonly FeatureToggle[];

const FEATURE_TOGGLES = [...READABLE_TOGGLES, ...WRITE_ONLY_TOGGLES];

/**
 * The keys the repository section handles specially instead of sending them
 * through the base PATCH: `topics` (its own PUT) and the feature toggles
 * (each a PUT/DELETE sub-endpoint). Exported as the single source the
 * README's repository special-keys documentation is pinned against.
 */
export const SPECIAL_KEYS = new Set(["topics", ...FEATURE_TOGGLES.map((toggle) => toggle.key)]);

export const repositorySection: SectionModule<"repository"> = {
  key: "repository",
  deletesUndeclared: "untouched",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: anyRecord,
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as Record<string, unknown>;
    for (const toggle of FEATURE_TOGGLES) {
      if (toggle.key in desired && typeof desired[toggle.key] !== "boolean") {
        throw new Error(
          `repository.${toggle.key} is ${JSON.stringify(desired[toggle.key])}, which is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
        );
      }
    }
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired)) {
      if (!SPECIAL_KEYS.has(key)) {
        patch[key] = value;
      }
    }

    if (ctx.check) {
      const live = (await call(ctx, this, ENDPOINTS.get)) as Record<string, unknown>;
      result.drift.push(...subsetDiff(patch, live, "repository"));
      if ("topics" in desired) {
        result.drift.push(
          ...subsetDiff(
            normalizeTopics(desired.topics).sort(),
            ((live.topics as string[]) ?? []).slice().sort(),
            "repository.topics",
          ),
        );
      }
      for (const toggle of READABLE_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }
        const probe = await probeAbsent(ctx, this, toggle.get);
        const enabled = "missing" in probe ? false : toggle.isEnabled(probe.data);
        if (enabled !== desired[toggle.key]) {
          result.drift.push(
            `repository.${toggle.key}: declared ${desired[toggle.key]} != live ${enabled}; apply will set the declared value`,
          );
        }
      }
      for (const toggle of WRITE_ONLY_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }
        result.notes.push(
          `repository.${toggle.key}: GitHub exposes no endpoint to read this state back, so check mode cannot verify it; apply re-asserts the declared value (${JSON.stringify(desired[toggle.key])}) on every run`,
        );
      }
      return result;
    }

    if (Object.keys(patch).length > 0) {
      await call(ctx, this, ENDPOINTS.update, { payload: patch });
      result.changes.push(`patched repository fields: ${Object.keys(patch).join(", ")}`);
    }
    if ("topics" in desired) {
      const names = normalizeTopics(desired.topics);
      await call(ctx, this, ENDPOINTS.topics, { payload: { names } });
      result.changes.push(`set topics: ${names.join(", ") || "(none)"}`);
    }
    for (const toggle of FEATURE_TOGGLES) {
      if (!(toggle.key in desired)) {
        continue;
      }
      if (desired[toggle.key]) {
        await call(ctx, this, toggle.put);
      } else {
        // Disabling where the feature does not apply is already the declared
        // state; the DELETE's declared >= 400 statuses (e.g. 404/422 for
        // private vulnerability reporting) are tolerated, anything else is a
        // real failure. Toggles whose DELETE declares no such statuses
        // tolerate nothing, so tryCall throws on any error just like call.
        await tryCall(ctx, this, toggle.remove);
      }
      result.changes.push(`${toggle.label}: ${desired[toggle.key] ? "enabled" : "disabled"}`);
    }
    return result;
  },
};

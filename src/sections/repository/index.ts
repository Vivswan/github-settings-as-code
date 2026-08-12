/**
 * `repository:` section - PATCH passthrough for repo fields, plus the
 * settings that live on their own endpoints even though the settings file
 * nests them here: topics, the feature toggles, and the two GraphQL-only
 * keys (the Sponsor button and the issue creation policy).
 */

import { subsetDiff } from "../../engine/diff.js";
import { type RepositoryConfig, SettingsFile } from "../../schema.js";
import {
  call,
  callGraphql,
  type EndpointDecl,
  emptyResult,
  type GraphqlOpDecl,
  graphqlOp,
  loosen,
  probeAbsent,
  repoVariables,
  requirePlainMapping,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "../contract.js";

/** Topics: accept a comma-separated string or an array; lowercase, dedupe. */
export function normalizeTopics(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "")
        .split(",")
        .map((t) => t.trim());
  return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}

/**
 * A repository key the settings schema declares a type for. Typing the
 * toggle and routed-key tables with it keeps them in lockstep with
 * schema.ts, which now carries the value validation (and its YAML
 * boolean-gotcha error prose) the shape sweep here used to do: a toggle
 * added below without a schema declaration fails to compile.
 */
type DeclaredRepositoryKey = keyof typeof RepositoryConfig.shape & string;

/** One boolean settings key backed by PUT/DELETE on its own sub-resource. */
interface FeatureToggle {
  key: DeclaredRepositoryKey;
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
  /**
   * Read from a successful GET whether the live state is enforced above the
   * repository (immutable releases' enforced_by_owner), so drift prose says
   * apply cannot change it instead of promising to set the declared value.
   */
  isEnforced?: (data: unknown) => boolean;
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

/**
 * The declared meaning of the 409 both immutable-releases writes answer when
 * the repository owner enforces the feature; the apply note and the check
 * drift prose build on the same words.
 */
const OWNER_ENFORCED = "the repository owner enforces immutable releases";

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
  immutableReleasesGet: {
    route: "GET /repos/{owner}/{repo}/immutable-releases",
    statuses: {
      200: "the immutable releases state readable from the body",
      404: "immutable releases are not enabled",
    },
  },
  immutableReleasesPut: {
    route: "PUT /repos/{owner}/{repo}/immutable-releases",
    statuses: { 204: "immutable releases enabled", 409: OWNER_ENFORCED },
  },
  immutableReleasesRemove: {
    route: "DELETE /repos/{owner}/{repo}/immutable-releases",
    statuses: { 204: "immutable releases disabled", 409: OWNER_ENFORCED },
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
  {
    key: "enable_immutable_releases",
    label: "immutable releases",
    get: ENDPOINTS.immutableReleasesGet,
    put: ENDPOINTS.immutableReleasesPut,
    remove: ENDPOINTS.immutableReleasesRemove,
    isEnabled: (data) => (data as { enabled?: boolean } | null)?.enabled === true,
    isEnforced: (data) =>
      (data as { enforced_by_owner?: boolean } | null)?.enforced_by_owner === true,
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

/**
 * The GraphQL-routed keys: two repository settings whose ONLY surface is
 * GraphQL. The issue creation policy is live-verified both ways (the REST
 * repo PATCH answers 200 and silently ignores an issue_creation_policy
 * field, and no REST GET returns one); the sponsor button has no REST field
 * at all. One read serves every declared key AND supplies the node id the
 * mutation addresses, so neither mode needs an extra REST round trip.
 *
 * Each key is a RoutedKey descriptor, and everything else derives from the
 * table: SPECIAL_KEYS (the PATCH strip), the check-mode compare, and the
 * apply-mode mutate-and-verify loop all iterate GRAPHQL_ROUTED_KEYS - so a
 * new key cannot compile into a silently stripped-but-never-applied no-op.
 * Value validation (with its YAML-gotcha prose) lives on the schema.ts
 * declarations the DeclaredRepositoryKey typing pins these keys to.
 */
interface RoutedKey {
  /** The settings-file key. */
  readonly key: DeclaredRepositoryKey;
  /** The change-line label ("sponsor button: enabled"). */
  readonly label: string;
  /** The Repository read field, also the UpdateRepositoryInput field. */
  readonly field: "hasSponsorshipsEnabled" | "issueCreationPolicy";
  /** Map a valid declared value to its GraphQL variable value. */
  encode(declared: unknown): boolean | string;
  /**
   * Map a readback field value to the settings-file vocabulary, or
   * undefined when the value is outside the vocabulary this section reads
   * (the caller fails loudly; folding to a default could report a clean
   * check against state the section does not understand).
   */
  decode(live: unknown): unknown;
  /** Render a settings-vocabulary value for drift prose (raw, like the toggles' drift lines). */
  show(value: unknown): string;
  /** Render a settings-vocabulary value for a change line ("enabled", "collaborators_only"). */
  changeText(value: unknown): string;
  /**
   * Appended to the unreadable-value error for a vocabulary this section
   * knows can surprise (the policy's SDL-nullable read). One sentence, no
   * trailing period.
   */
  readonly unreadableHint?: string;
}

/** The settings-file vocabulary for issue_creation_policy -> GitHub's enum. */
const ISSUE_CREATION_POLICIES = {
  all: "ALL",
  collaborators_only: "COLLABORATORS_ONLY",
} as const;

type IssueCreationPolicy = keyof typeof ISSUE_CREATION_POLICIES;

const GRAPHQL_ROUTED_KEYS = [
  {
    key: "enable_sponsorships",
    label: "sponsor button",
    field: "hasSponsorshipsEnabled",
    encode: (declared) => declared as boolean,
    decode: (live) => (typeof live === "boolean" ? live : undefined),
    show: (value) => String(value),
    changeText: (value) => (value ? "enabled" : "disabled"),
  },
  {
    key: "issue_creation_policy",
    label: "issue creation policy",
    field: "issueCreationPolicy",
    encode: (declared) => ISSUE_CREATION_POLICIES[declared as IssueCreationPolicy],
    decode: (live) =>
      live === "ALL" ? "all" : live === "COLLABORATORS_ONLY" ? "collaborators_only" : undefined,
    show: (value) => String(value),
    changeText: (value) => String(value),
    // The SDL marks Repository.issueCreationPolicy nullable, though a live
    // probe never observed null (the policy is retained even with issues
    // disabled), so a null read stays a loud failure with honest prose.
    unreadableHint:
      "a null policy means GitHub reported no issue creation policy for this repository; otherwise the field vocabulary may have changed",
  },
] as const satisfies readonly RoutedKey[];

const FEATURES_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "RepositoryFeatures",
  kind: "read",
  query:
    "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }",
  outcomes: {
    ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses",
  },
});

// The GraphQL absent-variable rule makes one mutation serve any declared
// subset: an input field fed by an unprovided variable is treated as not
// provided, so the input carries exactly the keys apply needs to move.
const UPDATE_FEATURES = graphqlOp<{
  repositoryId: string;
  hasSponsorshipsEnabled?: boolean;
  issueCreationPolicy?: (typeof ISSUE_CREATION_POLICIES)[IssueCreationPolicy];
}>()({
  name: "UpdateRepositoryFeatures",
  kind: "write",
  query:
    "mutation UpdateRepositoryFeatures($repositoryId: ID!, $hasSponsorshipsEnabled: Boolean, $issueCreationPolicy: IssueCreationPolicy) { updateRepository(input: {repositoryId: $repositoryId, hasSponsorshipsEnabled: $hasSponsorshipsEnabled, issueCreationPolicy: $issueCreationPolicy}) { repository { hasSponsorshipsEnabled issueCreationPolicy } } }",
  outcomes: { ok: "the carried values set; the echoed state verifies each one took" },
});

const GRAPHQL_OPS = {
  featuresQuery: FEATURES_QUERY,
  updateFeatures: UPDATE_FEATURES,
} as const satisfies Record<string, GraphqlOpDecl>;

/**
 * Decode the routed fields of a repository object for the DECLARED keys
 * only, into the settings-file vocabulary. Scoping the strictness to
 * `routed` is deliberate: an unreadable value (the SDL-nullable policy, a
 * future enum member) must fail loudly for a key the file declares, and
 * must not fail a run that never declared it.
 */
function decodeRoutedFields(
  fields: Record<string, unknown>,
  routed: readonly RoutedKey[],
  opName: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of routed) {
    const decoded = entry.decode(fields[entry.field]);
    if (decoded === undefined) {
      const hint = entry.unreadableHint ? `; ${entry.unreadableHint}` : "";
      throw new Error(
        `repository: GRAPHQL ${opName} returned ${entry.field} ${JSON.stringify(fields[entry.field])}, which this section cannot read as a repository.${entry.key} value${hint}. Drop the key, or update the action if GitHub's vocabulary moved`,
      );
    }
    values[entry.key] = decoded;
  }
  return values;
}

/** The routed-state read: the mutation's node id plus each declared key's live value. */
interface LiveRoutedState {
  id: string;
  values: Record<string, unknown>;
}

async function fetchRoutedState(
  ctx: SectionContext,
  section: SectionMeta,
  routed: readonly RoutedKey[],
): Promise<LiveRoutedState> {
  const data = await callGraphql(ctx, section, FEATURES_QUERY, repoVariables(ctx));
  const repository = (data as { repository?: Record<string, unknown> }).repository;
  if (!repository || typeof repository.id !== "string") {
    throw new Error(
      `repository: GRAPHQL ${FEATURES_QUERY.name} returned no repository object with an id, so the ${GRAPHQL_ROUTED_KEYS.map((entry) => entry.key).join("/")} state cannot be read. Check the token's repository access`,
    );
  }
  return { id: repository.id, values: decodeRoutedFields(repository, routed, FEATURES_QUERY.name) };
}

/**
 * Every feature toggle, exported for the test that pins the apply loop's
 * safety contract: the loop reports a change for any tolerated non-409
 * outcome, so a toggle write may only tolerate statuses the loop knows how
 * to interpret (409 owner-enforced, and the 404/422 that mean "already
 * off" on a remove).
 */
export const FEATURE_TOGGLES = [...READABLE_TOGGLES, ...WRITE_ONLY_TOGGLES];

/**
 * The keys the repository section handles specially instead of sending them
 * through the base PATCH: `topics` (its own PUT), the feature toggles
 * (each a PUT/DELETE sub-endpoint), and the GraphQL-routed keys
 * (GRAPHQL_ROUTED_KEYS). Exported as the single source the README's
 * repository special-keys documentation is pinned against.
 */
export const SPECIAL_KEYS = new Set([
  "topics",
  ...FEATURE_TOGGLES.map((toggle) => toggle.key),
  ...GRAPHQL_ROUTED_KEYS.map((routed) => routed.key),
]);

export const repositorySection: SectionModule<"repository"> = {
  key: "repository",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: requirePlainMapping(loosen(SettingsFile.shape.repository)),
  async run(ctx, declared): Promise<SectionResult> {
    const result = emptyResult();
    const desired: Record<string, unknown> = declared;
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
          const enforced = "missing" in probe ? false : toggle.isEnforced?.(probe.data) === true;
          result.drift.push(
            enforced
              ? `repository.${toggle.key}: declared ${desired[toggle.key]} != live ${enabled}; the repository owner enforces ${toggle.label}, so apply cannot change it from the repository`
              : `repository.${toggle.key}: declared ${desired[toggle.key]} != live ${enabled}; apply will set the declared value`,
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
      const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
      if (declaredRouted.length > 0) {
        const live = await fetchRoutedState(ctx, this, declaredRouted);
        for (const routed of declaredRouted) {
          if (desired[routed.key] !== live.values[routed.key]) {
            result.drift.push(
              `repository.${routed.key}: declared ${routed.show(desired[routed.key])} != live ${routed.show(live.values[routed.key])}; apply will set the declared value`,
            );
          }
        }
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
      // Both writes go through tryCall so each endpoint's declared >= 400
      // statuses are tolerated: on a DELETE, 404/422 mean the feature does
      // not apply here, so the declared "off" already holds and the change
      // line stands (private vulnerability reporting); a 409 on either write
      // means the setting is enforced above the repository (immutable
      // releases' owner enforcement), so nothing changed - a note, never a
      // false change line. An endpoint declaring no >= 400 statuses
      // tolerates nothing, so tryCall throws on any error just like call.
      const endpoint = desired[toggle.key] ? toggle.put : toggle.remove;
      const outcome = await tryCall(ctx, this, endpoint);
      if ("error" in outcome && outcome.error.status === 409) {
        result.notes.push(
          `repository.${toggle.key}: ${(endpoint as EndpointDecl).statuses[409]}, so apply cannot change it from the repository (409)`,
        );
        continue;
      }
      result.changes.push(`${toggle.label}: ${desired[toggle.key] ? "enabled" : "disabled"}`);
    }
    const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
    if (declaredRouted.length > 0) {
      // Compare before writing, unlike the endpoint-backed toggles: the
      // routed-state read is already needed for the mutation's node id, so
      // the comparison is free and a converged repo issues no GraphQL write.
      const live = await fetchRoutedState(ctx, this, declaredRouted);
      const diverged = declaredRouted.filter(
        (routed) => desired[routed.key] !== live.values[routed.key],
      );
      if (diverged.length > 0) {
        const variables: Record<string, unknown> = { repositoryId: live.id };
        for (const routed of diverged) {
          variables[routed.field] = routed.encode(desired[routed.key]);
        }
        const data = await callGraphql(
          ctx,
          this,
          UPDATE_FEATURES,
          variables as { repositoryId: string },
        );
        // The mutation selects the post-state on purpose: silently
        // accepting-and-ignoring a field is the exact REST failure mode that
        // forced these keys onto GraphQL, so each carried value is verified
        // against the echo, and the change lines report OBSERVED state.
        const echoedRepo = (data as { updateRepository?: { repository?: Record<string, unknown> } })
          .updateRepository?.repository;
        if (!echoedRepo) {
          throw new Error(
            `repository: GRAPHQL ${UPDATE_FEATURES.name} returned no repository echo, so the write cannot be verified. GitHub may have changed the mutation payload; update the action`,
          );
        }
        const echoed = decodeRoutedFields(echoedRepo, diverged, UPDATE_FEATURES.name);
        for (const routed of diverged) {
          if (echoed[routed.key] !== desired[routed.key]) {
            throw new Error(
              `repository: GRAPHQL ${UPDATE_FEATURES.name} was accepted, but GitHub reports repository.${routed.key} ${routed.show(echoed[routed.key])} where ${routed.show(desired[routed.key])} was set, so the write did not take. GitHub may restrict this setting on the repository`,
            );
          }
          result.changes.push(`${routed.label}: ${routed.changeText(echoed[routed.key])}`);
        }
      }
    }
    return result;
  },
};

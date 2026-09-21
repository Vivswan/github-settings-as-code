import { err, ok, Result, safeTry } from "neverthrow";
import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { type EndpointDecl, repoVariables } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { type GraphqlOpDecl, type GraphqlVariablesOf, graphqlOp } from "../contract/graphql.js";
import {
  cannotVerifyNote,
  loosen,
  requirePlainMapping,
  type SectionMeta,
  type SectionModule,
  sectionGrant,
  valueDrift,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  type ChangeLines,
  hasDrift,
  type PlanContext,
  type PlannedOp,
  plainData,
  type Read,
  type SectionPlan,
} from "../contract/plan.js";
import { readOrNote } from "../shared/snapshot-helpers.js";
import {
  normalizeTopics,
  PATCH_FIELDS,
  RepositoryConfig,
  SECURITY_AND_ANALYSIS_PATCH_FIELDS,
} from "./schema.js";

/**
 * Typing the toggle and routed-key tables with it keeps them in lockstep with schema.ts: a toggle
 * added below without a schema declaration fails to compile.
 */
type DeclaredRepositoryKey = keyof typeof RepositoryConfig.shape & string;

const permission: SectionPermission = { repo: ["administration"] };

const LFS_DENIAL_HINT =
  "a 403 here can also mean Git LFS is disabled account-wide or for the root of this " +
  "repository network, or that the credential lacks billing access (organization repositories " +
  "need an organization owner or billing manager), rather than a missing token grant";

const OWNER_ENFORCED = "the repository owner enforces immutable releases";

// FEATURE_TOGGLES names these entries by role, so declaration and use cannot drift.
const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}",
    statuses: { 200: "the repository" },
    primaryRead: { notFound: "denied" },
  },
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
      422: "the feature is not applicable, so it is already off",
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
  // Git LFS has no read endpoint, so the declared state is re-asserted on every apply.
  lfsPut: {
    route: "PUT /repos/{owner}/{repo}/lfs",
    statuses: { 202: "Git LFS enabled (GitHub processes the change asynchronously)" },
    denialHint: LFS_DENIAL_HINT,
    alwaysRewrite: true,
  },
  lfsRemove: {
    route: "DELETE /repos/{owner}/{repo}/lfs",
    statuses: { 204: "Git LFS disabled" },
    denialHint: LFS_DENIAL_HINT,
    alwaysRewrite: true,
  },
} as const satisfies Record<string, EndpointDecl>;

// GitHub may return topics as null or omit them; the rest of the body rides into subsetDiff as passthrough.
const LiveRepository = z.looseObject({ topics: z.array(z.string()).nullish() });

/** The live security_and_analysis object narrowed to its PATCHable sub-keys; undefined when none. */
function snapshotSecurityAndAnalysis(live: unknown): Record<string, unknown> | undefined {
  if (typeof live !== "object" || live === null || Array.isArray(live)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const field of SECURITY_AND_ANALYSIS_PATCH_FIELDS) {
    const value = (live as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) {
      out[field] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

const FEATURES_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "RepositoryFeatures",
  kind: "read",
  query:
    "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }",
  outcomes: {
    ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses",
  },
});

const ISSUE_CREATION_POLICIES = {
  all: "ALL",
  collaborators_only: "COLLABORATORS_ONLY",
} as const;

type IssueCreationPolicy = keyof typeof ISSUE_CREATION_POLICIES;

// GraphQL treats an input field fed by an unprovided variable as not provided, so one mutation
// serves any declared subset: the input carries exactly the keys apply needs to move.
const UPDATE_FEATURES = graphqlOp<{
  repositoryId: string;
  hasSponsorshipsEnabled?: boolean;
  issueCreationPolicy?: (typeof ISSUE_CREATION_POLICIES)[IssueCreationPolicy];
}>()({
  name: "UpdateRepositoryFeatures",
  kind: "write",
  query: `mutation UpdateRepositoryFeatures(
    $repositoryId: ID!
    $hasSponsorshipsEnabled: Boolean
    $issueCreationPolicy: IssueCreationPolicy
  ) {
    updateRepository(
      input: {
        repositoryId: $repositoryId
        hasSponsorshipsEnabled: $hasSponsorshipsEnabled
        issueCreationPolicy: $issueCreationPolicy
      }
    ) {
      repository { hasSponsorshipsEnabled issueCreationPolicy }
    }
  }`,
  outcomes: { ok: "the carried values set; the echoed state verifies each one took" },
});

const GRAPHQL_OPS = {
  featuresQuery: FEATURES_QUERY,
  updateFeatures: UPDATE_FEATURES,
} as const satisfies Record<string, GraphqlOpDecl>;

type RepositoryContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
type RepositoryOp = PlannedOp<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
type RepositoryPlan = SectionPlan<RepositoryOp>;

type RestWriteRole = Extract<RepositoryOp, { variables?: never }>["role"];

type RewriteRole = {
  [R in RestWriteRole]: (typeof ENDPOINTS)[R] extends { readonly alwaysRewrite: true } ? R : never;
}[RestWriteRole];

/** A toggle's GET, whose 404 means "not enabled". */
type ProbeRole = {
  [R in keyof RepositoryContext["read"]]: RepositoryContext["read"][R] extends {
    probeAbsent: unknown;
  }
    ? R
    : never;
}[keyof RepositoryContext["read"]];

type FeatureVariables = GraphqlVariablesOf<typeof UPDATE_FEATURES>;

interface FeatureToggle {
  key: DeclaredRepositoryKey;
  label: string;
  put: RestWriteRole;
  remove: RestWriteRole;
}

/**
 * The GET's declared tolerable statuses mean "not enabled"; a write's mean "nothing changed here"
 * (owner-enforced, already off) and are tolerated by declaration.
 */
interface ReadableToggle extends FeatureToggle {
  get: ProbeRole;
  /** Parsed at the boundary, so an off-contract body fails loudly instead of driving a write. */
  live: z.ZodType<LiveToggle>;
  isEnabled: (live: LiveToggle) => boolean;
  /** Enforced above the repository (immutable releases' enforced_by_owner), so the drift prose says apply cannot change it. */
  isEnforced?: (live: LiveToggle) => boolean;
}

/** null is the 204 no-content answer a toggle GET gives when the feature is on. */
type LiveToggle = null | { enabled: boolean; enforced_by_owner?: boolean };

const LiveNoContent = z.null();

const LiveToggleState = z.looseObject({
  enabled: z.boolean(),
  enforced_by_owner: z.boolean().optional(),
});

const READABLE_TOGGLES: readonly ReadableToggle[] = [
  {
    key: "enable_vulnerability_alerts",
    label: "vulnerability alerts",
    get: "vulnerabilityAlertsGet",
    put: "vulnerabilityAlertsPut",
    remove: "vulnerabilityAlertsRemove",
    // The declared 204 has no body: reaching it at all means enabled.
    live: LiveNoContent,
    isEnabled: () => true,
  },
  {
    key: "enable_automated_security_fixes",
    label: "automated security fixes",
    get: "automatedSecurityFixesGet",
    put: "automatedSecurityFixesPut",
    remove: "automatedSecurityFixesRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
  },
  {
    key: "enable_private_vulnerability_reporting",
    label: "private vulnerability reporting",
    get: "privateVulnerabilityReportingGet",
    put: "privateVulnerabilityReportingPut",
    remove: "privateVulnerabilityReportingRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
  },
  {
    key: "enable_immutable_releases",
    label: "immutable releases",
    get: "immutableReleasesGet",
    put: "immutableReleasesPut",
    remove: "immutableReleasesRemove",
    live: LiveToggleState,
    isEnabled: (live) => live?.enabled === true,
    isEnforced: (live) => live?.enforced_by_owner === true,
  },
];

/** No read endpoint, so the writes must be alwaysRewrite by declaration: no drift can ever justify them. */
interface WriteOnlyToggle extends FeatureToggle {
  put: RewriteRole;
  remove: RewriteRole;
}

const WRITE_ONLY_TOGGLES: readonly WriteOnlyToggle[] = [
  {
    key: "enable_git_lfs",
    label: "Git LFS",
    put: "lfsPut",
    remove: "lfsRemove",
  },
];

/**
 * Two settings whose ONLY surface is GraphQL. SPECIAL_KEYS, the compare, and the mutate-and-verify
 * operation all iterate this list, so a new key cannot compile into a stripped-but-never-applied no-op.
 *
 * issue_creation_policy  -> the REST repo PATCH answers 200 and silently ignores it (live-verified)
 * enable_sponsorships    -> no REST field at all
 */
interface RoutedKey {
  readonly key: DeclaredRepositoryKey;
  /** The change-line label ("sponsor button: enabled"). */
  readonly label: string;
  readonly field: "hasSponsorshipsEnabled" | "issueCreationPolicy";
  variables(declared: unknown): Omit<FeatureVariables, "repositoryId">;
  /**
   * undefined when the value is outside the vocabulary this section reads; the caller fails loudly,
   * since folding to a default could report a clean check against state the section does not understand.
   */
  decode(live: unknown): unknown;
  show(value: unknown): string;
  changeText(value: unknown): string;
  /** Appended to the unreadable-value error; one sentence, no trailing period. */
  readonly unreadableHint?: string;
}

const GRAPHQL_ROUTED_KEYS = [
  {
    key: "enable_sponsorships",
    label: "sponsor button",
    field: "hasSponsorshipsEnabled",
    variables: (declared) => ({ hasSponsorshipsEnabled: declared as boolean }),
    decode: (live) => (typeof live === "boolean" ? live : undefined),
    show: (value) => String(value),
    changeText: (value) => (value ? "enabled" : "disabled"),
  },
  {
    key: "issue_creation_policy",
    label: "issue creation policy",
    field: "issueCreationPolicy",
    variables: (declared) => ({
      issueCreationPolicy: ISSUE_CREATION_POLICIES[declared as IssueCreationPolicy],
    }),
    decode: (live) =>
      live === "ALL" ? "all" : live === "COLLABORATORS_ONLY" ? "collaborators_only" : undefined,
    show: (value) => String(value),
    changeText: (value) => String(value),
    // The SDL marks Repository.issueCreationPolicy nullable, though a live probe never observed null
    // (the policy is retained even with issues disabled), so a null read stays a loud failure.
    unreadableHint:
      "a null policy means GitHub reported no issue creation policy for this repository; otherwise the field vocabulary may have changed",
  },
] as const satisfies readonly RoutedKey[];

/** Why a routed field's live value cannot be read into the settings vocabulary. */
function unreadableRoutedValue(entry: RoutedKey, raw: unknown, opName: string): string {
  const hint = entry.unreadableHint ? `; ${entry.unreadableHint}` : "";
  return `GRAPHQL ${opName} returned ${entry.field} ${JSON.stringify(raw)}, which this section cannot read as a repository.${entry.key} value${hint}`;
}

/**
 * Strictness is scoped to the DECLARED keys: an unreadable value (the SDL-nullable policy, a future
 * enum member) must fail loudly for a key the file declares and must not fail a run that never declared it.
 */
function decodeRoutedFields(
  fields: Record<string, unknown>,
  routed: readonly RoutedKey[],
  opName: string,
): Result<Record<string, unknown>, SectionFailure> {
  const values: Record<string, unknown> = {};
  for (const entry of routed) {
    const decoded = entry.decode(fields[entry.field]);
    if (decoded === undefined) {
      return err(
        sectionFailure(
          "live-shape",
          `repository: ${unreadableRoutedValue(entry, fields[entry.field], opName)}. Drop the key, or update the action if GitHub's vocabulary moved`,
        ),
      );
    }
    values[entry.key] = decoded;
  }
  return ok(values);
}

interface LiveRoutedState {
  id: string;
  values: Record<string, unknown>;
}

/**
 * The features read: the Repository object with the routed fields at their wire types (the vocabulary
 * itself is decoded by each routed key), or null when the token cannot see the repository.
 */
const LiveFeatures = z.looseObject({
  repository: z
    .looseObject({
      id: z.string(),
      hasSponsorshipsEnabled: z.boolean(),
      issueCreationPolicy: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

/** The Repository object of a features read, with the node id the mutation addresses. */
function repositoryNode(
  data: z.infer<typeof LiveFeatures>,
): Result<Record<string, unknown> & { id: string }, SectionFailure> {
  const repository = data.repository;
  if (repository === null || repository === undefined) {
    return err(
      sectionFailure(
        "live-shape",
        `repository: GRAPHQL ${FEATURES_QUERY.name} returned no repository object with an id, so the ${GRAPHQL_ROUTED_KEYS.map((entry) => entry.key).join("/")} state cannot be read. Check the token's repository access`,
      ),
    );
  }
  return ok(repository);
}

function fetchRoutedState(
  ctx: RepositoryContext,
  routed: readonly RoutedKey[],
): Read<LiveRoutedState> {
  return ctx.read.featuresQuery
    .call(LiveFeatures, repoVariables(ctx))
    .andThen(repositoryNode)
    .andThen((repository) =>
      decodeRoutedFields(repository, routed, FEATURES_QUERY.name).map((values) => ({
        id: repository.id,
        values,
      })),
    );
}

/** Exported for the table-driven test that pins each toggle to its own PUT/DELETE pair, never the base PATCH. */
export const FEATURE_TOGGLES: readonly FeatureToggle[] = [
  ...READABLE_TOGGLES,
  ...WRITE_ONLY_TOGGLES,
];

/** Exported for the docs examples test (test/docs/settings-examples.ts). */
export const SPECIAL_KEYS = new Set([
  "topics",
  ...FEATURE_TOGGLES.map((toggle) => toggle.key),
  ...GRAPHQL_ROUTED_KEYS.map((routed) => routed.key),
]);

/** A 409 means owner enforcement; any other tolerated status means the feature does not apply here and was already off. */
function toggleTolerated(
  section: SectionMeta,
  toggle: FeatureToggle,
  role: RestWriteRole,
  status: number,
): string {
  const meaning = section.endpoints[role]?.statuses[status];
  return status === 409
    ? `repository.${toggle.key}: ${meaning}, so apply cannot change it from the repository (${status})`
    : `repository.${toggle.key}: ${meaning}, so nothing changed (${status})`;
}

export const repositorySection = {
  key: "repository",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: requirePlainMapping(loosen(RepositoryConfig)),
  async plan(ctx, declared) {
    const section = this;
    return safeTry(async function* () {
      const plan: RepositoryPlan = { ops: [], notes: [], drift: [] };
      const desired: Record<string, unknown> = declared;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desired)) {
        if (!SPECIAL_KEYS.has(key)) {
          patch[key] = value;
        }
      }

      const live = yield* ctx.read.get.call(LiveRepository);
      if (Object.keys(patch).length > 0) {
        // The PATCH is diff-gated and the fields pass through, so a declared key GitHub ignores would
        // re-PATCH on every apply without converging.
        const phantom = phantomKeys(patch, live);
        if (phantom.length > 0) {
          plan.notes.push(
            phantomNote("repository", phantom, "repository", "this PATCH will re-run"),
          );
        }
        const drift = subsetDiff(patch, live, "repository");
        if (hasDrift(drift)) {
          plan.ops.push({
            role: "update",
            payload: plainData(patch),
            drift,
            change: `patched repository fields: ${Object.keys(patch).join(", ")}`,
          });
        }
      }
      if (declared.topics !== undefined) {
        const names = normalizeTopics(declared.topics);
        const drift = subsetDiff(
          [...names].sort(),
          [...(live.topics ?? [])].sort(),
          "repository.topics",
        );
        if (hasDrift(drift)) {
          plan.ops.push({
            role: "topics",
            payload: { names },
            drift,
            change: `set topics: ${names.join(", ") || "(none)"}`,
          });
        }
      }
      for (const toggle of READABLE_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }
        const want = desired[toggle.key] === true;
        const probe = yield* ctx.read[toggle.get].probeAbsent(toggle.live);
        const live = "missing" in probe ? undefined : probe.data;
        const enabled = live === undefined ? false : toggle.isEnabled(live);
        if (enabled === want) {
          continue;
        }
        const enforced = live !== undefined && toggle.isEnforced?.(live) === true;
        const role = want ? toggle.put : toggle.remove;
        // The write's declared tolerable statuses (409 owner-enforced, 404/422 already off on a remove)
        // mean nothing changed: a note, never a change line. A write declaring none tolerates nothing.
        plan.ops.push({
          role,
          drift: [
            valueDrift(`repository.${toggle.key}`, String(want), String(enabled), {
              remedy: enforced
                ? `the repository owner enforces ${toggle.label}, so apply cannot change it from the repository`
                : undefined,
            }),
          ],
          tolerate: {
            outcome: (error) => ({ note: toggleTolerated(section, toggle, role, error.status) }),
          },
          change: `${toggle.label}: ${want ? "enabled" : "disabled"}`,
        });
      }
      for (const toggle of WRITE_ONLY_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }
        const want = desired[toggle.key] === true;
        plan.notes.push(
          cannotVerifyNote(`repository.${toggle.key}`, {
            why: "GitHub exposes no endpoint to read this state back",
            what: "it",
            reasserts: `re-asserts the declared value (${JSON.stringify(desired[toggle.key])})`,
          }),
        );
        plan.ops.push({
          role: want ? toggle.put : toggle.remove,
          drift: [],
          change: `${toggle.label}: ${want ? "enabled" : "disabled"}`,
        });
      }
      const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
      if (declaredRouted.length > 0) {
        // The routed-state read supplies the mutation's node id, so the comparison is free and a
        // converged repo issues no GraphQL write.
        const liveRouted = yield* fetchRoutedState(ctx, declaredRouted);
        const diverged = declaredRouted.filter(
          (routed) => desired[routed.key] !== liveRouted.values[routed.key],
        );
        const [first, ...rest] = diverged;
        if (first !== undefined) {
          const variables: FeatureVariables = Object.assign(
            { repositoryId: liveRouted.id },
            ...diverged.map((routed) => routed.variables(desired[routed.key])),
          );
          plan.ops.push({
            role: "updateFeatures",
            variables,
            drift: diverged.map((routed) =>
              valueDrift(
                `repository.${routed.key}`,
                routed.show(desired[routed.key]),
                routed.show(liveRouted.values[routed.key]),
              ),
            ) as [string, ...string[]],
            // The mutation selects the post-state on purpose: a silently ignored field is the REST
            // failure mode that forced these keys onto GraphQL, so each value is verified against the echo.
            change: (response) => {
              const echoedRepo = (
                response as { updateRepository?: { repository?: Record<string, unknown> } }
              ).updateRepository?.repository;
              if (!echoedRepo) {
                return err(
                  sectionFailure(
                    "unverified",
                    `repository: GRAPHQL ${UPDATE_FEATURES.name} returned no repository echo, so the write cannot be verified. GitHub may have changed the mutation payload; update the action`,
                  ),
                );
              }
              return decodeRoutedFields(echoedRepo, diverged, UPDATE_FEATURES.name).andThen(
                (echoed) => {
                  const verified = (routed: RoutedKey): Result<string, SectionFailure> => {
                    if (echoed[routed.key] !== desired[routed.key]) {
                      return err(
                        sectionFailure(
                          "unverified",
                          `repository: GRAPHQL ${UPDATE_FEATURES.name} was accepted, but GitHub ` +
                            `reports repository.${routed.key} ${routed.show(echoed[routed.key])} where ` +
                            `${routed.show(desired[routed.key])} was set, so the write did not take. ` +
                            `GitHub may restrict this setting on the repository`,
                        ),
                      );
                    }
                    return ok(`${routed.label}: ${routed.changeText(echoed[routed.key])}`);
                  };
                  return Result.combine([verified(first), ...rest.map(verified)]).map(
                    ([lead, ...more]): ChangeLines => [lead as string, ...more],
                  );
                },
              );
            },
          });
        }
      }
      return ok(plan);
    });
  },
  // A null PATCH field is GitHub's "unset", so it is left out rather than declared as null.
  async snapshot(ctx) {
    const section = this;
    return safeTry(async function* () {
      const notes: string[] = [];
      const live = yield* ctx.read.get.call(LiveRepository);
      const value: Record<string, unknown> = {};
      for (const field of PATCH_FIELDS) {
        const read =
          field === "security_and_analysis"
            ? snapshotSecurityAndAnalysis(live[field])
            : live[field];
        if (read !== undefined && read !== null) {
          value[field] = read;
        }
      }
      if (live.topics !== undefined && live.topics !== null && live.topics.length > 0) {
        value.topics = [...live.topics];
      }
      const probes: Array<{
        toggle: ReadableToggle;
        live: LiveToggle | undefined;
        concealable: boolean;
      }> = [];
      for (const toggle of READABLE_TOGGLES) {
        const read = yield* await readOrNote(ctx, notes, `repository.${toggle.key}`, () =>
          ctx.read[toggle.get].tryCall(toggle.live).map((answer) =>
            "error" in answer
              ? // The declared 422 ("not applicable") is answered only to a granted token.
                { live: undefined, concealable: answer.error.status === 404 }
              : { live: answer.data, concealable: false },
          ),
        );
        if (!("denied" in read)) {
          probes.push({ toggle, ...read.value });
        }
      }
      // The toggle GETs share one grant and answer 404 for "off", the same 404 a fine-grained token
      // missing the grant is concealed behind. One other answer proves the grant; all 404s prove
      // nothing, so the toggles are left out rather than written as off.
      if (probes.length > 0 && probes.every((probe) => probe.concealable)) {
        notes.push(
          `repository.${probes.map((probe) => probe.toggle.key).join("/")}: every toggle GET answered 404, which reads as off ` +
            "but is also how a fine-grained token missing the grant is answered, so they are left out; " +
            `if the token does ${sectionGrant(section)}, they are all off and can be declared false`,
        );
      } else {
        for (const { toggle, live } of probes) {
          const enabled = live === undefined ? false : toggle.isEnabled(live);
          value[toggle.key] = enabled;
          if (live !== undefined && toggle.isEnforced?.(live) === true) {
            notes.push(
              `repository.${toggle.key}: ${OWNER_ENFORCED}, so it reads back as ${enabled} but cannot be changed from the repository`,
            );
          }
        }
      }
      for (const toggle of WRITE_ONLY_TOGGLES) {
        notes.push(
          `repository.${toggle.key}: GitHub exposes no endpoint to read ${toggle.label} back, so the snapshot leaves it out; declare it yourself to manage it`,
        );
      }
      const routed = yield* await readOrNote(
        ctx,
        notes,
        GRAPHQL_ROUTED_KEYS.map((entry) => `repository.${entry.key}`).join(" and "),
        () => ctx.read.featuresQuery.call(LiveFeatures, repoVariables(ctx)),
      );
      if (!("denied" in routed)) {
        const repository = yield* repositoryNode(routed.value);
        for (const entry of GRAPHQL_ROUTED_KEYS) {
          const decoded = entry.decode(repository[entry.field]);
          if (decoded === undefined) {
            notes.push(
              `repository.${entry.key}: ${unreadableRoutedValue(entry, repository[entry.field], FEATURES_QUERY.name)}, so the snapshot leaves it out`,
            );
            continue;
          }
          value[entry.key] = decoded;
        }
      }
      return ok({ value: value as RepositoryConfig, notes });
    });
  },
} satisfies SectionModule<"repository", typeof ENDPOINTS, typeof GRAPHQL_OPS>;

import { err, ok, Result, safeTry } from "neverthrow";
import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { isPlainObject } from "../../plain-data.js";
import { requirePlainMapping } from "../contract/declared.js";
import { cannotVerifyNote, valueDrift } from "../contract/drift.js";
import { type EndpointDecl, repoVariables } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { type GraphqlOpDecl, type GraphqlVariablesOf, graphqlOp } from "../contract/graphql.js";
import type { SectionMeta, SectionModule } from "../contract/module.js";
import { sectionGrant } from "../contract/operations.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  type ChangeLines,
  hasDrift,
  type PlainData,
  type PlanContext,
  type PlannedOp,
  type Read,
  type SectionPlan,
  type SnapshotContext,
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

// The grant the denial advice names for every route and GraphQL op below.
const permission: SectionPermission = { repo: ["administration"] };

// Shared by the LFS PUT and DELETE, the one pair whose 403 has causes a grant cannot fix.
const LFS_DENIAL_HINT =
  "a 403 here can also mean Git LFS is disabled account-wide or for the root of this " +
  "repository network, or that the credential lacks billing access (organization repositories " +
  "need an organization owner or billing manager), rather than a missing token grant";

// The 409 meaning of both immutable-releases writes; the snapshot's enforced note reuses it.
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

type LiveRepository = z.infer<typeof LiveRepository>;

/** The live security_and_analysis object narrowed to its PATCHable sub-keys; undefined when none. */
function snapshotSecurityAndAnalysis(live: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(live)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const field of SECURITY_AND_ANALYSIS_PATCH_FIELDS) {
    const value = live[field];
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

// The inverse of ISSUE_CREATION_POLICIES for the reads; a Map, so a wire value naming a prototype property cannot match.
const ISSUE_CREATION_POLICY_BY_WIRE: ReadonlyMap<unknown, IssueCreationPolicy> = new Map(
  Object.entries(ISSUE_CREATION_POLICIES).map(([policy, wire]) => [
    wire,
    policy as IssueCreationPolicy,
  ]),
);

// GraphQL treats an input field fed by an unprovided variable as not provided, so one mutation serves any declared subset.
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

// Keyed by role as ENDPOINTS is; ctx.read and the plan ops address both tables by these names.
const GRAPHQL_OPS = {
  featuresQuery: FEATURES_QUERY,
  updateFeatures: UPDATE_FEATURES,
} as const satisfies Record<string, GraphqlOpDecl>;

type RepositoryContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
type RepositorySnapshotContext = SnapshotContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;
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
  /** The toggle's GET, a probe whose 404 is the off state. */
  get: ProbeRole;

  /** Parsed at the boundary, so an off-contract body fails loudly instead of driving a write. */
  live: z.ZodType<LiveToggle>;

  /** Whether a 2xx answer means the feature is on. */
  isEnabled: (live: LiveToggle) => boolean;

  /** Enforced above the repository (immutable releases' enforced_by_owner), so the drift prose says apply cannot change it. */
  isEnforced?: (live: LiveToggle) => boolean;
}

/** null is the 204 no-content answer a toggle GET gives when the feature is on. */
type LiveToggle = null | { enabled: boolean; enforced_by_owner?: boolean };

/** One toggle's snapshot answer; concealable marks the 404 that a fine-grained token missing the grant also answers. */
interface ToggleProbe {
  toggle: ReadableToggle;
  live: LiveToggle | undefined;
  concealable: boolean;
}

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
  /** The settings key; SPECIAL_KEYS keeps it out of the PATCH body. */
  readonly key: DeclaredRepositoryKey;

  /** The change-line label ("sponsor button: enabled"). */
  readonly label: string;

  /** The Repository field the query selects and the mutation echoes. */
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
    decode: (live) => ISSUE_CREATION_POLICY_BY_WIRE.get(live),
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

/** The features read: the routed fields at their wire types (each routed key decodes its own), or a null repository when the token cannot see it. */
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

/** The PATCH op when the declared fields differ from live; a declared key GitHub never echoes is noted first. */
function planPatch(
  plan: RepositoryPlan,
  patch: Record<string, PlainData | undefined>,
  live: LiveRepository,
): void {
  if (Object.keys(patch).length === 0) {
    return;
  }

  // The PATCH is diff-gated and the fields pass through, so a declared key GitHub ignores would
  // re-PATCH on every apply without converging.
  const phantom = phantomKeys(patch, live);
  if (phantom.length > 0) {
    plan.notes.push(phantomNote("repository", phantom, "repository", "this PATCH will re-run"));
  }

  const drift = subsetDiff(patch, live, "repository");
  if (hasDrift(drift)) {
    plan.ops.push({
      role: "update",
      payload: patch,
      drift,
      change: `patched repository fields: ${Object.keys(patch).join(", ")}`,
    });
  }
}

/** The topics PUT when the declared set differs from live, both compared as sorted sets after the wire fold. */
function planTopics(
  plan: RepositoryPlan,
  topics: string | readonly string[],
  live: LiveRepository,
): void {
  const names = normalizeTopics(topics);
  const drift = subsetDiff([...names].sort(), [...(live.topics ?? [])].sort(), "repository.topics");
  if (hasDrift(drift)) {
    plan.ops.push({
      role: "topics",
      payload: { names },
      drift,
      change: `set topics: ${names.join(", ") || "(none)"}`,
    });
  }
}

/**
 * One readable toggle's write after its probe, or nothing when the declared state is the live one. The
 * write's declared tolerable statuses (409 owner-enforced, 404/422 already off on a remove) mean nothing
 * changed: a note, never a change line. A write declaring none tolerates nothing.
 */
function planReadableToggle(
  ctx: RepositoryContext,
  section: SectionMeta,
  toggle: ReadableToggle,
  want: boolean,
): Read<RepositoryOp | undefined> {
  return ctx.read[toggle.get].probeAbsent(toggle.live).map((probe): RepositoryOp | undefined => {
    const live = "missing" in probe ? undefined : probe.data;
    const enabled = live === undefined ? false : toggle.isEnabled(live);
    if (enabled === want) {
      return undefined;
    }

    const enforced = live !== undefined && toggle.isEnforced?.(live) === true;
    const role = want ? toggle.put : toggle.remove;
    return {
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
    };
  });
}

/** Each declared write-only toggle's unconditional write, with the note that nothing can read it back. */
function planWriteOnlyToggles(plan: RepositoryPlan, desired: Record<string, unknown>): void {
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
}

/** One routed key's change line, or the verification failure when the echoed value is not the declared one. */
function verifiedRoutedLine(
  routed: RoutedKey,
  echoed: Record<string, unknown>,
  want: unknown,
): Result<string, SectionFailure> {
  if (echoed[routed.key] !== want) {
    return err(
      sectionFailure(
        "unverified",
        `repository: GRAPHQL ${UPDATE_FEATURES.name} was accepted, but GitHub ` +
          `reports repository.${routed.key} ${routed.show(echoed[routed.key])} where ` +
          `${routed.show(want)} was set, so the write did not take. ` +
          `GitHub may restrict this setting on the repository`,
      ),
    );
  }
  return ok(`${routed.label}: ${routed.changeText(echoed[routed.key])}`);
}

/** The features mutation's change lines, each diverged value verified against the echoed post-state. */
function verifiedRoutedChange(
  response: unknown,
  diverged: readonly [RoutedKey, ...RoutedKey[]],
  desired: Record<string, unknown>,
): Result<ChangeLines, SectionFailure> {
  const echoedRepo = (response as { updateRepository?: { repository?: Record<string, unknown> } })
    .updateRepository?.repository;
  if (!echoedRepo) {
    return err(
      sectionFailure(
        "unverified",
        `repository: GRAPHQL ${UPDATE_FEATURES.name} returned no repository echo, so the write cannot be verified. GitHub may have changed the mutation payload; update the action`,
      ),
    );
  }

  return decodeRoutedFields(echoedRepo, diverged, UPDATE_FEATURES.name).andThen((echoed) => {
    const [first, ...rest] = diverged;
    const verified = (routed: RoutedKey) => verifiedRoutedLine(routed, echoed, desired[routed.key]);
    return Result.combine([verified(first), ...rest.map(verified)]).map(
      ([lead, ...more]): ChangeLines => [lead as string, ...more],
    );
  });
}

/** The one features mutation for the declared routed keys whose live value differs; nothing when all agree. */
function planRoutedKeys(
  ctx: RepositoryContext,
  plan: RepositoryPlan,
  desired: Record<string, unknown>,
): Read<void> {
  return safeTry(async function* () {
    const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
    if (declaredRouted.length === 0) {
      return ok(undefined);
    }

    // The routed-state read supplies the mutation's node id, so the comparison is free and a
    // converged repo issues no GraphQL write.
    const liveRouted = yield* fetchRoutedState(ctx, declaredRouted);
    const [first, ...rest] = declaredRouted.filter(
      (routed) => desired[routed.key] !== liveRouted.values[routed.key],
    );
    if (first === undefined) {
      return ok(undefined);
    }

    const diverged: readonly [RoutedKey, ...RoutedKey[]] = [first, ...rest];
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
      change: (response) => verifiedRoutedChange(response, diverged, desired),
    });
    return ok(undefined);
  });
}

/** The PATCH fields and topics as the GET reports them; a null field is GitHub's "unset" and is left out rather than declared as null. */
function patchSnapshot(live: LiveRepository): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const field of PATCH_FIELDS) {
    const read =
      field === "security_and_analysis" ? snapshotSecurityAndAnalysis(live[field]) : live[field];
    if (read !== undefined && read !== null) {
      value[field] = read;
    }
  }

  if (live.topics !== undefined && live.topics !== null && live.topics.length > 0) {
    value.topics = [...live.topics];
  }

  return value;
}

/** Every readable toggle's answer; a denied one is noted and left out. */
function probeToggles(ctx: RepositorySnapshotContext, notes: string[]): Read<ToggleProbe[]> {
  return safeTry(async function* () {
    const probes: ToggleProbe[] = [];
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
    return ok(probes);
  });
}

/** The toggles' states by key, with an enforced one noted; all-404 answers are a note and no keys. */
function snapshotToggles(
  section: SectionMeta,
  probes: readonly ToggleProbe[],
  notes: string[],
): Record<string, unknown> {
  const value: Record<string, unknown> = {};

  // The toggle GETs share one grant and answer 404 for "off", the same 404 a fine-grained token
  // missing the grant is concealed behind. One other answer proves the grant; all 404s prove
  // nothing, so the toggles are left out rather than written as off.
  if (probes.length > 0 && probes.every((probe) => probe.concealable)) {
    notes.push(
      `repository.${probes.map((probe) => probe.toggle.key).join("/")}: every toggle GET answered 404, which reads as off ` +
        "but is also how a fine-grained token missing the grant is answered, so they are left out; " +
        `if the token does ${sectionGrant(section)}, they are all off and can be declared false`,
    );
    return value;
  }

  for (const { toggle, live } of probes) {
    const enabled = live === undefined ? false : toggle.isEnabled(live);
    value[toggle.key] = enabled;
    if (live !== undefined && toggle.isEnforced?.(live) === true) {
      notes.push(
        `repository.${toggle.key}: ${OWNER_ENFORCED}, so it reads back as ${enabled} but cannot be changed from the repository`,
      );
    }
  }

  return value;
}

/** The routed keys' states by key from the features read; a denied read or an unreadable value is noted and left out. */
function snapshotRoutedKeys(
  ctx: RepositorySnapshotContext,
  notes: string[],
): Read<Record<string, unknown>> {
  return safeTry(async function* () {
    const value: Record<string, unknown> = {};
    const routed = yield* await readOrNote(
      ctx,
      notes,
      GRAPHQL_ROUTED_KEYS.map((entry) => `repository.${entry.key}`).join(" and "),
      () => ctx.read.featuresQuery.call(LiveFeatures, repoVariables(ctx)),
    );
    if ("denied" in routed) {
      return ok(value);
    }

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
    return ok(value);
  });
}

export const repositorySection = {
  key: "repository",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: requirePlainMapping(RepositoryConfig),
  async plan(ctx, declared) {
    const section = this;
    return safeTry(async function* () {
      const plan: RepositoryPlan = { ops: [], notes: [], drift: [] };
      const desired: Record<string, unknown> = declared;
      const patch: Record<string, PlainData | undefined> = Object.fromEntries(
        Object.entries(declared).filter(([key]) => !SPECIAL_KEYS.has(key)),
      );

      const live = yield* ctx.read.get.call(LiveRepository);
      planPatch(plan, patch, live);
      if (declared.topics !== undefined) {
        planTopics(plan, declared.topics, live);
      }

      for (const toggle of READABLE_TOGGLES) {
        if (!(toggle.key in desired)) {
          continue;
        }

        const op = yield* planReadableToggle(ctx, section, toggle, desired[toggle.key] === true);
        if (op !== undefined) {
          plan.ops.push(op);
        }
      }
      planWriteOnlyToggles(plan, desired);

      yield* planRoutedKeys(ctx, plan, desired);
      return ok(plan);
    });
  },
  async snapshot(ctx) {
    const section = this;
    return safeTry(async function* () {
      const notes: string[] = [];
      const live = yield* ctx.read.get.call(LiveRepository);
      const value = patchSnapshot(live);

      const probes = yield* probeToggles(ctx, notes);
      Object.assign(value, snapshotToggles(section, probes, notes));
      for (const toggle of WRITE_ONLY_TOGGLES) {
        notes.push(
          `repository.${toggle.key}: GitHub exposes no endpoint to read ${toggle.label} back, so the snapshot leaves it out; declare it yourself to manage it`,
        );
      }

      const routed = yield* snapshotRoutedKeys(ctx, notes);
      Object.assign(value, routed);
      return ok({ value: value as RepositoryConfig, notes });
    });
  },
} satisfies SectionModule<"repository", typeof ENDPOINTS, typeof GRAPHQL_OPS>;

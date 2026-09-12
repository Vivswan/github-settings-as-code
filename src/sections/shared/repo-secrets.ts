/**
 * GitHub's four repo-scoped secret families (Actions, Dependabot, Codespaces, Copilot agents) expose the
 * same four endpoints under a different path segment and differ only in PAT resource, noun, and (Codespaces)
 * the grade GitHub gates the reads at, so each section module is ONE repoSecretsSection() call.
 *
 *   environments section                    -> consumes ./secrets-engine.ts directly, with nested scopes
 *   .github/scripts/changed-sections.ts     -> derives this file's smoke fan-out from the import graph
 */

import type { z } from "zod";
import { snapshotSecretReference, snapshotSecretVariable } from "../../engine/secret-reference.js";
import type { SettingsFile } from "../../schema.js";
import type { MustBeNever, UndeclaredPolicyList } from "../../types.js";
import { ActionsSecretConfig } from "../actions_secrets/schema.js";
import { AgentsSecretConfig } from "../agents_secrets/schema.js";
import { CodespacesSecretConfig } from "../codespaces_secrets/schema.js";
import { parseLive } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  type SectionSnapshot,
  undeclaredPolicy,
} from "../contract/module.js";
import type { PatResource } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import { DependabotSecretConfig } from "../dependabot_secrets/schema.js";
import { knobbed, type sealedSecretConfig } from "./schema-helpers.js";
import {
  LIVE_SECRET_NAMES,
  listSecretValues,
  planSecrets,
  rejectDuplicateSecretNames,
  type SecretEntry,
  type SecretsPlanScope,
} from "./secrets-engine.js";
import { knobbedSnapshot } from "./snapshot-helpers.js";

export type RepoSecretsKey =
  | "actions_secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "agents_secrets";

/**
 * The factory derives the routes from THIS map, so a key paired with another family's segment (which the
 * mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE to the
 * segment its own KEY spells, so a fifth family breaking the `<segment>_secrets` naming must say so here.
 */
const SECRETS_SEGMENTS = {
  actions_secrets: "actions",
  dependabot_secrets: "dependabot",
  codespaces_secrets: "codespaces",
  agents_secrets: "agents",
} as const satisfies { [K in RepoSecretsKey]: SegmentOfSecretsKey<K> };

/**
 * The factory derives the runtime shape from THIS map, so a key paired with another family's config
 * (structurally identical, invisible to every gate) is unrepresentable.
 */
const SECRETS_ENTRIES = {
  actions_secrets: ActionsSecretConfig,
  dependabot_secrets: DependabotSecretConfig,
  codespaces_secrets: CodespacesSecretConfig,
  agents_secrets: AgentsSecretConfig,
} as const satisfies Record<RepoSecretsKey, ReturnType<typeof sealedSecretConfig>>;

type SegmentOfSecretsKey<K extends RepoSecretsKey> = K extends `${infer S}_secrets` ? S : never;

type SecretsSegment<K extends RepoSecretsKey = RepoSecretsKey> = (typeof SECRETS_SEGMENTS)[K];

/**
 * Routes as LITERAL types, so the registry's SectionEndpointKey union, the typed mock fragments, and
 * USED_PATHS see exactly what a hand-written dictionary would declare. A type alias, not an interface,
 * so it keeps the implicit index signature EndpointDict expects.
 */
type RepoSecretsEndpoints<P extends SecretsSegment> = {
  readonly list: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/secrets`;
    readonly statuses: { readonly 200: string };
    readonly accessGrade?: "write";
    readonly primaryRead: { readonly notFound: "denied" };
  };
  readonly publicKey: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/secrets/public-key`;
    readonly statuses: { readonly 200: string };
    readonly accessGrade?: "write";
  };
  readonly put: {
    readonly route: `PUT /repos/{owner}/{repo}/${P}/secrets/{secret_name}`;
    readonly statuses: { readonly 201: string; readonly 204: string };
    readonly alwaysRewrite: true;
  };
  readonly remove: {
    readonly route: `DELETE /repos/{owner}/{repo}/${P}/secrets/{secret_name}`;
    readonly statuses: { readonly 204: string };
  };
};

type RepoSecretsDeclared<K extends RepoSecretsKey> = Exclude<SettingsFile[K], undefined>;

/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoSecretsPlan<K extends RepoSecretsKey> = {
  [F in RepoSecretsKey]: (
    ctx: PlanContext<RepoSecretsEndpoints<SecretsSegment<F>>>,
    declared: RepoSecretsDeclared<F>,
  ) => Promise<SectionPlan<PlannedOp<RepoSecretsEndpoints<SecretsSegment<F>>>>>;
}[K];

/**
 * Every family's routes as one dictionary (each route the union over the
 * segments): inside the generic factory the segment is unresolved, so the
 * contract's role derivations only resolve over this view.
 */
type WideEndpoints = RepoSecretsEndpoints<SecretsSegment>;

type WideDeclared = SecretEntry[] | UndeclaredPolicyList<SecretEntry>;

type SharedPlan = (
  ctx: PlanContext<WideEndpoints>,
  declared: WideDeclared,
) => Promise<SectionPlan<PlannedOp<WideEndpoints>>>;

/** What every family's snapshot reads back: one shape, since the four entry slices are identical. */
type WideSnapshot = { value: UndeclaredPolicyList<SecretEntry> | undefined; notes: string[] };

type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _SharedPlanIsEveryFamilyPlan = MustBeNever<
  {
    [K in RepoSecretsKey]: Invariant<SharedPlan, RepoSecretsPlan<K>> extends true ? never : K;
  }[RepoSecretsKey]
>;

/**
 * Checked HERE as a fresh object literal, once per family key: the factory hands ../registry.ts a module
 * IDENTIFIER, where excess-property checking no longer runs, so a `known` key no entry type carries any
 * more would otherwise compile silently. The intersection admits a key present in ANY constituent, but a
 * key only one family dropped breaks SecretEntry and the shared plan signature first.
 */
const CLOSED_SURFACE = {
  known: { name: true, value: true },
  describe: (entry: SecretEntry) => entry.name,
  consequence: "the API body carries only the sealed value, so the key would silently do nothing",
} satisfies ClosedSurfaceOf<"actions_secrets"> &
  ClosedSurfaceOf<"dependabot_secrets"> &
  ClosedSurfaceOf<"codespaces_secrets"> &
  ClosedSurfaceOf<"agents_secrets">;

type ClosedSurfaceOf<K extends RepoSecretsKey> = NonNullable<SectionModule<K>["closedSurface"]>;

/** The module shape repoSecretsSection() mints (SectionModule<K> at the registry). */
export interface RepoSecretsSectionModule<K extends RepoSecretsKey> {
  readonly key: K;
  readonly undeclaredDefault: "keep";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoSecretsEndpoints<SecretsSegment<K>>;
  readonly shape: z.ZodType;
  readonly secretValues: typeof listSecretValues;
  readonly closedSurface: typeof CLOSED_SURFACE;
  readonly plan: RepoSecretsPlan<K>;
  readonly snapshot: (
    ctx: PlanContext<RepoSecretsEndpoints<SecretsSegment<K>>>,
  ) => Promise<SectionSnapshot<K>>;
}

/**
 * Keep-by-default on purpose: a deleted secret's value is unrecoverable, so deletion is opt-in via the
 * wrapped `_undeclared: delete` form. A family supplies only its key, PAT resource, noun, and (Codespaces) read grade.
 */
export function repoSecretsSection<K extends RepoSecretsKey>(family: {
  key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  resource: PatResource;
  /** The output noun for notes ("Actions secret", "Dependabot secret", ...). */
  noun: string;
  /**
   * The fine-grained "Codespaces secrets" permission gates even the GETs (list, public-key) at write;
   * the writes are write-graded by method already.
   */
  accessGrade?: "write";
}): RepoSecretsSectionModule<K> {
  const { key, resource, noun, accessGrade } = family;
  const pathSegment: SecretsSegment<K> = SECRETS_SEGMENTS[key];
  const readGrade = accessGrade === undefined ? {} : { accessGrade };
  const endpoints: RepoSecretsEndpoints<SecretsSegment<K>> = {
    list: {
      route: `GET /repos/{owner}/{repo}/${pathSegment}/secrets`,
      statuses: { 200: "the secrets list (names and timestamps; never values)" },
      ...readGrade,
      // A fine-grained token conceals a denied list as 404; reading it as "no secrets" would be wrong, so it is a denial.
      primaryRead: { notFound: "denied" },
    },
    publicKey: {
      route: `GET /repos/{owner}/{repo}/${pathSegment}/secrets/public-key`,
      statuses: { 200: "the sealing public key" },
      ...readGrade,
    },
    put: {
      route: `PUT /repos/{owner}/{repo}/${pathSegment}/secrets/{secret_name}`,
      statuses: { 201: "secret created", 204: "secret updated" },
      alwaysRewrite: true,
    },
    remove: {
      route: `DELETE /repos/{owner}/{repo}/${pathSegment}/secrets/{secret_name}`,
      statuses: { 204: "secret deleted" },
    },
  };

  const wide: WideEndpoints = endpoints;
  const plan: SharedPlan = async (ctx, declared) => {
    const defaultPolicy = defaultUndeclaredPolicy(section);
    const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
    rejectDuplicateSecretNames(section, entries);
    // Built where the routes are known, so params typecheck.
    type Op = PlannedOp<WideEndpoints>;
    type Described<R extends Op["role"]> = Extract<Op, { role: R }> & { readonly describe: string };
    const scope: SecretsPlanScope<Described<"put">, Described<"remove">> = {
      label: key,
      noun,
      list: async () =>
        parseLive(
          section,
          wide.list,
          LIVE_SECRET_NAMES,
          await ctx.read.list.listAllEnveloped("secrets"),
        ),
      publicKey: (describe) => ctx.read.publicKey.call({ describe }),
      publicKeyEndpoint: wide.publicKey,
      put: (write) => ({
        role: "put",
        params: { secret_name: write.name },
        payload: write.payload,
        drift: write.drift,
        change: write.change,
        describe: write.describe,
      }),
      remove: (deletion) => ({
        role: "remove",
        params: { secret_name: deletion.name },
        drift: deletion.drift,
        change: deletion.change,
        describe: deletion.describe,
      }),
    };
    return planSecrets(section, scope, { entries, policy, defaultPolicy });
  };

  // GitHub lists names only, so each entry carries the `$NAME` reference the operator must export
  // before an apply, and a note says so per secret.
  const snapshot = async (ctx: PlanContext<WideEndpoints>): Promise<WideSnapshot> => {
    const live = parseLive(
      section,
      wide.list,
      LIVE_SECRET_NAMES,
      await ctx.read.list.listAllEnveloped("secrets"),
    );
    if (live.length === 0) {
      return { value: undefined, notes: [] };
    }
    const entries = live.map(({ name }) => ({ name, value: snapshotSecretReference(name) }));
    const notes = live.map(
      ({ name }) =>
        `${key}[${name}]: value of ${name} is not readable; export it into the environment as ${snapshotSecretVariable(name)} before apply`,
    );
    return { value: knobbedSnapshot(section, entries), notes };
  };

  const section: RepoSecretsSectionModule<K> = {
    key,
    undeclaredDefault: "keep",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(knobbed(SECRETS_ENTRIES[key])),
    secretValues: listSecretValues,
    closedSurface: CLOSED_SURFACE,
    plan,
    // The family's port is the wide port at one segment; the cast is that boundary.
    snapshot: (ctx) => snapshot(ctx as PlanContext<WideEndpoints>),
  };
  return section;
}

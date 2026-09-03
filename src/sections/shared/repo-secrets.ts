/**
 * The repository-level sealed-secret section factory. GitHub's four
 * repo-scoped secret families (Actions, Dependabot, Codespaces, Copilot
 * agents) expose the same four endpoints under a different path segment and
 * differ only in PAT resource, output noun, and - for Codespaces - the access
 * grade GitHub gates the reads at, so each section module is ONE
 * repoSecretsSection() call carrying its family's facts. The factory sits
 * above the shared secrets engine (./secrets-engine.ts), which owns the
 * existence-based reconciliation and client-side sealing; the per-environment
 * secrets family (environments) consumes the engine directly with its own
 * nested scopes. The smoke selector (.github/scripts/changed-sections.ts)
 * derives this file's section fan-out from the import graph.
 */

import type { z } from "zod";
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

/** The section keys the factory may mint, each with its API path segment. */
export type RepoSecretsKey =
  | "actions_secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "agents_secrets";

/**
 * Each family's path segment under /repos/{owner}/{repo}, keyed by section:
 * the factory derives the routes from THIS map, so a key paired with another
 * family's segment (which the mock would faithfully serve, hiding the swap)
 * is unrepresentable. The `satisfies` pins every VALUE to the segment its
 * own KEY spells, so the map cannot lie either - each section key is exactly
 * `<segment>_secrets`, and a fifth family that broke that naming would have
 * to say so here rather than silently mis-route.
 */
const SECRETS_SEGMENTS = {
  actions_secrets: "actions",
  dependabot_secrets: "dependabot",
  codespaces_secrets: "codespaces",
  agents_secrets: "agents",
} as const satisfies { [K in RepoSecretsKey]: SegmentOfSecretsKey<K> };

/**
 * Each family's entry slice (src/sections/<key>/schema.ts), keyed by section
 * like SECRETS_SEGMENTS: the factory derives the runtime shape from THIS
 * map, so a key paired with another family's config - structurally identical
 * and invisible to every gate - is unrepresentable.
 */
const SECRETS_ENTRIES = {
  actions_secrets: ActionsSecretConfig,
  dependabot_secrets: DependabotSecretConfig,
  codespaces_secrets: CodespacesSecretConfig,
  agents_secrets: AgentsSecretConfig,
} as const satisfies Record<RepoSecretsKey, ReturnType<typeof sealedSecretConfig>>;

/** The path segment a `<segment>_secrets` section key spells. */
type SegmentOfSecretsKey<K extends RepoSecretsKey> = K extends `${infer S}_secrets` ? S : never;

/** The path segment a secret family lives at, derived from its key. */
type SecretsSegment<K extends RepoSecretsKey = RepoSecretsKey> = (typeof SECRETS_SEGMENTS)[K];

/**
 * The four-endpoint dictionary of one family, its routes derived from the
 * family's path segment as LITERAL types - so the registry's
 * SectionEndpointKey union, the typed mock fragments, and USED_PATHS see the
 * same exact roles and routes a hand-written dictionary would declare. A
 * type alias, not an interface, so it keeps the implicit index signature
 * EndpointDict expects.
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

/** The declared value of one family's section, exactly as the settings document types it. */
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

/** The declared value every family accepts: the entry list, plain or wrapped. */
type WideDeclared = SecretEntry[] | UndeclaredPolicyList<SecretEntry>;

/** The one plan the factory builds, over the wide dictionary. */
type SharedPlan = (
  ctx: PlanContext<WideEndpoints>,
  declared: WideDeclared,
) => Promise<SectionPlan<PlannedOp<WideEndpoints>>>;

/** Mutual assignability - equality up to structure, in both directions. */
type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time pin: the shared plan IS each family's exact plan, so a family
 * whose roles, params, or declared value diverge fails here by name.
 */
type _SharedPlanIsEveryFamilyPlan = MustBeNever<
  {
    [K in RepoSecretsKey]: Invariant<SharedPlan, RepoSecretsPlan<K>> extends true ? never : K;
  }[RepoSecretsKey]
>;

/**
 * The closed entry surface every family shares, checked HERE as a fresh
 * object literal against the same mapped type SectionModule declares it
 * with - once per family key, since a conditional type over a generic K
 * cannot be checked inside the factory body. Freshness is the point: the
 * factory hands the registry a module IDENTIFIER, where excess-property
 * checking no longer runs, so a `known` key none of the four entry types
 * carries any more would otherwise compile silently for all of them. (An
 * intersection admits a property present in ANY constituent, so a key that
 * only ONE family dropped would still pass - a divergence that would break
 * SecretEntry and the shared plan signature first.) The missing-key
 * direction is plain assignability and still bites at the registry line.
 */
const CLOSED_SURFACE = {
  known: { name: true, value: true },
  describe: (entry: SecretEntry) => entry.name,
  // The PUT body is built from the sealed value alone, so an extra entry key
  // never reaches GitHub: it would apply "successfully" forever while doing
  // nothing, which is exactly what closed surfaces exist to reject.
  consequence: "the API body carries only the sealed value, so the key would silently do nothing",
} satisfies ClosedSurfaceOf<"actions_secrets"> &
  ClosedSurfaceOf<"dependabot_secrets"> &
  ClosedSurfaceOf<"codespaces_secrets"> &
  ClosedSurfaceOf<"agents_secrets">;

/** The closedSurface declaration one section key's SectionModule requires. */
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
}

/**
 * Mint one repository-level secret family's section module. Everything the
 * families share - the reconcile-by-existence plan, the engine wiring, the
 * closed {name, value} entry surface, the keep-by-default posture (deleted
 * secret values are unrecoverable, so deletion is opt-in via the wrapped
 * `undeclared: delete` form) - lives here once, and the routes derive from
 * the key through SECRETS_SEGMENTS; a family supplies only its key, PAT
 * resource, noun, and (Codespaces) read grade.
 */
export function repoSecretsSection<K extends RepoSecretsKey>(family: {
  key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  resource: PatResource;
  /** The output noun for notes ("Actions secret", "Dependabot secret", ...). */
  noun: string;
  /**
   * The access grade GitHub gates the family's READS (list and public-key)
   * at, when it is not the method-derived one: the fine-grained "Codespaces
   * secrets" permission gates even those GETs at write. The writes are
   * write-graded by method already, so the override applies to the GETs.
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
      // A fine-grained token conceals a denied list as 404, which is a
      // denial here: the section stops instead of reading "no secrets".
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
    // Built where the routes are known, so params typecheck; each write carries
    // the describe prose a failing request renders.
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
    // The engine validates every $NAME reference before any section plans and,
    // in apply mode, resolves and masks them; the PUT thunks read them through ExecTools.
    return planSecrets(section, scope, { entries, policy, defaultPolicy });
  };

  const section: RepoSecretsSectionModule<K> = {
    key,
    undeclaredDefault: "keep",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(knobbed(SECRETS_ENTRIES[key])),
    // The engine's shared list extractor: the declared value of every entry,
    // for the up-front reference resolution.
    secretValues: listSecretValues,
    closedSurface: CLOSED_SURFACE,
    plan,
  };
  return section;
}

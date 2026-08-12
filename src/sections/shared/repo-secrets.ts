/**
 * The repository-level sealed-secret section factory. GitHub's four
 * repo-scoped secret families (Actions, Dependabot, Codespaces, Copilot
 * agents) expose the same four endpoints under a different path segment and
 * differ only in PAT resource, output noun, and - for Codespaces - the access
 * grade GitHub gates the reads at, so each section module is ONE
 * repoSecretsSection() call carrying its family's facts. The factory sits
 * above the shared secrets engine (../secrets-engine.ts), which owns the
 * existence-based reconciliation and client-side sealing; the per-environment
 * secrets family (environments) consumes the engine directly with its own
 * nested scopes. Selector fan-out for this file is declared in
 * SHARED_FAN_OUT (.github/scripts/changed-sections.ts).
 */

import type { z } from "zod";
import { SettingsFile, type UndeclaredPolicyList } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  listAllEnveloped,
  loosen,
  type PatResource,
  parseLive,
  type SectionContext,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";
import {
  LIVE_SECRET_NAMES,
  listSecretValues,
  reconcileSecrets,
  rejectDuplicateSecretNames,
  type SecretEntry,
  type SecretsScope,
  type SecretsScopeOps,
} from "../secrets-engine.js";

/** The section keys the factory may mint, each with its API path segment. */
type RepoSecretsKey =
  | "actions_secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "agents_secrets";

/** The path segment under /repos/{owner}/{repo} a secret family lives at. */
type SecretsSegment = "actions" | "dependabot" | "codespaces" | "agents";

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

/** The declared value every family accepts: the entry list, plain or wrapped. */
type RepoSecretsDeclared = SecretEntry[] | UndeclaredPolicyList<SecretEntry>;

/** The module shape repoSecretsSection() mints (SectionModule<K> at the registry). */
export interface RepoSecretsSectionModule<K extends RepoSecretsKey, P extends SecretsSegment> {
  readonly key: K;
  readonly undeclaredDefault: "keep";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoSecretsEndpoints<P>;
  readonly shape: z.ZodType;
  readonly secretValues: typeof listSecretValues;
  readonly closedSurface: {
    readonly known: readonly ("name" | "value")[];
    readonly describe: (entry: SecretEntry) => string;
    readonly consequence: string;
  };
  run(ctx: SectionContext, declared: RepoSecretsDeclared): Promise<SectionResult>;
}

/**
 * Mint one repository-level secret family's section module. Everything the
 * families share - the reconcile-by-existence run, the engine wiring, the
 * closed {name, value} entry surface, the keep-by-default posture (deleted
 * secret values are unrecoverable, so deletion is opt-in via the wrapped
 * `undeclared: delete` form) - lives here once; a family supplies only its
 * key, path segment, PAT resource, noun, and (Codespaces) read grade.
 */
export function repoSecretsSection<K extends RepoSecretsKey, P extends SecretsSegment>(family: {
  key: K;
  /** The API path segment: /repos/{owner}/{repo}/<segment>/secrets. */
  pathSegment: P;
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
}): RepoSecretsSectionModule<K, P> {
  const { key, pathSegment, resource, noun, accessGrade } = family;
  const readGrade = accessGrade === undefined ? {} : { accessGrade };
  const endpoints: RepoSecretsEndpoints<P> = {
    list: {
      route: `GET /repos/{owner}/{repo}/${pathSegment}/secrets`,
      statuses: { 200: "the secrets list (names and timestamps; never values)" },
      ...readGrade,
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

  // The engine's four operations, built here where the routes are known so
  // the params contract compile-checks (secret_name on put/remove). The
  // request helpers resolve path params from the ROUTE type, which stays
  // parametric on P inside this generic body, so the ops read the dictionary
  // through the constraint-widened view - each route becomes the finite
  // union over every family segment, on which PathParams resolves.
  const wide: RepoSecretsEndpoints<SecretsSegment> = endpoints;
  const ops: SecretsScopeOps = {
    list: async (ctx, section) =>
      parseLive(
        section,
        wide.list,
        LIVE_SECRET_NAMES,
        await listAllEnveloped(ctx, section, wide.list, "secrets"),
      ),
    publicKey: (ctx, section, describe) => call(ctx, section, wide.publicKey, { describe }),
    put: (ctx, section, secretName, payload, describe) =>
      call(ctx, section, wide.put, {
        params: { secret_name: secretName },
        payload,
        describe,
      }),
    remove: (ctx, section, secretName, describe) =>
      call(ctx, section, wide.remove, { params: { secret_name: secretName }, describe }),
  };

  const scope: SecretsScope = { label: key, noun, ops };

  return {
    key,
    undeclaredDefault: "keep",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(SettingsFile.shape[key]),
    // The engine's shared list extractor: the declared value of every entry,
    // for the up-front reference resolution.
    secretValues: listSecretValues,
    // The PUT body is built from the sealed value alone, so an extra entry key
    // never reaches GitHub: it would apply "successfully" forever while doing
    // nothing, which is exactly what closed surfaces exist to reject.
    closedSurface: {
      known: ["name", "value"],
      describe: (entry) => entry.name,
      consequence:
        "the API body carries only the sealed value, so the key would silently do nothing",
    },
    async run(ctx, declared): Promise<SectionResult> {
      const { policy, entries } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
      rejectDuplicateSecretNames(this, entries);
      // The engine validated every $NAME reference in both modes and, in
      // apply mode, resolved and masked the plaintexts before any section
      // ran; the sealed-write path reads them through the run's apply arm.
      const run = beginRun(ctx);
      await reconcileSecrets(run, this, scope, { entries, policy });
      return run.result;
    },
  };
}

/**
 * `actions_secrets:` section - repository Actions secrets, reconciled by
 * existence through the shared secrets engine (secrets-engine.ts). Declared
 * values are whole-value `$NAME` environment references (never literals -
 * settings files are committed plaintext), resolved at apply time and sealed
 * client-side; GitHub cannot return a value, so check mode verifies that each
 * declared secret exists and apply re-seals every declared value on each run.
 * Undeclared secrets are kept by default (their values are unrecoverable);
 * the wrapped `undeclared: delete` form opts into deletion.
 */

import { z } from "zod";
import type { ActionsSecretConfig, UndeclaredPolicyList } from "../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  grantFor,
  listAllEnveloped,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
  undeclaredPolicyShape,
} from "./contract.js";
import {
  prepareSecretValues,
  reconcileSecrets,
  rejectDuplicateSecretNames,
  type SecretsScope,
  type SecretsScopeOps,
} from "./secrets-engine.js";

const permission: SectionPermission = { repo: ["secrets"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/actions/secrets",
    statuses: { 200: "the secrets list (names and timestamps; never values)" },
  },
  publicKey: {
    route: "GET /repos/{owner}/{repo}/actions/secrets/public-key",
    statuses: { 200: "the sealing public key" },
  },
  put: {
    route: "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
    statuses: { 201: "secret created", 204: "secret updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}",
    statuses: { 204: "secret deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

// The engine's four operations, built here where the literal routes are
// known so the params contract compile-checks (secret_name on put/remove).
const OPS: SecretsScopeOps = {
  list: (ctx, section) => listAllEnveloped(ctx, section, ENDPOINTS.list, "secrets"),
  publicKey: (ctx, section, describe) => call(ctx, section, ENDPOINTS.publicKey, { describe }),
  put: (ctx, section, secretName, payload, describe) =>
    call(ctx, section, ENDPOINTS.put, {
      params: { secret_name: secretName },
      payload,
      describe,
    }),
  remove: (ctx, section, secretName, describe) =>
    call(ctx, section, ENDPOINTS.remove, { params: { secret_name: secretName }, describe }),
};

const SCOPE: SecretsScope = {
  label: "actions_secrets",
  noun: "Actions secret",
  ops: OPS,
};

/**
 * The declared value of every entry, for the engine's up-front resolution.
 * Runs BEFORE validation on target-fetched documents (the webhooks
 * precedent), so a malformed container returns [] and shape validation
 * reports the actionable error.
 */
function secretValues(declared: unknown): string[] {
  const container = declared as ActionsSecretConfig[] | UndeclaredPolicyList<ActionsSecretConfig>;
  const isWrapper =
    typeof container === "object" &&
    container !== null &&
    !Array.isArray(container) &&
    Array.isArray((container as UndeclaredPolicyList<ActionsSecretConfig>).entries);
  if (!Array.isArray(container) && !isWrapper) {
    return [];
  }
  const { entries } = undeclaredPolicy(container, "keep");
  return entries
    .map((entry) => (typeof entry === "object" && entry !== null ? entry.value : undefined))
    .filter((value): value is string => typeof value === "string");
}

export const actionsSecretsSection: SectionModule<"actions_secrets"> = {
  key: "actions_secrets",
  undeclaredDefault: "keep",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: undeclaredPolicyShape(z.array(z.looseObject({ name: z.string(), value: z.string() }))),
  secretValues,
  // The PUT body is built from the sealed value alone, so an extra entry key
  // never reaches GitHub: it would apply "successfully" forever while doing
  // nothing, which is exactly what closed surfaces exist to reject.
  closedSurface: {
    known: ["name", "value"],
    describe: (entry) => entry.name,
    consequence: "the API body carries only the sealed value, so the key would silently do nothing",
  },
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const { policy, entries } = undeclaredPolicy(
      desiredRaw as ActionsSecretConfig[] | UndeclaredPolicyList<ActionsSecretConfig>,
      defaultUndeclaredPolicy(this),
    );
    rejectDuplicateSecretNames(this, entries);
    // The engine validated every $NAME reference in both modes and, in
    // apply mode, resolved and masked the plaintexts before any section
    // ran; this adapts ctx.resolveSecret into the per-entry lookup the
    // sealed-write path takes.
    const resolvedValueOf = prepareSecretValues(ctx, this, entries);
    return reconcileSecrets(ctx, this, SCOPE, { entries, policy, resolvedValueOf });
  },
};

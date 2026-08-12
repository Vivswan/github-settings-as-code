/**
 * `agents_secrets:` section - repository Copilot agents secrets, reconciled
 * by existence through the shared secrets engine (secrets-engine.ts).
 * Declared values are whole-value `$NAME` environment references (never
 * literals - settings files are committed plaintext), resolved at apply time
 * and sealed client-side; GitHub cannot return a value, so check mode
 * verifies that each declared secret exists and apply re-seals every
 * declared value on each run. Undeclared secrets are kept by default (their
 * values are unrecoverable); the wrapped `undeclared: delete` form opts into
 * deletion.
 */

import { type AgentsSecretConfig, SettingsFile, type UndeclaredPolicyList } from "../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  listAllEnveloped,
  loosen,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "./contract.js";
import {
  listSecretValues,
  reconcileSecrets,
  rejectDuplicateSecretNames,
  type SecretsScope,
  type SecretsScopeOps,
} from "./secrets-engine.js";

const permission: SectionPermission = { repo: ["agent_secrets"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/agents/secrets",
    statuses: { 200: "the secrets list (names and timestamps; never values)" },
  },
  publicKey: {
    route: "GET /repos/{owner}/{repo}/agents/secrets/public-key",
    statuses: { 200: "the sealing public key" },
  },
  put: {
    route: "PUT /repos/{owner}/{repo}/agents/secrets/{secret_name}",
    statuses: { 201: "secret created", 204: "secret updated" },
    alwaysRewrite: true,
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/agents/secrets/{secret_name}",
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
  label: "agents_secrets",
  noun: "Copilot agents secret",
  ops: OPS,
};

export const agentsSecretsSection: SectionModule<"agents_secrets"> = {
  key: "agents_secrets",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.agents_secrets),
  // The engine's shared list extractor: the declared value of every entry,
  // for the up-front reference resolution.
  secretValues: listSecretValues,
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
      desiredRaw as AgentsSecretConfig[] | UndeclaredPolicyList<AgentsSecretConfig>,
      defaultUndeclaredPolicy(this),
    );
    rejectDuplicateSecretNames(this, entries);
    // The engine validated every $NAME reference in both modes and, in
    // apply mode, resolved and masked the plaintexts before any section
    // ran; the sealed-write path reads them through ctx.resolveSecret.
    return reconcileSecrets(ctx, this, SCOPE, { entries, policy });
  },
};

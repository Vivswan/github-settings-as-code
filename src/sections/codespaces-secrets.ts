/**
 * `codespaces_secrets:` section - repository Codespaces secrets (development
 * environment secrets), reconciled by existence through the shared secrets
 * engine (secrets-engine.ts). Declared values are whole-value `$NAME`
 * environment references (never literals - settings files are committed
 * plaintext), resolved at apply time and sealed client-side against the
 * Codespaces public key; GitHub cannot return a value, so check mode
 * verifies that each declared secret exists and apply re-seals every
 * declared value on each run. Undeclared secrets are kept by default (their
 * values are unrecoverable); the wrapped `undeclared: delete` form opts into
 * deletion.
 *
 * The fine-grained "Codespaces secrets" PAT permission gates every endpoint
 * here at WRITE on real GitHub, reads included (GitHub's own fine-grained
 * permission data), so both GETs declare `accessGrade: "write"` - the e2e
 * mock and fuzz oracle then model the real gating. The grant advice already
 * says read and write, so a token set up from it works, and a read-only
 * grant fails the list exactly like a missing one.
 */

import { z } from "zod";
import type { CodespacesSecretConfig, UndeclaredPolicyList } from "../schema.js";
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
  listSecretValues,
  prepareSecretValues,
  reconcileSecrets,
  rejectDuplicateSecretNames,
  type SecretsScope,
  type SecretsScopeOps,
} from "./secrets-engine.js";

const permission: SectionPermission = { repo: ["codespaces_secrets"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/codespaces/secrets",
    statuses: { 200: "the secrets list (names and timestamps; never values)" },
    accessGrade: "write",
  },
  publicKey: {
    route: "GET /repos/{owner}/{repo}/codespaces/secrets/public-key",
    statuses: { 200: "the sealing public key" },
    accessGrade: "write",
  },
  put: {
    route: "PUT /repos/{owner}/{repo}/codespaces/secrets/{secret_name}",
    statuses: { 201: "secret created", 204: "secret updated" },
    alwaysRewrite: true,
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/codespaces/secrets/{secret_name}",
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
  label: "codespaces_secrets",
  noun: "Codespaces secret",
  ops: OPS,
};

export const codespacesSecretsSection: SectionModule<"codespaces_secrets"> = {
  key: "codespaces_secrets",
  undeclaredDefault: "keep",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: undeclaredPolicyShape(z.array(z.looseObject({ name: z.string(), value: z.string() }))),
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
      desiredRaw as CodespacesSecretConfig[] | UndeclaredPolicyList<CodespacesSecretConfig>,
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

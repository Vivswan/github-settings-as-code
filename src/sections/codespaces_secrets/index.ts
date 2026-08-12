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

import { repoSecretsSection } from "../shared/repo-secrets.js";
import { CodespacesSecretConfig } from "./schema.js";

export const codespacesSecretsSection = repoSecretsSection({
  key: "codespaces_secrets",
  entry: CodespacesSecretConfig,
  resource: "codespaces_secrets",
  noun: "Codespaces secret",
  accessGrade: "write",
});

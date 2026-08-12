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

import { repoSecretsSection } from "../shared/repo-secrets.js";

export const agentsSecretsSection = repoSecretsSection({
  key: "agents_secrets",
  pathSegment: "agents",
  resource: "agent_secrets",
  noun: "Copilot agents secret",
});

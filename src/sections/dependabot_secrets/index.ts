/**
 * `dependabot_secrets:` section - repository Dependabot secrets
 * (private-registry credentials Dependabot uses), reconciled by existence
 * through the shared secrets engine (secrets-engine.ts). Declared values are
 * whole-value `$NAME` environment references (never literals - settings
 * files are committed plaintext), resolved at apply time and sealed
 * client-side against the Dependabot public key; GitHub cannot return a
 * value, so check mode verifies that each declared secret exists and apply
 * re-seals every declared value on each run. Undeclared secrets are kept by
 * default (their values are unrecoverable); the wrapped `undeclared: delete`
 * form opts into deletion.
 */

import { repoSecretsSection } from "../shared/repo-secrets.js";

export const dependabotSecretsSection = repoSecretsSection({
  key: "dependabot_secrets",
  resource: "dependabot_secrets",
  noun: "Dependabot secret",
});

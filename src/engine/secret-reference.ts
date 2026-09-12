/**
 * The `$NAME` reference a snapshot writes in place of a secret value GitHub never reveals. The
 * grammar and the reserved prefixes are the secret-reference module's; this is the one place a
 * snapshot mints a reference from a live secret's name.
 */

import { RESERVED_REF_PREFIXES } from "../action/secret-refs.js";

/** The prefix that keeps a reserved-looking secret name out of the runner's own namespace. */
const RESERVED_ESCAPE = "SECRET_";

/**
 * The environment variable a snapshot asks the operator to export for a live secret: the secret's
 * own name, or `SECRET_<name>` when the bare name would be refused as a reserved runner variable
 * (a repository secret named GITHUB_TOKEN is legal on GitHub; a reference to it is not).
 */
export function snapshotSecretVariable(secretName: string): string {
  const reserved = RESERVED_REF_PREFIXES.some((prefix) => secretName.startsWith(prefix));
  return reserved ? `${RESERVED_ESCAPE}${secretName}` : secretName;
}

/** The whole-value reference for a live secret, as the settings file spells it. */
export function snapshotSecretReference(secretName: string): string {
  return `$${snapshotSecretVariable(secretName)}`;
}

/**
 * The `$NAME` reference a snapshot writes in place of a secret value GitHub never reveals. One
 * reference per store and name, so two stores holding the same secret name (an Actions and a
 * Dependabot DEPLOY_TOKEN) never share an environment variable an apply would write to both.
 */

import { validateSecretRef } from "../action/secret-refs.js";

/**
 * The environment variable a snapshot asks the operator to export for one live secret, and the
 * whole-value reference the settings file carries for it: `SECRET_<STORE>_<NAME>`. The store leads
 * so the variable stays out of the runner's reserved namespaces (`ACTIONS_*` is reserved, so the
 * store cannot lead as `ACTIONS_SECRET_...`); the reference grammar itself proves the mint.
 */
export function snapshotSecretReference(
  store: string,
  secretName: string,
): { variable: string; reference: string } {
  const variable = `SECRET_${store.toUpperCase()}_${secretName}`;
  const reference = `$${variable}`;
  const checked = validateSecretRef(reference, "operator", `the ${store} secret ${secretName}`);
  if (!checked.ok) {
    throw new Error(
      `BUG: the snapshot minted a reference the settings file refuses: ${checked.error}`,
    );
  }
  return { variable, reference };
}

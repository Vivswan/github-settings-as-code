/**
 * Shared leaf helpers for the sealed-secret config schemas: the repository
 * secret sections and the environments section's nested secrets key declare
 * the same {name, value} entry shape with the same documentation. A leaf
 * module (zod only) so a per-section schema file can import it without
 * touching the root schema - root schema.ts importing a section schema that
 * imported root back would TDZ-crash at module evaluation.
 */

import { z } from "zod";

export const SEALED_SECRET_VALUE_DOC =
  "A whole-value `$NAME` reference to an environment variable holding the secret - never a literal (settings files are committed plaintext). Resolved from the action step's env at run time and sealed with a libsodium sealed box before upload; GitHub cannot return the value, so check mode verifies existence only and apply re-seals it on every run.";

export const SECRET_NAME_DOC =
  "The secret name, the natural key; compared case-insensitively and written uppercase.";

/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
export function sealedSecretConfig(id: string, description: string) {
  return z
    .object({
      name: z.string().describe(SECRET_NAME_DOC),
      value: z.string().describe(SEALED_SECRET_VALUE_DOC),
    })
    .describe(description)
    .meta({ id });
}

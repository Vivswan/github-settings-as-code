/**
 * settings.yml is committed plaintext and GitHub does not interpolate ${{ secrets }} inside repository files, so a
 * designated secret field carries a whole-value `$NAME` reference resolved from the step's environment at run time.
 * Every edge fails closed; nothing here logs a value, and the module knows no field names.
 *
 * a literal value                 -> rejected: committed plaintext is what the mechanism prevents
 * "prefix-$TOKEN"                 -> rejected: shipping it as a literal secret is worse than failing
 * $INPUT_*, $GITHUB_*, ...        -> refused: reserved runner variables
 * a reference in a target's file  -> refused: a target must not route the operator's environment into itself
 */

import { err, ok, type Result } from "neverthrow";

/** Who authored the source: a `target` document (fetched from the target repository) has its references refused; flows/multi.ts decides. */
export type SettingsSource = "operator" | "target";

/** A syntactically valid reference: the env var name, without the `$`. */
export interface SecretRef {
  readonly name: string;
}

const REFERENCE_RE = /^\$[A-Z_][A-Z0-9_]*$/;

const EMBEDDED_REFERENCE_RE = /\$[A-Z_][A-Z0-9_]*/;

/**
 * INPUT_* holds the action's own inputs (INPUT_TOKEN is the admin token); the rest are runner and workflow context.
 * Routing any of them into a settings value would make the settings file an exfiltration channel.
 */
export const RESERVED_REF_PREFIXES = ["INPUT_", "GITHUB_", "ACTIONS_", "RUNNER_", "NODE_"] as const;

/**
 * Reads no environment, so check mode and preflight run it without touching secrets; `label` names the owning entry
 * (a secret name, a webhook url), never a value. Errors never echo a non-reference value either: a rejected literal,
 * or the text around an embedded `$NAME`, may already be a secret.
 */
export function validateSecretRef(
  value: string,
  source: SettingsSource,
  label: string,
): Result<SecretRef, string> {
  if (REFERENCE_RE.test(value)) {
    const name = value.slice(1);
    if (source === "target") {
      return err(
        `${label} uses the secret reference ${value} in a target-fetched settings file; references are honored only in operator-owned settings sources, so a target repository cannot read the operator's environment`,
      );
    }
    const reserved = RESERVED_REF_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved !== undefined) {
      return err(
        `${label} references the reserved runner variable ${value} (${reserved}* is refused): workflow inputs and GitHub/runner context cannot be routed into settings values`,
      );
    }
    return ok({ name });
  }
  const embedded = value.match(EMBEDDED_REFERENCE_RE)?.[0];
  if (embedded !== undefined) {
    return err(
      `${label} embeds ${embedded} without being a whole-value reference; it would otherwise ship verbatim as the secret. Make the entire value a single $NAME reference`,
    );
  }
  return err(
    `${label} carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set it to a whole-value $NAME reference and define NAME in the step's env block`,
  );
}

export interface ResolvedSecretRefs {
  /** Resolved plaintext, keyed by env var name (two fields may share one). */
  values: Record<string, string>;
  /** Every distinct plaintext value, for the caller to register with masking. */
  mask: string[];
}

/** The variable a validated whole-value reference names: REFERENCE_RE admits `$NAME`, so the name follows the `$`. */
export function referenceName(reference: string): string {
  return reference.slice(1);
}

/**
 * Every reference arrives from a validated document (validateSectionShapes judged its form and its provenance), so
 * resolution is the environment lookup alone. All problems are collected: a run with three unset variables says so once.
 *
 * unset variable          -> fails
 * set but empty variable  -> fails too: an empty vault lookup must not write an empty secret
 */
export function resolveSecretRefs(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Result<ResolvedSecretRefs, string[]> {
  const errors: string[] = [];
  const resolved: Record<string, string> = {};
  const mask = new Set<string>();
  for (const name of names) {
    const plaintext = env[name];
    if (plaintext === undefined) {
      errors.push(
        `secret reference $${name} is unset: the step environment does not define ${name}. Add it to the step's env block, e.g. from a repository or organization secret`,
      );
      continue;
    }
    if (plaintext === "") {
      errors.push(
        `secret reference $${name} is set but empty; an empty value would write an empty secret, so a failed lookup cannot pass silently. Give ${name} a non-empty value`,
      );
      continue;
    }
    resolved[name] = plaintext;
    mask.add(plaintext);
  }
  if (errors.length > 0) {
    return err(errors);
  }
  return ok({ values: resolved, mask: [...mask] });
}

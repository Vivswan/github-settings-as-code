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

/** Who authored the source: a `target` document (fetched from the target repository) has its references refused; flows/multi.ts decides. */
export type SettingsSource = "operator" | "target";

/** A syntactically valid reference: the env var name, without the `$`. */
interface SecretRef {
  readonly name: string;
}

export type SecretRefCheck = { ok: true; ref: SecretRef } | { ok: false; error: string };

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
): SecretRefCheck {
  if (REFERENCE_RE.test(value)) {
    const name = value.slice(1);
    if (source === "target") {
      return {
        ok: false,
        error: `${label} uses the secret reference ${value} in a target-fetched settings file; references are honored only in operator-owned settings sources, so a target repository cannot read the operator's environment`,
      };
    }
    const reserved = RESERVED_REF_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved !== undefined) {
      return {
        ok: false,
        error: `${label} references the reserved runner variable ${value} (${reserved}* is refused): workflow inputs and GitHub/runner context cannot be routed into settings values`,
      };
    }
    return { ok: true, ref: { name } };
  }
  const embedded = value.match(EMBEDDED_REFERENCE_RE)?.[0];
  if (embedded !== undefined) {
    return {
      ok: false,
      error: `${label} embeds ${embedded} without being a whole-value reference; it would otherwise ship verbatim as the secret. Make the entire value a single $NAME reference`,
    };
  }
  return {
    ok: false,
    error: `${label} carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set it to a whole-value $NAME reference and define NAME in the step's env block`,
  };
}

export type SecretRefsResolution =
  | {
      ok: true;
      /** Resolved plaintext, keyed by env var name (two fields may share one). */
      values: Record<string, string>;
      /** Every distinct plaintext value, for the caller to register with masking. */
      mask: string[];
    }
  | { ok: false; errors: string[] };

/**
 * One secret field's value with the provenance of the DOCUMENT that declared it, decided once where the document is
 * chosen (flows/multi.ts readTargetSettings).
 */
export interface SourcedSecretValue {
  readonly value: string;
  /** The owning entry as the settings file spells it, never a value. */
  readonly label: string;
  readonly source: SettingsSource;
}

/**
 * Every value re-runs validateSecretRef with ITS OWN source, so a mixed batch cannot launder a target-declared reference
 * behind operator-declared ones. All problems are collected: a run with three broken references says so once.
 *
 * unset variable          -> fails
 * set but empty variable  -> fails too: an empty vault lookup must not write an empty secret
 */
export function resolveSecretRefs(
  values: readonly SourcedSecretValue[],
  env: Record<string, string | undefined> = process.env,
): SecretRefsResolution {
  const errors: string[] = [];
  const resolved: Record<string, string> = {};
  const mask = new Set<string>();
  for (const { value, source, label } of values) {
    const checked = validateSecretRef(value, source, label);
    if (!checked.ok) {
      errors.push(checked.error);
      continue;
    }
    const { name } = checked.ref;
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
    return { ok: false, errors };
  }
  return { ok: true, values: resolved, mask: [...mask] };
}

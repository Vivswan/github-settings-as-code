/**
 * $NAME secret references: how secret values stay out of committed settings
 * files. settings.yml is plaintext in git and GitHub does not interpolate
 * ${{ secrets }} inside repository files, so a designated secret field
 * carries a whole-value `$NAME` reference resolved from the action step's
 * environment at run time. Every edge fails closed: a literal is rejected
 * (committed plaintext is exactly what the mechanism prevents), a
 * near-reference like "prefix-$TOKEN" is rejected (shipping it as a literal
 * secret is worse than failing), reserved runner variables are refused, and
 * a reference in a target-fetched settings file is refused (a target
 * repository must not route the operator's environment into itself).
 *
 * The module knows no field names; future consumer sections call these
 * functions per designated secret field. Nothing here logs a value.
 */

/**
 * Who authored the settings source a value came from. References are honored
 * only in operator-owned sources; in a `target` source (a settings file
 * fetched from the target repository itself) a reference is a hard error.
 * Integration decides which files are which.
 */
export type SettingsSource = "operator" | "target";

/** A syntactically valid reference: the env var name, without the `$`. */
export interface SecretRef {
  readonly name: string;
}

export type SecretRefCheck = { ok: true; ref: SecretRef } | { ok: false; error: string };

/** Whole-value reference shape: `$NAME` and nothing else. */
const REFERENCE_RE = /^\$[A-Z_][A-Z0-9_]*$/;

/** A reference-looking fragment anywhere in a value that is NOT a whole-value reference. */
const EMBEDDED_REFERENCE_RE = /\$[A-Z_][A-Z0-9_]*/;

/**
 * Variable prefixes a reference may never name. INPUT_* are the action's own
 * inputs (INPUT_TOKEN is the admin token); GITHUB_*, ACTIONS_*, RUNNER_* and
 * NODE_* are runner and workflow context. Routing any of them into a settings
 * value would turn a settings file into an exfiltration channel.
 */
export const RESERVED_REF_PREFIXES = ["INPUT_", "GITHUB_", "ACTIONS_", "RUNNER_", "NODE_"] as const;

/**
 * Phase (a): syntax and policy validation for one designated secret field's
 * value. Takes no environment and reads no values, so check mode and
 * preflight can run it without touching secrets. Error strings name the rule
 * and the reference, and never echo a non-reference value: a rejected
 * literal or the text around an embedded `$NAME` may already be a secret.
 */
export function validateSecretRef(value: string, source: SettingsSource): SecretRefCheck {
  if (REFERENCE_RE.test(value)) {
    const name = value.slice(1);
    if (source === "target") {
      return {
        ok: false,
        error: `secret reference ${value} appears in a target-fetched settings file; references are honored only in operator-owned settings sources, so a target repository cannot read the operator's environment`,
      };
    }
    const reserved = RESERVED_REF_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (reserved !== undefined) {
      return {
        ok: false,
        error: `secret reference ${value} names a reserved runner variable (${reserved}* is refused): workflow inputs and GitHub/runner context cannot be routed into settings values`,
      };
    }
    return { ok: true, ref: { name } };
  }
  const embedded = value.match(EMBEDDED_REFERENCE_RE)?.[0];
  if (embedded !== undefined) {
    return {
      ok: false,
      error: `a secret field value embeds ${embedded} without being a whole-value reference; it would otherwise ship verbatim as the secret. Make the entire value a single $NAME reference`,
    };
  }
  return {
    ok: false,
    error:
      "a secret field carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set the field to a whole-value $NAME reference and define NAME in the step's env block",
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
 * One designated secret field's value, tagged with the provenance of the
 * DOCUMENT that declared it. The tag must be attached when each source
 * document is read - before any defaults merge folds documents together,
 * because after a merge a value's origin is gone and no batch-level source
 * can be correct: operator defaults merged under a target's settings would
 * either authorize the target's references or reject the operator's.
 */
export interface SourcedSecretValue {
  readonly value: string;
  readonly source: SettingsSource;
}

/**
 * Phase (b): resolve every reference up front from the given environment,
 * before any of them is used. Each value re-runs the full phase (a)
 * validation with ITS OWN source, so a mixed batch cannot launder a
 * target-declared reference behind operator-declared ones. All problems are
 * collected, not just the
 * first: a run with three broken references should say so once. An UNSET
 * variable and a SET-BUT-EMPTY variable both fail - an empty vault lookup
 * must not write an empty secret. Callers pass `process.env` at the edge and
 * an injected record in tests.
 */
export function resolveSecretRefs(
  values: readonly SourcedSecretValue[],
  env: Record<string, string | undefined> = process.env,
): SecretRefsResolution {
  const errors: string[] = [];
  const resolved: Record<string, string> = {};
  const mask = new Set<string>();
  for (const { value, source } of values) {
    const checked = validateSecretRef(value, source);
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

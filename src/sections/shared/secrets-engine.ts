/**
 * The shared secrets engine: existence reconciliation (values never read
 * back; every declared secret re-sealed on each apply) over route-free scopes
 * the section builds. planSecrets() plans, reconcileSecrets() is the run() form.
 */

import sodium from "libsodium-wrappers";
import { z } from "zod";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import {
  type DeclaredSecretValue,
  type SectionContext,
  type SectionMeta,
  type SectionRun,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { ExecTools, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";

/** One declared secret entry, as every family's settings shape spells it. */
export interface SecretEntry {
  name: string;
  value: string;
}

/** One live secret's identity, parsed by the scope's list against LIVE_SECRET_NAMES. */
interface LiveSecretName {
  name: string;
}

/** The list-body schema every family's list closure parses with. */
export const LIVE_SECRET_NAMES = z.array(z.looseObject({ name: z.string() }));

/** The sealed PUT body; an alias (not an interface) so it is JSON-plain to the plan contract. */
export type SealedSecretPayload = {
  encrypted_value: string;
  key_id: string;
};

/** The erased planned-op view; the scopes are generic over the section's exact arms. */
type AnyPlannedOp = SectionPlan["ops"][number];

/**
 * The run() contract's four operations, as closures built where the routes
 * are literal (so their params typecheck); a nested scope closes over its
 * extra path params here.
 */
export interface SecretsScopeOps {
  /** The parsed {name} identities of the enveloped secrets list, all pages. */
  list(ctx: SectionContext, section: SectionMeta): Promise<LiveSecretName[]>;
  /** GET the {key_id, key} sealing key for this scope. */
  publicKey(ctx: SectionContext, section: SectionMeta, describe: string): Promise<unknown>;
  /** PUT one sealed value: 201 created a new secret, 204 updated an existing one. */
  put(
    ctx: SectionContext,
    section: SectionMeta,
    secretName: string,
    payload: SealedSecretPayload,
    describe: string,
  ): Promise<unknown>;
  /** DELETE one secret by name: 204. */
  remove(
    ctx: SectionContext,
    section: SectionMeta,
    secretName: string,
    describe: string,
  ): Promise<unknown>;
}

/** How a scope names itself in output; shared by both contracts' scopes. */
interface SecretsScopeProse {
  /** The drift-line prefix, e.g. "actions_secrets" or "environments[prod].secrets". */
  label: string;
  /** The noun for notes ("Actions secret"; a nested scope says "prod environment secret"). */
  noun: string;
  /** Where a secret lives in note and drift prose; "the repo" unless a nested scope says otherwise. */
  home?: string;
  /** Appended to change lines and describes (` in environment "prod"`); "" for the repo families. */
  changeSuffix?: string;
}

/** One secret scope under the run() contract: a family's operations plus its prose. */
export interface SecretsScope extends SecretsScopeProse {
  ops: SecretsScopeOps;
}

/**
 * One planned sealed PUT's facets, for the section to place under its put
 * role. The payload thunk resolves and seals only when executed, so the plan
 * carries the `$NAME` reference and nothing derived from a value.
 */
interface SealedSecretWrite {
  /** The secret's uppercase name - the write path's {secret_name}. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  /** Seals the resolved plaintext against the scope's sealing key at execution time. */
  readonly payload: (exec: ExecTools) => SealedSecretPayload;
  /** The missing-secret line, or empty when the name exists (the PUT recurs by declaration). */
  readonly drift: readonly string[];
  readonly change: string;
}

/** The facets of one planned DELETE of an undeclared live secret. */
interface UndeclaredSecretDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  readonly drift: readonly [string];
  readonly change: string;
}

/**
 * The plan contract's scope: reads over the section's typed port, and
 * builders placing each write under the section's own role. `Put`/`Remove`
 * are its exact PlannedOp arms, so a wrong role or params fails to compile.
 */
export interface SecretsPlanScope<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>
  extends SecretsScopeProse {
  /** The parsed {name} identities of the enveloped secrets list, all pages. */
  readonly list: () => Promise<LiveSecretName[]>;
  /** GET the {key_id, key} sealing key for this scope. */
  readonly publicKey: (describe: string) => Promise<unknown>;
  /** The planned sealed PUT; function-valued so a builder demanding an unsupplied facet fails. */
  readonly put: (write: SealedSecretWrite) => Put;
  /** The planned DELETE of one undeclared live secret. */
  readonly remove: (deletion: UndeclaredSecretDeletion) => Remove;
}

/** The matching key for a secret name: GitHub stores and compares uppercase. */
export function secretKey(name: string): string {
  return name.toUpperCase();
}

/**
 * The declared `value` of every entry in one {name, value} secret list -
 * plain-array or wrapped form - for the engine's up-front reference
 * resolution (SectionModule.secretValues), each labelled with its entry's
 * secret NAME so a validation error can point at the offending entry.
 * DEFENSIVE by contract: a
 * malformed container returns [] instead of throwing, so the actionable
 * error always comes from shape validation, never a TypeError from here.
 */
export function listSecretValues(declared: unknown): DeclaredSecretValue[] {
  const container = declared as SecretEntry[] | UndeclaredPolicyList<SecretEntry>;
  const isWrapper =
    typeof container === "object" &&
    container !== null &&
    !Array.isArray(container) &&
    Array.isArray((container as UndeclaredPolicyList<SecretEntry>).entries);
  if (!Array.isArray(container) && !isWrapper) {
    return [];
  }
  // The default policy is irrelevant here: only the entries are read.
  const { entries } = undeclaredPolicy(container, "keep");
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || typeof entry.value !== "string") {
      return [];
    }
    const label =
      typeof entry.name === "string"
        ? `the secret entry "${entry.name}"`
        : "an unnamed secret entry";
    return [{ label, value: entry.value }];
  });
}

/**
 * Reject two declared entries that resolve to the same uppercase secret name
 * upfront; GitHub would fold them into one secret and the last write would
 * silently win on every run.
 */
export function rejectDuplicateSecretNames(
  section: SectionMeta,
  entries: readonly SecretEntry[],
): void {
  rejectDuplicates(
    section,
    entries,
    (entry) => secretKey(entry.name),
    (entry) => entry.name,
  );
}

/** A libsodium sealed box over an X25519 public key, base64 for the PUT body. */
function sealedBox(plaintext: string, publicKey: Uint8Array): string {
  return sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(plaintext), publicKey),
    sodium.base64_variants.ORIGINAL,
  );
}

/** Seal a resolved plaintext against a base64 key: the raw primitive, for the mock's crypto tests. */
export async function sealSecretValue(plaintext: string, publicKeyB64: string): Promise<string> {
  await sodium.ready;
  return sealedBox(plaintext, sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL));
}

/** A parsed sealing key; `seal` is synchronous because parseSealingKey awaited sodium.ready. */
export interface SealingKey {
  readonly keyId: string;
  /** Seal one ALREADY-RESOLVED plaintext into the {encrypted_value, key_id} PUT body. */
  seal(plaintext: string): SealedSecretPayload;
}

/**
 * Parse a public-key response down to its X25519 key material, so a
 * malformed key fails here with the endpoint named rather than as a bare
 * libsodium error inside a seal.
 */
export async function parseSealingKey(
  section: SectionMeta,
  scope: Pick<SecretsScopeProse, "label">,
  data: unknown,
): Promise<SealingKey> {
  await sodium.ready;
  const advice = `Check the "api-version" input against the GitHub REST docs for this endpoint`;
  const body = (data ?? {}) as { key_id?: unknown; key?: unknown };
  const keyId = body.key_id;
  const publicKey = body.key;
  if (
    typeof keyId !== "string" ||
    keyId === "" ||
    typeof publicKey !== "string" ||
    publicKey === ""
  ) {
    // Name the exact defect (which field, absent vs wrong type vs empty),
    // like the base64 and byte-length rejections below.
    const fieldDefect = (label: string, value: unknown): string | null =>
      value === undefined
        ? `${label} is missing`
        : typeof value !== "string"
          ? `${label} is not a string`
          : value === ""
            ? `${label} is empty`
            : null;
    const defect = fieldDefect("key_id", keyId) ?? fieldDefect("key", publicKey);
    throw new Error(
      `${section.key}: the ${scope.label} public-key endpoint returned no usable {key_id, key} pair (${defect}), so no value can be sealed. ${advice}`,
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error(
      `${section.key}: the ${scope.label} public key is not valid base64, so no value can be sealed. ${advice}`,
    );
  }
  if (keyBytes.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error(
      `${section.key}: the ${scope.label} public key decodes to ${keyBytes.length} bytes where an X25519 public key has ${sodium.crypto_box_PUBLICKEYBYTES}, so no value can be sealed. ${advice}`,
    );
  }
  return {
    keyId,
    seal: (plaintext) => ({ encrypted_value: sealedBox(plaintext, keyBytes), key_id: keyId }),
  };
}

/** The check-mode line for a declared secret the listing does not carry. */
function missingSecretDrift(scope: SecretsScopeProse, name: string): string {
  return `${scope.label}[${name}]: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}

/** ONE note per scope (the LFS precedent): values are unverifiable by design. */
function cannotVerifyNote(scope: SecretsScopeProse): string {
  return `${scope.noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`;
}

/** The keep-note for a live secret the settings file does not declare. */
function undeclaredSecretNote(scope: SecretsScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.home ?? "the repo"} but is not declared`,
    action: "DELETE it (a deleted secret's value is unrecoverable)",
  });
}

/** The deletion drift for a live secret the settings file does not declare. */
function undeclaredSecretDrift(
  scope: SecretsScopeProse,
  defaultPolicy: UndeclaredPolicy,
  liveName: string,
): string {
  return undeclaredDrift(defaultPolicy, {
    label: `${scope.label}[${liveName}]`,
    action: "DELETE it (the value is unrecoverable)",
  });
}

/** Uppercase key -> the name as listed (normalizing keeps a differently-cased mock harmless). */
function liveSecretsByKey(live: readonly LiveSecretName[]): Map<string, string> {
  const liveByKey = new Map<string, string>();
  for (const item of live) {
    liveByKey.set(secretKey(item.name), item.name);
  }
  return liveByKey;
}

/**
 * Plan one scope: a sealed PUT per declared secret (drift only when missing),
 * one cannot-verify note, and a keep-note or planned DELETE per undeclared
 * live one. The key is read here and closed over; values resolve in thunks.
 */
export async function planSecrets<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>(
  section: SectionMeta,
  scope: SecretsPlanScope<Put, Remove>,
  opts: {
    entries: readonly SecretEntry[];
    policy: UndeclaredPolicy;
    /**
     * The DEFAULT the caller unwrapped `policy` against (the section's
     * undeclaredDefault, or environments' fixed nested default), from which
     * undeclaredDrift derives its explicit-knob clause.
     */
    defaultPolicy: UndeclaredPolicy;
  },
): Promise<SectionPlan<Put | Remove>> {
  const { entries, policy, defaultPolicy } = opts;
  const suffix = scope.changeSuffix ?? "";
  const plan: SectionPlan<Put | Remove> = { ops: [], notes: [], drift: [] };

  const liveByKey = liveSecretsByKey(await scope.list());
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));

  if (entries.length > 0) {
    const sealingKey = await parseSealingKey(
      section,
      scope,
      await scope.publicKey(`reading the ${scope.label} sealing key`),
    );
    for (const entry of entries) {
      const name = secretKey(entry.name);
      // The listing decides the verb; the executor does not surface the PUT's 201/204.
      const exists = liveByKey.has(name);
      plan.ops.push(
        scope.put({
          name,
          describe: `writing secret "${name}"${suffix}`,
          payload: (exec) => sealingKey.seal(exec.resolveSecret(entry.value)),
          drift: exists ? [] : [missingSecretDrift(scope, name)],
          change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
        }),
      );
    }
    plan.notes.push(cannotVerifyNote(scope));
  }

  for (const [key, liveName] of liveByKey) {
    if (declaredKeys.has(key)) {
      continue;
    }
    if (policy === "keep") {
      plan.notes.push(undeclaredSecretNote(scope, liveName));
    } else {
      plan.ops.push(
        scope.remove({
          name: liveName,
          describe: `deleting undeclared secret "${liveName}"${suffix}`,
          drift: [undeclaredSecretDrift(scope, defaultPolicy, liveName)],
          change: `DELETED undeclared secret "${liveName}"${suffix}`,
        }),
      );
    }
  }
  return plan;
}

/**
 * The run() form of planSecrets, executed in place onto `run.result` (the
 * nested family consumes it): check reports existence drift and notes, apply
 * resolves every value up front, then seals and PUTs, then purges per policy.
 */
export async function reconcileSecrets(
  run: SectionRun,
  section: SectionMeta,
  scope: SecretsScope,
  opts: {
    entries: readonly SecretEntry[];
    policy: UndeclaredPolicy;
    /**
     * The DEFAULT the caller unwrapped `policy` against (the section's
     * undeclaredDefault, or environments' fixed nested default), from which
     * undeclaredDrift derives its explicit-knob clause.
     */
    defaultPolicy: UndeclaredPolicy;
  },
): Promise<void> {
  const { entries, policy, defaultPolicy } = opts;
  const suffix = scope.changeSuffix ?? "";

  // Apply resolves EVERY declared value up front, before any request of this
  // scope: a resolution failure - an engine sequencing BUG - must leave the
  // scope with zero writes. Each plaintext travels WITH its entry, so no
  // name-keyed lookup exists to miss.
  const resolvedEntries =
    !run.check && entries.length > 0
      ? entries.map((entry) => ({ entry, plaintext: run.ctx.resolveSecret(entry.value) }))
      : [];

  const liveByKey = liveSecretsByKey(await scope.ops.list(run.ctx, section));
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));

  if (run.check) {
    for (const entry of entries) {
      if (!liveByKey.has(secretKey(entry.name))) {
        run.result.drift.push(missingSecretDrift(scope, secretKey(entry.name)));
      }
    }
    if (entries.length > 0) {
      run.result.notes.push(cannotVerifyNote(scope));
    }
  } else if (resolvedEntries.length > 0) {
    const sealingKey = await parseSealingKey(
      section,
      scope,
      await scope.ops.publicKey(run.ctx, section, `reading the ${scope.label} sealing key`),
    );
    for (const { entry, plaintext } of resolvedEntries) {
      const name = secretKey(entry.name);
      await scope.ops.put(
        run.ctx,
        section,
        name,
        sealingKey.seal(plaintext),
        `writing secret "${name}"${suffix}`,
      );
      // Existence from the listing decides the verb; the PUT's own 201/204
      // says the same thing but call() deliberately does not surface statuses.
      run.result.changes.push(
        liveByKey.has(name)
          ? `updated secret "${name}"${suffix}`
          : `created secret "${name}"${suffix}`,
      );
    }
  }

  for (const [key, liveName] of liveByKey) {
    if (declaredKeys.has(key)) {
      continue;
    }
    if (policy === "keep") {
      run.result.notes.push(undeclaredSecretNote(scope, liveName));
    } else if (run.check) {
      run.result.drift.push(undeclaredSecretDrift(scope, defaultPolicy, liveName));
    } else {
      await scope.ops.remove(
        run.ctx,
        section,
        liveName,
        `deleting undeclared secret "${liveName}"${suffix}`,
      );
      run.result.changes.push(`DELETED undeclared secret "${liveName}"${suffix}`);
    }
  }
}

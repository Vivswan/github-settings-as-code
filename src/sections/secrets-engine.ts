/**
 * The shared secrets engine: existence-based reconciliation plus client-side
 * sealing for GitHub's five repo-scoped secret families - repository Actions,
 * Dependabot, Codespaces, and Copilot agents secrets, plus per-environment
 * Actions secrets.
 * Each family exposes the same four operations - an enveloped list, a public
 * key, a sealed PUT, a DELETE - differing only in route, so a consuming
 * section keeps its own EndpointDecls (which also drive the mock routes and
 * USED_PATHS) and hands the engine a SecretsScope carrying four TYPED
 * operation closures built against those literal routes. The closures are
 * where the per-route params contract typechecks; the engine itself never
 * sees a route. A nested family (environment secrets) builds ONE scope PER
 * ENVIRONMENT, its closures closing over the environment name.
 *
 * The semantics the engine encodes, shared by every family:
 * - GitHub never returns a secret's value, only names and timestamps. Check
 *   mode therefore reconciles EXISTENCE: a declared-but-missing secret is
 *   drift, and the declared values get one cannot-verify note (the Git LFS
 *   precedent). No resolved value - or anything derived from one, length
 *   included - ever appears in a drift, note, or change line.
 * - Apply re-seals and re-writes every declared secret on every run, so a
 *   rotated source value propagates without any diff. The sealed-write path
 *   resolves each entry's `$NAME` reference through the run's apply-arm
 *   resolver, which SectionRun carries by construction; the engine
 *   resolved and masked every reference before any section ran (see
 *   engine/secrets.ts).
 * - Sealing is a libsodium sealed box against the scope's public key; the
 *   PUT body is {encrypted_value, key_id}. `encrypted_value` is a named
 *   secret field, so the request-side redaction in github/api.ts masks it in
 *   traces and withholds error bodies wholesale.
 * - Secret names are case-insensitive and stored uppercase by GitHub, so
 *   names are uppercased for matching, for the write paths, and in output.
 */

import sodium from "libsodium-wrappers";
import { z } from "zod";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../schema.js";
import {
  type DeclaredSecretValue,
  rejectDuplicates,
  type SectionContext,
  type SectionMeta,
  type SectionRun,
  undeclaredPolicy,
} from "./contract.js";

/** One declared secret entry, as every family's settings shape spells it. */
export interface SecretEntry {
  name: string;
  value: string;
}

/**
 * The identity of one live secret as a family's list endpoint reports it.
 * Each section's list closure parses its enveloped body against
 * LIVE_SECRET_NAMES (parseLive on its own EndpointDecl - the engine
 * deliberately never sees a route), so the engine receives proven names
 * instead of coercing unknowns.
 */
interface LiveSecretName {
  name: string;
}

/** The list-body schema every family's list closure parses with. */
export const LIVE_SECRET_NAMES = z.array(z.looseObject({ name: z.string() }));

/** The {encrypted_value, key_id} body every family's sealed PUT takes. */
export interface SealedSecretPayload {
  encrypted_value: string;
  key_id: string;
}

/**
 * The four operations every secret family exposes, as closures the consuming
 * section builds against its own literal EndpointDecls (so params are
 * compile-checked where the routes are known). A nested scope (environment
 * secrets) closes over its extra path params here.
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

/** One secret scope: a family's operations plus how to name it in output. */
export interface SecretsScope {
  /** The drift-line prefix, e.g. "actions_secrets" or "environments[prod].secrets". */
  label: string;
  /**
   * The noun for notes, e.g. "Actions secret". A per-environment scope
   * carries the environment name here ("prod environment secret") so its
   * one cannot-verify note and every keep-note name their environment.
   */
  noun: string;
  /**
   * Where an undeclared or missing secret lives, for note and drift prose;
   * defaults to "the repo" (the repository-level families). A nested scope
   * says "the environment".
   */
  home?: string;
  /**
   * Appended to change lines and write describes to place the write, e.g.
   * ` in environment "prod"` (the environment variables wording precedent);
   * defaults to "" for the repository-level families.
   */
  changeSuffix?: string;
  ops: SecretsScopeOps;
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

/**
 * libsodium's WASM init, awaited once before the first seal (never once per
 * seal: the promise is the module's own cached `ready`, so every later await
 * resolves synchronously).
 */
function readySodium(): Promise<void> {
  return sodium.ready;
}

/**
 * Seal one ALREADY-RESOLVED plaintext for a scope: a libsodium sealed box
 * (crypto_box_seal) against the base64 public key, returned base64-encoded
 * for the {encrypted_value, key_id} PUT body.
 */
export async function sealSecretValue(plaintext: string, publicKeyB64: string): Promise<string> {
  await readySodium();
  const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/**
 * The {key_id, key} pair a scope's public-key endpoint must answer with,
 * checked down to the key material: base64 that decodes to exactly an
 * X25519 public key. A malformed key fails here with the endpoint named,
 * not later as a bare libsodium error from inside the seal loop. Callers
 * await readySodium() first (the base64 decode and the length constant are
 * libsodium's own).
 */
function parsePublicKey(
  section: SectionMeta,
  scope: SecretsScope,
  data: unknown,
): { keyId: string; key: string } {
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
  return { keyId, key: publicKey };
}

/**
 * Reconcile one secret scope into the caller's run. Existence is the only
 * comparable state (values cannot be read back), so:
 * - check: a declared-but-missing name is drift; declared values earn ONE
 *   cannot-verify note; an undeclared live secret is a keep-note or (under
 *   the delete policy) deletion drift. Nothing here reads a value.
 * - apply: seal and PUT every declared secret (201 create / 204 update both
 *   land as normal outcomes; created-vs-updated is decided by the listing),
 *   then handle undeclared ones per the policy. Every entry's plaintext is
 *   resolved through the run's apply-arm resolver (which exists by
 *   construction) UP FRONT, before this scope's
 *   first request, so a resolution failure writes nothing. The ENGINE
 *   validated every reference for syntax and provenance in both modes and,
 *   in apply mode, resolved and masked every plaintext before any section
 *   ran. Resolution is inherently keyed to THIS call's entries, so one
 *   scope can never seal another scope's same-named secret.
 * Lines land directly on `run.result` - the caller's own accumulator - so a
 * nested scope (environment secrets) needs no result merging, and this
 * engine can never pair a check context with an apply result.
 */
export async function reconcileSecrets(
  run: SectionRun,
  section: SectionMeta,
  scope: SecretsScope,
  opts: {
    entries: readonly SecretEntry[];
    policy: UndeclaredPolicy;
  },
): Promise<void> {
  const { entries, policy } = opts;
  const home = scope.home ?? "the repo";
  const suffix = scope.changeSuffix ?? "";

  // Apply resolves EVERY declared value up front, before any request of this
  // scope: a resolution failure - an engine sequencing BUG - must leave the
  // scope with zero writes. Each plaintext travels WITH its entry, so no
  // name-keyed lookup exists to miss.
  const resolvedEntries =
    !run.check && entries.length > 0
      ? entries.map((entry) => ({ entry, plaintext: run.ctx.resolveSecret(entry.value) }))
      : [];

  const live = await scope.ops.list(run.ctx, section);
  // Uppercase key -> the name as the API listed it (already uppercase on real
  // GitHub; normalizing keeps a differently-cased mock or proxy harmless).
  const liveByKey = new Map<string, string>();
  for (const item of live) {
    liveByKey.set(secretKey(item.name), item.name);
  }
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));

  if (run.check) {
    for (const entry of entries) {
      if (!liveByKey.has(secretKey(entry.name))) {
        run.result.drift.push(
          `${scope.label}[${secretKey(entry.name)}]: missing - declared in the settings file but not on ${home}; apply will create it`,
        );
      }
    }
    if (entries.length > 0) {
      // ONE note for the whole section (the LFS precedent): the value side is
      // unverifiable by design, and saying it per entry would be noise.
      run.result.notes.push(
        `${scope.noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`,
      );
    }
  } else if (resolvedEntries.length > 0) {
    // One WASM init up front: parsePublicKey and every seal below use
    // libsodium synchronously.
    await readySodium();
    const keyData = await scope.ops.publicKey(
      run.ctx,
      section,
      `reading the ${scope.label} sealing key`,
    );
    const { keyId, key } = parsePublicKey(section, scope, keyData);
    for (const { entry, plaintext } of resolvedEntries) {
      const name = secretKey(entry.name);
      const encryptedValue = await sealSecretValue(plaintext, key);
      await scope.ops.put(
        run.ctx,
        section,
        name,
        { encrypted_value: encryptedValue, key_id: keyId },
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
      run.result.notes.push(
        `${scope.noun} "${liveName}" exists on ${home} but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it (a deleted secret's value is unrecoverable)`,
      );
    } else if (run.check) {
      run.result.drift.push(
        `${scope.label}[${liveName}]: undeclared - not in the settings file, so apply will DELETE it (the value is unrecoverable); add it to the settings file to keep it`,
      );
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

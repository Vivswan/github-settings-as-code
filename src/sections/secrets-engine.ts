/**
 * The shared secrets engine: existence-based reconciliation plus client-side
 * sealing for GitHub's four repo-scoped secret families (Actions today;
 * environment, Dependabot, and Codespaces secrets are built to slot in). Each
 * family exposes the same four operations - an enveloped list, a public key,
 * a sealed PUT, a DELETE - differing only in route, so a consuming section
 * keeps its own EndpointDecls (which also drive the mock routes and
 * USED_PATHS) and hands the engine a SecretsScope carrying four TYPED
 * operation closures built against those literal routes. The closures are
 * where the per-route params contract typechecks; the engine itself never
 * sees a route.
 *
 * The semantics the engine encodes, shared by every family:
 * - GitHub never returns a secret's value, only names and timestamps. Check
 *   mode therefore reconciles EXISTENCE: a declared-but-missing secret is
 *   drift, and the declared values get one cannot-verify note (the Git LFS
 *   precedent). No resolved value - or anything derived from one, length
 *   included - ever appears in a drift, note, or change line.
 * - Apply re-seals and re-writes every declared secret on every run, so a
 *   rotated source value propagates without any diff. The sealed-write path
 *   takes ALREADY-RESOLVED plaintext through a lookup parameter; the engine
 *   resolved and masked every `$NAME` reference before any section ran (see
 *   engine/secrets.ts), and prepareSecretValues below adapts
 *   ctx.resolveSecret into that per-entry lookup.
 * - Sealing is a libsodium sealed box against the scope's public key; the
 *   PUT body is {encrypted_value, key_id}. `encrypted_value` is a named
 *   secret field, so the request-side redaction in github/api.ts masks it in
 *   traces and withholds error bodies wholesale.
 * - Secret names are case-insensitive and stored uppercase by GitHub, so
 *   names are uppercased for matching, for the write paths, and in output.
 */

import sodium from "libsodium-wrappers";
import type { UndeclaredPolicy } from "../schema.js";
import {
  emptyResult,
  rejectDuplicates,
  type SectionContext,
  type SectionMeta,
  type SectionResult,
} from "./contract.js";

/** One declared secret entry, as every family's settings shape spells it. */
export interface SecretEntry {
  name: string;
  value: string;
}

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
  /** GET the enveloped {total_count, secrets: [{name, ...}]} list, all pages. */
  list(ctx: SectionContext, section: SectionMeta): Promise<unknown[]>;
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
  /** The drift-line prefix, e.g. "actions_secrets" (later families: a nested label). */
  label: string;
  /** The noun for notes, e.g. "Actions secret". */
  noun: string;
  ops: SecretsScopeOps;
}

/** The matching key for a secret name: GitHub stores and compares uppercase. */
export function secretKey(name: string): string {
  return name.toUpperCase();
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
 * Adapt the engine's up-front resolution into the per-entry-name lookup the
 * sealed-write path takes. The ENGINE (engine/secrets.ts) already validated
 * every reference for syntax and provenance in both modes and, in apply
 * mode, resolved and masked every plaintext before any section ran - so
 * this is a pure adapter: check mode and an empty declaration return
 * undefined (nothing to seal - and a document declaring no references gets
 * no resolver from the engine, so an empty inventory must not demand one).
 * A missing resolver when entries ARE declared is an engine sequencing bug
 * and throws loudly.
 */
export function prepareSecretValues(
  ctx: SectionContext,
  section: SectionMeta,
  entries: readonly SecretEntry[],
): ((entryName: string) => string) | undefined {
  if (ctx.check || entries.length === 0) {
    return undefined;
  }
  const resolve = ctx.resolveSecret;
  if (resolve === undefined) {
    throw new Error(
      `BUG: applying ${section.key} reached a sealed write with no secret resolver on the context; the engine must resolve secret references before any section runs`,
    );
  }
  const plaintextByEntry = new Map(
    entries.map((entry) => [secretKey(entry.name), resolve(entry.value)]),
  );
  return (entryName) => {
    const plaintext = plaintextByEntry.get(secretKey(entryName));
    if (plaintext === undefined) {
      throw new Error(`BUG: no resolved value for secret "${secretKey(entryName)}"`);
    }
    return plaintext;
  };
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
  if (
    typeof body.key_id !== "string" ||
    body.key_id === "" ||
    typeof body.key !== "string" ||
    body.key === ""
  ) {
    throw new Error(
      `${section.key}: the ${scope.label} public-key endpoint returned no usable {key_id, key} pair, so no value can be sealed. ${advice}`,
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = sodium.from_base64(body.key, sodium.base64_variants.ORIGINAL);
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
  return { keyId: body.key_id, key: body.key };
}

/**
 * Reconcile one secret scope. Existence is the only comparable state (values
 * cannot be read back), so:
 * - check: a declared-but-missing name is drift; declared values earn ONE
 *   cannot-verify note; an undeclared live secret is a keep-note or (under
 *   the delete policy) deletion drift. Nothing here reads a value.
 * - apply: seal and PUT every declared secret (201 create / 204 update both
 *   land as normal outcomes; created-vs-updated is decided by the listing),
 *   then handle undeclared ones per the policy. `resolvedValueOf` supplies
 *   the already-resolved plaintext per declared entry name and is required
 *   exactly when entries are declared.
 */
export async function reconcileSecrets(
  ctx: SectionContext,
  section: SectionMeta,
  scope: SecretsScope,
  opts: {
    entries: readonly SecretEntry[];
    policy: UndeclaredPolicy;
    resolvedValueOf?: (entryName: string) => string;
  },
): Promise<SectionResult> {
  const result = emptyResult();
  const { entries, policy } = opts;

  const live = (await scope.ops.list(ctx, section)) as Array<{ name?: unknown }>;
  // Uppercase key -> the name as the API listed it (already uppercase on real
  // GitHub; normalizing keeps a differently-cased mock or proxy harmless).
  const liveByKey = new Map<string, string>();
  for (const item of live) {
    const name = String(item?.name ?? "");
    liveByKey.set(secretKey(name), name);
  }
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));

  if (ctx.check) {
    for (const entry of entries) {
      if (!liveByKey.has(secretKey(entry.name))) {
        result.drift.push(
          `${scope.label}[${secretKey(entry.name)}]: missing - declared in the settings file but not on the repo; apply will create it`,
        );
      }
    }
    if (entries.length > 0) {
      // ONE note for the whole section (the LFS precedent): the value side is
      // unverifiable by design, and saying it per entry would be noise.
      result.notes.push(
        `${scope.noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`,
      );
    }
  } else if (entries.length > 0) {
    const resolvedValueOf = opts.resolvedValueOf;
    if (resolvedValueOf === undefined) {
      throw new Error(
        `BUG: applying ${section.key} requires resolved secret values, but none were supplied`,
      );
    }
    // One WASM init up front: parsePublicKey and every seal below use
    // libsodium synchronously.
    await readySodium();
    const keyData = await scope.ops.publicKey(
      ctx,
      section,
      `reading the ${scope.label} sealing key`,
    );
    const { keyId, key } = parsePublicKey(section, scope, keyData);
    for (const entry of entries) {
      const name = secretKey(entry.name);
      const encryptedValue = await sealSecretValue(resolvedValueOf(entry.name), key);
      await scope.ops.put(
        ctx,
        section,
        name,
        { encrypted_value: encryptedValue, key_id: keyId },
        `writing secret "${name}"`,
      );
      // Existence from the listing decides the verb; the PUT's own 201/204
      // says the same thing but call() deliberately does not surface statuses.
      result.changes.push(
        liveByKey.has(name) ? `updated secret "${name}"` : `created secret "${name}"`,
      );
    }
  }

  for (const [key, liveName] of liveByKey) {
    if (declaredKeys.has(key)) {
      continue;
    }
    if (policy === "keep") {
      result.notes.push(
        `${scope.noun} "${liveName}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it (a deleted secret's value is unrecoverable)`,
      );
    } else if (ctx.check) {
      result.drift.push(
        `${scope.label}[${liveName}]: undeclared - not in the settings file, so apply will DELETE it (the value is unrecoverable); add it to the settings file to keep it`,
      );
    } else {
      await scope.ops.remove(ctx, section, liveName, `deleting undeclared secret "${liveName}"`);
      result.changes.push(`DELETED undeclared secret "${liveName}"`);
    }
  }
  return result;
}

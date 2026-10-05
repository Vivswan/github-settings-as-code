/**
 * Existence reconciliation over route-free scopes: values are never read back, and every declared secret
 * is re-sealed on each apply. The four repo families (./repo-secrets.ts) and the environments section's
 * nested secrets (../environments/nested.ts) plan through it; the frame is ./named-scope.ts.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { UndeclaredPolicyList } from "../../types.js";
import { type EndpointDecl, endpointPath } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import {
  cannotVerifyNote,
  type DeclaredSecretValue,
  type SectionMeta,
  secretValuesOf,
} from "../contract/module.js";
import { type ExecTools, paramsWith, type SectionPlan } from "../contract/plan.js";
import {
  type AnyPlannedOp,
  missingNamedDrift,
  type NamedPlanOpts,
  type NamedScope,
  planNamed,
  type ScopeProse,
  type UndeclaredWords,
  undeclaredRemoval,
  upperKey,
} from "./named-scope.js";
import { decodeBase64, SEALED_BOX_PUBLIC_KEY_BYTES, sealForGithub } from "./sealed-box.js";

export interface SecretEntry {
  name: string;
  value: string;
}

/** One live secret's identity, the item schema every family's list reads with. */
export const LiveSecretName = z.looseObject({ name: z.string() });
export type LiveSecretName = z.infer<typeof LiveSecretName>;

/** The sealed PUT body; an alias (not an interface) so it is JSON-plain to the plan contract. */
export type SealedSecretPayload = {
  encrypted_value: string;
  key_id: string;
};

/**
 * The payload thunk resolves and seals only when executed, so the plan carries the `$NAME` reference and
 * nothing derived from a value.
 */
interface SealedSecretWrite {
  /** The secret's uppercase name - the write path's {secret_name}. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  /** Reads the scope's sealing key (once per plan) and seals the resolved plaintext, at execution time. */
  readonly payload: (exec: ExecTools) => Promise<Result<SealedSecretPayload, SectionFailure>>;
  /** The missing-secret line, or empty when the name exists (the PUT recurs by declaration). */
  readonly drift: readonly string[];
  readonly change: string;
}

/** `Put`/`Remove` are the section's exact PlannedOp arms, so a wrong role or params fails to compile. */
export interface SecretsPlanScope<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>
  extends NamedScope<LiveSecretName, Remove> {
  /**
   * GET the {key_id, key} sealing key for this scope, at EXECUTION time: an environment's key exists
   * only once the PUT that creates the environment has landed, so the read rides the first PUT's thunk.
   */
  readonly publicKey: (
    exec: ExecTools,
    describe: string,
  ) => PromiseLike<Result<unknown, SectionFailure>>;
  /** The declaration behind `publicKey`, named in the prose of a key the endpoint cannot supply. */
  readonly publicKeyEndpoint: EndpointDecl;
  /** The planned sealed PUT; function-valued so a builder demanding an unsupplied facet fails. */
  readonly put: (write: SealedSecretWrite) => Put;
}

/** The scope's two mappers under its role names; `params` is what its routes take beyond the `{secret_name}` token. */
export function secretOps<
  Put extends string,
  Remove extends string,
  Params extends Readonly<Record<string, string>> | undefined,
>(roles: { put: Put; remove: Remove }, params: Params) {
  return {
    put: ({ name, ...write }: SealedSecretWrite) => ({
      role: roles.put,
      params: paramsWith(params, "secret_name", name),
      ...write,
    }),
    remove: undeclaredRemoval(roles.remove, params, "secret_name"),
  };
}

/** Each value is labelled with its entry's secret NAME so a validation error can point at it. */
export function listSecretValues(
  declared: SecretEntry[] | UndeclaredPolicyList<SecretEntry>,
): DeclaredSecretValue[] {
  return secretValuesOf(declared, (entry) => [
    { label: `the secret entry "${entry.name}"`, value: entry.value },
  ]);
}

export interface SealingKey {
  readonly keyId: string;
  /** Seal one ALREADY-RESOLVED plaintext into the {encrypted_value, key_id} PUT body. */
  seal(plaintext: string): SealedSecretPayload;
}

/**
 * A malformed key fails here with the endpoint and scope named, rather than as a bare primitive error
 * inside a seal.
 */
export function parseSealingKey(
  section: SectionMeta,
  scope: Pick<ScopeProse, "label">,
  endpoint: EndpointDecl,
  data: unknown,
): Result<SealingKey, SectionFailure> {
  const advice = `Check the "api-version" input against the GitHub REST docs for this endpoint`;
  const where = `${section.key}: GET ${endpointPath(endpoint.route)} (the ${scope.label} sealing key)`;
  const unusable = (reason: string): Result<never, SectionFailure> =>
    err(
      sectionFailure(
        "live-shape",
        `${where} returned ${reason}, so no value can be sealed. ${advice}`,
      ),
    );
  const body = (data ?? {}) as { key_id?: unknown; key?: unknown };
  const keyId = body.key_id;
  const publicKey = body.key;
  if (
    typeof keyId !== "string" ||
    keyId === "" ||
    typeof publicKey !== "string" ||
    publicKey === ""
  ) {
    const fieldDefect = (label: string, value: unknown): string | null =>
      value === undefined
        ? `${label} is missing`
        : typeof value !== "string"
          ? `${label} is not a string`
          : value === ""
            ? `${label} is empty`
            : null;
    const defect = fieldDefect("key_id", keyId) ?? fieldDefect("key", publicKey);
    return unusable(`no usable {key_id, key} pair (${defect})`);
  }
  const decoded = decodeBase64(publicKey);
  if (decoded.isErr()) {
    return unusable("a key that is not valid base64");
  }
  const keyBytes = decoded.value;
  if (keyBytes.length !== SEALED_BOX_PUBLIC_KEY_BYTES) {
    return unusable(
      `a key that decodes to ${keyBytes.length} bytes where an X25519 public key has ${SEALED_BOX_PUBLIC_KEY_BYTES}`,
    );
  }
  // Right-sized bytes can still be an unusable point; one probe seal is the exact test.
  try {
    sealForGithub(keyBytes, "");
  } catch {
    return unusable("a key that is not a usable X25519 public key");
  }
  return ok({
    keyId,
    seal: (plaintext) => ({ encrypted_value: sealForGithub(keyBytes, plaintext), key_id: keyId }),
  });
}

/** ONE note per scope (the LFS precedent): values are unverifiable by design. */
function valuesUnverifiableNote(scope: ScopeProse): string {
  return cannotVerifyNote(scope.label, {
    why: `${scope.noun} values cannot be read back from GitHub`,
    what: "them, only that each declared secret exists",
    reasserts: "re-seals and rewrites every declared value",
  });
}

/** A deleted secret's value is unrecoverable, so both the keep-note and the drift line say so. */
const UNDECLARED_SECRET_WORDS: UndeclaredWords = {
  what: "secret",
  noteAction: "DELETE it (a deleted secret's value is unrecoverable)",
  driftAction: "DELETE it (the value is unrecoverable)",
};

export function planSecrets<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>(
  section: SectionMeta,
  scope: SecretsPlanScope<Put, Remove>,
  opts: NamedPlanOpts<SecretEntry>,
): Promise<Result<SectionPlan<Put | Remove>, SectionFailure>> {
  const suffix = scope.suffix ?? "";

  // Read once per scope, by the first payload thunk that runs; the token it demands is the one the thunk received.
  let sealingKey: Promise<Result<SealingKey, SectionFailure>> | undefined;
  const readSealingKey = (exec: ExecTools): Promise<Result<SealingKey, SectionFailure>> => {
    sealingKey ??= Promise.resolve(
      scope.publicKey(exec, `reading the ${scope.label} sealing key`),
    ).then((body) =>
      body.andThen((data) => parseSealingKey(section, scope, scope.publicKeyEndpoint, data)),
    );
    return sealingKey;
  };
  return planNamed(section, scope, opts, UNDECLARED_SECRET_WORDS, (liveOf) => {
    const ops: Put[] = [];
    for (const entry of opts.entries) {
      const name = upperKey(entry.name);
      // The listing decides the verb; the executor does not surface the PUT's 201/204.
      const exists = liveOf(entry) !== undefined;
      ops.push(
        scope.put({
          name,
          describe: `writing secret "${name}"${suffix}`,
          payload: async (exec) => {
            const plaintext = exec.resolveSecret(entry.value);
            return (await readSealingKey(exec)).map((key) => key.seal(plaintext));
          },
          drift: exists ? [] : [missingNamedDrift(scope, name)],
          change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
        }),
      );
    }
    return { ops, notes: opts.entries.length > 0 ? [valuesUnverifiableNote(scope)] : [] };
  });
}

/** Existence reconciliation over route-free scopes: values are never read back, and every declared secret is re-sealed on each apply. */

import { z } from "zod";
import type { UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import { type EndpointDecl, endpointPath } from "../contract/endpoints.js";
import {
  type DeclaredSecretValue,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { ExecTools, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { decodeBase64, SEALED_BOX_PUBLIC_KEY_BYTES, sealForGithub } from "./sealed-box.js";

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

type AnyPlannedOp = SectionPlan["ops"][number];

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

/** The payload thunk resolves and seals only when executed, so the plan carries the `$NAME` reference and nothing derived from a value. */
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

interface UndeclaredSecretDeletion {
  /** The live name as the API listed it. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  readonly drift: readonly [string];
  readonly change: string;
}

/** `Put`/`Remove` are the section's exact PlannedOp arms, so a wrong role or params fails to compile. */
export interface SecretsPlanScope<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>
  extends SecretsScopeProse {
  /** The parsed {name} identities of the enveloped secrets list, all pages. */
  readonly list: () => Promise<LiveSecretName[]>;
  /** GET the {key_id, key} sealing key for this scope. */
  readonly publicKey: (describe: string) => Promise<unknown>;
  /** The declaration behind `publicKey`, named in the prose of a key the endpoint cannot supply. */
  readonly publicKeyEndpoint: EndpointDecl;
  /** The planned sealed PUT; function-valued so a builder demanding an unsupplied facet fails. */
  readonly put: (write: SealedSecretWrite) => Put;
  readonly remove: (deletion: UndeclaredSecretDeletion) => Remove;
}

/** The matching key for a secret name: GitHub stores and compares uppercase. */
export function secretKey(name: string): string {
  return name.toUpperCase();
}

/**
 * Each value is labelled with its entry's secret NAME so a validation error can point at it. DEFENSIVE by
 * contract: a malformed container returns [] instead of throwing, so the actionable error always comes
 * from shape validation, never a TypeError here.
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
  // "keep" is a placeholder: only the entries are read.
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

/** GitHub folds two names equal uppercased into one secret, so the last write would silently win on every run. */
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

export interface SealingKey {
  readonly keyId: string;
  /** Seal one ALREADY-RESOLVED plaintext into the {encrypted_value, key_id} PUT body. */
  seal(plaintext: string): SealedSecretPayload;
}

/** A malformed key fails here with the endpoint and scope named, rather than as a bare primitive error inside a seal. */
export function parseSealingKey(
  section: SectionMeta,
  scope: Pick<SecretsScopeProse, "label">,
  endpoint: EndpointDecl,
  data: unknown,
): SealingKey {
  const advice = `Check the "api-version" input against the GitHub REST docs for this endpoint`;
  const where = `${section.key}: GET ${endpointPath(endpoint.route)} (the ${scope.label} sealing key)`;
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
    throw new Error(
      `${where} returned no usable {key_id, key} pair (${defect}), so no value can be sealed. ${advice}`,
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase64(publicKey);
  } catch {
    throw new Error(
      `${where} returned a key that is not valid base64, so no value can be sealed. ${advice}`,
    );
  }
  if (keyBytes.length !== SEALED_BOX_PUBLIC_KEY_BYTES) {
    throw new Error(
      `${where} returned a key that decodes to ${keyBytes.length} bytes where an X25519 public key has ${SEALED_BOX_PUBLIC_KEY_BYTES}, so no value can be sealed. ${advice}`,
    );
  }
  // Right-sized bytes can still be an unusable point; one probe seal is the exact test.
  try {
    sealForGithub(keyBytes, "");
  } catch {
    throw new Error(
      `${where} returned a key that is not a usable X25519 public key, so no value can be sealed. ${advice}`,
    );
  }
  return {
    keyId,
    seal: (plaintext) => ({ encrypted_value: sealForGithub(keyBytes, plaintext), key_id: keyId }),
  };
}

function missingSecretDrift(scope: SecretsScopeProse, name: string): string {
  return `${scope.label}[${name}]: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}

/** ONE note per scope (the LFS precedent): values are unverifiable by design. */
function cannotVerifyNote(scope: SecretsScopeProse): string {
  return `${scope.noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`;
}

function undeclaredSecretNote(scope: SecretsScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.home ?? "the repo"} but is not declared`,
    action: "DELETE it (a deleted secret's value is unrecoverable)",
  });
}

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

export async function planSecrets<Put extends AnyPlannedOp, Remove extends AnyPlannedOp>(
  section: SectionMeta,
  scope: SecretsPlanScope<Put, Remove>,
  opts: {
    entries: readonly SecretEntry[];
    policy: UndeclaredPolicy;
    /**
     * The DEFAULT `policy` was unwrapped against (the section's undeclaredDefault, or environments'
     * fixed nested default); undeclaredDrift derives its knob clause from it.
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
    const sealingKey = parseSealingKey(
      section,
      scope,
      scope.publicKeyEndpoint,
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

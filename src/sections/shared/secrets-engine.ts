/**
 * Existence reconciliation over route-free scopes: values are never read back, and every declared secret
 * is re-sealed on each apply. The four repo families (./repo-secrets.ts) and the environments section's
 * nested secrets (../environments/nested.ts) plan through it.
 */

import { z } from "zod";
import type { UndeclaredPolicy } from "../../types.js";
import { type EndpointDecl, endpointPath } from "../contract/endpoints.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  cannotVerifyNote,
  type DeclaredSecretValue,
  missingDrift,
  type SectionMeta,
  secretValuesOf,
  undeclaredDrift,
  undeclaredNote,
} from "../contract/module.js";
import type { ExecTools, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
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

type AnyPlannedOp = SectionPlan["ops"][number];

/** The words a scope supplies; a nested scope names its home so the lines say where the secret lives. */
export interface SecretsScopeProse {
  /** The drift-line prefix, e.g. "actions_secrets" or "environments[prod].secrets". */
  label: string;
  /** The noun for notes ("Actions secret"; a nested scope says "prod environment secret"). */
  noun: string;
  /** Where the secrets live when "the repo" understates it ("the environment"). */
  where?: string;
  /** Appended to change and describe lines (` in environment "prod"`). */
  suffix?: string;
  /** What two declared entries under one name are reported as naming, when `<section> entry` understates it (`secret of the "prod" environment`). */
  what?: string;
}

/** The payload thunk resolves and seals only when executed, so the plan carries the `$NAME` reference and nothing derived from a value. */
interface SealedSecretWrite {
  /** The secret's uppercase name - the write path's {secret_name}. */
  readonly name: string;
  /** What the write is doing, in settings-file terms, for its error prose. */
  readonly describe: string;
  /** Reads the scope's sealing key (once per plan) and seals the resolved plaintext, at execution time. */
  readonly payload: (exec: ExecTools) => Promise<SealedSecretPayload>;
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
  /**
   * GET the {key_id, key} sealing key for this scope, at EXECUTION time: an environment's key exists
   * only once the PUT that creates the environment has landed, so the read rides the first PUT's thunk.
   */
  readonly publicKey: (exec: ExecTools, describe: string) => Promise<unknown>;
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

/** Each value is labelled with its entry's secret NAME so a validation error can point at it. */
export function listSecretValues(declared: unknown): DeclaredSecretValue[] {
  return secretValuesOf(declared, (entry) => {
    if (typeof entry.value !== "string") {
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
 * GitHub folds two names equal uppercased into one secret, so the last write would silently win on
 * every run. planSecrets runs it before its read, so no scope can skip it; `what` names the resource
 * when "<section> entry" understates it (a nested scope's).
 */
export function rejectDuplicateSecretNames(
  section: SectionMeta,
  entries: readonly SecretEntry[],
  what?: string,
): void {
  rejectDuplicates(
    section,
    entries,
    (entry) => secretKey(entry.name),
    (entry) => entry.name,
    what,
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

/** ONE note per scope (the LFS precedent): values are unverifiable by design. */
function valuesUnverifiableNote(scope: SecretsScopeProse): string {
  return cannotVerifyNote(scope.label, {
    why: `${scope.noun} values cannot be read back from GitHub`,
    what: "them, only that each declared secret exists",
    reasserts: "re-seals and rewrites every declared value",
  });
}

function undeclaredSecretNote(scope: SecretsScopeProse, liveName: string): string {
  return undeclaredNote({
    subject: `${scope.noun} "${liveName}"`,
    state: `exists on ${scope.where ?? "the repo"} but is not declared`,
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

/**
 * Uppercase key -> the name as listed (normalizing keeps a differently-cased mock harmless), under the
 * duplicate-live guard: plan() and every snapshot over a secrets list index through it, so none can
 * read a pair GitHub folds into one secret as two.
 */
export function liveSecretsByKey(
  section: SectionMeta,
  noun: string,
  live: readonly LiveSecretName[],
): Map<string, string> {
  const byKey = liveByIdentity(
    section,
    noun,
    live,
    (item) => secretKey(item.name),
    (item) => liveIdentity(item.name),
  );
  return new Map([...byKey].map(([key, item]) => [key, item.name]));
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
  const suffix = scope.suffix ?? "";
  const plan: SectionPlan<Put | Remove> = { ops: [], notes: [], drift: [] };

  rejectDuplicateSecretNames(section, entries, scope.what);
  const liveByKey = liveSecretsByKey(section, scope.noun, await scope.list());
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));

  // Read once per scope, by the first payload thunk that runs; the token it demands is the one the thunk received.
  let sealingKey: Promise<SealingKey> | undefined;
  const readSealingKey = (exec: ExecTools): Promise<SealingKey> => {
    sealingKey ??= scope
      .publicKey(exec, `reading the ${scope.label} sealing key`)
      .then((body) => parseSealingKey(section, scope, scope.publicKeyEndpoint, body));
    return sealingKey;
  };
  for (const entry of entries) {
    const name = secretKey(entry.name);
    // The listing decides the verb; the executor does not surface the PUT's 201/204.
    const exists = liveByKey.has(name);
    plan.ops.push(
      scope.put({
        name,
        describe: `writing secret "${name}"${suffix}`,
        payload: async (exec) => {
          const plaintext = exec.resolveSecret(entry.value);
          return (await readSealingKey(exec)).seal(plaintext);
        },
        drift: exists
          ? []
          : [missingDrift(`${scope.label}[${name}]`, { where: `on ${scope.where ?? "the repo"}` })],
        change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
      }),
    );
  }
  if (entries.length > 0) {
    plan.notes.push(valuesUnverifiableNote(scope));
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

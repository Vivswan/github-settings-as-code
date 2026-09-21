/**
 * `deploy_keys:` section: deploy keys matched by exact title; the declared material is a PUBLIC key.
 * Immutable upstream (no update role), so a changed key or read_only flag is delete plus recreate.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { exactName, listSection } from "../shared/list-section.js";
import {
  DeployKeyConfig,
  declaresAlgorithm,
  PUBLIC_KEY_ALGORITHMS,
  parsePublicKey,
  parseStoredKey,
} from "./schema.js";

/**
 * A live deploy key with its material parsed ONCE, at the response boundary: the two-field shape is the
 * documented contract, the algorithm is GitHub's call. Material off that shape fails the read as a body
 * outside the documented shape, so no hook downstream re-parses or re-checks it.
 */
const LiveDeployKey = z
  .looseObject({
    id: z.number(),
    title: z.string(),
    key: z.string(),
    read_only: z.boolean(),
  })
  .transform((live, refineCtx) => {
    const parsed = parseStoredKey(live.key);
    if (!parsed.ok) {
      refineCtx.addIssue({
        code: "custom",
        path: ["key"],
        message: `key id ${String(live.id)} ("${live.title}") holds material that is not "<algorithm> <base64>": ${parsed.reason}`,
      });
      return z.NEVER;
    }
    return { ...live, key: parsed.material, algorithm: parsed.algorithm };
  });

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/keys",
    statuses: { 200: "the deploy key list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/keys",
    statuses: { 201: "deploy key created" },
    hints: {
      422: "A public key can be attached to only ONE repository account-wide, so a 422 here can mean the key is already in use elsewhere; generate a distinct keypair per repository",
    },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/keys/{key_id}",
    statuses: { 204: "deploy key deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

function declaredMaterial(title: string, key: string): string {
  const parsed = parsePublicKey(key);
  if (!parsed.ok) {
    throw new Error(`deploy_keys[${title}]: ${parsed.reason}`);
  }
  return parsed.material;
}

export const deployKeysSection = listSection({
  key: "deploy_keys",
  permission: { repo: ["administration"] },
  undeclaredDefault: "keep",
  noun: "deploy key",
  entry: DeployKeyConfig,
  live: LiveDeployKey,
  endpoints: ENDPOINTS,
  // Exact titles: GitHub documents no case folding, so two titles differing in case are two keys.
  identity: { field: "title", fold: exactName },
  address: (live) => ({ key_id: String(live.id) }),
  lens: {
    toWrite: ({ title, key, read_only, ...passthrough }) => ({
      title,
      key: declaredMaterial(title, key),
      ...(read_only === undefined ? {} : { read_only }),
      ...passthrough,
    }),
    // The algorithm is the section's own reading of the material, not a field GitHub echoes, so it stays out of the compare.
    fromLive: ({ algorithm: _algorithm, ...live }) => live,
    matchBy: {},
  },
  replaces: false,
  // GitHub accepted the key, and the settings file has no form for its algorithm, so the section neither
  // matches, deletes, nor snapshots it; the note says why it is missing from the snapshot.
  foreign: (live) =>
    declaresAlgorithm(live.algorithm)
      ? null
      : {
          name: live.title,
          reason:
            `its algorithm "${live.algorithm}" is not one the settings file can declare ` +
            `(${PUBLIC_KEY_ALGORITHMS.join(", ")}), so the section leaves the key as GitHub holds it`,
        },
  /**
   * GitHub creates a key READ/WRITE when the body omits read_only, and this file does not manage an
   * undeclared flag, so the flag reaches a create body only from a source that holds it:
   *
   *   declared              -> the declared value, on a create and a recreate alike (the write is spread last)
   *   undeclared, create    -> omitted: GitHub's default, never compared afterwards
   *   undeclared, recreate  -> the LIVE flag re-sent, so rotating a read-only key never widens its access
   */
  recreate: (live, write) => ({ read_only: live.read_only, ...write }),
  // GitHub attaches a public key to one repository once, so a second key with the same material is
  // rejected at create time; both collisions are named upfront instead of failing mid-apply.
  conflicts: {
    declared: (writes) => {
      const titleByMaterial = new Map<string, string>();
      return writes.flatMap((write) => {
        const first = titleByMaterial.get(String(write.key));
        titleByMaterial.set(String(write.key), write.title);
        return first === undefined
          ? []
          : [
              `the entries "${first}" and "${write.title}" declare the same key material, and GitHub attaches a public key to one repository once, so the second create would be rejected - keep one entry per key`,
            ];
      });
    },
    live: (writes, live) =>
      writes.flatMap((write) => {
        const holder = live.find((key) => key.title !== write.title && key.key === write.key);
        return holder === undefined
          ? []
          : [
              `the entry "${write.title}" declares key material that live key ` +
                `"${holder.title}" (id ${String(holder.id)}) already holds, and GitHub ` +
                `attaches a public key to one repository once, so writing it would be rejected ` +
                `- delete or rename the live key on GitHub, or declare the entry under its ` +
                `live title "${holder.title}"`,
            ];
      }),
  },
  prose: { undeclaredAction: "DELETE it" },
});

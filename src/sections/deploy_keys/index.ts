/**
 * `deploy_keys:` section - repository deploy keys, matched by title. The
 * declared material is a PUBLIC key, safe in a committed settings file. Deploy
 * keys are immutable upstream (no update endpoint exists), so a changed key or
 * read_only flag is applied as delete plus recreate, the autolinks pattern.
 * Undeclared keys are KEPT by default: deleting a live deploy key breaks
 * whatever service authenticates with it, and deployment tooling installs its
 * own keys; the wrapped `undeclared: delete` form opts into deletion.
 *
 * GitHub may strip or rewrite the free-text comment that trails the key
 * material on storage, so both sides compare only the algorithm and base64
 * blob (normalizeKeyMaterial) - comparing the raw string would read the
 * stripped comment as drift and delete-and-recreate the key on every apply.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { type DeployKeyConfig, SettingsFile } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  listAll,
  loosen,
  parseLive,
  rejectDuplicates,
  type SectionMeta,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";

/** The fields of a live deploy key this section reads; extras ride along. */
const LiveDeployKey = z.looseObject({
  id: z.number(),
  title: z.string(),
  key: z.string(),
  read_only: z.boolean().optional(),
});
type LiveDeployKey = z.infer<typeof LiveDeployKey>;

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/keys", statuses: { 200: "the deploy key list" } },
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

/**
 * The comparable form of deploy key material: the algorithm and base64 blob
 * (the first two whitespace-separated fields), without the trailing comment -
 * GitHub may strip or rewrite the comment on storage, so including it would
 * make every apply read the stored key as drift. Returns null when the value
 * has fewer than two fields; callers turn that into their own loud error
 * (declared material is a settings-file mistake, live material a contract
 * violation) instead of comparing garbage.
 */
export function normalizeKeyMaterial(key: string): string | null {
  const fields = key.trim().split(/\s+/);
  const algorithm = fields[0];
  const blob = fields[1];
  if (algorithm === undefined || blob === undefined) {
    return null;
  }
  return `${algorithm} ${blob}`;
}

/** The declared key's comparable material, or a loud settings-file error. */
function declaredMaterial(entry: DeployKeyConfig): string {
  const normalized = normalizeKeyMaterial(entry.key);
  if (normalized === null) {
    throw new Error(
      `deploy_keys[${entry.title}]: the declared key must have at least two whitespace-separated fields (an algorithm and a base64 blob, e.g. "ssh-ed25519 AAAAC3..."), got ${JSON.stringify(entry.key)}`,
    );
  }
  return normalized;
}

/**
 * Parse the live deploy keys LOUDLY (parseLive on id/title/key), never a
 * silent skip - a skipped live key would read as absent and be
 * recreated (or escape the undeclared policy) forever. The normalized
 * material rides in a side map keyed by id, NOT on the returned objects:
 * subsetDiff and phantomKeys must see the RAW api body, so a declared
 * passthrough field named "material" diffs against what GitHub actually
 * returns instead of a synthetic field. Material stays a runtime check on
 * top of the shape parse: two whitespace-separated fields is a semantic
 * fact about the key STRING, not its type.
 */
function extractLive(
  section: SectionMeta,
  raw: unknown,
): { live: LiveDeployKey[]; materialById: Map<number, string> } {
  const live = parseLive(section, ENDPOINTS.list, z.array(LiveDeployKey), raw);
  const materialById = new Map<number, string>();
  for (const entry of live) {
    const material = normalizeKeyMaterial(entry.key);
    if (material === null) {
      throw new Error(
        `deploy_keys: GET /repos/{owner}/{repo}/keys returned key id ${entry.id} ("${entry.title}") whose material has fewer than two whitespace-separated fields (${JSON.stringify(entry.key)}); the response does not match the documented deploy key shape - check the "api-version" input against the GitHub REST docs for this endpoint`,
      );
    }
    materialById.set(entry.id, material);
  }
  return { live, materialById };
}

export const deployKeysSection = {
  key: "deploy_keys",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.deploy_keys),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // Titles are matched EXACTLY: GitHub does not document any case folding
    // for deploy key titles, so two titles differing in case are two keys.
    rejectDuplicates(
      this,
      desired,
      (entry) => entry.title,
      (entry) => entry.title,
    );
    // Validate every declared key's material BEFORE any read or write (the
    // .map is eager), so a malformed entry can never leave earlier entries
    // already applied. Each declared entry travels with its parsed material
    // from here on.
    const parsed = desired.map((entry) => ({ entry, material: declaredMaterial(entry) }));
    // Two entries with the same MATERIAL under different titles would fight
    // upstream, not here: GitHub attaches a public key to one repository
    // once, so the second POST answers 422 mid-section with the repo
    // half-applied. Rejected upfront, keyed on the normalized material.
    rejectDuplicates(
      this,
      parsed,
      (p) => p.material,
      (p) => p.entry.title,
    );
    const { live, materialById } = extractLive(this, await listAll(ctx, this, ENDPOINTS.list));

    // Ambiguity and upstream key conflicts are rejected BEFORE any write
    // (the webhooks precedent): a hard error mid-loop would leave earlier
    // declared keys already written. Every conflict is collected before the
    // one throw - each fix is manual GitHub cleanup, so N conflicts must
    // cost one run to discover, not N.
    const conflicts: string[] = [];
    for (const { entry, material } of parsed) {
      const matches = live.filter((candidate) => candidate.title === entry.title);
      if (matches.length > 1) {
        // GitHub does not enforce title uniqueness, and replacing one of N
        // same-titled keys is a guess either way.
        conflicts.push(
          `the declared title "${entry.title}" matches ${matches.length} live deploy keys (ids ${matches
            .map((candidate) => candidate.id)
            .join(
              ", ",
            )}), and this section manages at most one key per title - delete the duplicates on GitHub so exactly one remains`,
        );
      }
      // A live key holding the declared material under ANOTHER title would
      // 422 the create ("key is already in use") only after earlier entries
      // were written - and no undeclared policy can save it: keep never
      // deletes the holder, and delete runs after the creates. The 422's
      // hint would also send the user hunting in other repositories when
      // the conflict is right here, so name the holder instead.
      const holder = live.find(
        (candidate) =>
          candidate.title !== entry.title && materialById.get(candidate.id) === material,
      );
      if (holder) {
        conflicts.push(
          `the entry "${entry.title}" declares key material that live key "${holder.title}" (id ${holder.id}) already holds, and GitHub attaches a public key to one repository once, so writing it would be rejected - delete or rename the live key on GitHub, or declare the entry under its live title "${holder.title}"`,
        );
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `deploy_keys: ${conflicts.length} declared entr${conflicts.length === 1 ? "y conflicts" : "ies conflict"} with live keys: ${conflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`,
      );
    }

    const declaredKeys = new Set(desired.map((entry) => entry.title));
    for (const { entry, material } of parsed) {
      const existing = live.find((candidate) => candidate.title === entry.title);
      const { title: _title, key: _key, read_only, ...extraKeys } = entry;
      if (!existing) {
        if (run.check) {
          run.result.drift.push(
            `deploy_keys[${entry.title}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
          continue;
        }
        await call(ctx, this, ENDPOINTS.create, {
          payload: { ...entry }, // the declared entry (future fields included) passes through
          describe: `creating deploy key "${entry.title}"`,
        });
        run.result.changes.push(`created deploy key "${entry.title}"`);
        continue;
      }

      const keyDrift = materialById.get(existing.id) !== material;
      // read_only is compared only when DECLARED; GitHub defaults it to false
      // on create, and an undeclared toggle is not managed by this file.
      const readOnlyDrift = read_only !== undefined && (existing.read_only ?? false) !== read_only;
      const extraDrift = subsetDiff(extraKeys, existing, `deploy_keys[${entry.title}]`);
      if (!keyDrift && !readOnlyDrift && extraDrift.length === 0) {
        continue;
      }
      if (run.check) {
        run.result.drift.push(
          `deploy_keys[${entry.title}]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it`,
        );
        // Name the differing fields; the generic line alone leaves the reader
        // guessing which field (or typo) forces the replace.
        if (keyDrift) {
          run.result.drift.push(
            `deploy_keys[${entry.title}].key: declared material ${JSON.stringify(material)} != live ${JSON.stringify(materialById.get(existing.id))} (compared as algorithm + blob, comments ignored)`,
          );
        }
        if (readOnlyDrift) {
          run.result.drift.push(
            `deploy_keys[${entry.title}].read_only: declared ${JSON.stringify(read_only)} != live ${JSON.stringify(existing.read_only ?? false)}`,
          );
        }
        run.result.drift.push(...extraDrift);
        continue;
      }
      const phantom = phantomKeys(extraKeys, existing);
      if (phantom.length > 0) {
        run.result.notes.push(
          phantomNote(
            `deploy_keys[${entry.title}]`,
            phantom,
            "deploy key",
            "this delete-and-recreate will repeat",
          ),
        );
      }
      // Deploy keys have no update endpoint; replace. The recreate seeds the
      // LIVE read_only first: an undeclared toggle is not managed by this
      // file, and without the seed a rotated read-only key would come back
      // with GitHub's read/write default - a privilege widening nothing in
      // the settings file asked for. A declared value still wins via the
      // spread.
      await call(ctx, this, ENDPOINTS.remove, {
        params: { key_id: String(existing.id) },
        describe: `deleting deploy key "${entry.title}" before recreating it`,
      });
      await call(ctx, this, ENDPOINTS.create, {
        payload: { read_only: existing.read_only ?? false, ...entry },
        describe: `recreating deploy key "${entry.title}"`,
      });
      run.result.changes.push(`replaced deploy key "${entry.title}"`);
    }

    // Undeclared keys are kept by default: a live deploy key authenticates a
    // service somewhere, and deployment tooling installs its own keys.
    for (const key of live) {
      if (declaredKeys.has(key.title)) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          `deploy key "${key.title}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
        );
      } else if (run.check) {
        run.result.drift.push(
          `deploy_keys[${key.title}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, {
          params: { key_id: String(key.id) },
          describe: `deleting undeclared deploy key "${key.title}"`,
        });
        run.result.changes.push(`DELETED undeclared deploy key "${key.title}"`);
      }
    }
    return run.result;
  },
} satisfies SectionModule<"deploy_keys">;

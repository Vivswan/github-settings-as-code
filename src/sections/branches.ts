/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely. required_signatures is the one toggle the PUT does
 * not accept (GitHub silently drops it), so it is stripped from the payload
 * and applied through its own POST/DELETE sub-endpoint after the PUT.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { BranchConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  expand,
  probeAbsent,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  getProtection: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "the branch protection", 404: "the branch is unprotected or does not exist" },
  },
  putProtection: {
    route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "protection replaced" },
    hints: {
      422: 'Usually a sub-object is missing a required half: "required_status_checks" needs both "strict" and "contexts", "required_pull_request_reviews" values must fit their documented shapes, and "restrictions" needs "users" and "teams" lists (or declare the whole key as null)',
    },
  },
  removeProtection: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 204: "protection removed" },
  },
  // required_signatures lives on its own sub-resource (the protection PUT
  // silently drops the key), so the declared boolean is applied through
  // these two calls right after a successful PUT.
  sigPost: {
    route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 200: "signed commits now required" },
  },
  sigDelete: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 204: "signed-commit requirement removed" },
  },
  // Advisory branch-existence probe: called directly via tryRequest (not
  // through the enforced helpers), declared here so the dictionary is
  // complete for downstream mock-route and USED_PATHS derivation. It is
  // Contents-gated in reality, but that requirement stays OUT of the
  // section's grant prose because the probe is optional (a token without
  // Contents just skips the advisory branch-does-not-exist wording).
  branchProbe: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch exists", 404: "no such branch" },
    permission: { repo: ["contents"] },
    advisory: true,
  },
} as const satisfies Record<string, EndpointDecl>;

export const branchesSection: SectionModule<"branches"> = {
  key: "branches",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  // protection stays a passthrough record except its one routed key: the
  // signature toggle is typed so a YAML-quoted "true" fails upfront in
  // document validation, before any section writes (the 1A/1C precedent).
  shape: z.array(
    z.looseObject({
      name: z.string(),
      protection: z
        .looseObject({
          required_signatures: z
            .boolean({
              error:
                'required_signatures must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous',
            })
            .optional(),
        })
        .nullable(),
    }),
  ),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as BranchConfig[];
    // Protection is keyed by exact branch name; two entries for the same
    // branch would overwrite each other's PUT on every run.
    rejectDuplicates(
      this,
      desired,
      (b) => b.name,
      (b) => b.name,
    );
    for (const branch of desired) {
      if (branch.protection === null) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getProtection, {
          params: { branch: branch.name },
        });
        if ("missing" in probe) {
          continue;
        }
        if (ctx.check) {
          result.drift.push(
            `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.removeProtection, { params: { branch: branch.name } });
          result.changes.push(`removed protection from "${branch.name}"`);
        }
        continue;
      }
      // The classic API rejects payloads missing the core keys; fill nulls.
      const payload: Record<string, unknown> = { ...branch.protection };
      // GitHub's protection PUT silently DROPS required_signatures, so it
      // must never ride the payload; the sub-endpoint calls after the PUT
      // apply the declared toggle instead.
      const requiredSignatures = payload.required_signatures as boolean | undefined;
      delete payload.required_signatures;
      for (const key of REQUIRED_PROTECTION_KEYS) {
        if (!(key in payload)) {
          payload[key] = null;
        }
      }
      if (ctx.check) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getProtection, {
          params: { branch: branch.name },
        });
        if ("missing" in probe) {
          // Protection 404s for a missing BRANCH too. The branch probe is
          // advisory: only a definitive 404 flips the message (other errors,
          // e.g. a token without Contents read, fall back to the plain
          // unprotected reading rather than misreporting or failing).
          const branchProbe = await ctx.api.tryRequest(
            "GET",
            expand(ENDPOINTS.branchProbe, ctx, { branch: branch.name }),
          );
          if ("error" in branchProbe && branchProbe.error.status === 404) {
            result.drift.push(
              `branches[${branch.name}]: declared in the settings file but the branch does not exist on the repo, so apply cannot protect it; create the branch, or remove it from the settings file`,
            );
          } else {
            result.drift.push(
              `branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`,
            );
          }
        } else {
          // GET shapes booleans as {enabled: bool}; compare declared keys
          // against a flattened view.
          const live = flattenProtection(probe.data as Record<string, unknown>);
          // The protection GET OMITS required_signatures entirely when
          // signed commits are not required, so an absent live field means
          // false; normalize before the diff so declared false does not
          // read as drift.
          if (!("required_signatures" in live)) {
            live.required_signatures = false;
          }
          result.drift.push(
            ...subsetDiff(branch.protection, live, `branches[${branch.name}].protection`),
          );
          // Apply null-fills the four required keys, REMOVING live settings
          // the declaration omits - surface that as drift, not silence.
          for (const key of REQUIRED_PROTECTION_KEYS) {
            if (!(key in branch.protection) && live[key] != null && live[key] !== false) {
              result.drift.push(
                `branches[${branch.name}].protection.${key}: set live but omitted from the settings file, so apply would REMOVE it; add ${key} to the branch's protection in the settings file to keep it`,
              );
            }
          }
        }
      } else {
        await call(ctx, this, ENDPOINTS.putProtection, {
          params: { branch: branch.name },
          payload,
          describe: `replacing protection for branch "${branch.name}"`,
        });
        // The declared toggle is applied once the PUT has ensured the
        // protection (and with it the sub-resource) exists; an undeclared
        // toggle leaves the live requirement alone.
        if (requiredSignatures === true) {
          await call(ctx, this, ENDPOINTS.sigPost, {
            params: { branch: branch.name },
            describe: `requiring signed commits on branch "${branch.name}"`,
          });
        } else if (requiredSignatures === false) {
          await call(ctx, this, ENDPOINTS.sigDelete, {
            params: { branch: branch.name },
            describe: `removing the signed-commit requirement from branch "${branch.name}"`,
          });
        }
        result.changes.push(`applied protection to "${branch.name}"`);
      }
    }
    return result;
  },
};

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists
 * (restrictions, dismissal_restrictions, bypass_pull_request_allowances)
 * into user/team/app OBJECTS, while the PUT shape uses login/slug strings.
 * Unwrap both so check mode compares like with like. Exported so the e2e
 * state tests assert their protectionFromPut transformer inverts this exact
 * function (not a lookalike copy).
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    out[key] = flattenValue(value);
  }
  return out;
}

const ACTOR_NAME_KEYS = ["login", "slug"] as const;
const ACTOR_LIST_KEYS = new Set(["users", "teams", "apps"]);

function flattenValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    "enabled" in record &&
    typeof record.enabled === "boolean" &&
    keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))
  ) {
    return record.enabled;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((actor) => {
        if (typeof actor === "object" && actor !== null) {
          for (const nameKey of ACTOR_NAME_KEYS) {
            const name = (actor as Record<string, unknown>)[nameKey];
            if (typeof name === "string") {
              return name;
            }
          }
        }
        return actor;
      });
    } else if (key.endsWith("_url") || key === "url") {
      // URLs never appear in the PUT shape; drop to avoid noise.
    } else {
      out[key] = flattenValue(inner);
    }
  }
  return out;
}

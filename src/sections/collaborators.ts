/**
 * `collaborators:` section - direct collaborators keyed by username.
 * Undeclared collaborators are REMOVED (the owner never is).
 */

import { z } from "zod";
import type { CollaboratorConfig, MustBeNever } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  listAll,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";
import { DEFAULT_ROLE, roleForPermission } from "./roles.js";

interface LiveCollaborator {
  login: string;
  permissions?: Record<string, boolean>;
  role_name?: string;
}

const permission: SectionPermission = { repo: ["administration"] };

const KNOWN_KEYS = ["username", "permission"] as const;
/** Compile-time lockstep: a CollaboratorConfig field missing from KNOWN_KEYS fails here. */
type _AllKeysKnown = MustBeNever<Exclude<keyof CollaboratorConfig, (typeof KNOWN_KEYS)[number]>>;

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/collaborators",
    statuses: { 200: "the direct-collaborator list" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/collaborators/{username}",
    statuses: { 201: "invitation created", 204: "collaborator already had the access" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/collaborators/{username}",
    statuses: { 204: "collaborator removed" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const collaboratorsSection: SectionModule<"collaborators"> = {
  key: "collaborators",
  deletesUndeclared: "deletes",
  permission,
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(z.looseObject({ username: z.string() })),
  // Closed surface: the PUT accepts exactly one setting ("permission"), so
  // an extra key is always a typo - and a misspelled "permission" would
  // silently grant the default role and report clean forever.
  closedSurface: {
    known: KNOWN_KEYS,
    describe: (c) => c.username,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as CollaboratorConfig[];
    rejectDuplicates(
      this,
      desired,
      (c) => c.username.toLowerCase(),
      (c) => c.username,
    );
    const live = (await listAll(ctx, this, ENDPOINTS.list, {
      query: { affiliation: "direct" },
    })) as LiveCollaborator[];
    const liveByLogin = new Map(live.map((c) => [c.login.toLowerCase(), c]));
    const declared = new Set<string>();

    for (const collaborator of desired) {
      const login = collaborator.username.toLowerCase();
      declared.add(login);
      const wantPermission = collaborator.permission ?? DEFAULT_ROLE;
      const existing = liveByLogin.get(login);
      const wantRole = roleForPermission(wantPermission);
      if (existing && (existing.role_name ?? "") === wantRole) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(
          existing
            ? `collaborators[${collaborator.username}]: live role "${existing.role_name}" != declared "${wantRole}"; apply will set the declared permission`
            : `collaborators[${collaborator.username}]: missing - not a collaborator on the repo; apply will send an invitation with "${wantPermission}"`,
        );
      } else {
        await call(ctx, this, ENDPOINTS.update, {
          params: { username: collaborator.username },
          payload: { permission: wantPermission },
          describe: `${existing ? "updating" : "inviting"} collaborator "${collaborator.username}"`,
        });
        result.changes.push(
          `${existing ? "updated" : "invited"} collaborator "${collaborator.username}" (${wantPermission})`,
        );
      }
    }

    for (const collaborator of live) {
      const login = collaborator.login.toLowerCase();
      if (login === ctx.owner.toLowerCase() || declared.has(login)) {
        continue; // never remove the owner
      }
      if (ctx.check) {
        result.drift.push(
          `collaborators[${collaborator.login}]: undeclared - not in the settings file, so apply will REMOVE them; add them to the settings file to keep their access`,
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, {
          params: { username: collaborator.login },
        });
        result.changes.push(`REMOVED undeclared collaborator "${collaborator.login}"`);
      }
    }
    return result;
  },
};

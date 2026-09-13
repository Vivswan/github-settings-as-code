/**
 * The owner gate behind `ownerSensitivity: "org"` (./module.ts): teams and custom properties exist only
 * under an organization owner, so the registry composes every such module's plan() and snapshot()
 * through gatedByOwner, which probes the owner first and stops with a note on a personal account.
 * No section body spells the probe, and one run probes an owner once: the answer is shared across
 * the gated sections reading through the same client.
 */

import { z } from "zod";
import type { GitHubClient } from "../../github/api.js";
import type { SectionKey } from "../../schema.js";
import { ORG_PROBE, type SectionMeta, type SectionModule } from "./module.js";
import { clientOf, type PlanContext } from "./plan.js";

function personalAccountNote(
  section: Pick<SectionMeta, "key">,
  owner: string,
  phase: "plan" | "snapshot",
): string {
  const note = `${section.key}: owner "${owner}" is a personal account, not an organization, so this section does not apply`;
  return phase === "plan"
    ? `${note}; section skipped - remove the ${section.key} section from the settings file to silence this note`
    : note;
}

/** The `org` role's probe as the erased port exposes it; the cast in gatedByOwner is that boundary. */
interface OrgProbePort {
  readonly org: {
    probeAbsent(
      schema: z.ZodType<unknown>,
      opts: { params: { org: string } },
    ): Promise<{ data: unknown } | { missing: true }>;
  };
}

/**
 * Whether each owner is a personal account, per client (one client is one run's token): the first
 * gated section probes, the rest read the answer. A failed probe (a denial, a server error) is not
 * kept, so every section reports it through its own port.
 */
const personalByClient = new WeakMap<GitHubClient, Map<string, Promise<boolean>>>();

function isPersonalAccount(ctx: PlanContext): Promise<boolean> {
  const api = clientOf(ctx);
  let byOwner = personalByClient.get(api);
  if (byOwner === undefined) {
    byOwner = new Map();
    personalByClient.set(api, byOwner);
  }
  const owner = ctx.repo.owner;
  const known = byOwner.get(owner);
  if (known !== undefined) {
    return known;
  }
  const probing = (ctx.read as unknown as OrgProbePort).org
    .probeAbsent(z.unknown(), { params: { org: owner } })
    .then((answer) => "missing" in answer);
  byOwner.set(owner, probing);
  probing.catch(() => byOwner.delete(owner));
  return probing;
}

/**
 * A module without the flag passes through untouched. One with it must declare the probe under the
 * `org` role (the type demands it on a literal dictionary; the runtime check covers the erased view).
 */
export function gatedByOwner<K extends SectionKey>(module: SectionModule<K>): SectionModule<K> {
  if (module.ownerSensitivity !== "org") {
    return module;
  }
  if (module.endpoints.org?.route !== ORG_PROBE.route) {
    throw new Error(
      `BUG: section "${module.key}" declares ownerSensitivity "org" without the owner probe under its "org" role; declare org: ORG_PROBE in its endpoints`,
    );
  }
  const personal = async (
    ctx: PlanContext,
    phase: "plan" | "snapshot",
  ): Promise<string | undefined> =>
    (await isPersonalAccount(ctx)) ? personalAccountNote(module, ctx.repo.owner, phase) : undefined;
  const snapshot = module.snapshot;
  return {
    ...module,
    plan: async (ctx, desired) => {
      const note = await personal(ctx, "plan");
      return note === undefined ? module.plan(ctx, desired) : { ops: [], notes: [note], drift: [] };
    },
    ...(snapshot === undefined
      ? {}
      : {
          snapshot: async (ctx: Parameters<typeof snapshot>[0]) => {
            const note = await personal(ctx, "snapshot");
            return note === undefined
              ? snapshot.call(module, ctx)
              : { value: undefined, notes: [note] };
          },
        }),
  };
}

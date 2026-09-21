/**
 * The owner gate behind `ownerSensitivity: "org"` (./module.ts): teams and custom properties exist only
 * under an organization owner, so the registry composes every such module's plan() and snapshot()
 * through gatedByOwner, which probes the owner first and stops with a note on a personal account.
 * No section body spells the probe, and one run probes an owner once: the answer is shared across
 * the gated sections reading through the same client.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { GitHubClient } from "../../github/api.js";
import type { SectionKey } from "../../schema.js";
import type { SectionFailure } from "./errors.js";
import { ORG_PROBE, type SectionMeta, type SectionModule } from "./module.js";
import { clientOf, type PlanContext, type Read } from "./plan.js";

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
    ): Read<{ data: unknown } | { missing: true }>;
  };
}

/**
 * Whether each owner is a personal account, per client (one client is one run's token): the first
 * gated section probes, the rest read the answer. A failed probe (a denial, a server error) is not
 * kept, so every section reports it through its own port.
 */
const personalByClient = new WeakMap<
  GitHubClient,
  Map<string, Promise<Result<boolean, SectionFailure>>>
>();

function isPersonalAccount(ctx: PlanContext): Promise<Result<boolean, SectionFailure>> {
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
  const probing = (async (): Promise<Result<boolean, SectionFailure>> => {
    const answer = await (ctx.read as unknown as OrgProbePort).org
      .probeAbsent(z.unknown(), { params: { org: owner } })
      .map((probe) => "missing" in probe);
    if (answer.isErr()) {
      byOwner.delete(owner);
    }
    return answer;
  })();
  byOwner.set(owner, probing);
  // The client's own throw (a transport error on the probe) is not kept either.
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
  ): Promise<Result<string | undefined, SectionFailure>> =>
    (await isPersonalAccount(ctx)).map((isPersonal) =>
      isPersonal ? personalAccountNote(module, ctx.repo.owner, phase) : undefined,
    );
  const snapshot = module.snapshot;
  return {
    ...module,
    plan: async (ctx, desired) => {
      const probed = await personal(ctx, "plan");
      if (probed.isErr()) {
        return err(probed.error);
      }
      const note = probed.value;
      return note === undefined
        ? module.plan(ctx, desired)
        : ok({ ops: [], notes: [note], drift: [] });
    },
    ...(snapshot === undefined
      ? {}
      : {
          snapshot: async (ctx: Parameters<typeof snapshot>[0]) => {
            const probed = await personal(ctx, "snapshot");
            if (probed.isErr()) {
              return err(probed.error);
            }
            const note = probed.value;
            return note === undefined
              ? snapshot.call(module, ctx)
              : ok({ value: undefined, notes: [note] });
          },
        }),
  };
}

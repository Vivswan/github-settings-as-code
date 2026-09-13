import { z } from "zod";
import type { UndeclaredPolicy } from "../../types.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  missingDrift,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
} from "../contract/module.js";
import { rejectDuplicates } from "../contract/requests.js";
import type { EnvironmentsRestContext } from "./endpoints.js";
import type { NestedPlan } from "./nested.js";
import type { DeploymentProtectionRuleConfig } from "./schema.js";

// "keep" for a security reason: Apps can enable themselves as deployment gates, and silently
// disabling a gate the file never named would weaken a protection nobody asked to weaken.
export const PROTECTION_RULES_DEFAULT_POLICY: UndeclaredPolicy = "keep";

/**
 * The endpoint documents enabled rules only, so presence is the enablement signal; `enabled` is
 * read as a belt over that, since a rule the API ever reported disabled must not satisfy a declared
 * gate. An enabled rule without an App slug fails loudly: it has no identity to reconcile by.
 */
const LiveProtectionRule = z.looseObject({
  id: z.number().optional(),
  enabled: z.boolean().optional(),
  app: z.looseObject({ id: z.number().optional(), slug: z.string().optional() }).optional(),
});
type LiveProtectionRule = z.infer<typeof LiveProtectionRule>;

function liveRuleSlug(rule: LiveProtectionRule, envName: string): string {
  const slug = rule.app?.slug;
  if (typeof slug !== "string") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without an app slug, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return slug;
}

function liveRuleId(rule: LiveProtectionRule, envName: string): string {
  // A null or string id would serialize into the DELETE path (".../deployment_protection_rules/null").
  if (typeof rule.id !== "number") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without a numeric id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return String(rule.id);
}

/**
 * A single call(), NOT listAllEnveloped: this endpoint documents no page/per_page parameters, so
 * the page loop would append a query GitHub never specified. Both envelope keys are optional in the
 * spec, so an ABSENT list reads as empty, while a PRESENT off-shape value fails loudly at the port.
 */
const LiveProtectionRules = z
  .looseObject({ custom_deployment_protection_rules: z.array(LiveProtectionRule).optional() })
  .nullable();

export async function listProtectionRules(
  ctx: EnvironmentsRestContext,
  envName: string,
): Promise<LiveProtectionRule[]> {
  const data = await ctx.read.listProtectionRules.call(LiveProtectionRules, {
    params: { environment_name: envName },
    describe: `environment "${envName}"`,
  });
  return data?.custom_deployment_protection_rules ?? [];
}

/** An unlisted slug means the App is not installed, which nothing this section may call can change. */
function resolveIntegrationId(
  apps: ReadonlyMap<string, LiveProtectionRuleApp>,
  slug: string,
  envName: string,
): number {
  const app = apps.get(slug);
  if (app === undefined) {
    const available =
      apps.size > 0
        ? `the available Apps are ${[...apps.keys()].map((candidate) => `"${candidate}"`).join(", ")}`
        : "no protection-rule Apps are available to it";
    throw new Error(
      `environments: the deployment protection rule App "${slug}" is not available to environment "${envName}" (${available}). Install the GitHub App providing the rule on this repository, or declare one of the available slugs`,
    );
  }
  return app.id;
}

const LiveProtectionRuleApp = z.looseObject({ id: z.number(), slug: z.string() });
type LiveProtectionRuleApp = z.infer<typeof LiveProtectionRuleApp>;

/**
 * The Apps available to an environment, by slug, under the duplicate-live guard. An App without a
 * slug or id could neither be offered in the unknown-slug error nor resolve a declared rule, so the
 * port rejects the whole listing.
 */
async function listProtectionRuleApps(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Promise<ReadonlyMap<string, LiveProtectionRuleApp>> {
  const apps = await ctx.read.listProtectionRuleApps.listAllEnveloped(
    "available_custom_deployment_protection_rule_integrations",
    LiveProtectionRuleApp,
    { params: { environment_name: envName }, describe: `environment "${envName}"` },
  );
  return liveByIdentity(
    section,
    "protection-rule App",
    apps,
    (app) => app.slug,
    (app) => liveIdentity(app.slug, { app_id: app.id }),
  );
}

/**
 * The gates that are ON, by App slug, under the duplicate-live guard: a disabled declared rule must be
 * re-enabled rather than read as clean, and a disabled undeclared rule is no active gate, so neither
 * the keep-note nor the disable applies to it. plan() and snapshot() both index through it.
 */
export function enabledRulesBySlug(
  section: SectionMeta,
  live: readonly LiveProtectionRule[],
  envName: string,
): Map<string, LiveProtectionRule> {
  return liveByIdentity(
    section,
    "deployment protection rule",
    live.filter((rule) => rule.enabled !== false),
    (rule) => liveRuleSlug(rule, envName),
    (rule) => liveIdentity(liveRuleSlug(rule, envName), { protection_rule_id: rule.id }),
  );
}

/** Every missing slug resolves from one Apps read before the first POST leaves, so an unlisted slug fails before any rule is half-enabled. */
export async function planProtectionRules(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentProtectionRuleConfig[],
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  rejectDuplicates(
    section,
    entries,
    (rule) => rule.app,
    (rule) => rule.app,
    `deployment protection rule App of the "${envName}" environment`,
  );
  const params = { environment_name: envName };
  const live = liveEnv === undefined ? [] : await listProtectionRules(ctx, envName);
  const liveBySlug = enabledRulesBySlug(section, live, envName);
  const declared = new Set(entries.map((rule) => rule.app));
  const planned: NestedPlan = { ops: [], notes: [] };

  const missing = entries.filter((rule) => !liveBySlug.has(rule.app));
  // One Apps read resolves every missing slug. For an environment that exists it runs HERE, so an
  // unlisted or duplicated App fails the plan before any write; for an environment the run creates
  // the list 404s until its PUT lands, so the first enabling POST's payload thunk reads it instead.
  let integrationIds: Promise<Map<string, number>> | undefined;
  const resolveMissing = (): Promise<Map<string, number>> => {
    integrationIds ??= listProtectionRuleApps(ctx, section, envName).then(
      (apps) =>
        new Map(missing.map((rule) => [rule.app, resolveIntegrationId(apps, rule.app, envName)])),
    );
    return integrationIds;
  };
  if (liveEnv !== undefined && missing.length > 0) {
    await resolveMissing();
  }
  for (const rule of missing) {
    planned.ops.push({
      role: "createProtectionRule",
      params,
      payload: async () => {
        const integrationId = (await resolveMissing()).get(rule.app);
        if (integrationId === undefined) {
          throw new Error(
            `BUG: environments: the protection rule App "${rule.app}" of environment "${envName}" was planned but not resolved`,
          );
        }
        return { integration_id: integrationId };
      },
      drift: [
        missingDrift(`environments[${envName}].deployment_protection_rules[${rule.app}]`, {
          where: "enabled on the environment",
          action: "enable it if the App is available to this environment",
        }),
      ],
      change: `enabled deployment protection rule "${rule.app}" in environment "${envName}"`,
      describe: `enabling deployment protection rule "${rule.app}" in environment "${envName}"`,
    });
  }

  for (const [slug, rule] of liveBySlug) {
    if (declared.has(slug)) {
      continue;
    }
    if (policy === "keep") {
      planned.notes.push(
        undeclaredNote({
          subject: `deployment protection rule "${slug}"`,
          state: `is enabled on environment "${envName}" but is not declared`,
          action: "DISABLE it",
        }),
      );
      continue;
    }
    planned.ops.push({
      role: "removeProtectionRule",
      params: { ...params, protection_rule_id: liveRuleId(rule, envName) },
      drift: [
        undeclaredDrift(PROTECTION_RULES_DEFAULT_POLICY, {
          label: `environments[${envName}].deployment_protection_rules[${slug}]`,
          action: "DISABLE it",
        }),
      ],
      change: `DISABLED undeclared deployment protection rule "${slug}" in environment "${envName}"`,
      describe: `disabling undeclared deployment protection rule "${slug}" in environment "${envName}"`,
    });
  }
  return planned;
}

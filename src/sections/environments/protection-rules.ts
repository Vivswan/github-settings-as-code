/**
 * The nested `deployment_protection_rules` key: plan one environment's
 * custom deployment protection rules - GitHub App gates, enable/disable
 * only, declared by App slug and resolved to the integration id at apply
 * time.
 */

import { z } from "zod";
import type { UndeclaredPolicy } from "../../types.js";
import { parseLive } from "../contract/live.js";
import { type SectionMeta, undeclaredDrift, undeclaredNote } from "../contract/module.js";
import { ENDPOINTS, type EnvironmentsRestContext } from "./endpoints.js";
import type { NestedPlan } from "./nested.js";
import type { DeploymentProtectionRuleConfig, EnvironmentConfig } from "./schema.js";

// "keep" like the secret families, for a security reason instead of an
// unrecoverable one: Apps can enable themselves as deployment gates, and
// silently disabling a gate the file never named would weaken a
// protection nobody asked to weaken. Disabling is opt-in via the wrapped
// form.
export const PROTECTION_RULES_DEFAULT_POLICY: UndeclaredPolicy = "keep";

/**
 * The fields of a live custom deployment protection rule this section reads.
 * The spec marks every field required, but the identity fields are still
 * extracted loudly (the livePolicyName precedent): a rule without an App
 * slug has no identity to reconcile by, and silently skipping it would let
 * check report falsely clean. The endpoint documents that it returns
 * enabled rules only, so presence in the list is the enablement signal;
 * `enabled` is read anyway as a belt over that contract - a rule the API
 * ever reported as disabled must not satisfy a declared gate.
 */
const LiveProtectionRule = z.looseObject({
  id: z.number().optional(),
  enabled: z.boolean().optional(),
  app: z.looseObject({ id: z.number().optional(), slug: z.string().optional() }).optional(),
});
type LiveProtectionRule = z.infer<typeof LiveProtectionRule>;

/** The App slug a rule reconciles by, or a loud error when the response omitted it. */
function liveRuleSlug(rule: LiveProtectionRule, envName: string): string {
  const slug = rule.app?.slug;
  if (typeof slug !== "string") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without an app slug, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return slug;
}

/** The id a disable addresses, or a loud error when the response omitted it. */
function liveRuleId(rule: LiveProtectionRule, envName: string): string {
  // Only a real number may address the DELETE: a null or string id would
  // otherwise serialize into the path (".../deployment_protection_rules/null").
  if (typeof rule.id !== "number") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without a numeric id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return String(rule.id);
}

/**
 * The enabled rules of one environment. A single call(), NOT
 * listAllEnveloped: this endpoint documents no page/per_page parameters, so
 * the page loop would append a query GitHub never specified. Both envelope
 * keys are optional in the spec, so an ABSENT list reads as empty - but a
 * PRESENT off-shape value is a contract break parseLive fails loudly.
 */
async function listProtectionRules(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Promise<LiveProtectionRule[]> {
  const data = parseLive(
    section,
    ENDPOINTS.listProtectionRules,
    z
      .looseObject({ custom_deployment_protection_rules: z.array(LiveProtectionRule).optional() })
      .nullable(),
    await ctx.read.listProtectionRules.call({
      params: { environment_name: envName },
      describe: `listing deployment protection rules of environment "${envName}"`,
    }),
    `environment "${envName}"`,
  );
  return data?.custom_deployment_protection_rules ?? [];
}

/**
 * Resolve a declared App slug to its integration id via the available-Apps
 * listing; an unlisted slug is a hard error naming the available ones (the
 * App is not installed, which no call this section may make can change).
 */
function resolveIntegrationId(
  apps: readonly LiveProtectionRuleApp[],
  slug: string,
  envName: string,
): number {
  const app = apps.find((candidate) => candidate.slug === slug);
  if (app === undefined) {
    const available =
      apps.length > 0
        ? `the available Apps are ${apps.map((candidate) => `"${candidate.slug}"`).join(", ")}`
        : "no protection-rule Apps are available to it";
    throw new Error(
      `environments: the deployment protection rule App "${slug}" is not available to environment "${envName}" (${available}). Install the GitHub App providing the rule on this repository, or declare one of the available slugs`,
    );
  }
  return app.id;
}

/** The fields of an available protection-rule App this section reads. */
const LiveProtectionRuleApp = z.looseObject({ id: z.number(), slug: z.string() });
type LiveProtectionRuleApp = z.infer<typeof LiveProtectionRuleApp>;

/**
 * The available-Apps listing, parsed loudly at the boundary: an App without
 * a slug or id could neither be offered in the unknown-slug error nor
 * resolve a declared rule, so parseLive rejects the whole listing.
 */
async function listProtectionRuleApps(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Promise<LiveProtectionRuleApp[]> {
  return parseLive(
    section,
    ENDPOINTS.listProtectionRuleApps,
    z.array(LiveProtectionRuleApp),
    await ctx.read.listProtectionRuleApps.listAllEnveloped(
      "available_custom_deployment_protection_rule_integrations",
      { params: { environment_name: envName } },
    ),
    `environment "${envName}"`,
  );
}

/**
 * Upfront rejection of duplicate declared App slugs: the same gate enabled
 * twice would fight itself on every run.
 */
export function validateProtectionRules(
  env: EnvironmentConfig,
  entries: readonly DeploymentProtectionRuleConfig[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rule of entries) {
    if (seen.has(rule.app)) {
      duplicates.add(rule.app);
    }
    seen.add(rule.app);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `environments: the "${env.name}" entry declares the deployment protection rule App${duplicates.size === 1 ? "" : "s"} ${[...duplicates].map((app) => `"${app}"`).join(", ")} more than once. Keep exactly one entry per App`,
    );
  }
}

/**
 * Plan one environment's protection rules (enable/disable only): a missing
 * rule is enabled, an undeclared one follows the policy, and the FIRST enable's
 * thunk resolves EVERY missing slug from one Apps read before any POST leaves.
 */
export async function planProtectionRules(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentProtectionRuleConfig[],
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const live = liveEnv === undefined ? [] : await listProtectionRules(ctx, section, envName);
  const liveBySlug = new Map<string, LiveProtectionRule>();
  for (const rule of live) {
    // The map models gates that are ON (see the LiveProtectionRule JSDoc):
    // skipping a disabled rule makes apply re-enable a declared gate instead
    // of reading falsely clean, and in the undeclared direction a disabled
    // rule is not an active gate, so neither the keep-note nor the disable
    // applies to it.
    if (rule.enabled === false) {
      continue;
    }
    liveBySlug.set(liveRuleSlug(rule, envName), rule);
  }
  const declared = new Set(entries.map((rule) => rule.app));
  const planned: NestedPlan = { ops: [], notes: [] };

  const missing = entries.filter((rule) => !liveBySlug.has(rule.app));
  let integrationIds: Promise<Map<string, number>> | undefined;
  const resolveMissing = (): Promise<Map<string, number>> => {
    integrationIds ??= listProtectionRuleApps(ctx, section, envName).then(
      (apps) =>
        new Map(missing.map((rule) => [rule.app, resolveIntegrationId(apps, rule.app, envName)])),
    );
    return integrationIds;
  };
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
        `environments[${envName}].deployment_protection_rules[${rule.app}]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment`,
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

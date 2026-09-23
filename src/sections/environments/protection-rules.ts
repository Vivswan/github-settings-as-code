import { err, ok, Result, safeTry } from "neverthrow";
import { z } from "zod";
import type { UndeclaredPolicy } from "../../types.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  type DeclaredIssue,
  duplicateFieldIssues,
  missingDrift,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
} from "../contract/module.js";
import type { Read } from "../contract/plan.js";
import { type EnvironmentsRestContext, unreconcilable } from "./endpoints.js";
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

const RULE = { list: "deployment protection rule", entry: "rule" };

function liveRuleSlug(rule: LiveProtectionRule, envName: string): Result<string, SectionFailure> {
  const slug = rule.app?.slug;
  if (typeof slug !== "string") {
    return err(unreconcilable(RULE, envName, "an app slug"));
  }
  return ok(slug);
}

function liveRuleId(rule: LiveProtectionRule, envName: string): Result<string, SectionFailure> {
  // A null or string id would serialize into the DELETE path (".../deployment_protection_rules/null").
  if (typeof rule.id !== "number") {
    return err(unreconcilable(RULE, envName, "a numeric id"));
  }
  return ok(String(rule.id));
}

/**
 * A single call(), NOT listAllEnveloped: this endpoint documents no page/per_page parameters, so
 * the page loop would append a query GitHub never specified. Both envelope keys are optional in the
 * spec, so an ABSENT list reads as empty, while a PRESENT off-shape value fails loudly at the port.
 */
const LiveProtectionRules = z
  .looseObject({ custom_deployment_protection_rules: z.array(LiveProtectionRule).optional() })
  .nullable();

export function listProtectionRules(
  ctx: EnvironmentsRestContext,
  envName: string,
): Read<LiveProtectionRule[]> {
  return ctx.read.listProtectionRules
    .call(LiveProtectionRules, {
      params: { environment_name: envName },
      describe: `environment "${envName}"`,
    })
    .map((data) => data?.custom_deployment_protection_rules ?? []);
}

/** An unlisted slug means the App is not installed, which nothing this section may call can change. */
function resolveIntegrationId(
  apps: ReadonlyMap<string, LiveProtectionRuleApp>,
  slug: string,
  envName: string,
): Result<number, SectionFailure> {
  const app = apps.get(slug);
  if (app === undefined) {
    const available =
      apps.size > 0
        ? `the available Apps are ${[...apps.keys()].map((candidate) => `"${candidate}"`).join(", ")}`
        : "no protection-rule Apps are available to it";
    return err(
      sectionFailure(
        "refused",
        `environments: the deployment protection rule App "${slug}" is not available to environment "${envName}" (${available}). Install the GitHub App providing the rule on this repository, or declare one of the available slugs`,
      ),
    );
  }
  return ok(app.id);
}

const LiveProtectionRuleApp = z.looseObject({ id: z.number(), slug: z.string() });
type LiveProtectionRuleApp = z.infer<typeof LiveProtectionRuleApp>;

/**
 * The Apps available to an environment, by slug, under the duplicate-live guard. An App without a
 * slug or id could neither be offered in the unknown-slug error nor resolve a declared rule, so the
 * port rejects the whole listing.
 */
function listProtectionRuleApps(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Read<ReadonlyMap<string, LiveProtectionRuleApp>> {
  return ctx.read.listProtectionRuleApps
    .listAllEnveloped(
      "available_custom_deployment_protection_rule_integrations",
      LiveProtectionRuleApp,
      { params: { environment_name: envName }, describe: `environment "${envName}"` },
    )
    .andThen((apps) =>
      liveByIdentity(
        section,
        "protection-rule App",
        apps,
        (app) => app.slug,
        (app) => liveIdentity(app.slug, { app_id: app.id }),
      ),
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
): Result<Map<string, LiveProtectionRule>, SectionFailure> {
  return Result.combine(
    live
      .filter((rule) => rule.enabled !== false)
      .map((rule) => liveRuleSlug(rule, envName).map((slug) => ({ rule, slug }))),
  )
    .andThen((slugged) =>
      liveByIdentity(
        section,
        "deployment protection rule",
        slugged,
        (entry) => entry.slug,
        (entry) => liveIdentity(entry.slug, { protection_rule_id: entry.rule.id }),
      ),
    )
    .map((bySlug) => new Map([...bySlug].map(([slug, entry]) => [slug, entry.rule])));
}

/** Two entries for one App would enable and re-enable the same rule on every run. */
export function duplicateProtectionRuleIssues(
  entries: readonly DeploymentProtectionRuleConfig[],
  envName: string,
): DeclaredIssue[] {
  return duplicateFieldIssues(
    entries,
    { field: "app" },
    `deployment protection rule App of the "${envName}" environment`,
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
): Promise<Result<NestedPlan, SectionFailure>> {
  return safeTry(async function* () {
    const params = { environment_name: envName };
    const live = liveEnv === undefined ? [] : yield* listProtectionRules(ctx, envName);
    const liveBySlug = yield* enabledRulesBySlug(section, live, envName);
    const declared = new Set(entries.map((rule) => rule.app));
    const planned: NestedPlan = { ops: [], notes: [] };

    const missing = entries.filter((rule) => !liveBySlug.has(rule.app));
    // One Apps read resolves every missing slug. For an environment that exists it runs HERE, so an
    // unlisted or duplicated App fails the plan before any write; for an environment the run creates
    // the list 404s until its PUT lands, so the first enabling POST's payload thunk reads it instead.
    let integrationIds: Promise<Result<Map<string, number>, SectionFailure>> | undefined;
    const resolveMissing = (): Promise<Result<Map<string, number>, SectionFailure>> => {
      integrationIds ??= Promise.resolve(
        listProtectionRuleApps(ctx, section, envName).andThen((apps) =>
          Result.combine(
            missing.map((rule) =>
              resolveIntegrationId(apps, rule.app, envName).map((id) => [rule.app, id] as const),
            ),
          ).map((pairs) => new Map(pairs)),
        ),
      );
      return integrationIds;
    };
    if (liveEnv !== undefined && missing.length > 0) {
      yield* await resolveMissing();
    }
    for (const rule of missing) {
      planned.ops.push({
        role: "createProtectionRule",
        params,
        payload: async () =>
          (await resolveMissing()).map((ids) => {
            const integrationId = ids.get(rule.app);
            if (integrationId === undefined) {
              throw new Error(
                `BUG: environments: the protection rule App "${rule.app}" of environment "${envName}" was planned but not resolved`,
              );
            }
            return { integration_id: integrationId };
          }),
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
        params: { ...params, protection_rule_id: yield* liveRuleId(rule, envName) },
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
    return ok(planned);
  });
}

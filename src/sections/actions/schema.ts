/** The `actions:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

/** GitHub's rule for an OIDC claim key; the PUT 422s on anything else. */
const CLAIM_KEY = /^[A-Za-z0-9_]+$/;

/**
 * The fields the GET reports and the PUT does not take, as [path to the holder, field]: a declared value
 * can only diff against live and re-PUT forever, so the document is refused with the key named. The
 * holder is read off the loosened (passthrough) parse output, which is how the refinement sees a key
 * the shape does not declare.
 */
const REPORTED_ONLY: readonly (readonly [readonly string[], string])[] = [
  [[], "selected_actions_url"],
  [["artifact_and_log_retention"], "maximum_allowed_days"],
  [["oidc_customization_sub"], "sub_claim_prefix"],
];

function refuseReportedOnly(ctx: z.core.$RefinementCtx, declared: object): void {
  for (const [path, field] of REPORTED_ONLY) {
    const holder = path.reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined,
      declared,
    );
    if (typeof holder === "object" && holder !== null && Object.hasOwn(holder, field)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, field],
        message:
          `${field} is a value GitHub reports, not a setting it accepts (the GET returns it, the PUT does not take it), ` +
          "so a declared value could never be applied; remove it from the settings file",
      });
    }
  }
}

/** Each claim key must be unique: GitHub 422s a repeated one, and a repeat cannot mean anything in a subject template. */
const ClaimKeys = z
  .array(
    z.string().regex(CLAIM_KEY, {
      error:
        'a claim key holds only letters, digits, and underscores (such as "repo" or "job_workflow_ref")',
    }),
  )
  .superRefine((keys, refineCtx) => {
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (seen.has(key)) {
        refineCtx.addIssue({
          code: "custom",
          path: [index],
          message: `"${key}" repeats an earlier claim key; GitHub requires the keys to be unique`,
        });
      }
      seen.add(key);
    });
  });

/**
 * The two templates are two variants, discriminated on use_default, so the claim-key list has no
 * home on the default one and the plan narrows on the flag instead of re-checking it. The default
 * variant is passthrough once loosened, so a list declared beside use_default: true is refused by
 * name here rather than riding through.
 */
const OidcTemplate = z
  .discriminatedUnion("use_default", [
    z.object({ use_default: z.literal(true), use_immutable_subject: z.boolean().optional() }),
    z.object({
      use_default: z.literal(false),
      include_claim_keys: ClaimKeys.optional(),
      use_immutable_subject: z.boolean().optional(),
    }),
  ])
  .superRefine((declared, refineCtx) => {
    if (declared.use_default && Object.hasOwn(declared, "include_claim_keys")) {
      refineCtx.addIssue({
        code: "custom",
        path: ["include_claim_keys"],
        message:
          "GitHub ignores include_claim_keys under use_default: true, so the declared list could never take; " +
          "set use_default: false for a custom template, or remove the list",
      });
    }
  });

export const ActionsConfig = z
  .object({
    enabled: z.boolean().optional(),
    allowed_actions: z.enum(["all", "local_only", "selected"]).optional(),
    sha_pinning_required: z.boolean().optional(),
    // STRICT: the spec documents the complete allowlist body, and this PUT has no unrecognized-key
    // note, so a misspelled key would otherwise re-PUT on every run without a word.
    selected_actions: z
      .strictObject({
        github_owned_allowed: z.boolean().optional(),
        verified_allowed: z.boolean().optional(),
        patterns_allowed: z.array(z.string()).optional(),
      })
      .optional(),
    default_workflow_permissions: z.enum(["read", "write"]).optional(),
    can_approve_pull_request_reviews: z.boolean().optional(),
    access_level: z.enum(["none", "user", "organization"]).optional(),
    // The upper bounds of the retention and cache limits are plan-dependent, so only the integer rule is checked here.
    artifact_and_log_retention: z.object({ days: z.int().positive() }).optional(),
    // STRICT, unlike its siblings: each cache limit is the entire body of its own endpoint, so an
    // unrecognized cache key has no passthrough destination and can only be a typo.
    cache: z
      .strictObject({
        max_cache_retention_days: z.int().positive().optional(),
        max_cache_size_gb: z.int().positive().optional(),
      })
      .optional(),
    oidc_customization_sub: OidcTemplate.optional(),
    fork_pr_contributor_approval: z
      .object({
        approval_policy: z.enum([
          "first_time_contributors_new_to_github",
          "first_time_contributors",
          "all_external_contributors",
        ]),
      })
      .optional(),
    // Only the first toggle is required, as in the request body; the docs advise declaring all four.
    fork_pr_workflows_private_repos: z
      .object({
        run_workflows_from_fork_pull_requests: z.boolean(),
        send_write_tokens_to_workflows: z.boolean().optional(),
        send_secrets_and_variables: z.boolean().optional(),
        require_approval_for_fork_pr_workflows: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((declared, refineCtx) => {
    // Checked in the shape, not in plan(), so both modes reject the document before ANY section
    // writes; a plan-time throw would fire after earlier sections already wrote.
    refuseReportedOnly(refineCtx, declared);
    if (declared.selected_actions === undefined || declared.allowed_actions === undefined) {
      return;
    }
    if (declared.allowed_actions !== "selected") {
      refineCtx.addIssue({
        code: "custom",
        path: ["selected_actions"],
        message: `selected_actions is declared together with allowed_actions: "${declared.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`,
      });
    }
  })
  .meta({ id: "ActionsConfig" });
export type ActionsConfig = z.infer<typeof ActionsConfig>;

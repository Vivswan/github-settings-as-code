/** The `branches:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { isPlainObject } from "../../plain-data.js";
import { stringItems } from "../shared/raw-values.js";
import { conditional, open, rule } from "../shared/schema-helpers.js";
import { type BooleanControl, isGetOnlyKey, isUrlKey, NULLABLE_CONTROLS } from "./keys.js";

export type BypassActor =
  | { kind: "user"; login: string }
  | { kind: "team"; org: string; team: string }
  | { kind: "app"; slug: string };

const NAME_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

/** The lowercase "app" head is reserved for GitHub Apps. */
export function parseBypassActor(raw: string): BypassActor | null {
  const parts = raw.split("/");
  if (parts.length === 1) {
    const login = parts[0] as string;
    return NAME_SEGMENT.test(login) ? { kind: "user", login } : null;
  }
  if (parts.length !== 2) {
    return null;
  }
  const [head, tail] = parts as [string, string];
  if (!NAME_SEGMENT.test(head) || !NAME_SEGMENT.test(tail)) {
    return null;
  }
  return head === "app" ? { kind: "app", slug: tail } : { kind: "team", org: head, team: tail };
}

const ACTOR_FORM_ERROR =
  'each force_push_bypassers actor must be a bare user login ("octocat"), "org/team-slug" for a team, or "app/slug" for a GitHub App';

/** The list may be raw beside its own shape issue (see ../shared/raw-values.ts): only the string items are judged. */
function duplicateIn(list: unknown): string | null {
  const seen = new Set<string>();
  for (const item of stringItems(list)) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return item;
    }
    seen.add(key);
  }
  return null;
}

const ACTOR_LIST_EXAMPLE = {
  users: { nameKey: "login", example: "octocat" },
  teams: { nameKey: "slug", example: "platform-team" },
  apps: { nameKey: "slug", example: "deploy-gate" },
} as const;
type ActorList = keyof typeof ACTOR_LIST_EXAMPLE;

/** The login or slug of a GET actor object, or null for anything else. */
export function copiedActorName(item: unknown): string | null {
  if (!isPlainObject(item)) {
    return null;
  }
  for (const nameKey of ["login", "slug"] as const) {
    if (typeof item[nameKey] === "string") {
      return item[nameKey];
    }
  }
  return null;
}

/**
 * The GET expands each actor into an object ({login, id, ...} for a user, {slug, ...} for a team
 * or App); the PUT takes the login/slug string, so a copied item is refused naming the string to
 * write, and any other non-string item the type rule. A list the holder requires is refused when
 * absent, naming the required lists; an optional one is wrapped in .optional() by its holder, so
 * the absent case never reaches this error.
 */
function actorList(holder: string, list: ActorList) {
  const site = `protection.${holder}.${list}`;
  const { nameKey, example } = ACTOR_LIST_EXAMPLE[list];
  const typeRule = `${site} lists each actor as its ${nameKey} string ("${example}")`;
  return z.array(
    z.string({
      error: (issue) => {
        const copied = copiedActorName(issue.input);
        return copied === null
          ? typeRule
          : `${site} carries an actor object copied from GitHub's GET response, which the protection PUT takes as the ${nameKey} string; write "${copied}" instead`;
      },
    }),
    {
      error: (issue) =>
        issue.input === undefined
          ? `protection.${holder} must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; ${holder}: null lifts the push restriction`
          : typeRule,
    },
  );
}

function holderError(holder: string): string {
  return `protection.${holder} must be a mapping of users, teams, and apps lists, each actor its login or slug string ("octocat")`;
}

/**
 * GitHub's protection PUT takes every list of dismissal_restrictions and
 * bypass_pull_request_allowances as optional and reads an empty holder as "disabled".
 */
function reviewActorHolder(holder: string) {
  return z.looseObject(
    {
      users: actorList(holder, "users").optional(),
      teams: actorList(holder, "teams").optional(),
      apps: actorList(holder, "apps").optional(),
    },
    { error: holderError(holder) },
  );
}

const Restrictions = z.looseObject(
  {
    // The PUT requires users and teams here (apps stays optional), so a mapping missing either
    // would 422 at apply and is refused at parse instead.
    users: actorList("restrictions", "users"),
    teams: actorList("restrictions", "teams"),
    apps: actorList("restrictions", "apps").optional(),
  },
  { error: holderError("restrictions") },
);

const STRICT_ERROR =
  "required_status_checks.strict must be an unquoted true or false (GitHub's protection PUT rejects the requirement without it): true also requires the branch to be up to date with its base before merging, false only requires the checks to pass";

const CHECK_LIST_ERROR =
  "required_status_checks must list the required checks as contexts: [names] or checks: [{context, app_id}] (GitHub's protection PUT rejects the requirement without them); contexts: [] requires none";

const REVIEW_COUNT_ERROR =
  "required_pull_request_reviews.required_approving_review_count must be a whole number from 0 to 6 (GitHub accepts 1 to 6, or 0 to require no approvals)";

const CHECK_ITEM_ERROR =
  "each required_status_checks.checks item is a {context, app_id} mapping naming one required check; a bare name goes under contexts: [names]";

const CHECK_CONTEXT_ERROR =
  "required_status_checks.checks[].context must be the check's name, as a string";

const CHECK_APP_ID_ERROR =
  "required_status_checks.checks[].app_id must be a whole number: the id of the GitHub App that must report the check, or -1 to let any App report it; omit it to pin whichever App reported it last";

/** The unknown keys of a check item, each named with the fix: GitHub's PUT takes no other field there. */
function checkItemKeyError(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "unrecognized_keys") {
    return CHECK_ITEM_ERROR;
  }
  const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
  return `a required_status_checks.checks item takes only context and app_id (GitHub's protection PUT has no other field there); remove ${keys}`;
}

const RequiredStatusCheck = z.strictObject(
  {
    context: z.string({ error: CHECK_CONTEXT_ERROR }),
    // null reads back from GitHub as "any App" and is sent as -1 (index.ts putStatusChecks).
    app_id: z.int({ error: CHECK_APP_ID_ERROR }).nullable().optional(),
  },
  { error: checkItemKeyError },
);

const RequiredStatusChecks = z
  .looseObject(
    {
      strict: z.boolean({ error: STRICT_ERROR }),
      contexts: z.array(z.string()).optional(),
      checks: z.array(RequiredStatusCheck).optional(),
    },
    {
      error:
        "required_status_checks must be a mapping of its keys (strict, then contexts or checks), or null to turn the requirement off",
    },
  )
  .check(
    rule((status, refineCtx) => {
      if (status.contexts === undefined && status.checks === undefined) {
        refineCtx.addIssue({ code: "custom", message: CHECK_LIST_ERROR });
      }
    }),
  )
  .meta({
    // The refinement's published-schema twin: zod refinements do not reach z.toJSONSchema, and
    // test/published-schema.test.ts holds the two sides to the same verdicts.
    anyOf: [{ required: ["contexts"] }, { required: ["checks"] }],
  });

/** The one wording for a toggle that is not a boolean; `site` is its path under protection. */
function toggleError(site: string): string {
  return `${site} must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous`;
}

function toggle(site: string) {
  return z.boolean({ error: toggleError(site) });
}

/** The controls the protection PUT carries; required_signatures rides its own sub-endpoint. */
type PutControl = Exclude<BooleanControl, "required_signatures">;

/** The GET wraps each of these as {url, enabled}, so a copied wrapper is refused naming the boolean to declare. */
function control(key: PutControl) {
  return z.boolean({
    error: (issue) => {
      const enabled = isPlainObject(issue.input) ? issue.input.enabled : undefined;
      return typeof enabled === "boolean"
        ? `protection.${key} is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare ${key}: ${enabled} instead`
        : toggleError(key);
    },
  });
}

/** The booleans of the PUT body; each takes null here, since the one shape serves both kinds of entry (refuseNullsThePutRefuses states the two contracts). */
const PutControls = {
  enforce_admins: control("enforce_admins").nullable().optional(),
  required_linear_history: control("required_linear_history").nullable().optional(),
  allow_force_pushes: control("allow_force_pushes").nullable().optional(),
  allow_deletions: control("allow_deletions").nullable().optional(),
  block_creations: control("block_creations").nullable().optional(),
  required_conversation_resolution: control("required_conversation_resolution")
    .nullable()
    .optional(),
  lock_branch: control("lock_branch").nullable().optional(),
  allow_fork_syncing: control("allow_fork_syncing").nullable().optional(),
} satisfies Record<PutControl, z.ZodType>;

/** The controls of the block above that the PUT answers 422 to a null under: all but the two it marks nullable. */
const NON_NULLABLE_CONTROLS = Object.keys(PutControls).filter((key) => !NULLABLE_CONTROLS.has(key));

/** The review settings the PUT takes as a bare boolean, under the same two contracts; the GET serves them bare too. */
const ReviewToggles = {
  dismiss_stale_reviews: toggle("required_pull_request_reviews.dismiss_stale_reviews")
    .nullable()
    .optional(),
  require_code_owner_reviews: toggle("required_pull_request_reviews.require_code_owner_reviews")
    .nullable()
    .optional(),
  require_last_push_approval: toggle("required_pull_request_reviews.require_last_push_approval")
    .nullable()
    .optional(),
};

/** The keys of the block above; the PUT answers 422 to a null under each. */
const REVIEW_TOGGLES = Object.keys(ReviewToggles);

const RequiredPullRequestReviews = z.looseObject(
  {
    required_approving_review_count: z
      .int({ error: REVIEW_COUNT_ERROR })
      .min(0, { error: REVIEW_COUNT_ERROR })
      .max(6, { error: REVIEW_COUNT_ERROR })
      .optional(),
    dismissal_restrictions: reviewActorHolder(
      "required_pull_request_reviews.dismissal_restrictions",
    ).optional(),
    bypass_pull_request_allowances: reviewActorHolder(
      "required_pull_request_reviews.bypass_pull_request_allowances",
    ).optional(),
    ...ReviewToggles,
  },
  {
    error:
      "required_pull_request_reviews must be a mapping of its keys (required_approving_review_count and the other review settings), or null to turn the requirement off",
  },
);

const ECHO_CARRIER: Readonly<Record<string, string>> = {
  name: "the entry's name already names the branch",
  enabled: "the control's own key carries the toggle",
  enforcement_level: "strict and the check list carry the requirement",
};

/** The fix for a GET-only key; a wrapper under a control never reaches here, since the control's own type refuses it (control(), above). */
function getOnlyKeyError(path: readonly (string | number)[], key: string): string {
  const site = ["protection", ...path, key].join(".");
  if (isUrlKey(key)) {
    return `${site} is a link GitHub's GET response carries and the protection PUT has no word for; remove it`;
  }
  return `${site} is GitHub's GET-only echo, which the protection PUT has no word for; remove it (${ECHO_CARRIER[key]})`;
}

/**
 * A YAML alias can point a mapping at one of its own ancestors; that container is skipped on
 * re-entry and left to the engine's document-cycle diagnostic, while an alias shared between two
 * sites is walked at both.
 */
function refuseGetOnlyKeys(
  value: unknown,
  path: (string | number)[],
  refineCtx: z.RefinementCtx,
  ancestors: Set<object> = new Set(),
): void {
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return;
  }
  if (ancestors.has(value)) {
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      refuseGetOnlyKeys(item, [...path, index], refineCtx, ancestors);
    });
  } else {
    for (const [key, inner] of Object.entries(value)) {
      if (isGetOnlyKey(key)) {
        refineCtx.addIssue({
          code: "custom",
          path: [...path, key],
          message: getOnlyKeyError(path, key),
        });
        continue;
      }
      refuseGetOnlyKeys(inner, [...path, key], refineCtx, ancestors);
    }
  }
  ancestors.delete(value);
}

/** zod's own issue for a null where a boolean goes, so validation words the refusal like any null with no empty state. */
const NULL_FOR_BOOLEAN = { code: "invalid_type", expected: "boolean", input: null } as const;

/**
 * GitHub states two contracts for a null under a boolean of the PUT body. One shape serves both kinds of entry, so
 * the shape takes the null and this refuses it on a literal entry:
 *
 *   the protection PUT (a literal entry)  -> 422, except under the two controls it marks nullable, where null is off
 *   the rule mutation (a wildcard entry)  -> every twin is a nullable Boolean input, so GitHub can accept the null
 */
function refuseNullsThePutRefuses(
  protection: Record<string, unknown>,
  refineCtx: z.RefinementCtx,
): void {
  for (const key of NON_NULLABLE_CONTROLS) {
    if (protection[key] === null) {
      refineCtx.addIssue({ ...NULL_FOR_BOOLEAN, path: ["protection", key] });
    }
  }

  const reviews = protection.required_pull_request_reviews;
  if (!isPlainObject(reviews)) {
    return;
  }

  for (const key of REVIEW_TOGGLES) {
    if (reviews[key] === null) {
      refineCtx.addIssue({
        ...NULL_FOR_BOOLEAN,
        path: ["protection", "required_pull_request_reviews", key],
      });
    }
  }
}

/** A JSON Schema `properties` map typing each key a boolean. */
function booleans(keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, { type: "boolean" }]));
}

/** The schema's keys under each open protection mapping, by dotted path: the PUT's vocabulary there. index.ts notes a declared key outside it that the GET never echoes. */
export const PROTECTION_MAPPING_KEYS = {
  required_status_checks: Object.keys(RequiredStatusChecks.shape),
  required_pull_request_reviews: Object.keys(RequiredPullRequestReviews.shape),
  "required_pull_request_reviews.dismissal_restrictions": Object.keys(ACTOR_LIST_EXAMPLE),
  "required_pull_request_reviews.bypass_pull_request_allowances": Object.keys(ACTOR_LIST_EXAMPLE),
  restrictions: Object.keys(Restrictions.shape),
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The protection mapping; the GET-only sweep runs at every depth, since the wrappers sit under each control and the links under the actor holders too. */
export const BranchProtectionConfig = z
  .looseObject({
    required_status_checks: RequiredStatusChecks.nullable().optional(),
    required_pull_request_reviews: RequiredPullRequestReviews.nullable().optional(),
    restrictions: Restrictions.nullable().optional(),
    ...PutControls,
    required_signatures: toggle("required_signatures").optional(),
    force_push_bypassers: z
      .array(
        z.string().check(
          rule((raw, refineCtx) => {
            if (parseBypassActor(raw) === null) {
              refineCtx.addIssue({ code: "custom", message: ACTOR_FORM_ERROR });
            }
          }),
        ),
      )
      .optional(),
    required_deployments: z
      .strictObject({ environments: z.array(z.string()) })
      .nullable()
      .optional(),
  })
  .check(
    rule((protection, refineCtx) => {
      refuseGetOnlyKeys(protection, [], refineCtx);
    }),
  )
  .meta({ id: "BranchProtectionConfig" });

export type BranchProtectionConfig = z.infer<typeof BranchProtectionConfig>;

/** What makes a name a wildcard pattern: git refnames forbid `*`, `?`, and `[`, so one can never collide with a literal branch. */
export const WILDCARD_NAME = /[*?[]/;

export const BranchConfig = open({
  name: z.string(),
  protection: BranchProtectionConfig.nullable(),
})
  .check(
    rule((entry, refineCtx) => {
      // GitHub canonicalizes actor and environment names case-insensitively and the routed lists
      // replace wholesale, so a duplicate would apply "successfully" and then drift forever against
      // the deduplicated read-back.
      const routed = entry.protection;
      if (isPlainObject(routed)) {
        const duplicateActor = duplicateIn(routed.force_push_bypassers);
        if (duplicateActor !== null) {
          refineCtx.addIssue({
            code: "custom",
            path: ["protection", "force_push_bypassers"],
            message: `force_push_bypassers lists "${duplicateActor}" more than once (actor names are case-insensitive); keep one entry per actor`,
          });
        }
        const duplicateEnv = duplicateIn(routed.required_deployments?.environments);
        if (duplicateEnv !== null) {
          refineCtx.addIssue({
            code: "custom",
            path: ["protection", "required_deployments", "environments"],
            message: `required_deployments.environments lists "${duplicateEnv}" more than once (environment names are case-insensitive); keep one entry per environment`,
          });
        }
      }
    }),
  )
  .check(
    rule((entry, refineCtx) => {
      // The name or the protection may be raw beside its own shape issue; a regex would coerce a raw name.
      const literal = typeof entry.name === "string" && !WILDCARD_NAME.test(entry.name);
      if (literal && isPlainObject(entry.protection)) {
        refuseNullsThePutRefuses(entry.protection, refineCtx);
      }
    }),
  )
  // The conditional is the null refusal's published twin, read from the same two lists: a refinement does not reach z.toJSONSchema.
  .meta({
    id: "BranchConfig",
    ...conditional(
      { properties: { name: { not: { pattern: WILDCARD_NAME.source } } } },
      {
        properties: {
          protection: {
            properties: {
              ...booleans(NON_NULLABLE_CONTROLS),
              required_pull_request_reviews: { properties: booleans(REVIEW_TOGGLES) },
            },
          },
        },
      },
    ),
  });
export type BranchConfig = z.infer<typeof BranchConfig>;

export const BranchesConfig = z.array(BranchConfig);

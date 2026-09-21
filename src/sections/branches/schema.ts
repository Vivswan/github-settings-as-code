/** The `branches:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { isMapping, stringItems } from "../shared/raw-values.js";
import { BOOLEAN_CONTROL_SET, isGetOnlyKey, isUrlKey } from "./keys.js";

// --- Actor vocabulary (branches force_push_bypassers) ------------------------

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

// --- Actor holders: restrictions, dismissal_restrictions, bypass_pull_request_allowances --------

const ACTOR_LIST_EXAMPLE = {
  users: { nameKey: "login", example: "octocat" },
  teams: { nameKey: "slug", example: "platform-team" },
  apps: { nameKey: "slug", example: "deploy-gate" },
} as const;
type ActorList = keyof typeof ACTOR_LIST_EXAMPLE;

function copiedActorName(item: unknown): string | null {
  if (!isMapping(item)) {
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

/**
 * The PUT requires users and teams under restrictions (apps stays optional), so a mapping missing
 * either would 422 at apply and is refused at parse instead.
 */
const Restrictions = z.looseObject(
  {
    users: actorList("restrictions", "users"),
    teams: actorList("restrictions", "teams"),
    apps: actorList("restrictions", "apps").optional(),
  },
  { error: holderError("restrictions") },
);

// --- Controls whose wrong shapes the settings file alone reveals ---------------

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

/**
 * One required check, GitHub's PUT vocabulary exactly: the check's name and the App that must report
 * it (`null` reads back from GitHub as "any App" and is sent as -1, see index.ts putStatusChecks).
 */
const RequiredStatusCheck = z.strictObject(
  {
    context: z.string({ error: CHECK_CONTEXT_ERROR }),
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
  .superRefine((status, refineCtx) => {
    if (status.contexts === undefined && status.checks === undefined) {
      refineCtx.addIssue({ code: "custom", message: CHECK_LIST_ERROR });
    }
  })
  // The refinement's published-schema twin: zod refinements do not reach z.toJSONSchema, and
  // test/published-schema.test.ts holds the two sides to the same verdicts.
  .meta({ anyOf: [{ required: ["contexts"] }, { required: ["checks"] }] });

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
  },
  {
    error:
      "required_pull_request_reviews must be a mapping of its keys (required_approving_review_count and the other review settings), or null to turn the requirement off",
  },
);

/** What carries the fact a GET-only echo repeats, so the message can say why removing it loses nothing. */
const ECHO_CARRIER: Readonly<Record<string, string>> = {
  name: "the entry's name already names the branch",
  enabled: "the control's own key carries the toggle",
  enforcement_level: "strict and the check list carry the requirement",
};

/**
 * The fix for each GET-only key a copied GET response carries. The bare-boolean advice is offered
 * only under a control the PUT takes as a boolean: under a mapping-valued one such as
 * required_pull_request_reviews, "declare required_pull_request_reviews: true" would itself be refused.
 */
function getOnlyKeyError(path: readonly (string | number)[], key: string, value: unknown): string {
  const site = ["protection", ...path, key].join(".");
  const parent = path.at(-1);
  if (
    key === "enabled" &&
    typeof parent === "string" &&
    BOOLEAN_CONTROL_SET.has(parent) &&
    typeof value === "boolean"
  ) {
    return `${site} is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare ${parent}: ${value} instead`;
  }
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
  if (!Array.isArray(value) && !isMapping(value)) {
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
          message: getOnlyKeyError(path, key, inner),
        });
        continue;
      }
      refuseGetOnlyKeys(inner, [...path, key], refineCtx, ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * The keys the schema declares under each open protection mapping, by the mapping's dotted path.
 * index.ts completes the PUT vocabulary with the controls that pass through (the boolean controls,
 * the review booleans) and notes a declared key outside it that the GET never echoes.
 */
export const PROTECTION_MAPPING_KEYS = {
  required_status_checks: Object.keys(RequiredStatusChecks.shape),
  required_pull_request_reviews: Object.keys(RequiredPullRequestReviews.shape),
  "required_pull_request_reviews.dismissal_restrictions": Object.keys(ACTOR_LIST_EXAMPLE),
  "required_pull_request_reviews.bypass_pull_request_allowances": Object.keys(ACTOR_LIST_EXAMPLE),
  restrictions: Object.keys(Restrictions.shape),
} as const satisfies Readonly<Record<string, readonly string[]>>;

export const BranchProtectionConfig = z
  .looseObject({
    required_status_checks: RequiredStatusChecks.nullable().optional(),
    required_pull_request_reviews: RequiredPullRequestReviews.nullable().optional(),
    restrictions: Restrictions.nullable().optional(),
    required_signatures: z
      .boolean({
        error:
          'required_signatures must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous',
      })
      .optional(),
    force_push_bypassers: z
      .array(
        z.string().refine((raw) => parseBypassActor(raw) !== null, { error: ACTOR_FORM_ERROR }),
      )
      .optional(),
    required_deployments: z
      .strictObject({ environments: z.array(z.string()) })
      .nullable()
      .optional(),
  })
  // Every depth: the wrappers sit under each control, and the links under the actor holders too.
  .superRefine((protection, refineCtx) => {
    refuseGetOnlyKeys(protection, [], refineCtx);
  })
  .meta({ id: "BranchProtectionConfig" });
export type BranchProtectionConfig = z.infer<typeof BranchProtectionConfig>;

export const BranchConfig = z
  .object({
    name: z.string(),
    protection: BranchProtectionConfig.nullable(),
  })
  .superRefine((entry, refineCtx) => {
    // GitHub canonicalizes actor and environment names case-insensitively and the routed lists
    // replace wholesale, so a duplicate would apply "successfully" and then drift forever against
    // the deduplicated read-back.
    const routed = entry.protection;
    if (isMapping(routed)) {
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
  })
  .meta({ id: "BranchConfig" });
export type BranchConfig = z.infer<typeof BranchConfig>;

export const BranchesConfig = z.array(BranchConfig);

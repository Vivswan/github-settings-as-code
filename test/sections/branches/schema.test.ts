import { describe, expect, test } from "bun:test";
import { branchesSection, protectionSnapshot } from "../../../src/sections/branches/index.js";

/** Every issue as "path: message", so a case pins the whole verdict and not one line of it. */
function issues(entries: unknown[]): string[] {
  const parsed = branchesSection.shape.safeParse(entries);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

const WILDCARD_KEYS =
  "enforce_admins, required_linear_history, allow_force_pushes, allow_deletions, " +
  "block_creations, required_conversation_resolution, lock_branch, allow_fork_syncing, " +
  "required_signatures, required_status_checks, required_pull_request_reviews, " +
  "force_push_bypassers, required_deployments";

const cases: Array<{
  refused: string;
  protection: Record<string, unknown>;
  name?: string;
  paths: string[];
  /** The message of every issue in full (one per path when they differ): the path never stands in for it. */
  fix: string | string[];
}> = [
  {
    refused: "a status-check requirement without strict (the PUT 422s on it)",
    protection: { required_status_checks: { contexts: ["ci"] } },
    paths: ["0.protection.required_status_checks.strict"],
    fix: "required_status_checks.strict must be an unquoted true or false (GitHub's protection PUT rejects the requirement without it): true also requires the branch to be up to date with its base before merging, false only requires the checks to pass",
  },
  {
    refused: "a status-check requirement without a check list (the PUT 422s on it)",
    protection: { required_status_checks: { strict: true } },
    paths: ["0.protection.required_status_checks"],
    fix: "required_status_checks must list the required checks as contexts: [names] or checks: [{context, app_id}] (GitHub's protection PUT rejects the requirement without them); contexts: [] requires none",
  },
  {
    refused: "a restrictions holder without its users and teams lists (the PUT 422s on it)",
    protection: { restrictions: {} },
    paths: ["0.protection.restrictions.users", "0.protection.restrictions.teams"],
    fix: "protection.restrictions must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; restrictions: null lifts the push restriction",
  },
  {
    refused: "a restrictions holder naming only apps (the PUT 422s without users and teams)",
    protection: { restrictions: { apps: ["deploy-gate"] } },
    paths: ["0.protection.restrictions.users", "0.protection.restrictions.teams"],
    fix: "protection.restrictions must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; restrictions: null lifts the push restriction",
  },
  {
    refused: "a restrictions holder naming users but no teams",
    protection: { restrictions: { users: ["octocat"] } },
    paths: ["0.protection.restrictions.teams"],
    fix: "protection.restrictions must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; restrictions: null lifts the push restriction",
  },
  {
    refused: "a check item carrying a key the PUT has no word for",
    protection: {
      required_status_checks: { strict: true, checks: [{ context: "ci", app: "ci-bot" }] },
    },
    paths: ["0.protection.required_status_checks.checks.0"],
    fix: 'a required_status_checks.checks item takes only context and app_id (GitHub\'s protection PUT has no other field there); remove "app"',
  },
  {
    refused: "a check item without its context",
    protection: { required_status_checks: { strict: true, checks: [{ app_id: 15368 }] } },
    paths: ["0.protection.required_status_checks.checks.0.context"],
    fix: "required_status_checks.checks[].context must be the check's name, as a string",
  },
  {
    refused: "a fractional app_id on a check item",
    protection: {
      required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 1.5 }] },
    },
    paths: ["0.protection.required_status_checks.checks.0.app_id"],
    fix: "required_status_checks.checks[].app_id must be a whole number: the id of the GitHub App that must report the check, or -1 to let any App report it; omit it to pin whichever App reported it last",
  },
  {
    refused: "a bare name where a check item goes",
    protection: { required_status_checks: { strict: true, checks: ["ci"] } },
    paths: ["0.protection.required_status_checks.checks.0"],
    fix: "each required_status_checks.checks item is a {context, app_id} mapping naming one required check; a bare name goes under contexts: [names]",
  },
  {
    refused: "a scalar where the status-check mapping goes, on a literal branch",
    protection: { required_status_checks: true },
    paths: ["0.protection.required_status_checks"],
    fix: "required_status_checks must be a mapping of its keys (strict, then contexts or checks), or null to turn the requirement off",
  },
  {
    refused: "a scalar where the review mapping goes, on a wildcard rule",
    name: "release/*",
    protection: { required_pull_request_reviews: 5 },
    paths: ["0.protection.required_pull_request_reviews"],
    fix: "required_pull_request_reviews must be a mapping of its keys (required_approving_review_count and the other review settings), or null to turn the requirement off",
  },
  {
    refused:
      "a GET echo of enabled under a mapping-valued control, without advising a boolean the control cannot be",
    protection: {
      required_status_checks: { strict: true, contexts: ["ci"], enabled: true },
      required_pull_request_reviews: { enabled: true },
    },
    paths: [
      "0.protection.required_status_checks.enabled",
      "0.protection.required_pull_request_reviews.enabled",
    ],
    fix: ["required_status_checks", "required_pull_request_reviews"].map(
      (control) =>
        `protection.${control}.enabled is GitHub's GET-only echo, which the protection PUT has no word for; remove it (the control's own key carries the toggle)`,
    ),
  },
  {
    refused: "a review count of 7 (GitHub 422s above 6)",
    protection: { required_pull_request_reviews: { required_approving_review_count: 7 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "required_pull_request_reviews.required_approving_review_count must be a whole number from 0 to 6 (GitHub accepts 1 to 6, or 0 to require no approvals)",
  },
  {
    refused: "a fractional review count",
    protection: { required_pull_request_reviews: { required_approving_review_count: 1.5 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "required_pull_request_reviews.required_approving_review_count must be a whole number from 0 to 6 (GitHub accepts 1 to 6, or 0 to require no approvals)",
  },
  {
    refused: "a negative review count",
    protection: { required_pull_request_reviews: { required_approving_review_count: -1 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "required_pull_request_reviews.required_approving_review_count must be a whole number from 0 to 6 (GitHub accepts 1 to 6, or 0 to require no approvals)",
  },
  {
    // Typed in the zod shape so document validation rejects it before any section writes, not as a
    // plan-time throw after earlier sections applied.
    refused: 'a quoted "true" for the signatures toggle, with the YAML gotcha named',
    protection: { enforce_admins: true, required_signatures: "true" },
    paths: ["0.protection.required_signatures"],
    fix: 'required_signatures must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the toggle direction is unambiguous',
  },
  {
    // The same key on a LITERAL entry stays a passthrough (the parses-clean case below).
    refused: "an untranslatable key on a wildcard rule, naming the supported set",
    name: "release/*",
    protection: { enforce_admins: true, restrictions: { users: [], teams: [] } },
    paths: ["0.protection.restrictions"],
    fix:
      'the wildcard entry "release/*" declares protection.restrictions, which this section does ' +
      "not manage on wildcard rules; only the keys it can round-trip through the GraphQL rule " +
      "mutations apply here: [" +
      String(WILDCARD_KEYS) +
      "]. For actor lists and richer controls, prefer the rulesets section (the modern successor " +
      "of classic protection)",
  },
  {
    refused: "a wildcard sub-key the rule mutation has no word for",
    name: "release/*",
    protection: { required_status_checks: { strict: true, checks: [] } },
    paths: ["0.protection.required_status_checks.checks"],
    fix:
      'the wildcard entry "release/*" declares protection.required_status_checks.checks, which ' +
      "this section does not manage on wildcard rules; only the keys it can round-trip through " +
      "the GraphQL rule mutations apply here: [" +
      String(WILDCARD_KEYS) +
      "]. For actor lists and richer controls, prefer the rulesets section (the modern successor " +
      "of classic protection)",
  },
  {
    refused: "a malformed actor in a routed list",
    protection: { force_push_bypassers: ["a/b/c"] },
    paths: ["0.protection.force_push_bypassers.0"],
    fix: 'each force_push_bypassers actor must be a bare user login ("octocat"), "org/team-slug" for a team, or "app/slug" for a GitHub App',
  },
  {
    refused: "case-insensitive duplicates in a routed actor list",
    protection: { force_push_bypassers: ["octocat", "OctoCat"] },
    paths: ["0.protection.force_push_bypassers"],
    fix: 'force_push_bypassers lists "OctoCat" more than once (actor names are case-insensitive); keep one entry per actor',
  },
  {
    refused: "case-insensitive duplicates in the required environments",
    protection: { required_deployments: { environments: ["prod", "Prod"] } },
    paths: ["0.protection.required_deployments.environments"],
    fix: 'required_deployments.environments lists "Prod" more than once (environment names are case-insensitive); keep one entry per environment',
  },
];

describe("branches protection parse rules", () => {
  test.each(cases)("refuses $refused", ({ name, protection, paths, fix }) => {
    const found = issues([{ name: name ?? "main", protection }]).map((issue) => {
      const colon = issue.indexOf(":");
      return { path: issue.slice(0, colon), message: issue.slice(colon + 2) };
    });
    expect(found.map((issue) => issue.path)).toEqual(paths);
    expect(found.map((issue) => issue.message)).toEqual(
      Array.isArray(fix) ? fix : paths.map(() => fix),
    );
  });

  // The GET expands each actor into an object; the PUT takes the login/slug string, so a copied
  // list reached the PUT as objects and 422d there.
  const holders = [
    {
      holder: "restrictions",
      // The PUT requires users and teams here, so the two ride along and the copied list stands alone.
      at: (holder: object) => ({ restrictions: { users: [], teams: [], ...holder } }),
    },
    {
      holder: "required_pull_request_reviews.dismissal_restrictions",
      at: (holder: object) => ({
        required_pull_request_reviews: { dismissal_restrictions: holder },
      }),
    },
    {
      holder: "required_pull_request_reviews.bypass_pull_request_allowances",
      at: (holder: object) => ({
        required_pull_request_reviews: { bypass_pull_request_allowances: holder },
      }),
    },
  ];
  const lists = [
    { list: "users", copied: { login: "octocat", id: 1, type: "User" }, name: "octocat" },
    { list: "teams", copied: { slug: "platform", id: 2, name: "Platform" }, name: "platform" },
    { list: "apps", copied: { slug: "deploy-gate", id: 3, owner: {} }, name: "deploy-gate" },
  ];
  test.each(holders.flatMap((h) => lists.map((l) => ({ ...h, ...l }))))(
    "refuses a copied GET object in $list under $holder, naming the string to write",
    ({ holder, at, list, copied, name }) => {
      const found = issues([{ name: "main", protection: at({ [list]: [copied] }) }]);
      expect(found).toEqual([
        `0.protection.${holder}.${list}.0: protection.${holder}.${list} carries an actor object copied from GitHub's GET response, which the protection PUT takes as the ${list === "users" ? "login" : "slug"} string; write "${name}" instead`,
      ]);
      expect(issues([{ name: "main", protection: at({ [list]: [name] }) }])).toEqual([]);
    },
  );

  test("an actor item that is neither a string nor a GET object, and a holder that is not a mapping, are refused by the type rule", () => {
    expect(
      issues([
        {
          name: "main",
          protection: {
            restrictions: { users: [7], teams: "platform" },
            required_pull_request_reviews: { dismissal_restrictions: true },
          },
        },
      ]),
    ).toEqual([
      '0.protection.required_pull_request_reviews.dismissal_restrictions: protection.required_pull_request_reviews.dismissal_restrictions must be a mapping of users, teams, and apps lists, each actor its login or slug string ("octocat")',
      '0.protection.restrictions.users.0: protection.restrictions.users lists each actor as its login string ("octocat")',
      '0.protection.restrictions.teams: protection.restrictions.teams lists each actor as its slug string ("platform-team")',
    ]);
  });

  test("a protection copied from GitHub's GET response is refused key by key, while its snapshot projection parses clean", () => {
    // Without the refusal the {enabled} wrappers 422 at the PUT and the links and echoes never read back equal, so check reports drift forever.
    const getBody = {
      url: "https://api.github.com/repos/octocat/hello-world/branches/main/protection",
      name: "main",
      enabled: true,
      enforce_admins: {
        url: "https://api.github.com/repos/octocat/hello-world/branches/main/protection/enforce_admins",
        enabled: true,
      },
      required_status_checks: {
        strict: true,
        contexts: ["ci"],
        checks: [{ context: "ci", app_id: null }],
        contexts_url:
          "https://api.github.com/repos/octocat/hello-world/branches/main/protection/required_status_checks/contexts",
        enforcement_level: "everyone",
      },
      restrictions: {
        users: [{ login: "octocat" }],
        teams: [],
        apps: [],
        users_url:
          "https://api.github.com/repos/octocat/hello-world/branches/main/protection/restrictions/users",
      },
    };
    // The actor object is a typed field's failure; the mapping's own key sweep runs beside it (loosen() rewires
    // every check to report beside a failed sibling), so the whole copy is refused in one round.
    const keySweep = [
      "0.protection.required_status_checks.contexts_url: protection.required_status_checks.contexts_url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.required_status_checks.enforcement_level: protection.required_status_checks.enforcement_level is GitHub's GET-only echo, which the protection PUT has no word for; remove it (strict and the check list carry the requirement)",
      "0.protection.restrictions.users_url: protection.restrictions.users_url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.url: protection.url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.name: protection.name is GitHub's GET-only echo, which the protection PUT has no word for; remove it (the entry's name already names the branch)",
      "0.protection.enabled: protection.enabled is GitHub's GET-only echo, which the protection PUT has no word for; remove it (the control's own key carries the toggle)",
      "0.protection.enforce_admins.url: protection.enforce_admins.url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.enforce_admins.enabled: protection.enforce_admins.enabled is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare enforce_admins: true instead",
    ];
    expect(issues([{ name: "main", protection: getBody }])).toEqual([
      '0.protection.restrictions.users.0: protection.restrictions.users carries an actor object copied from GitHub\'s GET response, which the protection PUT takes as the login string; write "octocat" instead',
      ...keySweep,
    ]);
    const stringActors = {
      ...getBody,
      restrictions: { ...getBody.restrictions, users: ["octocat"] },
    };
    expect(issues([{ name: "main", protection: stringActors }])).toEqual(keySweep);
    expect(issues([{ name: "main", protection: protectionSnapshot(getBody) }])).toEqual([]);
  });

  test("a protection aliased to itself is left to the engine's document-cycle diagnostic instead of overflowing the key walk, and a shared alias is reported at both sites", () => {
    // The mapping doubles as its own restrictions holder, so it carries the two lists the PUT requires.
    const self: Record<string, unknown> = { users: [], teams: [] };
    self.restrictions = self;
    expect(issues([{ name: "main", protection: self }])).toEqual([]);
    const wrapper = { enabled: true };
    expect(
      issues([{ name: "main", protection: { enforce_admins: wrapper, lock_branch: wrapper } }]).map(
        (issue) => issue.slice(0, issue.indexOf(":")),
      ),
    ).toEqual(["0.protection.enforce_admins.enabled", "0.protection.lock_branch.enabled"]);
  });

  test("every shape the PUT and the rule mutation take parses clean, off controls and edge values included", () => {
    expect(
      issues([
        {
          name: "main",
          protection: {
            required_status_checks: { strict: false, contexts: [] },
            required_pull_request_reviews: { required_approving_review_count: 0 },
            enforce_admins: true,
            restrictions: null,
          },
        },
        {
          name: "develop",
          protection: {
            required_status_checks: { strict: true, checks: [{ context: "ci", app_id: null }] },
            required_pull_request_reviews: {
              required_approving_review_count: 6,
              dismiss_stale_reviews: true,
              // GitHub's PUT takes every list of the two review-side holders as optional and reads
              // an empty holder as "disabled", so the bare mapping is the documented off spelling.
              dismissal_restrictions: {},
              bypass_pull_request_allowances: {},
            },
            // The PUT requires users and teams under restrictions and only apps may be omitted.
            restrictions: { users: [], teams: [] },
          },
        },
        {
          name: "release/*",
          protection: { required_status_checks: null, required_pull_request_reviews: null },
        },
        // A key outside the PUT vocabulary passes the shape (the plan notes it); null removes protection.
        {
          name: "main",
          protection: { enforce_admins: true, required_signatures: true, extra_field: "x" },
        },
        { name: "legacy", protection: null },
      ]),
    ).toEqual([]);
  });
});

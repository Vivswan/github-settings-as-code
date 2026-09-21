import { describe, expect, test } from "bun:test";
import { branchesSection, protectionSnapshot } from "./index.js";

/** Every issue as "path: message", so a case pins the whole verdict and not one line of it. */
function issues(entries: unknown[]): string[] {
  const parsed = branchesSection.shape.safeParse(entries);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

const cases: Array<{
  refused: string;
  protection: Record<string, unknown>;
  name?: string;
  paths: string[];
  fix: string;
}> = [
  {
    refused: "a status-check requirement without strict (the PUT 422s on it)",
    protection: { required_status_checks: { contexts: ["ci"] } },
    paths: ["0.protection.required_status_checks.strict"],
    fix: "up to date with its base",
  },
  {
    refused: "a status-check requirement without a check list (the PUT 422s on it)",
    protection: { required_status_checks: { strict: true } },
    paths: ["0.protection.required_status_checks"],
    fix: "contexts: [] requires none",
  },
  {
    refused: "a restrictions holder without its users and teams lists (the PUT 422s on it)",
    protection: { restrictions: {} },
    paths: ["0.protection.restrictions.users", "0.protection.restrictions.teams"],
    fix: "restrictions: null lifts the push restriction",
  },
  {
    refused: "a restrictions holder naming only apps (the PUT 422s without users and teams)",
    protection: { restrictions: { apps: ["deploy-gate"] } },
    paths: ["0.protection.restrictions.users", "0.protection.restrictions.teams"],
    fix: "must carry both users and teams",
  },
  {
    refused: "a restrictions holder naming users but no teams",
    protection: { restrictions: { users: ["octocat"] } },
    paths: ["0.protection.restrictions.teams"],
    fix: "[] when none",
  },
  {
    refused: "a check item carrying a key the PUT has no word for",
    protection: {
      required_status_checks: { strict: true, checks: [{ context: "ci", app: "ci-bot" }] },
    },
    paths: ["0.protection.required_status_checks.checks.0"],
    fix: 'remove "app"',
  },
  {
    refused: "a check item without its context",
    protection: { required_status_checks: { strict: true, checks: [{ app_id: 15368 }] } },
    paths: ["0.protection.required_status_checks.checks.0.context"],
    fix: "the check's name",
  },
  {
    refused: "a fractional app_id on a check item",
    protection: {
      required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 1.5 }] },
    },
    paths: ["0.protection.required_status_checks.checks.0.app_id"],
    fix: "-1",
  },
  {
    refused: "a bare name where a check item goes",
    protection: { required_status_checks: { strict: true, checks: ["ci"] } },
    paths: ["0.protection.required_status_checks.checks.0"],
    fix: "contexts: [names]",
  },
  {
    refused: "a scalar where the status-check mapping goes, on a literal branch",
    protection: { required_status_checks: true },
    paths: ["0.protection.required_status_checks"],
    fix: "or null to turn the requirement off",
  },
  {
    refused: "a scalar where the review mapping goes, on a wildcard rule",
    name: "release/*",
    protection: { required_pull_request_reviews: 5 },
    paths: ["0.protection.required_pull_request_reviews"],
    fix: "or null to turn the requirement off",
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
    fix: "remove it (the control's own key carries the toggle)",
  },
  {
    refused: "a review count of 7 (GitHub 422s above 6)",
    protection: { required_pull_request_reviews: { required_approving_review_count: 7 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "from 0 to 6",
  },
  {
    refused: "a fractional review count",
    protection: { required_pull_request_reviews: { required_approving_review_count: 1.5 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "from 0 to 6",
  },
  {
    refused: "a negative review count",
    protection: { required_pull_request_reviews: { required_approving_review_count: -1 } },
    paths: ["0.protection.required_pull_request_reviews.required_approving_review_count"],
    fix: "from 0 to 6",
  },
];

describe("branches protection parse rules", () => {
  test.each(cases)("refuses $refused", ({ name, protection, paths, fix }) => {
    const found = issues([{ name: name ?? "main", protection }]);
    expect(found.map((issue) => issue.slice(0, issue.indexOf(":")))).toEqual(paths);
    for (const issue of found) {
      expect(issue).toContain(fix);
    }
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
    // The actor object is a typed field's failure, and zod runs the mapping's own key sweep only
    // once its fields parse: the copy is refused in two rounds, the string first, then the keys.
    expect(issues([{ name: "main", protection: getBody }])).toEqual([
      '0.protection.restrictions.users.0: protection.restrictions.users carries an actor object copied from GitHub\'s GET response, which the protection PUT takes as the login string; write "octocat" instead',
    ]);
    const stringActors = {
      ...getBody,
      restrictions: { ...getBody.restrictions, users: ["octocat"] },
    };
    expect(issues([{ name: "main", protection: stringActors }])).toEqual([
      "0.protection.required_status_checks.contexts_url: protection.required_status_checks.contexts_url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.required_status_checks.enforcement_level: protection.required_status_checks.enforcement_level is GitHub's GET-only echo, which the protection PUT has no word for; remove it (strict and the check list carry the requirement)",
      "0.protection.restrictions.users_url: protection.restrictions.users_url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.url: protection.url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.name: protection.name is GitHub's GET-only echo, which the protection PUT has no word for; remove it (the entry's name already names the branch)",
      "0.protection.enabled: protection.enabled is GitHub's GET-only echo, which the protection PUT has no word for; remove it (the control's own key carries the toggle)",
      "0.protection.enforce_admins.url: protection.enforce_admins.url is a link GitHub's GET response carries and the protection PUT has no word for; remove it",
      "0.protection.enforce_admins.enabled: protection.enforce_admins.enabled is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare enforce_admins: true instead",
    ]);
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
      ]),
    ).toEqual([]);
  });
});

/**
 * GitHub's interaction-limit rules the platform does not enforce for us before the wire: limit and expiry are closed
 * enums (a typo 422s the PUT, and since the PUT re-arms on every apply the typo can never surface earlier), the PUT
 * body is exactly limit and expiry (a declared origin or expires_at is GitHub's read-back and diffs unequal forever),
 * and max_open_pull_requests is a whole number in GitHub's 1 to 1000 range. Parsed through the loosened document
 * shape, so a rule that survives here reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { interactionLimitsSection } from "../../../src/sections/interaction_limits/index.js";

function verdict(interactionLimits: unknown): { ok: true } | { issues: readonly string[] } {
  return validateSectionShapes({ interaction_limits: interactionLimits }, "settings.yml").match(
    () => ({ ok: true }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

const LIMIT_RULE =
  /^interaction_limits\.limit: limit is one of existing_users, contributors_only, collaborators_only/;
const EXPIRY_RULE =
  /^interaction_limits\.expiry: expiry is one of one_day, three_days, one_week, one_month, six_months/;
const CAP_RULE =
  /^interaction_limits\.pull_request_creation_cap\.max_open_pull_requests: max_open_pull_requests is a whole number from 1 to 1000/;
const KNOWN_KEYS =
  "interaction_limits takes limit, expiry, pull_request_creation_cap, and pull_request_creation_bypass " +
  "\\(origin and expires_at are what GitHub reports, not what it accepts\\); remove the key, or fix its spelling$";
const unrecognized = (keys: string) =>
  new RegExp(`^interaction_limits: Unrecognized ${keys}; ${KNOWN_KEYS}`);
const NEEDS_LIMIT =
  /^interaction_limits\.limit: expiry rides the base interaction-limits PUT, which requires a limit; declare limit alongside it, or remove expiry$/;
const NEEDS_ONE_GROUP =
  /^interaction_limits: declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass/;

describe("an interaction limit GitHub would 422, or could never converge on, never reaches it", () => {
  test.each<[what: string, doc: unknown]>([
    ["a limit alone", { limit: "existing_users" }],
    ["a limit with the longest expiry", { limit: "collaborators_only", expiry: "six_months" }],
    [
      "the cap at GitHub's floor",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 1 } },
    ],
    [
      "the cap at GitHub's ceiling",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 1000 } },
    ],
    ["a cap flag without a number", { pull_request_creation_cap: { enabled: false } }],
    ["an empty bypass list", { pull_request_creation_bypass: [] }],
    ["null, which clears the base limit", null],
  ])("what GitHub accepts parses: %s", (_what, doc) => {
    expect(verdict(doc)).toEqual({ ok: true });
  });

  test.each<[what: string, doc: unknown, issues: RegExp[]]>([
    [
      "a limit GitHub has no group for (422 on the re-arming PUT)",
      { limit: "collaborators" },
      [LIMIT_RULE],
    ],
    ["a numeric limit", { limit: 7 }, [LIMIT_RULE]],
    [
      "an expiry GitHub has no duration for",
      { limit: "existing_users", expiry: "two_weeks" },
      [EXPIRY_RULE],
    ],
    [
      "GitHub's computed expires_at, which moves on every re-arm and would drift forever",
      { limit: "existing_users", expires_at: "2027-01-01T00:00:00Z" },
      [unrecognized('key: "expires_at"')],
    ],
    [
      "GitHub's origin, which the PUT never accepts",
      { limit: "existing_users", origin: "repository" },
      [unrecognized('key: "origin"')],
    ],
    [
      "two misspelled keys, both named in one issue",
      { limit: "existing_users", expiry_days: 7, pull_request_creation_caps: { enabled: true } },
      [unrecognized('keys: "expiry_days", "pull_request_creation_caps"')],
    ],
    [
      "an expiry without a limit, which would ride a PUT that never fires",
      { expiry: "one_week", pull_request_creation_cap: { enabled: true } },
      [NEEDS_LIMIT],
    ],
    ["an object declaring none of the three groups", {}, [NEEDS_ONE_GROUP]],
    [
      "a cap of zero",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 0 } },
      [CAP_RULE],
    ],
    [
      "a negative cap",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: -1 } },
      [CAP_RULE],
    ],
    [
      "a fractional cap",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 2.5 } },
      [CAP_RULE],
    ],
    [
      "a cap over GitHub's ceiling",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: 1001 } },
      [CAP_RULE],
    ],
    [
      "a YAML-quoted cap number",
      { pull_request_creation_cap: { enabled: true, max_open_pull_requests: "5" } },
      [CAP_RULE],
    ],
    [
      'a YAML-quoted "true" cap flag',
      { pull_request_creation_cap: { enabled: "true" } },
      [
        /^interaction_limits\.pull_request_creation_cap\.enabled: enabled must be an unquoted true or false/,
      ],
    ],
    [
      "a bypass list over GitHub's 100-user cap",
      { pull_request_creation_bypass: Array.from({ length: 101 }, (_, i) => `user-${i}`) },
      [
        /^interaction_limits\.pull_request_creation_bypass: GitHub caps the bypass list at 100 users, but 101 logins are declared/,
      ],
    ],
    [
      "two case-variant spellings of one login",
      { pull_request_creation_bypass: ["octocat", "Octocat"] },
      [
        /^interaction_limits\.pull_request_creation_bypass: "octocat" and "Octocat" name the same login/,
      ],
    ],
  ])(
    "what GitHub rejects fails at parse, naming the key and the rule: %s",
    (_what, doc, issues) => {
      expect(verdict(doc)).toEqual({ issues: issues.map((issue) => expect.stringMatching(issue)) });
    },
  );

  test("a cap key this version does not know survives the parse: the cap object is open, and the phantom note reports it at plan time", () => {
    // The section is strict but the cap is a plain object, which loosen() turns into passthrough; a strip here would
    // silently drop a future PATCH field instead of sending it.
    const cap = { enabled: true, max_open_prs: 5 };
    expect(interactionLimitsSection.shape.parse({ pull_request_creation_cap: cap })).toEqual({
      pull_request_creation_cap: cap,
    });
  });
});

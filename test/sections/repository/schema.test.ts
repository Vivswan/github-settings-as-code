/**
 * The repository section's parse refusals, each pinned as the problem line a user reads: a quoted boolean or a bare
 * number where the PATCH takes a toggle or a string, the vocabularies GitHub 422s (feature status, creation
 * policy, the commit-message pairs), the topic grammar and cap, the closed security_and_analysis shape, and the
 * GET-only fields that would drift forever. Parsed through the loosened document shape, so a rule that survives here
 * reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(repository: Record<string, unknown>): readonly string[] | null {
  return validateSectionShapes({ repository }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const SQUASH_PAIRS =
  ". Legal pairs: PR_TITLE with PR_BODY or BLANK or COMMIT_MESSAGES; COMMIT_OR_PR_TITLE with COMMIT_MESSAGES";

describe("a repository setting GitHub would 422 or never converge on is refused at parse, naming the key and the fix", () => {
  test.each<[what: string, repository: Record<string, unknown>, expected: string[]]>([
    [
      "a YAML-quoted toggle",
      { has_issues: "yes" },
      [
        'repository.has_issues: "yes" is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)',
      ],
    ],
    [
      "a list where a toggle goes",
      { has_issues: ["yes"] },
      [
        'repository.has_issues: a list is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)',
      ],
    ],
    [
      "a mapping where a toggle goes",
      { has_issues: { on: true } },
      [
        'repository.has_issues: a mapping is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)',
      ],
    ],
    [
      "a bare number where a clearable string goes",
      { description: 5 },
      [
        "repository.description: 5 is not a string; quote the value, or write null to clear the field",
      ],
    ],
    [
      "a bare number where a string goes",
      { default_branch: 2 },
      ["repository.default_branch: 2 is not a string; quote the value"],
    ],
    [
      "a key a feature toggle does not take",
      { security_and_analysis: { secret_scanning: { enabled: true } } },
      [
        'repository.security_and_analysis.secret_scanning: "enabled" is not a key a security_and_analysis feature accepts (GitHub rejects it with a 422); remove it. Known keys: "status"',
      ],
    ],
    [
      "a bypass reviewer with a key GitHub rejects",
      {
        security_and_analysis: {
          secret_scanning_delegated_bypass_options: {
            reviewers: [{ reviewer_id: 1, reviewer_type: "TEAM", role: "admin" }],
          },
        },
      },
      [
        'repository.security_and_analysis.secret_scanning_delegated_bypass_options.reviewers[0]: "role" is not a key a bypass reviewer accepts (GitHub rejects it with a 422); remove it. Known keys: "reviewer_id", "reviewer_type", "mode"',
      ],
    ],
    [
      "a bypass options key GitHub rejects",
      { security_and_analysis: { secret_scanning_delegated_bypass_options: { reviewer: [] } } },
      [
        'repository.security_and_analysis.secret_scanning_delegated_bypass_options: "reviewer" is not a key secret_scanning_delegated_bypass_options accepts (GitHub rejects it with a 422); remove it. Known keys: "reviewers"',
      ],
    ],
    [
      "a squash title in the wrong case",
      { squash_merge_commit_title: "pr_title" },
      [
        `repository.squash_merge_commit_title: "pr_title" is not a squash_merge_commit_title value; use "PR_TITLE", "COMMIT_OR_PR_TITLE"${SQUASH_PAIRS}`,
      ],
    ],
    [
      "a squash message GitHub has no value for",
      { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_DESCRIPTION" },
      [
        `repository.squash_merge_commit_message: "PR_DESCRIPTION" is not a squash_merge_commit_message value; use "PR_BODY", "BLANK", "COMMIT_MESSAGES"${SQUASH_PAIRS}`,
      ],
    ],
    [
      "a merge message without its title, where GitHub documents no pair matrix",
      { merge_commit_message: "PR_BODY" },
      [
        "repository.merge_commit_message: merge_commit_message needs merge_commit_title declared beside it (GitHub requires the pair)",
      ],
    ],
    [
      "a merge title GitHub has no value for",
      { merge_commit_title: "PR_BODY" },
      [
        'repository.merge_commit_title: "PR_BODY" is not a merge_commit_title value; use "PR_TITLE", "MERGE_MESSAGE"',
      ],
    ],
    [
      "a creation policy spelled in prose",
      { pull_request_creation_policy: "everyone" },
      [
        'repository.pull_request_creation_policy: "everyone" is not a recognized policy. Use "all" (everyone) or "collaborators_only"',
      ],
    ],
    [
      "an empty topic in the list form",
      { topics: ["ci", ""] },
      [
        "repository.topics[1]: an empty topic is not one GitHub accepts; drop the entry, or declare topics: [] to remove every topic",
      ],
    ],
    [
      "a topic starting with a hyphen, in the list form",
      { topics: ["-ci"] },
      [
        'repository.topics[0]: "-ci" is not a topic GitHub accepts: a topic is 1 to 50 characters, each a letter, digit, or hyphen, starting with a letter or digit (uppercase is lowercased on the wire)',
      ],
    ],
    [
      "a topic with a space, in the comma form, named by its position",
      { topics: "ci, bad topic" },
      [
        'repository.topics: "bad topic" (entry 2 of the comma list) is not a topic GitHub accepts: a topic is 1 to 50 characters, each a letter, digit, or hyphen, starting with a letter or digit (uppercase is lowercased on the wire)',
      ],
    ],
    [
      "an empty segment in the comma form",
      { topics: "ci,,docs" },
      [
        "repository.topics: an empty topic (entry 2 of the comma list) is not one GitHub accepts; drop the entry, or declare topics: [] to remove every topic",
      ],
    ],
    [
      "more distinct topics than GitHub stores",
      { topics: Array.from({ length: 21 }, (_, i) => `topic-${i}`) },
      ["repository.topics: 21 topics declared; GitHub allows at most 20"],
    ],
    [
      "a GET-only field no write accepts",
      { full_name: "octocat/hello-world" },
      [
        "repository.full_name: full_name is reported by GitHub but cannot be set through the API; remove it",
      ],
    ],
    [
      "a GET-only field another section owns",
      { has_pages: true },
      [
        "repository.has_pages: has_pages is reported by GitHub but cannot be set through the repository PATCH; declare it in the pages section instead",
      ],
    ],
  ])("%s", (_what, repository, expected) => {
    expect(issues(repository)).toEqual(expected);
  });

  test("the forms GitHub accepts parse: unquoted toggles, null to clear, both topic forms, the documented squash pairs", () => {
    expect(
      issues({
        has_issues: true,
        description: null,
        topics: ["CI", "ci", "docs"],
        squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
        squash_merge_commit_message: "COMMIT_MESSAGES",
        merge_commit_title: "MERGE_MESSAGE",
        merge_commit_message: "PR_TITLE",
        pull_request_creation_policy: "collaborators_only",
        security_and_analysis: { secret_scanning: { status: "enabled" } },
      }),
    ).toBeNull();
    expect(issues({ topics: "ci, docs" })).toBeNull();
  });
});

/**
 * The pages section's parse refusals, each pinned as the problem line a user reads: a field the GET reports that the
 * update PUT has no parameter for, so a declared value would ride the PUT ignored and diff on every run. One row per
 * read-only field, each naming why removing it loses nothing.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(pages: unknown): readonly string[] | null {
  return validateSectionShapes({ pages }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const REPORTED = (fix: string) =>
  `GitHub reports this field on the Pages site and the update has no such parameter, so the value would be sent, ignored, and reported as drift on every run (${fix}); remove it`;

describe("a Pages field the update cannot set is refused at parse, naming the key and why it can go", () => {
  test.each<[key: string, value: unknown, fix: string]>([
    [
      "url",
      "https://api.github.com/repos/o/r/pages",
      "GitHub mints the API address from the repository",
    ],
    [
      "html_url",
      "https://o.github.io/r/",
      "GitHub mints the site address from the repository and `cname`; declare `cname` for a custom domain",
    ],
    ["status", "built", "it reports the latest build's outcome"],
    [
      "custom_404",
      false,
      "it reports whether the published site carries a 404.html; add that file to the source instead",
    ],
    [
      "protected_domain_state",
      "verified",
      "it reports the custom domain's verification; verify the domain in the owner's Pages settings",
    ],
    [
      "pending_domain_unverified_at",
      "2026-10-01T00:00:00Z",
      "it reports the custom domain's verification deadline",
    ],
    [
      "https_certificate",
      { state: "approved" },
      "GitHub provisions the certificate for `cname`; declare `cname` and `https_enforced`",
    ],
  ])("%s", (key, value, fix) => {
    expect(issues({ build_type: "workflow", [key]: value })).toEqual([
      `pages.${key}: ${REPORTED(fix)}`,
    ]);
  });

  test("the fields the update takes parse, and null turns the site off", () => {
    expect(
      issues({
        build_type: "legacy",
        source: { branch: "gh-pages", path: "/docs" },
        cname: "docs.example.com",
        https_enforced: true,
      }),
    ).toBeNull();
    expect(issues(null)).toBeNull();
  });
});

/**
 * The commit subject the autofix hook reports for a regeneration, over the generated-output table's whole files. The
 * platform commits under whatever one-line Conventional Commit the hook hands it, so a wrong pick is silent: a
 * graduation beside regenerated files would land as `build:` or `docs:`.
 */

import { describe, expect, test } from "bun:test";
import { subjectFor } from "../../.github/scripts/autofix-subject.js";

describe("subjectFor", () => {
  test.each<[string, string[], string]>([
    [
      "a gap file rewritten or deleted is a graduation, even beside regenerated files",
      ["README.md", "src/generated/upstream-gaps.ts", "src/upstream-gaps/one.ts"],
      "fix: graduate upstream gaps octokit now ships",
    ],
    [
      "the gaps index alone is a regeneration, not a graduation",
      ["src/generated/upstream-gaps.ts", "docs/reference/coverage.md"],
      "build: regenerate generated files",
    ],
    [
      "generated regions alone are docs",
      ["README.md", "action.yml", "docs/reference/inputs.md"],
      "docs: regenerate generated docs",
    ],
  ])("%s", (_case, changed, subject) => {
    expect(subjectFor(changed)).toBe(subject);
  });
});

/**
 * The commit subject of a regeneration fix, chosen from what the hook (.github/actions/autofix) left in the work
 * tree; the platform's push job commits under it, and falls back to its own default for a subject its gate refuses.
 *
 *   a gap file rewritten or deleted   -> fix: graduate upstream gaps octokit now ships
 *   a whole generated file changed    -> build: regenerate generated files
 *   generated regions alone           -> docs: regenerate generated docs
 *
 * Run: `bun .github/scripts/autofix-subject.ts`; writes `subject=` to GITHUB_OUTPUT.
 */

import * as core from "@actions/core";
import { GENERATED_OUTPUTS } from "./generated.js";
import { output } from "./lib/command.js";
import { runMain } from "./lib/entry.js";

const GAPS_DIR = "src/upstream-gaps/";

/** The subject for a fix over the repo-relative paths it changed, added, or deleted. */
export function subjectFor(changed: readonly string[]): string {
  if (changed.some((path) => path.startsWith(GAPS_DIR))) {
    return "fix: graduate upstream gaps octokit now ships";
  }
  const wholeFiles = new Set(
    GENERATED_OUTPUTS.filter((output) => output.kind === "file").map((output) => output.path),
  );
  return changed.some((path) => wholeFiles.has(path))
    ? "build: regenerate generated files"
    : "docs: regenerate generated docs";
}

/** Every path the work tree holds differently from HEAD: tracked changes and deletions, and files git does not ignore. */
function changedPaths(): string[] {
  const tracked = output(["git", "diff", "--name-only", "--no-renames", "-z", "HEAD"], {
    stderr: "inherit",
  });
  const untracked = output(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
    stderr: "inherit",
  });
  return `${tracked}\0${untracked}`.split("\0").filter((path) => path !== "");
}

if (import.meta.main) {
  await runMain("autofix-subject", () => {
    core.setOutput("subject", subjectFor(changedPaths()));
  });
}

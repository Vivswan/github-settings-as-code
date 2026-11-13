/**
 * The release hook's work on the draft release through gh: the merge commit it targets and the version tag its name
 * gives, the assets it carries before anything publishes, and the rename that hands it to the publish stage.
 */

import { spawnSync } from "node:child_process";
import { capture, run } from "../lib/workflow-step.js";
import { FULL_SHA } from "./git.js";
import { versionTagOf } from "./tags.js";

/** What each subcommand writes to GITHUB_OUTPUT; test/workflows/post-green-workflow.test.ts judges the release hook's later reads of them against this table. */
export const STEP_OUTPUTS = { "resolve-source": ["sha", "tag"] } as const;

/** What the package job uploads to the draft; the managed publish stage attaches attestation.json after the check. */
export const RELEASE_ASSETS = ["index.js", "settings.schema.json"];

/** gh's whole stderr when no release, draft or published, carries the name it was asked for. */
const NO_RELEASE = "release not found";

/** The two fields of the release `resolveSource` reads, under gh's names for them. */
interface SourceView {
  isDraft: boolean;
  targetCommitish: string;
}

/** The release named `marker` as gh reads it, or null when none carries the name. Any other failure ends the step with gh's stderr and status. */
function viewSource(marker: string): SourceView | null {
  const view = spawnSync("gh", ["release", "view", marker, "--json", "isDraft,targetCommitish"], {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (view.error !== undefined) {
    throw view.error;
  }

  if (view.status !== 0 && view.stderr.trim() === NO_RELEASE) {
    return null;
  }

  if (view.status !== 0) {
    process.stderr.write(view.stderr);
    process.exit(view.status ?? 1);
  }

  return JSON.parse(view.stdout) as SourceView;
}

/** The version tag the draft's marker name gives, and the draft's target commitish, where release-please records the
 * merge commit. The release's identity is read from the draft and never from the run's own sha, so a newer push's
 * run can recover an older merge's pending release.
 *
 *   no release under the name  -> refused: the hook's rename took the name, and nothing proceeds under the new one
 *   a published release        -> refused: release-please published the marker's name itself (`"draft": false`)
 *   a target that is no sha    -> refused before a checkout or a tag could name it (a branch name on a hand-made draft)
 */
export function resolveSource(marker: string): { sha: string; tag: string } | { refusal: string } {
  const tag = versionTagOf(marker);
  const view = viewSource(marker);
  if (view === null) {
    return {
      refusal:
        `no release is named ${marker}.\n` +
        `If the release ${tag} exists, the hook already renamed the draft and this job is done: do not re-run it.\n` +
        "Of this workflow's jobs, only publish-npm can still be re-run.",
    };
  }

  if (!view.isDraft) {
    return {
      refusal:
        `release ${marker} is published, not a draft: users already see the marker's name as a release, so nothing is packaged from it.\n` +
        'Fix release-please-config.json by PR: "draft": true on package ".".',
    };
  }

  if (!FULL_SHA.test(view.targetCommitish)) {
    return {
      refusal: `draft ${marker}'s target commitish is '${view.targetCommitish}', not a commit SHA; refusing to package an unidentified source.`,
    };
  }

  return { sha: view.targetCommitish, tag };
}

/** The draft's asset names beside attestation.json, sorted. Publishing freezes the asset list, so an incomplete one
 * must stop while the release is still a draft (v2.0.0 shipped assetless exactly this way). */
export function releaseAssets(marker: string): string[] {
  const view = JSON.parse(capture(["gh", "release", "view", marker, "--json", "assets"])) as {
    assets: { name: string }[];
  };
  return view.assets
    .map((asset) => asset.name)
    .filter((name) => name !== "attestation.json")
    .sort();
}

/** The draft takes the version tag as its tag and title and stays a draft, which the managed publish stage publishes.
 * --verify-tag refuses a tag origin lacks: GitHub would create it on main, at the draft's target, on publish. */
export function renameDraft(marker: string, tag: string): void {
  run(["gh", "release", "edit", marker, "--tag", tag, "--title", tag, "--verify-tag"]);
}

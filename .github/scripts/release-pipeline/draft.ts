/**
 * The release hook's work on the draft release through gh: the merge commit it targets and the version tag its name
 * gives, the assets it carries before anything publishes, and the rename that hands it to the publish stage.
 */

import { capture, run } from "../lib/workflow-step.js";
import { FULL_SHA } from "./git.js";
import { versionTagOf } from "./tags.js";

/** What each subcommand writes to GITHUB_OUTPUT; test/workflows/post-green-workflow.test.ts judges the release hook's later reads of them against this table. */
export const STEP_OUTPUTS = { "resolve-source": ["sha", "tag"] } as const;

/** What the package job uploads to the draft; the managed publish stage attaches attestation.json after the check. */
export const RELEASE_ASSETS = ["index.js", "settings.schema.json"];

/** The version tag the draft's marker name gives, and the draft's target commitish, where release-please records the
 * merge commit. The release's identity is read from the draft and never from the run's own sha, so a newer push's
 * run can recover an older merge's pending release; anything but a full sha (a branch name on a hand-made draft) is
 * refused before a checkout or a tag could name it. */
export function resolveSource(marker: string): { sha: string; tag: string } | { refusal: string } {
  const tag = versionTagOf(marker);
  const target = capture([
    "gh",
    "release",
    "view",
    marker,
    "--json",
    "targetCommitish",
    "--jq",
    ".targetCommitish",
  ]);
  return FULL_SHA.test(target)
    ? { sha: target, tag }
    : {
        refusal: `draft ${marker}'s target commitish is '${target}', not a commit SHA; refusing to package an unidentified source.`,
      };
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

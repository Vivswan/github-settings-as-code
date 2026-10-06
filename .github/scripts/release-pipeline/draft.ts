/**
 * The release hook's reads of the draft release through gh: the merge commit it targets, and the assets it carries
 * before anything publishes.
 */

import { capture } from "../lib/workflow-step.js";
import { FULL_SHA } from "./git.js";

/** What each subcommand writes to GITHUB_OUTPUT: the release hook's later steps and jobs read the resolved merge
 * commit from it, and test/workflows/post-green-workflow.test.ts judges those reads against this table. */
export const STEP_OUTPUTS = { "resolve-source": ["sha"] } as const;
/** What the package job uploads to the draft; the managed publish stage attaches attestation.json after the check. */
export const RELEASE_ASSETS = ["index.js", "settings.schema.json"];

/** The draft's target commitish, where release-please records the merge commit. The release's identity is read from
 * the draft and never from the run's own sha, so a newer push's run can recover an older merge's pending release;
 * anything but a full sha (a branch name on a hand-made draft) is refused before a checkout or a tag could name it. */
export function resolveSource(tag: string): { sha: string } | { refusal: string } {
  const target = capture([
    "gh",
    "release",
    "view",
    tag,
    "--json",
    "targetCommitish",
    "--jq",
    ".targetCommitish",
  ]);
  return FULL_SHA.test(target)
    ? { sha: target }
    : {
        refusal: `draft ${tag}'s target commitish is '${target}', not a commit SHA; refusing to package an unidentified source.`,
      };
}

/** The draft's asset names beside attestation.json, sorted. Publishing freezes the asset list, so an incomplete one
 * must stop while the release is still a draft (v2.0.0 shipped assetless exactly this way). */
export function releaseAssets(tag: string): string[] {
  const view = JSON.parse(capture(["gh", "release", "view", tag, "--json", "assets"])) as {
    assets: { name: string }[];
  };
  return view.assets
    .map((asset) => asset.name)
    .filter((name) => name !== "attestation.json")
    .sort();
}

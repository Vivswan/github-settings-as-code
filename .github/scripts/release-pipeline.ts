/**
 * The release pipeline's git topology. main stays source-only, and every ref a consumer names points at a packaged
 * commit: the child of one main commit, carrying that commit's build. A release puts one tag on main: its marker.
 *
 *   packaged commit                = parent: the main commit; tree: its tree + lib/index.js + lib/settings.schema.json + lib/pkg/,
 *                                     package.json minus its preparation scripts
 *   refs/tags/build/<pos>.<sha7>   -> the packaged commit of the main commit at first-parent position <pos>; never moved
 *   refs/tags/latest               -> the packaged commit of the newest main commit
 *   refs/tags/vX.Y.Z               -> the packaged commit of the release's merge commit; never moved
 *   refs/tags/vX                   -> the same commit, moved on each release in the line
 *   refs/tags/source-vX.Y.Z        -> the release's merge commit itself, on main: the marker; never moved, never pushed here
 *
 * Every artifact is a function of its main commit alone, so runs for different commits never wait on each other
 * and a rerun mints the same name and verifies instead of appending. latest and vX move through movePointer alone.
 * Every subcommand is the whole `run:` of a workflow step; no step runs two.
 *
 * release-please cuts the DRAFT release as source-vX.Y.Z, creates that tag on the merge commit, and finds its
 * previous release by it (release-please-config.json: `draft` and `force-tag-creation` on, component `source`). The
 * release hook parses the name into vX.Y.Z, checks the marker, mints the version refs, and renames the draft.
 *
 * This file dispatches; its sections live under release-pipeline/, as lib/ holds only what several scripts share.
 *
 * Node builtins only: bun runs this before `bun install`.
 */

import { dispatch, type Handler } from "./lib/entry.js";
import { requireEnv, setOutput } from "./lib/workflow-step.js";
import {
  RELEASE_ASSETS,
  releaseAssets,
  renameDraft,
  resolveSource,
  STEP_OUTPUTS,
} from "./release-pipeline/draft.js";
import { packageCommit, packageRelease, retagMajor } from "./release-pipeline/tags.js";

/** The step's working directory: the checkout every subcommand works in. */
const cwd = process.cwd();

/** The subcommands by name; test/workflows reads the keys as the set a step may run. */
export const COMMANDS: Record<string, Handler> = {
  package: () => {
    const tag = requireEnv("TAG");
    const result = packageRelease({
      cwd,
      tag,
      sourceSha: requireEnv("GITHUB_SHA"),
      runUrl: process.env.RUN_URL,
    });
    console.error(
      `${result.created ? "created" : "verified"} ${tag} on packaged commit ${result.packagedSha}; ${result.pruned.length === 0 ? "no build tag beyond the window" : `pruned ${result.pruned.join(", ")}`}; ${result.latest.reason}`,
    );
  },
  "retag-major": () => {
    const result = retagMajor({ cwd, tag: requireEnv("TAG"), sourceSha: requireEnv("GITHUB_SHA") });
    console.error(result.move.reason);
  },
  "package-commit": () => {
    const result = packageCommit({
      cwd,
      sourceSha: requireEnv("GITHUB_SHA"),
      runUrl: process.env.RUN_URL,
    });
    console.error(
      `${result.ref}${result.created ? ": created at" : " already packages the commit at"} ${result.commit}; ${result.pruned.length === 0 ? "no build tag beyond the window" : `pruned ${result.pruned.join(", ")}`}; ${result.latest.reason}`,
    );
  },
  "resolve-source": () => {
    const source = resolveSource(requireEnv("MARKER"));
    if ("ghStatus" in source) {
      return source.ghStatus;
    }
    if ("refusal" in source) {
      console.log(`::error::${source.refusal}`);
      return 1;
    }
    const [sha, tag] = STEP_OUTPUTS["resolve-source"];
    setOutput(sha, source.sha);
    setOutput(tag, source.tag);
  },
  "verify-assets": () => {
    const marker = requireEnv("MARKER");
    const assets = releaseAssets(marker);
    if ("ghStatus" in assets) {
      return assets.ghStatus;
    }
    if (assets.join(" ") !== RELEASE_ASSETS.join(" ")) {
      console.log(
        `::error::release ${marker} carries assets [${assets.join(" ")}], expected ` +
          `[${RELEASE_ASSETS.join(" ")}]; re-run package-release before anything publishes.`,
      );
      return 1;
    }
  },
  "rename-draft": () => {
    const marker = requireEnv("MARKER");
    const tag = requireEnv("TAG");
    const failed = renameDraft(marker, tag);
    if (failed !== 0) {
      return failed;
    }
    console.error(`release ${marker} now carries tag ${tag} and title ${tag}`);
  },
};

if (import.meta.main) {
  await dispatch("release-pipeline", COMMANDS, process.argv.slice(2));
}

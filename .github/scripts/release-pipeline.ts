/**
 * The release pipeline's git topology. main stays source-only, no version tag ever lands on it, and every ref a
 * consumer names points at a packaged commit: the child of one main commit, carrying that commit's build.
 *
 *   packaged commit                = parent: the main commit; tree: its tree + lib/index.js + lib/settings.schema.json + lib/pkg/,
 *                                     package.json minus its preparation scripts
 *   refs/tags/build/<pos>.<sha7>   -> the packaged commit of the main commit at first-parent position <pos>; never moved
 *   refs/tags/latest               -> the packaged commit of the newest main commit
 *   refs/tags/vX.Y.Z               -> the packaged commit of the release's merge commit; never moved
 *   refs/tags/vX                   -> the same commit, moved on each release in the line
 *
 * Every artifact is a function of its main commit alone, so runs for different commits never wait on each other
 * and a rerun mints the same name and verifies instead of appending. latest and vX move through movePointer alone.
 * Every subcommand but prerelease-version is the whole `run:` of one workflow step; no step runs two.
 *
 * release-please cuts the DRAFT release without a tag (`draft` on, `force-tag-creation` off) and creates or
 * refreshes the release PR only when a releasable commit lands (release-please-config.json leaves always-update
 * off); that refresh is what publishes the `next` pre-release.
 *
 * This file dispatches; the sections live under release-pipeline/ rather than lib/, which holds what several
 * scripts share while these belong to this one.
 *
 * Node builtins only: bun runs this before `bun install`.
 */

import { dispatch, type Handler } from "./lib/entry.js";
import { requireEnv, setOutput } from "./lib/workflow-step.js";
import { anchorCheck, anchorReleasePr, boundaryCheck } from "./release-pipeline/anchor.js";
import {
  RELEASE_ASSETS,
  releaseAssets,
  resolveSource,
  STEP_OUTPUTS,
} from "./release-pipeline/draft.js";
import { NPM_FLOOR, npmFloor, npmPublish, prereleaseVersionOf } from "./release-pipeline/npm.js";
import { packageCommit, packageRelease, retagMajor } from "./release-pipeline/tags.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** 15 reads 20 s apart (up to 280 s): three of the first five publishes were still unreadable after 80 s. */
const CONFIRM_READS = 15;
const CONFIRM_PAUSE_MS = 20_000;

/** NPM_CONFIRM_PAUSE_MS exists for the test that confirms against a local registry without the wait. */
function confirmPauseMs(value: string | undefined): number {
  if (value === undefined || value === "") {
    return CONFIRM_PAUSE_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `NPM_CONFIRM_PAUSE_MS must be a whole number of milliseconds, not ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

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
  anchor: () => {
    const result = anchorReleasePr({ cwd, sourceSha: requireEnv("GITHUB_SHA") });
    console.error(result.reason);
  },
  "boundary-check": () => {
    const result = boundaryCheck(cwd);
    console.error(`boundary is fresh: ${result.boundary}`);
  },
  "anchor-check": () => {
    const result = anchorCheck(cwd);
    console.error(`the release PR carries this cycle's anchor: ${result.boundary}`);
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
  "prerelease-version": () => {
    console.log(prereleaseVersionOf({ cwd, sourceSha: requireEnv("GITHUB_SHA") }));
  },
  "npm-publish": async ([channel]) => {
    if (channel !== "next" && channel !== "stable") {
      throw new Error(
        `npm-publish takes the channel, next or stable, not ${JSON.stringify(channel ?? null)}`,
      );
    }
    const result = await npmPublish(
      {
        cwd,
        sourceSha: requireEnv("GITHUB_SHA"),
        registry: process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY,
        ...(channel === "next"
          ? {
              channel,
              confirm: {
                attempts: CONFIRM_READS,
                delayMs: confirmPauseMs(process.env.NPM_CONFIRM_PAUSE_MS),
              },
            }
          : { channel, tag: requireEnv("TAG") }),
      },
      (line) => console.error(line),
    );
    if (!result.published) {
      // A skipped pre-release is routine (a stale retry); a skipped release is a rerun worth a look.
      console.log(`::${channel === "next" ? "notice" : "warning"}::${result.reason}`);
      return;
    }
    if (result.channel === "next") {
      const { confirmed } = result;
      if (confirmed.outcome === "settled") {
        console.log(
          `::notice::${confirmed.version} is on the registry after ${confirmed.reads} ` +
            `${confirmed.reads === 1 ? "read" : "reads"}; next is not behind a descendant's pre-release`,
        );
      } else if (confirmed.outcome === "unsettled") {
        console.log(`::warning::${confirmed.reason}`);
      } else {
        console.log(`::error::${confirmed.reason}`);
        return 1;
      }
    }
  },
  "npm-floor": () => {
    // Silent when the floor holds, as the shell step was; the refusal is the annotation it printed.
    const result = npmFloor();
    if (!result.atFloor) {
      console.log(
        `::error::npm ${result.version} cannot publish through OIDC; trusted publishing needs npm ${NPM_FLOOR} or newer.`,
      );
      return 1;
    }
  },
  "resolve-source": () => {
    const source = resolveSource(requireEnv("TAG"));
    if ("refusal" in source) {
      console.log(`::error::${source.refusal}`);
      return 1;
    }
    setOutput(STEP_OUTPUTS["resolve-source"][0], source.sha);
  },
  "verify-assets": () => {
    const tag = requireEnv("TAG");
    const assets = releaseAssets(tag);
    if (assets.join(" ") !== RELEASE_ASSETS.join(" ")) {
      console.log(
        `::error::release ${tag} carries assets [${assets.join(" ")}], expected ` +
          `[${RELEASE_ASSETS.join(" ")}]; re-run package-release before anything publishes.`,
      );
      return 1;
    }
  },
};

if (import.meta.main) {
  await dispatch("release-pipeline", COMMANDS, process.argv.slice(2));
}

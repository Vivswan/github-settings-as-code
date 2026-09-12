/**
 * Multi-repo orchestration; each target runs independently, and the `defaults-file` document is applied WHOLE to a
 * target without a file, never merged into one that has. Under `private-repos: redact` a hidden target closes SEALED:
 * the summary, outputs, and report reach it only through projections.
 *
 *   resolve targets -> resolve visibility -> plan redaction, mask every hidden slug
 *   -> flush buffered central warnings -> run each target through its channel
 *
 * Before the mask step nothing is emitted that could name a target, except a fatal exit: its message and the flushed
 * central warnings may name slugs the operator wrote into the workflow or the admin repo.
 */

import { readFileSync } from "node:fs";
import { type Err, err, ok, type ResultAsync, safeTry } from "neverthrow";
import { resolveCentralTargets } from "../discovery/central.js";
import { type DiscoveryFilters, discoverRepos, formatSkipNotice } from "../discovery/discover.js";
import { parseReposInput } from "../discovery/repos-input.js";
import {
  type CentralTarget,
  dedupeTargets,
  parseRepoSlug,
  type RemoteTarget,
  type RepoRef,
  type Target,
} from "../discovery/targets.js";
import { runForRepo, type ValidatedSettings, validateSettingsDoc } from "../engine/orchestrate.js";
import type { SettingsSource } from "../engine/secret-refs.js";
import { type GithubClient, isPermissionError } from "../github/api.js";
import { getRepoFile } from "../github/repo-file.js";
import { createVisibilityResolver, type RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { Private } from "../private.js";
import { describeProblem, type Problem, RERUN_ADVICE } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { applyMarkerInjection } from "../report/delivery.js";
import {
  engineOutcome,
  failedTarget,
  type OpenedTarget,
  type RunFlowConfig,
  requireUploader,
  type TargetResult,
  targetFailure,
  withDelivery,
} from "./deliver.js";
import {
  attempt,
  openTargetChannel,
  planRedaction,
  type RedactionPlan,
  type TargetChannel,
  type TargetOutcome,
} from "./redact.js";
import { parseSettingsDoc, readSettingsFile } from "./settings-read.js";

/** The single source for the action.yml `settings-file` default, the multi-repo override guard in src/flows/inputs.ts, and the prose below. */
export const DEFAULT_SETTINGS_FILE = ".github/settings.yml";

export interface MultiConfig extends RunFlowConfig {
  reposDir: string;
  reposInput: string;
  defaultsFile: string;
  /** The owner a bare `<name>.yml` file under repos-dir belongs to. */
  adminOwner: string;
  discoveryFilters: DiscoveryFilters;
  /** Filter inputs the user explicitly set, for the misuse rejections. */
  discoveryFiltersSet: string[];
}

/** The channel is the only sink in scope, so a redacted target's text lands only in its report. */
async function processTarget(ctx: {
  api: GithubClient;
  target: Target;
  repo: RepoRef;
  /** Validated once before any target ran; null when no `defaults-file` was given. */
  defaults: ValidatedSettings | null;
  cfg: MultiConfig;
  injectMarker: boolean;
  channel: TargetChannel;
}): Promise<TargetResult> {
  const { api, target, defaults, cfg, injectMarker, channel } = ctx;
  const fail = (richMessage: string): TargetResult => targetFailure(channel.io, richMessage);

  // Marker injection is validity-preserving (it appends the constant marker label config, or strips a rename), so it
  // happens after validation and keeps the brand.
  const run = async (
    settings: ValidatedSettings,
    secretSource: SettingsSource,
  ): Promise<TargetResult> => {
    const injected = applyMarkerInjection(settings, injectMarker);
    if (injected.notice) {
      channel.io.annotate("notice", injected.notice);
    }
    const result = await runForRepo(
      api,
      {
        repo: ctx.repo,
        settings: injected.settings,
        mode: cfg.mode,
        onMissingPermission: cfg.onMissingPermission,
        sections: cfg.sections,
        secretSource,
      },
      channel.io,
    );
    return engineOutcome(result, channel.io);
  };

  const read = await readTargetSettings(api, target);
  if ("error" in read) {
    return fail(read.error);
  }
  if ("missing" in read) {
    if (defaults === null) {
      channel.io.annotate(
        "notice",
        `skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`,
      );
      return {
        result: "skipped",
        outcomes: [],
        note: `no ${DEFAULT_SETTINGS_FILE} on the default branch`,
      };
    }
    // The defaults document is operator-authored, so a $NAME reference in it resolves from the operator's environment.
    channel.io.annotate(
      "notice",
      `applying the defaults file: the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch`,
    );
    return run(defaults, "operator");
  }

  const parsed = parseSettingsDoc(read.raw);
  if (parsed.isErr()) {
    return fail(
      `cannot parse ${read.sourceLabel}: ${parsed.error.reason}. Fix the YAML in that file`,
    );
  }

  // validateSettingsDoc names sourceLabel (the slug for remote targets) in its own warnings, so they go through the unprefixed sink.
  const validated = validateSettingsDoc(
    parsed.value,
    read.sourceLabel,
    cfg.sections.only,
    channel.unprefixed,
  );
  if (validated.isErr()) {
    return fail(describeProblem(validated.error));
  }
  return run(validated.value, read.source);
}

/**
 * Channel and exposure come from ONE redaction decision, so a redacted channel never travels with a shown exposure.
 * Discovery's full_name is API data, so parseRepoSlug is checked here; a slug that fails it becomes the target's failure.
 */
function openTarget(
  plan: RedactionPlan,
  io: Io,
  slug: string,
  visibilityOf: (slug: string) => RepoVisibility,
): OpenedTarget {
  return {
    repo: parseRepoSlug(slug).unwrapOr(null),
    channel: openTargetChannel(plan, io, slug),
    exposure: plan.isRedacted(slug)
      ? { kind: "redacted", visibility: visibilityOf(slug) }
      : { kind: "shown" },
  };
}

/**
 * The document's provenance is decided here, with the document: a central file is operator-authored, a target's own
 * file is target-authored, so its $NAME references are refused (a target must not route the operator's environment
 * into itself). `missing` means a remote target is PROVEN to have no file; an absence that could not be proven is `error`.
 */
async function readTargetSettings(
  api: GithubClient,
  target: Target,
): Promise<
  | { raw: string; sourceLabel: string; source: SettingsSource }
  | { missing: true }
  | { error: string }
> {
  if (target.source === "central") {
    const sourceLabel = target.filePath;
    try {
      return { raw: readFileSync(target.filePath, "utf8"), sourceLabel, source: "operator" };
    } catch (error) {
      return {
        error: `cannot read settings from ${sourceLabel}: ${String(error)}. Fix the file, or delete it to stop managing this repository`,
      };
    }
  }
  const sourceLabel = `${target.slug}:${DEFAULT_SETTINGS_FILE}`;
  const file = await getRepoFile(api, target.slug, DEFAULT_SETTINGS_FILE);
  if ("missing" in file) {
    return { missing: true };
  }
  if ("unproven" in file) {
    return {
      error: `${file.unproven}. To stop managing it instead, remove ${target.slug} from the "repos" input`,
    };
  }
  if ("error" in file) {
    return {
      error: isPermissionError(file.error)
        ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT access to this repository (Contents: read), or remove it from the "repos" input`
        : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. ${RERUN_ADVICE}`,
    };
  }
  return { raw: file.content, sourceLabel, source: "target" };
}

export function runMulti(
  api: GithubClient,
  cfg: MultiConfig,
  io: Io,
  uploader?: ArtifactUploader,
): ResultAsync<TargetOutcome[], Problem> {
  // Central-resolution warnings are buffered so nothing emits before the redaction mask is registered; every exit path,
  // fatal or not, flushes them through this one helper (the fatal ones via orTee). They name repos-dir paths and slugs,
  // which are self-disclosed (checked into the public admin repo), so flushing them before masking on a fatal path leaks nothing.
  const bufferedWarnings: string[] = [];
  let warningsFlushed = false;
  const flushWarnings = (): void => {
    if (warningsFlushed) {
      return;
    }
    warningsFlushed = true;
    for (const warning of bufferedWarnings) {
      io.annotate("warning", warning);
    }
  };
  // Typed so a literal's `code` stays a literal inside the generator, where no return type narrows it.
  const fail = (problem: Problem): Err<never, Problem> => err(problem);

  return safeTry(async function* () {
    yield* requireUploader(cfg, uploader);

    let defaults: ValidatedSettings | null = null;
    if (cfg.defaultsFile) {
      const doc = yield* readSettingsFile(cfg.defaultsFile, "defaults-file");
      defaults = yield* validateSettingsDoc(doc, cfg.defaultsFile, cfg.sections.only, io);
    }

    let central: CentralTarget[] = [];
    if (cfg.reposDir) {
      const resolved = yield* resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
      bufferedWarnings.push(...resolved.warnings);
      central = resolved.targets;
    }

    let remote: RemoteTarget[] = [];
    let filteredOutCount = 0;
    const skipGroups: Array<{
      reason: string;
      repos: Parameters<typeof formatSkipNotice>[0]["repos"];
    }> = [];
    // Visibility learned from discovery is authoritative for those repos, so their per-target probe is skipped.
    const knownVisibility = new Map<string, RepoVisibility>();
    // Private slugs discovery filtered out are masked but never placeholdered.
    const filteredPrivateSlugs: Private<string>[] = [];
    if (cfg.reposInput) {
      const parsed = yield* parseReposInput(cfg.reposInput);
      let slugs = parsed.slugs;
      let origin = 'the "repos" input';
      if (parsed.discover) {
        const discovered = yield* discoverRepos(api, cfg.discoveryFilters);
        for (const group of discovered.filtered) {
          skipGroups.push(group);
          filteredOutCount += group.repos.length;
          for (const repo of group.repos) {
            if (repo.visibility !== "public") {
              filteredPrivateSlugs.push(repo.slug);
            }
          }
        }
        for (const repo of discovered.repos) {
          knownVisibility.set(repo.slug.toLowerCase(), repo.visibility);
        }
        slugs = discovered.repos.map((repo) => repo.slug);
        origin = 'repos: "*" discovery';
      } else if (cfg.discoveryFiltersSet.length > 0) {
        return fail({
          code: "discovery-filters-without-wildcard",
          filters: cfg.discoveryFiltersSet,
          targets: "explicit-repos",
        });
      }
      remote = slugs.map((slug) => ({ slug, source: "remote" as const, origin }));
    } else if (cfg.discoveryFiltersSet.length > 0) {
      return fail({
        code: "discovery-filters-without-wildcard",
        filters: cfg.discoveryFiltersSet,
        targets: "repos-dir",
      });
    }

    const redact = cfg.privateRepos === "redact";
    const self = cfg.selfSlug.toLowerCase();

    // Visibility is resolved for every distinct target slug before the plan, and the resolved value (not a boolean) drives
    // two decisions that fail closed in opposite directions, so an unknown never posts a private report to a repo that
    // might be public.
    //   discovery knew it          -> that value, no probe
    //   `show`, or the self slug   -> no probe
    //   redaction                  -> hide unless proven public
    //   report delivery            -> deliver only when proven private or internal
    const resolveVisibility = createVisibilityResolver(api);
    const orderedSlugs = [...central, ...remote].map((t) => t.slug);
    const visibilityBySlug = new Map<string, RepoVisibility>();
    if (redact) {
      for (const slug of orderedSlugs) {
        const key = slug.toLowerCase();
        if (visibilityBySlug.has(key)) {
          continue;
        }
        if (key === self) {
          visibilityBySlug.set(key, "public");
          continue;
        }
        const known = knownVisibility.get(key);
        visibilityBySlug.set(key, known ?? (await resolveVisibility(slug)));
      }
    }
    // Under `redact` the map holds every target slug, so the fallback only fires under `show`, where visibility is never
    // consulted; it still fails CLOSED, since "unknown" redacts as private and delivers as unproven.
    const visibilityOf = (slug: string): RepoVisibility =>
      visibilityBySlug.get(slug.toLowerCase()) ?? "unknown";

    const plan = planRedaction(
      cfg.privateRepos,
      orderedSlugs,
      filteredPrivateSlugs,
      (slug) => visibilityOf(slug) !== "public",
      cfg.selfSlug,
    );

    // Every hidden slug is masked before the first line that could name a target; the API trace reads the same registry.
    for (const slug of plan.maskedSlugs) {
      io.mask(slug);
    }

    flushWarnings();
    for (const group of skipGroups) {
      io.annotate("notice", formatSkipNotice(group, redact));
    }

    const targets = dedupeTargets(
      central,
      remote,
      (message) => io.annotate("notice", message),
      (slug) => plan.display(slug),
      (slug) => plan.isRedacted(slug),
    );
    if (targets.length === 0) {
      return fail({ code: "no-targets", filteredOut: filteredOutCount });
    }

    const results = await withDelivery({ api, cfg, io, uploader }, async (delivery) => {
      const delivered: TargetOutcome[] = [];
      for (const target of targets) {
        // The channel is opened BEFORE any processing so a read/parse/validation failure lands in a redacted target's transcript too.
        const opened = openTarget(plan, io, target.slug, visibilityOf);
        const { channel, repo } = opened;
        // A crash mid-processing never stops the rest of the fleet; it becomes this target's failure and still closes through the same delivery.
        const closed = await delivery.target(opened, async (injectMarker) =>
          repo === null
            ? targetFailure(
                channel.io,
                `the repository name "${target.slug}" from ${target.origin} is not an owner/name slug, so it cannot be targeted`,
              )
            : attempt(
                channel,
                () => processTarget({ api, target, repo, defaults, cfg, injectMarker, channel }),
                failedTarget,
              ),
        );
        delivered.push({ source: target.source, ...closed });
      }
      return delivered;
    });

    return ok(results);
  }).orTee(flushWarnings);
}

/**
 * Multi-repo orchestration: resolve targets (central files, explicit
 * repos, "*" discovery), read each target's settings, and run every
 * target independently through the engine. A target's own document is
 * applied exactly as written. The `defaults-file` document is a FALLBACK:
 * it is applied whole to a target that has no settings file of its own, and
 * never merged into a target that has one.
 *
 * When `private-repos: redact` (the default), private and internal targets
 * are hidden from this run's public view: their slug is masked and replaced
 * with a "private repository #N" placeholder, and their engine output is
 * captured rather than emitted. The redaction plan is built - and every
 * masked slug registered with the runner and the trace hardening - BEFORE
 * any annotation, log line, or output is produced, so nothing leaks in the
 * window before masking takes effect. Each target then reports through the
 * channel the plan opens for it, and a redacted target's end state closes
 * SEALED: the summary, outputs, and report reach it only through projections.
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
import { type GithubClient, isPermissionError, RERUN_ADVICE } from "../github/api.js";
import { getRepoFile } from "../github/repo-file.js";
import { createVisibilityResolver, type RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { Private } from "../private.js";
import { describeProblem, type Problem } from "../problem.js";
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

/**
 * The settings file a remote target is read from, and the action's default
 * `settings-file`: the single source for the action.yml default, the
 * multi-repo override guard in src/action/inputs.ts, and the prose below.
 */
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

/**
 * Process one target end to end and return its end state; each failure (read,
 * parse, validation, preflight) returns early. A target without a settings
 * file runs the defaults document when one was given and is skipped
 * otherwise. The channel is the only sink in scope, so a redacted target's
 * text lands only in its report.
 */
async function processTarget(ctx: {
  api: GithubClient;
  target: Target;
  /** The target as an owner/name pair, parsed once at the caller's boundary. */
  repo: RepoRef;
  /**
   * The defaults document, validated once before any target ran; null when
   * no `defaults-file` was given. Applied whole to a target that has no
   * settings file, never to one that has.
   */
  defaults: ValidatedSettings | null;
  cfg: MultiConfig;
  injectMarker: boolean;
  channel: TargetChannel;
}): Promise<TargetResult> {
  const { api, target, defaults, cfg, injectMarker, channel } = ctx;
  const fail = (richMessage: string): TargetResult => targetFailure(channel.io, richMessage);

  // Run one admitted document under the provenance decided where it was
  // chosen. Marker injection is validity-preserving (it appends the constant
  // marker label config, or strips a rename), so it happens after validation
  // and keeps the brand.
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
        requiredSections: cfg.requiredSections,
        onlySections: cfg.onlySections,
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
    // The defaults document is operator-authored, so it runs with operator
    // provenance: a $NAME reference in it resolves from the operator's
    // environment, exactly as in a central file.
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

  // validateSettingsDoc names sourceLabel (the slug for remote targets) in
  // its own warnings, so they go through the unprefixed sink. Its branded
  // return is the engine's admission ticket.
  const validated = validateSettingsDoc(
    parsed.value,
    read.sourceLabel,
    cfg.onlySections,
    channel.unprefixed,
  );
  if (validated.isErr()) {
    return fail(describeProblem(validated.error));
  }
  return run(validated.value, read.source);
}

/**
 * Channel and exposure come from ONE redaction decision, so a redacted channel
 * never travels with a shown exposure. Discovery's full_name is API data, so
 * parseRepoSlug is the boundary proving every delivered target is an owner/name pair.
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
 * Read a target's raw settings: from the checked-in central file, or from the
 * target repo's own default-branch settings.yml. The document's provenance is
 * decided here, with the document: a central file is operator-authored, a
 * target's own file is target-authored (its $NAME references are refused - a
 * target must not route the operator's environment into itself). Returns
 * `{raw, sourceLabel, source}`, `{missing: true}` when a remote target is
 * proven to have no file, or `{error}` when the read failed or the absence
 * could not be proven.
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

/**
 * Multi-repo orchestration. Config-level problems (bad defaults file, no
 * targets, duplicate definitions, discovery failure) come back as the error
 * before any target executes; per-target problems mark that target failed or
 * skipped and never stop the others.
 */
export function runMulti(
  api: GithubClient,
  cfg: MultiConfig,
  io: Io,
  uploader?: ArtifactUploader,
): ResultAsync<TargetOutcome[], Problem> {
  // Central-resolution warnings are buffered so nothing emits before the
  // redaction mask is registered. Every exit path - fatal or not - flushes
  // them through this one helper (the fatal ones via orTee), so a fatal config
  // error later in setup can never silently swallow a warning about a
  // repos-dir file. Central warnings name repos-dir paths and slugs, which are
  // self-disclosed (checked into the public admin repo), so flushing them
  // before masking leaks nothing.
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
  // Typed so a literal's `code` stays a literal inside the generator, where no
  // return type narrows it.
  const fail = (problem: Problem): Err<never, Problem> => err(problem);

  return safeTry(async function* () {
    yield* requireUploader(cfg, uploader);

    let defaults: ValidatedSettings | null = null;
    if (cfg.defaultsFile) {
      const doc = yield* readSettingsFile(cfg.defaultsFile, "defaults-file");
      defaults = yield* validateSettingsDoc(doc, cfg.defaultsFile, cfg.onlySections, io);
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
    // Visibility learned from discovery (authoritative for those repos), so the
    // per-target probe is skipped for them.
    const knownVisibility = new Map<string, RepoVisibility>();
    // Private slugs that discovery filtered out (sealed): masked, never placeholdered.
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

    // Resolve visibility for every distinct target slug before the plan: use
    // the discovery-supplied value when present, else one probe. Skipped
    // entirely under `show` and for the self slug. The resolved visibility (not
    // just a boolean) drives TWO decisions: redaction fails closed (redact unless
    // proven public), but report DELIVERY fails closed the other way (deliver only
    // when proven private or internal) - an unknown must never post a private
    // report to a repo that might be public.
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
    // Under `redact` the map holds every target slug, so the fallback only
    // fires under `show` (where visibility is never consulted) - but it still
    // fails CLOSED: an unresolved slug is "unknown", which redaction treats as
    // private and delivery treats as unproven, never "public".
    const visibilityOf = (slug: string): RepoVisibility =>
      visibilityBySlug.get(slug.toLowerCase()) ?? "unknown";

    const plan = planRedaction(
      cfg.privateRepos,
      orderedSlugs,
      filteredPrivateSlugs,
      (slug) => visibilityOf(slug) !== "public",
      cfg.selfSlug,
    );

    // Mask every hidden slug BEFORE the first annotate/log/output; the API
    // trace reads the same registry.
    for (const slug of plan.maskedSlugs) {
      io.mask(slug);
    }

    // Now safe to emit: buffered central warnings (flushed exactly once here on
    // the happy path; orTee below flushes them on every fatal path), then the
    // (redacting) skip notices.
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
        // The channel is opened BEFORE any processing so a read/parse/validation
        // failure lands in a redacted target's transcript too; it is the only sink
        // processing sees.
        const opened = openTarget(plan, io, target.slug, visibilityOf);
        const { channel, repo } = opened;
        // A crash mid-processing never stops the rest of the fleet; it becomes
        // this target's failure and still closes through the same delivery.
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

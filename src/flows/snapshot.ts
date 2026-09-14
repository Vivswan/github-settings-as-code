/**
 * The mode: snapshot run flow: read each target's live settings back through
 * the section snapshot ports and write them as a settings document, one file
 * per repository. The document reaches ONLY the file. Every public surface
 * (annotations, the step summary, the outputs) carries section keys, statuses,
 * and the notes check mode prints for the same repository (a secret's name, a
 * webhook's URL, never its value), routed through the target's redaction
 * channel exactly as check mode routes its lines, so a redacted target's file
 * lands on disk while nothing about it is printed.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { SectionSelection } from "../engine/section-selection.js";
import { renderSnapshotYaml, snapshotRepository } from "../engine/snapshot.js";
import type { GitHubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { Problem } from "../problem.js";
import { closeTarget, conclude, failedTarget, type TargetResult } from "./deliver.js";
import {
  DEFAULT_SETTINGS_FILE,
  openTarget,
  type ResolvedTargets,
  resolveTargets,
  type TargetsConfig,
} from "./multi.js";
import {
  attempt,
  type PrivateReposPolicy,
  publicDetail,
  type TargetChannel,
  type TargetOutcome,
  toPublicView,
} from "./redact.js";
import { canonicalPath, landingNames, renameTarget, writeReplacing } from "./settings-write.js";
import { openSingleRepoChannel } from "./single.js";
import { snapshotTakenLine, writeSnapshotDirSummary, writeSummary } from "./summary.js";

/**
 * The schema the written file's editor hint points at: the schema of this
 * release line, spelled as the README's quick start spells it. The marker
 * lets a major release rewrite the tag here (release-please-config.json lists
 * this file); test/docs/readme.test.ts pins it to the README's hint.
 */
export const SNAPSHOT_SCHEMA_URL =
  "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json"; // x-release-please-major

interface SnapshotConfigBase {
  onMissingPermission: "fail" | "warn";
  /** The allowlist; its required set is unused, since a snapshot never writes. */
  sections: SectionSelection;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
  /** The repository the run acts for; a target equal to it is never redacted. */
  selfSlug: string;
}

/**
 * A mode: snapshot run: one repository written to `snapshotFile`, or the
 * multi-repo targets (resolved exactly as apply resolves them) written under
 * `snapshotDir` as `<owner>/<name>.yml` each. No settings file, no report
 * channel: a snapshot reads and writes a file, and the type carries that.
 */
export type SnapshotConfig =
  | (SnapshotConfigBase & { form: "file"; repo: RepoRef; snapshotFile: string })
  | (SnapshotConfigBase & TargetsConfig & { form: "dir"; snapshotDir: string });

/**
 * A finished mode: snapshot run as runSnapshot hands it over: every target
 * closed through its channel, so a redacted one is sealed with its transcript
 * and concludeSnapshot opens only the public view. `takenAt` is the run's one
 * moment (an ISO-8601 UTC instant), which the summary states and no file carries.
 */
export type FinishedSnapshot =
  | { form: "file"; takenAt: string; target: Omit<TargetOutcome, "source"> }
  | { form: "dir"; takenAt: string; snapshotDir: string; targets: TargetOutcome[] };

/** Whether `path` is `dir` itself or lies under it; both already named the same way. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  // Only a whole ".." segment leaves `dir`: a child named "..snapshots" is inside.
  const leaves = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return !leaves;
}

/**
 * Whether one directory is or contains the other under either naming. As
 * spelled catches a symlink INSIDE one that leads into the other (repos-dir
 * "out/central" -> "../authored" under snapshot-dir "out"); as the filesystem
 * names them catches a case alias or a symlink TO the other. The dir form
 * writes join(snapshotDir, owner, name), and join collapses "link/.." before
 * the OS sees it, so the filesystem naming starts from the collapsed spelling
 * too: "link/../snapshots" lands beside link, never inside its target. The
 * file form writes its spelling raw and stays on OS semantics.
 */
function overlap(a: string, b: string): boolean {
  return [resolve, (p: string) => canonicalPath(resolve(p))].some(
    (name) => isWithin(name(a), name(b)) || isWithin(name(b), name(a)),
  );
}

/**
 * Refuse a destination that would overwrite an authored file: the settings file
 * carries the $NAME references and directives the operator wrote, which no
 * snapshot reproduces. The dir form writes the repos-dir layout, so the two
 * directories must be disjoint:
 *   snapshot-dir is the repos-dir -> overwrites every central file
 *   snapshot-dir above it         -> a target whose owner is the repos-dir's name overwrites its bare <name>.yml
 *   snapshot-dir below it         -> read back as central files on the next run
 */
function destinationCollision(cfg: SnapshotConfig): Result<void, Problem> {
  if (cfg.form === "file") {
    return canonicalPath(cfg.snapshotFile) === canonicalPath(DEFAULT_SETTINGS_FILE)
      ? err({
          code: "snapshot-file-is-settings-file",
          snapshotFile: cfg.snapshotFile,
          settingsFile: DEFAULT_SETTINGS_FILE,
        })
      : ok();
  }
  if (cfg.reposDir && overlap(cfg.snapshotDir, cfg.reposDir)) {
    return err({
      code: "snapshot-dir-overlaps-repos-dir",
      snapshotDir: cfg.snapshotDir,
      reposDir: cfg.reposDir,
    });
  }
  return ok();
}

/**
 * Read one repository back and write its document to `path`, speaking only
 * through the target's channel. The engine has already annotated every
 * skipped and failed section; the unsupported ones get one notice here, since
 * they are the sections the file will not carry. The written path names the
 * slug, so it travels in the result for the channel to seal.
 */
async function snapshotTarget(ctx: {
  api: GitHubClient;
  repo: RepoRef;
  cfg: SnapshotConfigBase;
  path: string;
  /** The input the path came from, named when the write fails. */
  pathInput: "snapshot-file" | "snapshot-dir";
  channel: TargetChannel;
}): Promise<TargetResult> {
  const { api, repo, cfg, path, channel } = ctx;
  const result = await snapshotRepository(
    api,
    { repo, sections: cfg.sections, onMissingPermission: cfg.onMissingPermission },
    channel.io,
  );
  const unsupported = result.outcomes.filter((o) => o.status === "unsupported").map((o) => o.key);
  if (unsupported.length > 0) {
    channel.io.annotate(
      "notice",
      `not snapshotted: ${unsupported.join(", ")} - snapshot does not read these sections back, so the file omits them (the header says why); declare them by hand if they should be managed`,
    );
  }
  if (result.result === "failed") {
    return {
      result: "failed",
      outcomes: result.outcomes,
      note: "the snapshot failed, so no file was written",
    };
  }
  const written = writeReplacing(path, renderSnapshotYaml(result, SNAPSHOT_SCHEMA_URL));
  if (written.isErr()) {
    channel.io.annotate(
      "error",
      `cannot write the snapshot to ${path}: ${written.error}. Check that the "${ctx.pathInput}" input names a writable path`,
    );
    return {
      result: "failed",
      outcomes: result.outcomes,
      note: `the snapshot could not be written to ${path}`,
    };
  }
  channel.io.log(`snapshot written to ${path}`);
  return {
    result: result.result,
    outcomes: result.outcomes,
    note: `written to ${path}`,
    file: path,
  };
}

/**
 * A target's file under the snapshot directory, in the repos-dir layout so the
 * directory can later serve as one, or why the target has none. SLUG_RE admits
 * "." and "..", which GitHub never issues but a repos entry can spell; either
 * would leave the directory. And the filesystem may carry the file onto
 * authored ground in a way the two inputs cannot show: a link under either
 * directory that leads into the other, or an owner spelled ".github". Two
 * targets can land on ONE file the same way (a link `out/bob -> out/alice`
 * with targets alice/r and bob/r), so every file this run writes is claimed
 * in `claimed` and a second target reaching it is refused. The refusal names
 * the earlier target through `display`, so a redacted one stays sealed, and
 * never the landing, whose spelling is the operator's.
 */
function snapshotFilePath(
  cfg: Extract<SnapshotConfig, { form: "dir" }>,
  repo: RepoRef,
  authored: ReadonlySet<string>,
  claimed: Map<string, string>,
  display: (slug: string) => string,
): { path: string } | { error: string } {
  if ([repo.owner, repo.name].some((part) => part === "." || part === "..")) {
    return {
      error: `the repository name "${repo.slug}" is not a GitHub owner/name (a "." or ".." segment), so it has no file under ${cfg.snapshotDir}`,
    };
  }
  const path = join(cfg.snapshotDir, repo.owner, `${repo.name}.yml`);
  const landing = canonicalPath(path);
  if (authored.has(landing)) {
    return {
      error: `cannot write the snapshot to ${path}: the filesystem carries it to ${landing}, an authored settings file. Write the snapshots to a directory that leads to no authored file`,
    };
  }
  if (cfg.reposDir && isWithin(landing, canonicalPath(cfg.reposDir))) {
    return {
      error: `cannot write the snapshot to ${path}: the filesystem carries it to ${landing}, inside the "repos-dir" input "${cfg.reposDir}". Write the snapshots to a directory that leads to no central file`,
    };
  }
  // The claim is the file the rename reaches; a later target is refused when any of its landing names is claimed
  // (its own rename target for a leaf that was a link, its referent for a leaf spelled in another case on a
  // case-insensitive filesystem once the first file exists).
  const written = renameTarget(path);
  const earlier = landingNames(path)
    .map((name) => claimed.get(name))
    .find((slug) => slug !== undefined);
  if (earlier !== undefined) {
    return {
      error:
        `cannot write the snapshot to ${path}: the filesystem carries it to the file this run already claimed for ` +
        `${display(earlier)}. Remove the link under the "snapshot-dir" input that folds the two owners together, so ` +
        "each target has a file of its own",
    };
  }
  claimed.set(written, repo.slug);
  return { path };
}

/**
 * Execute a mode: snapshot run. A destination that would overwrite an authored
 * file, or a fleet that cannot be resolved, comes back as the error before any
 * target is read; otherwise every target's closed outcome, which
 * concludeSnapshot turns into the summary, the outputs, and the exit code.
 */
export function runSnapshot(
  api: GitHubClient,
  cfg: SnapshotConfig,
  io: Io,
): ResultAsync<FinishedSnapshot, Problem> {
  return destinationCollision(cfg).asyncAndThen(() =>
    cfg.form === "file"
      ? ResultAsync.fromSafePromise(snapshotFile(api, cfg, io))
      : resolveTargets(api, cfg, io).map((resolved) => snapshotDir(api, cfg, io, resolved)),
  );
}

/**
 * The run's one moment, announced once through `io` and returned for the summary: no file carries it, so a
 * re-snapshot of an unchanged repository is byte-identical. The library verb states its own in its report instead.
 */
function takeMoment(io: Io): string {
  const takenAt = new Date().toISOString();
  io.annotate("notice", `snapshot taken ${takenAt}`);
  return takenAt;
}

/** The file form: one target, opened as the single-repo flow opens its own and closed through the same seal. */
async function snapshotFile(
  api: GitHubClient,
  cfg: Extract<SnapshotConfig, { form: "file" }>,
  io: Io,
): Promise<FinishedSnapshot> {
  const takenAt = takeMoment(io);
  const { channel } = await openSingleRepoChannel(api, cfg, io);
  const outcome = await attempt(
    channel,
    () =>
      snapshotTarget({
        api,
        repo: cfg.repo,
        cfg,
        path: cfg.snapshotFile,
        pathInput: "snapshot-file",
        channel,
      }),
    failedTarget,
  );
  return { form: "file", takenAt, target: await closeTarget(io, channel, outcome) };
}

/** The dir form: every resolved target, each through the channel the redaction plan opens for it. */
async function snapshotDir(
  api: GitHubClient,
  cfg: Extract<SnapshotConfig, { form: "dir" }>,
  io: Io,
  resolved: ResolvedTargets,
): Promise<FinishedSnapshot> {
  const takenAt = takeMoment(io);
  // Every file the run reads as authored, as the filesystem names it.
  const authored: ReadonlySet<string> = new Set([
    canonicalPath(DEFAULT_SETTINGS_FILE),
    ...resolved.targets.flatMap((t) => (t.source === "central" ? [canonicalPath(t.filePath)] : [])),
  ]);
  // Every landing this run writes, by the target that claimed it; the one writer's answer to two targets on one file.
  const claimed = new Map<string, string>();
  const targets: TargetOutcome[] = [];
  for (const target of resolved.targets) {
    // The channel is opened BEFORE any processing so a failure lands in a
    // redacted target's capture too; it is the only sink processing sees.
    const opened = openTarget(resolved.plan, io, target.slug, resolved.visibilityOf);
    const { channel, repo } = opened;
    const fail = (message: string): TargetResult => {
      channel.io.annotate("error", message);
      return failedTarget(message);
    };
    let outcome: TargetResult;
    if (repo === null) {
      outcome = fail(
        `the repository name "${target.slug}" from ${target.origin} is not an owner/name slug, so it cannot be snapshotted`,
      );
    } else {
      const located = snapshotFilePath(cfg, repo, authored, claimed, (slug) =>
        resolved.plan.display(slug),
      );
      outcome =
        "error" in located
          ? fail(located.error)
          : // A crash mid-target never stops the rest of the fleet; it becomes
            // this target's failure, spoken only through its channel.
            await attempt(
              channel,
              () =>
                snapshotTarget({
                  api,
                  repo,
                  cfg,
                  path: located.path,
                  pathInput: "snapshot-dir",
                  channel,
                }),
              failedTarget,
            );
    }
    targets.push({ source: target.source, ...(await closeTarget(io, channel, outcome)) });
  }
  return { form: "dir", takenAt, snapshotDir: cfg.snapshotDir, targets };
}

/**
 * A finished mode: snapshot run: the public view is projected first, so nothing below carries a redacted slug; then
 * the summary, the outputs, the result line, and the exit code as every mode ends.
 */
export function concludeSnapshot(io: Io, finished: FinishedSnapshot): number {
  if (finished.form === "file") {
    const view = publicDetail(finished.target.detail);
    writeSummary(io, view, "snapshot", finished.target.result, [
      snapshotTakenLine(finished.takenAt),
    ]);
    return conclude(io, { ...view, result: finished.target.result }, false);
  }
  const views = finished.targets.map(toPublicView);
  writeSnapshotDirSummary(io, views, finished.snapshotDir, finished.takenAt);
  return conclude(io, views, false);
}

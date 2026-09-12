/**
 * The mode: snapshot run flow: read each target's live settings back through
 * the section snapshot ports and write them as a settings document, one file
 * for one repository or one file per multi-repo target under a directory.
 * The document reaches ONLY the file. Every public surface (annotations, the
 * step summary, the outputs) carries section keys, statuses, and the notes
 * check mode prints for the same repository (a secret's name, a webhook's
 * URL, never a secret's value), routed through the target's redaction channel
 * exactly as check mode routes its lines, so a redacted target's file lands
 * on disk while nothing about it is printed.
 */

import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { RepoRef, Target } from "../discovery/targets.js";
import type { SectionSelection } from "../engine/section-selection.js";
import { renderSnapshotYaml, type SnapshotResult, snapshotRepository } from "../engine/snapshot.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { Problem } from "../problem.js";
import type { SectionKey } from "../schema.js";
import type { MustBeNever } from "../types.js";
import type { Exposure } from "./deliver.js";
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
  REDACTED_DETAIL,
  REDACTED_NOTE,
  type TargetChannel,
} from "./redact.js";
import { openSingleRepoChannel } from "./single.js";
import { writeSnapshotDirSummary, writeSnapshotSummary } from "./summary.js";

/**
 * The `result` output of a mode: snapshot run, worst first: `failed` when a
 * target failed (a denial under the fail policy, a value a section's own
 * schema rejects, an unwritable file), `partial` when a section was skipped
 * or failed without failing its target, `snapshot` when every target read
 * fully back. Not RepoResult values: a snapshot applies nothing, so they
 * never enter worstOf beside the per-repo values.
 */
export const SNAPSHOT_RESULTS = [
  "failed",
  "partial",
  "snapshot",
] as const satisfies readonly SnapshotResult["result"][];

export type SnapshotRunResult = (typeof SNAPSHOT_RESULTS)[number];

/** Compile-time lockstep: an engine result value missing from SNAPSHOT_RESULTS fails here. */
type _UnlistedSnapshotResult = MustBeNever<Exclude<SnapshotResult["result"], SnapshotRunResult>>;

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

/** One snapshot target's end state before projection: the engine's outcomes plus where the file went. */
interface SnapshotTargetResult {
  result: SnapshotRunResult;
  outcomes: SnapshotResult["outcomes"];
  /** Human line heading the target's summary. */
  note: string;
  /** The written file, as the channel may name it; absent when nothing was written. */
  file?: string;
}

/** One target as the summary and the outputs see it: closed values, detail already projected. */
export interface SnapshotTargetView {
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  source?: Target["source"];
  result: SnapshotRunResult;
  outcomes: Array<{
    key: SectionKey;
    status: SnapshotResult["outcomes"][number]["status"];
    detail: string[];
  }>;
  note: string;
  /** Where the file went, as the public view may show it. */
  file?: string;
}

/** A finished mode: snapshot run as runSnapshot hands it over: every target's public view. */
export type FinishedSnapshot =
  | { form: "file"; view: SnapshotTargetView }
  | { form: "dir"; snapshotDir: string; views: SnapshotTargetView[] };

/**
 * `path` as the filesystem names it: the real path of what exists, the rest
 * as spelled. Built one segment at a time, so ".." steps out of a symlink's
 * TARGET as the write will: handed "link/../x" whole, bun's realpath collapses
 * the ".." lexically before following the link and names a different file
 * than the one the write reaches. Every step retries realpath, since
 * "missing/../link" is back on existing ground after the "..".
 */
function canonicalPath(path: string): string {
  // The platform reads the root (a drive-relative "C:x" resolves on that drive); the walk reads the rest.
  const { root } = parse(path);
  let real = realOrSpelled(root === "" ? process.cwd() : resolve(root));
  for (const part of path.slice(root.length).split(sep === "\\" ? /[\\/]/ : sep)) {
    if (part === "" || part === ".") {
      continue;
    }
    real = part === ".." ? dirname(real) : realOrSpelled(join(real, part));
  }
  return real;
}

/** `path`'s real path when it exists, else `path` itself. */
function realOrSpelled(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

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
 * names them catches a case alias or a symlink TO the other.
 */
function overlap(a: string, b: string): boolean {
  return [resolve, canonicalPath].some(
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

/** A target that produced no outcomes because `message` stopped it. */
function failedSnapshotTarget(message: string): SnapshotTargetResult {
  return { result: "failed", outcomes: [], note: message };
}

/**
 * The public projection of one target: a redacted target keeps its section
 * keys and statuses (closed values) and loses every detail line, its note,
 * and its file path, which names the slug.
 */
function snapshotView(
  channel: TargetChannel,
  exposure: Exposure,
  outcome: SnapshotTargetResult,
  source?: Target["source"],
): SnapshotTargetView {
  const redacted = exposure.kind === "redacted";
  return {
    display: channel.display,
    ...(source === undefined ? {} : { source }),
    result: outcome.result,
    outcomes: outcome.outcomes.map((o) => ({
      key: o.key,
      status: o.status,
      detail: redacted ? [REDACTED_DETAIL] : o.detail,
    })),
    note: redacted ? REDACTED_NOTE : outcome.note,
    ...(outcome.file === undefined ? {} : { file: redacted ? REDACTED_DETAIL : outcome.file }),
  };
}

/**
 * Read one repository back and write its document to `path`, speaking only
 * through the target's channel. The engine has already annotated every
 * skipped and failed section; the unsupported ones get one notice here, since
 * they are the sections the file will not carry.
 */
async function snapshotTarget(ctx: {
  api: GithubClient;
  repo: RepoRef;
  cfg: SnapshotConfigBase;
  path: string;
  /** The input the path came from, named when the write fails. */
  pathInput: "snapshot-file" | "snapshot-dir";
  channel: TargetChannel;
  timestamp: string;
}): Promise<SnapshotTargetResult> {
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
  try {
    writeReplacing(
      path,
      renderSnapshotYaml(result, { schemaUrl: SNAPSHOT_SCHEMA_URL, timestamp: ctx.timestamp }),
    );
  } catch (error) {
    channel.io.annotate(
      "error",
      `cannot write the snapshot to ${path}: ${String(error)}. Check that the "${ctx.pathInput}" input names a writable path`,
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
 * Write `text` to `path` through a sibling staging file renamed into place, so
 * a write that fails partway (disk full, an interrupted run) leaves the
 * previous snapshot at `path` intact instead of a truncated one; the rename is
 * atomic on POSIX and a single replace call on Windows. A leftover staging
 * file or link is unlinked first, never written through.
 */
function writeReplacing(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  try {
    rmSync(staging, { force: true });
    writeFileSync(staging, text, { flag: "wx" });
    renameSync(staging, path);
  } catch (error) {
    // The write's error is the one reported: a directory at the staging path fails both the write and this rm.
    try {
      rmSync(staging, { force: true });
    } catch {}
    throw error;
  }
}

/**
 * A target's file under the snapshot directory, in the repos-dir layout so the
 * directory can later serve as one, or why the target has none. SLUG_RE admits
 * "." and "..", which GitHub never issues but a repos entry can spell; either
 * would leave the directory. And the filesystem may carry the file onto
 * authored ground in a way the two inputs cannot show: a link under either
 * directory that leads into the other, or an owner spelled ".github".
 */
function snapshotFilePath(
  cfg: Extract<SnapshotConfig, { form: "dir" }>,
  repo: RepoRef,
  authored: ReadonlySet<string>,
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
  return { path };
}

/**
 * Execute a mode: snapshot run. A destination that would overwrite an authored
 * file, or a fleet that cannot be resolved, comes back as the error before any
 * target is read; otherwise every target's public view, which concludeSnapshot
 * turns into the summary, the outputs, and the exit code.
 */
export function runSnapshot(
  api: GithubClient,
  cfg: SnapshotConfig,
  io: Io,
): ResultAsync<FinishedSnapshot, Problem> {
  return destinationCollision(cfg).asyncAndThen(() =>
    cfg.form === "file"
      ? ResultAsync.fromSafePromise(snapshotFile(api, cfg, io))
      : resolveTargets(api, cfg, io).map((resolved) => snapshotDir(api, cfg, io, resolved)),
  );
}

/** The file form: one target, opened as the single-repo flow opens its own. */
async function snapshotFile(
  api: GithubClient,
  cfg: Extract<SnapshotConfig, { form: "file" }>,
  io: Io,
): Promise<FinishedSnapshot> {
  const opened = await openSingleRepoChannel(api, cfg, io);
  const outcome = await attempt(
    opened.channel,
    () =>
      snapshotTarget({
        api,
        repo: cfg.repo,
        cfg,
        path: cfg.snapshotFile,
        pathInput: "snapshot-file",
        channel: opened.channel,
        timestamp: new Date().toISOString(),
      }),
    failedSnapshotTarget,
  );
  return { form: "file", view: snapshotView(opened.channel, opened.exposure, outcome) };
}

/** The dir form: every resolved target, each through the channel the redaction plan opens for it. */
async function snapshotDir(
  api: GithubClient,
  cfg: Extract<SnapshotConfig, { form: "dir" }>,
  io: Io,
  resolved: ResolvedTargets,
): Promise<FinishedSnapshot> {
  // One timestamp for the whole run, so every file's header shares it.
  const timestamp = new Date().toISOString();
  // Every file the run reads as authored, as the filesystem names it.
  const authored: ReadonlySet<string> = new Set([
    canonicalPath(DEFAULT_SETTINGS_FILE),
    ...resolved.targets.flatMap((t) => (t.source === "central" ? [canonicalPath(t.filePath)] : [])),
  ]);
  const views: SnapshotTargetView[] = [];
  for (const target of resolved.targets) {
    // The channel is opened BEFORE any processing so a failure lands in a
    // redacted target's capture too; it is the only sink processing sees.
    const opened = openTarget(resolved.plan, io, target.slug, resolved.visibilityOf);
    const { channel, repo } = opened;
    const fail = (message: string): SnapshotTargetResult => {
      channel.io.annotate("error", message);
      return failedSnapshotTarget(message);
    };
    let outcome: SnapshotTargetResult;
    if (repo === null) {
      outcome = fail(
        `the repository name "${target.slug}" from ${target.origin} is not an owner/name slug, so it cannot be snapshotted`,
      );
    } else {
      const located = snapshotFilePath(cfg, repo, authored);
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
                  timestamp,
                }),
              failedSnapshotTarget,
            );
    }
    views.push(snapshotView(channel, opened.exposure, outcome, target.source));
  }
  return { form: "dir", snapshotDir: cfg.snapshotDir, views };
}

/** The worst result across every target; a run without targets never reaches here. */
function worstSnapshotResult(
  views: ReadonlyArray<{ result: SnapshotRunResult }>,
): SnapshotRunResult {
  return SNAPSHOT_RESULTS.find((rank) => views.some((view) => view.result === rank)) ?? "snapshot";
}

/** A finished mode: snapshot run: the summary, the outputs, the result line, and the exit code. */
export function concludeSnapshot(io: Io, finished: FinishedSnapshot): number {
  const views = finished.form === "file" ? [finished.view] : finished.views;
  if (finished.form === "file") {
    writeSnapshotSummary(io, finished.view);
  } else {
    writeSnapshotDirSummary(io, finished.views, finished.snapshotDir);
    io.output(
      "repos-result",
      JSON.stringify(
        Object.fromEntries(
          finished.views.map((view) => [
            view.display,
            {
              result: view.result,
              source: view.source,
              skippedSections: view.outcomes
                .filter((o) => o.status === "skipped")
                .map((o) => o.key),
            },
          ]),
        ),
      ),
    );
  }
  io.output(
    "skipped-sections",
    [
      ...new Set(
        views.flatMap((view) =>
          view.outcomes.filter((o) => o.status === "skipped").map((o) => o.key),
        ),
      ),
    ].join(","),
  );
  const result = worstSnapshotResult(views);
  io.output("result", result);
  io.log(`result: ${result}`);
  return result === "failed" ? 1 : 0;
}

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

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Whether `path` is `dir` itself or lies under it, compared as resolved paths. */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  // Only a whole ".." segment leaves `dir`: a child named "..snapshots" is inside.
  const leaves = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return !leaves;
}

/**
 * Refuse a destination that would overwrite an authored file. Guarded here,
 * beside the write, so a library caller gets the refusal too. A snapshot is a
 * starting point beside the file apply and check read, never a replacement
 * written over it: that file carries the $NAME references and directives the
 * operator authored. The dir form writes the repos-dir layout, so the two
 * directories must be disjoint: the same directory overwrites every central
 * file, a snapshot-dir above the repos-dir overwrites a bare <name>.yml whose
 * owner segment is the repos-dir's name, and one below it is read back as
 * central files on the next run. Paths are compared resolved, so "./x" and "x" collide.
 */
function destinationCollision(cfg: SnapshotConfig): Result<void, Problem> {
  if (cfg.form === "file") {
    return resolve(cfg.snapshotFile) === resolve(DEFAULT_SETTINGS_FILE)
      ? err({
          code: "snapshot-file-is-settings-file",
          snapshotFile: cfg.snapshotFile,
          settingsFile: DEFAULT_SETTINGS_FILE,
        })
      : ok();
  }
  if (
    cfg.reposDir &&
    (isWithin(cfg.snapshotDir, cfg.reposDir) || isWithin(cfg.reposDir, cfg.snapshotDir))
  ) {
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
 * atomic for a regular file on POSIX and Windows alike. The staging file is
 * removed when the write fails.
 */
function writeReplacing(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  try {
    writeFileSync(staging, text);
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
 * directory can later serve as one. SLUG_RE admits "." and "..", which GitHub
 * never issues but a repos entry can spell; either would leave the directory.
 */
function snapshotFilePath(dir: string, repo: RepoRef): { path: string } | { error: string } {
  if ([repo.owner, repo.name].some((part) => part === "." || part === "..")) {
    return {
      error: `the repository name "${repo.slug}" is not a GitHub owner/name (a "." or ".." segment), so it has no file under ${dir}`,
    };
  }
  return { path: join(dir, repo.owner, `${repo.name}.yml`) };
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
      const located = snapshotFilePath(cfg.snapshotDir, repo);
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

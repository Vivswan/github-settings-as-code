/**
 * The library verbs: what a program calls where the action runs a mode. Every verb takes its inputs positionally and
 * one options object of knobs, each defaulted as the action's input of the same name; `io` is the one knob they all
 * share, and without it the lines the verb prints come back as the report's `log`.
 */

import type { Result } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { Layer, Layering, OptOutNotice } from "../engine/layers.js";
import {
  type RepoRunOptions,
  type RepoRunResult,
  runForRepo,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../engine/orchestrate.js";
import { SectionSelection } from "../engine/section-selection.js";
import {
  type RenderableSnapshot,
  snapshotRepository as readSnapshot,
  renderSnapshotYaml,
  type SnapshotResult,
} from "../engine/snapshot.js";
import type { GitHubClient } from "../github/api.js";
import { type CollectedLine, collectingIo, type Io } from "../io.js";
import type { LayerProblem, SettingsProblem } from "../problem.js";
import { foldLayers } from "./layers.js";
import { SNAPSHOT_SCHEMA_URL } from "./snapshot.js";

const UNNAMED_SOURCE = "the settings document";

const MERGED_SOURCE = "the rendered settings document";

/** The Io a verb prints through, and the lines the report carries: the caller's own Io leaves the log empty. */
function sink(io: Io | undefined): { io: Io; log: () => CollectedLine[] } {
  if (io !== undefined) {
    return { io, log: () => [] };
  }
  const collected = collectingIo();
  return { io: collected.io, log: () => collected.lines };
}

/** The knobs every verb over a document takes. */
export interface ValidateOptions {
  /** How the document is named in problems and warnings; a file path, usually. */
  source?: string;
  /** The `sections` allowlist: an unknown top-level key outside a non-empty one is a warning, not an error. */
  sections?: SectionSelection;
  /** Where the warnings print; without one they come back as the report's `log`. */
  io?: Io;
}

export interface ValidateReport {
  settings: ValidatedSettings;
  log: CollectedLine[];
}

/** Validate a parsed document into the branded settings every other verb takes. */
export function validateSettings(
  doc: unknown,
  options: ValidateOptions = {},
): Result<ValidateReport, SettingsProblem> {
  const out = sink(options.io);
  return validateSettingsDoc(
    doc,
    options.source ?? UNNAMED_SOURCE,
    options.sections ?? SectionSelection.ALL,
    out.io,
  ).map((settings) => ({ settings, log: out.log() }));
}

export interface MergeOptions {
  /** How the merged document is named in problems and warnings. */
  source?: string;
  /** How the list sections fold across layers; the action's `layering` input, "deep" unless set. */
  layering?: Layering;
  io?: Io;
}

/** The fold's result: the merged document, its opt-out notices, and the file text mode: render writes, byte for byte. */
export interface MergeReport {
  settings: ValidatedSettings;
  notices: OptOutNotice[];
  yaml: string;
  log: CollectedLine[];
}

/** Fold an ordered list of layers into one validated document, as mode: render does. */
export function mergeSettings(
  layers: readonly Layer[],
  options: MergeOptions = {},
): Result<MergeReport, SettingsProblem | LayerProblem> {
  const out = sink(options.io);
  return foldLayers(
    layers,
    options.source ?? MERGED_SOURCE,
    options.layering ?? "deep",
    out.io,
  ).map((folded) => ({ ...folded, log: out.log() }));
}

/** The knobs a run over one repository takes, each defaulted as the action's input of the same name. */
interface RepositoryOptions {
  sections?: SectionSelection;
  onMissingPermission?: RepoRunOptions["onMissingPermission"];
  io?: Io;
  secretSource?: RepoRunOptions["secretSource"];
  secretEnv?: RepoRunOptions["secretEnv"];
}

export type CheckOptions = RepositoryOptions;

export type ApplyOptions = RepositoryOptions;

/** The engine's result plus every line the run printed when the caller brought no Io of their own. */
interface RepositoryReport extends RepoRunResult {
  log: CollectedLine[];
}

export type CheckReport = RepositoryReport;

export type ApplyReport = RepositoryReport;

async function runMode(
  client: GitHubClient,
  repo: RepoRef,
  settings: ValidatedSettings,
  mode: RepoRunOptions["mode"],
  options: RepositoryOptions,
): Promise<RepositoryReport> {
  const out = sink(options.io);
  const result = await runForRepo(
    client,
    {
      repo,
      settings,
      mode,
      onMissingPermission: options.onMissingPermission ?? "fail",
      sections: options.sections ?? SectionSelection.ALL,
      secretSource: options.secretSource,
      secretEnv: options.secretEnv,
    },
    out.io,
  );
  return { ...result, log: out.log() };
}

/** Plan and diff every active section without writing. */
export function checkRepository(
  client: GitHubClient,
  repo: RepoRef,
  settings: ValidatedSettings,
  options: CheckOptions = {},
): Promise<CheckReport> {
  return runMode(client, repo, settings, "check", options);
}

/** Execute the plan: the repository converges on the document. */
export function applyRepository(
  client: GitHubClient,
  repo: RepoRef,
  settings: ValidatedSettings,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  return runMode(client, repo, settings, "apply", options);
}

/** The knobs a snapshot takes: the same three, since a snapshot never writes. */
export interface SnapshotOptions {
  sections?: SectionSelection;
  onMissingPermission?: RepoRunOptions["onMissingPermission"];
  io?: Io;
}

/**
 * The engine's snapshot result plus the file text mode: snapshot would write
 * (absent exactly when the result is failed, which carries no document), the
 * moment the reads began (`takenAt`: the file carries no date, and the report
 * is the library's summary, so it states the moment where the action's summary
 * and notice do), and every line the run printed when the caller brought no Io
 * of their own.
 */
export type SnapshotReport = (
  | (RenderableSnapshot & { yaml: string })
  | (Extract<SnapshotResult, { result: "failed" }> & { yaml?: never })
) & { takenAt: string; log: CollectedLine[] };

/** Read one repository's supported sections back as a settings document and its rendered file. */
export async function snapshotRepository(
  client: GitHubClient,
  repo: RepoRef,
  options: SnapshotOptions = {},
): Promise<SnapshotReport> {
  const out = sink(options.io);
  const takenAt = new Date().toISOString();
  const result = await readSnapshot(
    client,
    {
      repo,
      sections: options.sections ?? SectionSelection.ALL,
      onMissingPermission: options.onMissingPermission ?? "fail",
    },
    out.io,
  );
  const log = out.log();
  if (result.result === "failed") {
    return { ...result, takenAt, log };
  }
  const yaml = renderSnapshotYaml(result, SNAPSHOT_SCHEMA_URL);
  return { ...result, yaml, takenAt, log };
}

/** Snapshot several repositories in order, one report each; a failed target never stops the rest. */
export async function snapshotRepositories(
  client: GitHubClient,
  repos: readonly RepoRef[],
  options: SnapshotOptions = {},
): Promise<SnapshotReport[]> {
  const reports: SnapshotReport[] = [];
  for (const repo of repos) {
    reports.push(await snapshotRepository(client, repo, options));
  }
  return reports;
}

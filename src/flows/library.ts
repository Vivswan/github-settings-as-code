import type { Result } from "neverthrow";
import { stringify as stringifyYaml } from "yaml";
import type { RepoRef } from "../discovery/targets.js";
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
import type { GithubClient } from "../github/api.js";
import { type CollectedLine, collectingIo, type Io } from "../io.js";
import type { SettingsProblem } from "../problem.js";
import type { SectionKey } from "../schema.js";
import { SNAPSHOT_SCHEMA_URL } from "./snapshot.js";

const UNNAMED_SOURCE = "the settings document";

const NO_ALLOWLIST: ReadonlySet<SectionKey> = new Set();

export function validateSettings(
  doc: unknown,
  options: { source?: string; sections?: ReadonlySet<SectionKey> } = {},
): Result<{ settings: ValidatedSettings; warnings: string[] }, SettingsProblem> {
  const collected = collectingIo();
  return validateSettingsDoc(
    doc,
    options.source ?? UNNAMED_SOURCE,
    options.sections ?? NO_ALLOWLIST,
    collected.io,
  ).map((settings) => ({ settings, warnings: collected.lines.map((entry) => entry.line) }));
}

export type RepoRunReport = RepoRunResult & { log: CollectedLine[] };

async function runMode(
  client: GithubClient,
  opts: Omit<RepoRunOptions, "mode">,
  mode: RepoRunOptions["mode"],
  io: Io | undefined,
): Promise<RepoRunReport> {
  const collected = collectingIo();
  const result = await runForRepo(client, { ...opts, mode }, io ?? collected.io);
  return { ...result, log: io === undefined ? collected.lines : [] };
}

export function checkRepository(
  client: GithubClient,
  opts: Omit<RepoRunOptions, "mode">,
  io?: Io,
): Promise<RepoRunReport> {
  return runMode(client, opts, "check", io);
}

export function applyRepository(
  client: GithubClient,
  opts: Omit<RepoRunOptions, "mode">,
  io?: Io,
): Promise<RepoRunReport> {
  return runMode(client, opts, "apply", io);
}

/** The merged document exactly as mode: merge writes it to merged-file. */
export function renderMergedYaml(settings: ValidatedSettings): string {
  return stringifyYaml(settings);
}

/** What a library snapshot may narrow: the selection, the denial policy, and the Io the lines go to. */
export interface SnapshotLibraryOptions {
  sections?: SectionSelection;
  onMissingPermission?: "fail" | "warn";
  io?: Io;
}

/**
 * The engine's snapshot result plus the file text mode: snapshot would write
 * (absent exactly when the result is failed, which carries no document) and
 * every line the run printed when the caller brought no Io of their own.
 */
export type SnapshotReport = (
  | (RenderableSnapshot & { yaml: string })
  | (Extract<SnapshotResult, { result: "failed" }> & { yaml?: never })
) & { log: CollectedLine[] };

/** Read one repository's supported sections back as a settings document and its rendered file. */
export async function snapshotRepository(
  client: GithubClient,
  repo: RepoRef,
  options: SnapshotLibraryOptions = {},
): Promise<SnapshotReport> {
  const collected = collectingIo();
  const result = await readSnapshot(
    client,
    {
      repo,
      sections: options.sections ?? SectionSelection.ALL,
      onMissingPermission: options.onMissingPermission ?? "fail",
    },
    options.io ?? collected.io,
  );
  const log = options.io === undefined ? collected.lines : [];
  if (result.result === "failed") {
    return { ...result, log };
  }
  const yaml = renderSnapshotYaml(result, {
    schemaUrl: SNAPSHOT_SCHEMA_URL,
    timestamp: new Date().toISOString(),
  });
  return { ...result, yaml, log };
}

/** Snapshot several repositories in order, one report each; a failed target never stops the rest. */
export async function snapshotRepositories(
  client: GithubClient,
  targets: readonly RepoRef[],
  options: SnapshotLibraryOptions = {},
): Promise<SnapshotReport[]> {
  const reports: SnapshotReport[] = [];
  for (const repo of targets) {
    reports.push(await snapshotRepository(client, repo, options));
  }
  return reports;
}

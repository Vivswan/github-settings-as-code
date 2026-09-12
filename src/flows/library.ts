import type { Result } from "neverthrow";
import { stringify as stringifyYaml } from "yaml";
import {
  type RepoRunOptions,
  type RepoRunResult,
  runForRepo,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../engine/orchestrate.js";
import type { GithubClient } from "../github/api.js";
import { type CollectedLine, collectingIo, type Io } from "../io.js";
import type { SettingsProblem } from "../problem.js";
import type { SectionKey } from "../schema.js";

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

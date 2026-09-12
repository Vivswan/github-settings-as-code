/** The engine for a caller with no action inputs: the mode and the Io sink are fixed here. */

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
import type { SectionKey } from "../schema.js";

/** How a document with no caller-given source is named in its own errors. */
const UNNAMED_SOURCE = "the settings document";

const NO_ALLOWLIST: ReadonlySet<SectionKey> = new Set();

/** `sections` is the allowlist; unknown keys outside it come back as `warnings` instead of failing. */
export function validateSettings(
  doc: unknown,
  options: { source?: string; sections?: ReadonlySet<SectionKey> } = {},
): { ok: true; settings: ValidatedSettings; warnings: string[] } | { ok: false; error: string } {
  const collected = collectingIo();
  const validated = validateSettingsDoc(
    doc,
    options.source ?? UNNAMED_SOURCE,
    options.sections ?? NO_ALLOWLIST,
    collected.io,
  );
  if ("error" in validated) {
    return { ok: false, error: validated.error };
  }
  return {
    ok: true,
    settings: validated.settings,
    warnings: collected.lines.map((entry) => entry.line),
  };
}

/** The engine's result plus every line it printed when the caller brought no Io of their own. */
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

/** Plan and diff every active section against the live repository; nothing is written. */
export function checkRepository(
  client: GithubClient,
  opts: Omit<RepoRunOptions, "mode">,
  io?: Io,
): Promise<RepoRunReport> {
  return runMode(client, opts, "check", io);
}

/** Plan every active section and execute the plan's writes. */
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

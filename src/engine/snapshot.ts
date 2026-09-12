/**
 * The snapshot pipeline: read every supported section back through its read port, assemble the
 * settings document, and validate it before anyone sees it. The read-only twin of runForRepo in
 * ./orchestrate.ts, sharing its allowlist rule and its denial classification.
 */

import { stringify as stringifyYaml } from "yaml";
import type { RepoRef } from "../discovery/targets.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { SectionKey } from "../schema.js";
import { PermissionDenied } from "../sections/contract/errors.js";
import { type SectionSnapshot, snapshotUnsupportedNote } from "../sections/contract/module.js";
import { planContext } from "../sections/contract/plan.js";
import { SECTIONS } from "../sections/registry.js";
import { deniedSectionStatus, type ValidatedSettings, validateSettingsDoc } from "./orchestrate.js";
import type { SectionSelection } from "./section-selection.js";

export interface SnapshotOptions {
  /** The target repository, parsed at the caller's validated boundary. */
  repo: RepoRef;
  /** The allowlist; its required set is unused here, since a snapshot never writes. */
  sections: SectionSelection;
  onMissingPermission: "fail" | "warn";
}

/**
 * One section's end state: read back ("snapshot", its notes in detail), denied under the warn
 * policy ("skipped"), without a snapshot handler ("unsupported", the reason in detail), or failed.
 */
interface SectionSnapshotOutcome {
  key: SectionKey;
  status: "snapshot" | "skipped" | "unsupported" | "failed";
  detail: string[];
}

/**
 * The document exists only when the run did not fail: a denial under the fail policy and a
 * section producing a value its own schema rejects both withhold it, so a failed result cannot be
 * rendered by mistake. "partial" says a section was skipped or failed without failing the run.
 */
export type SnapshotResult =
  | {
      repo: string;
      result: "snapshot" | "partial";
      settings: ValidatedSettings;
      outcomes: SectionSnapshotOutcome[];
    }
  | { repo: string; result: "failed"; settings?: never; outcomes: SectionSnapshotOutcome[] };

/** A snapshot result that carries a document. */
export type RenderableSnapshot = Extract<SnapshotResult, { settings: ValidatedSettings }>;

/** What a section without live state says for itself in the outcome and the file header. */
const NOTHING_TO_DECLARE = "nothing exists on the repository, so the section is omitted";

/** Read one repository's supported sections back into a validated settings document. */
export async function snapshotRepository(
  api: GithubClient,
  opts: SnapshotOptions,
  io: Io,
): Promise<SnapshotResult> {
  const outcomes: SectionSnapshotOutcome[] = [];
  const document: Record<string, unknown> = {};
  let partial = false;
  let failed = false;

  for (const section of SECTIONS) {
    if (opts.sections.only.size > 0 && !opts.sections.only.has(section.key)) {
      continue;
    }
    if (section.snapshot === undefined) {
      outcomes.push({
        key: section.key,
        status: "unsupported",
        detail: [snapshotUnsupportedNote(section)],
      });
      continue;
    }
    let snapshot: SectionSnapshot;
    try {
      snapshot = await section.snapshot(planContext(section, api, opts.repo));
    } catch (error) {
      if (error instanceof PermissionDenied) {
        // Nothing is ever written here, so the denial classifies on the policy alone.
        const status = deniedSectionStatus(opts.onMissingPermission, false);
        if (status === "skipped") {
          io.annotate("warning", `${section.key}: skipped - ${error.detail}`);
          partial = true;
        } else {
          io.annotate("error", `${section.key}: not snapshotted - ${error.detail}`);
          failed = true;
        }
        outcomes.push({ key: section.key, status, detail: [error.detail] });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      const prefixed = message.startsWith(`${section.key}:`)
        ? message
        : `${section.key}: ${message}`;
      io.annotate("error", prefixed);
      outcomes.push({ key: section.key, status: "failed", detail: [prefixed] });
      partial = true;
      continue;
    }
    for (const note of snapshot.notes) {
      io.annotate("notice", `${section.key}: ${note}`);
    }
    if (snapshot.value === undefined) {
      outcomes.push({
        key: section.key,
        status: "snapshot",
        detail: [...snapshot.notes, NOTHING_TO_DECLARE],
      });
      continue;
    }
    // Validated per section so the rejection names its producer: a value the section's own
    // schema refuses is a bug in that section, never a document to hand out.
    const verdict = validateSettingsDoc(
      { [section.key]: snapshot.value },
      `the ${section.key} snapshot of ${opts.repo.slug}`,
      new Set(),
      io,
    );
    if ("error" in verdict) {
      const detail = `BUG: ${section.key} produced a snapshot its own schema rejects - ${verdict.error}`;
      io.annotate("error", detail);
      outcomes.push({ key: section.key, status: "failed", detail: [...snapshot.notes, detail] });
      failed = true;
      continue;
    }
    document[section.key] = verdict.settings[section.key];
    outcomes.push({ key: section.key, status: "snapshot", detail: [...snapshot.notes] });
  }

  if (failed) {
    return { repo: opts.repo.slug, result: "failed", outcomes };
  }
  // The brand's one mint, over the already-parsed fragments: every section validated alone
  // above, so the whole cannot fail.
  const verdict = validateSettingsDoc(document, `the snapshot of ${opts.repo.slug}`, new Set(), io);
  if ("error" in verdict) {
    throw new Error(
      `BUG: the assembled snapshot of ${opts.repo.slug} failed validation after every section validated on its own: ${verdict.error}`,
    );
  }
  return {
    repo: opts.repo.slug,
    result: partial ? "partial" : "snapshot",
    settings: verdict.settings,
    outcomes,
  };
}

/**
 * The snapshot as a settings file: the language-server schema pin, a comment header naming the
 * repository, the moment (supplied by the caller, so the text is deterministic), and every
 * outcome line, then the document as the merge flow writes one. A message spanning several
 * physical lines (an API error body) is commented line by line, so no line escapes the header.
 */
export function renderSnapshotYaml(
  result: RenderableSnapshot,
  opts: { schemaUrl: string; timestamp: string },
): string {
  const header = [
    `# yaml-language-server: $schema=${opts.schemaUrl}`,
    `# Snapshot of ${result.repo} taken ${opts.timestamp}`,
    ...result.outcomes.flatMap((outcome) =>
      outcome.detail.flatMap((message) =>
        message.split(/\r?\n/).map((line) => `# ${outcome.key}: ${line}`),
      ),
    ),
  ];
  return `${header.join("\n")}\n${stringifyYaml(result.settings)}`;
}

/**
 * The read-only twin of runForRepo in ./orchestrate.ts, honoring the sections allowlist by the
 * same rule.
 */

import type { RepoRef } from "../discovery/targets.js";
import type { GitHubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { describeProblem } from "../problem.js";
import type { SectionKey } from "../schema.js";
import {
  type EndpointDecl,
  endpointPath,
  matchesTemplate,
} from "../sections/contract/endpoints.js";
import { PermissionDenied } from "../sections/contract/errors.js";
import {
  concealedAbsenceNote,
  gatedAbsentRead,
  type SectionSnapshot,
  snapshotUnsupportedNote,
} from "../sections/contract/module.js";
import { type OnMissingPermission, snapshotContext } from "../sections/contract/plan.js";
import { SECTIONS } from "../sections/registry.js";
import type { MustBeNever } from "../types.js";
import { canonicalDocument, compareByCodePoint, renderCanonicalYaml } from "./canonical.js";
import { type ValidatedSettings, validateSettingsDoc } from "./orchestrate.js";
import type { RunOutcome } from "./outcome.js";
import { SectionSelection } from "./section-selection.js";

export interface SnapshotRunOptions {
  /** The target repository, parsed at the caller's validated boundary. */
  repo: RepoRef;
  /**
   * The allowlist. Its required set goes unread: required-sections governs what must apply, and
   * a snapshot never writes, so a denial classifies on onMissingPermission alone.
   */
  sections: SectionSelection;
  onMissingPermission: OnMissingPermission;
}

/**
 * One section's end state: read back ("snapshot", its notes in detail), denied under the warn
 * policy ("skipped"), without a snapshot handler ("unsupported", the reason in detail), or failed.
 */
export interface SectionSnapshotOutcome {
  key: SectionKey;
  status: "snapshot" | "skipped" | "unsupported" | "failed";
  detail: string[];
}

/**
 * The document exists only when the run did not fail: a failed section (a denial under the fail
 * policy, a throw, a value its own schema rejects) withholds it, so a failed result cannot be
 * rendered by mistake. "partial" says a section was skipped under the warn policy.
 */
export type SnapshotResult =
  | {
      repo: string;
      result: "snapshot" | "partial";
      settings: ValidatedSettings;
      outcomes: SectionSnapshotOutcome[];
    }
  | { repo: string; result: "failed"; settings?: never; outcomes: SectionSnapshotOutcome[] };

type _UnrankedSnapshotResult = MustBeNever<Exclude<SnapshotResult["result"], RunOutcome>>;

/** A snapshot result that carries a document. */
export type RenderableSnapshot = Extract<SnapshotResult, { settings: ValidatedSettings }>;

/** What a section without live state says for itself in the outcome and the file header. */
const NOTHING_TO_DECLARE = "nothing exists on the repository, so the section is omitted";

/** A line under its section's key, prefixed once: a section's own notes already lead with the key. */
function underKey(key: SectionKey, line: string): string {
  const own = line.startsWith(key) && /^[:.[]/.test(line.slice(key.length));
  return own ? line : `${key}: ${line}`;
}

/**
 * The client as one section's snapshot sees it, reporting whether a GET on `read`'s route
 * answered 404 (the observation the concealed-absence note is keyed on). Null passes through.
 */
function watchingNotFound(
  api: GitHubClient,
  read: EndpointDecl | null,
  seen: { notFound: boolean },
): GitHubClient {
  if (read === null) {
    return api;
  }
  const template = endpointPath(read.route);
  return {
    tryRequest: async (method, path, payload, options) => {
      const result = await api.tryRequest(method, path, payload, options);
      if (
        "error" in result &&
        result.error.status === 404 &&
        method === "GET" &&
        matchesTemplate(template, path)
      ) {
        seen.notFound = true;
      }
      return result;
    },
    tryGraphql: (op, variables, slug, options) => api.tryGraphql(op, variables, slug, options),
  };
}

/** Read one repository's supported sections back into a validated settings document. */
export async function snapshotRepository(
  api: GitHubClient,
  opts: SnapshotRunOptions,
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
    const absentRead = gatedAbsentRead(section);
    const seen = { notFound: false };
    let snapshot: SectionSnapshot;
    try {
      snapshot = await section.snapshot(
        snapshotContext(
          section,
          watchingNotFound(api, absentRead, seen),
          opts.repo,
          opts.onMissingPermission,
        ),
      );
    } catch (error) {
      // A denial escapes the section from its primary read under both policies and from a
      // sub-read (readOrNote) under fail, so this branch classifies every denial the run sees.
      if (error instanceof PermissionDenied) {
        const status = opts.onMissingPermission === "warn" ? "skipped" : "failed";
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
      failed = true;
      continue;
    }
    // The section's notes in code-point order: a section notes its entries in the order GitHub listed them, and the
    // file's header and the annotations must read the same on every run over the same repository.
    const notes = [...snapshot.notes].sort(compareByCodePoint);
    for (const note of notes) {
      io.annotate("notice", underKey(section.key, note));
    }
    if (snapshot.value === undefined) {
      // Chosen at the engine level so every absent-posture section behaves alike: the 404 keeps
      // its "nothing exists" reading, and the note names the denial it could also be. Keyed on an
      // observed 404, so an empty 200 listing earns no note.
      const concealed =
        absentRead !== null && seen.notFound ? concealedAbsenceNote(section, absentRead) : null;
      if (concealed !== null) {
        io.annotate("notice", concealed);
      }
      outcomes.push({
        key: section.key,
        status: "snapshot",
        detail: [...notes, ...(concealed === null ? [] : [concealed]), NOTHING_TO_DECLARE],
      });
      continue;
    }
    // Validated per section so the rejection names its producer: a value the section's own
    // schema refuses is a bug in that section, never a document to hand out.
    const verdict = validateSettingsDoc(
      { [section.key]: snapshot.value },
      `the ${section.key} snapshot of ${opts.repo.slug}`,
      SectionSelection.ALL,
      io,
    );
    if (verdict.isErr()) {
      const detail = `BUG: ${section.key} produced a snapshot its own schema rejects - ${describeProblem(verdict.error)}`;
      io.annotate("error", detail);
      outcomes.push({ key: section.key, status: "failed", detail: [...notes, detail] });
      failed = true;
      continue;
    }
    document[section.key] = verdict.value[section.key];
    outcomes.push({ key: section.key, status: "snapshot", detail: [...notes] });
  }

  if (failed) {
    return { repo: opts.repo.slug, result: "failed", outcomes };
  }
  // The brand's one mint, over the already-parsed fragments in the canonical order (so the document a library caller
  // reads is ordered as the file is): every section validated alone above, so the whole cannot fail.
  const verdict = validateSettingsDoc(
    canonicalDocument(document),
    `the snapshot of ${opts.repo.slug}`,
    SectionSelection.ALL,
    io,
  );
  if (verdict.isErr()) {
    throw new Error(
      `BUG: the assembled snapshot of ${opts.repo.slug} failed validation after every section validated on its own: ${describeProblem(verdict.error)}`,
    );
  }
  return {
    repo: opts.repo.slug,
    result: partial ? "partial" : "snapshot",
    settings: verdict.value,
    outcomes,
  };
}

/**
 * The snapshot as a settings file: the language-server schema pin and every outcome line, then
 * the document in the canonical order the merge flow writes too. Nothing in the file names the
 * moment it was taken (the run summary and a notice carry that), so a snapshot of an unchanged
 * repository is byte for byte the last one. A message spanning several physical lines (an API
 * error body) is commented line by line, so no line escapes the header.
 */
export function renderSnapshotYaml(result: RenderableSnapshot, schemaUrl: string): string {
  const header = [
    `# yaml-language-server: $schema=${schemaUrl}`,
    ...result.outcomes.flatMap((outcome) =>
      outcome.detail.flatMap((message) =>
        message.split(/\r?\n/).map((line) => `# ${underKey(outcome.key, line)}`),
      ),
    ),
  ];
  return `${header.join("\n")}\n${renderCanonicalYaml(result.settings)}`;
}

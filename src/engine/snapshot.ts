/**
 * The read-only twin of runForRepo in ./orchestrate.ts, honoring the sections allowlist by the
 * same rule.
 */

import { err } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import type { ClientAnswer, GitHubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { describeProblem } from "../problem.js";
import type { SectionKey } from "../schema.js";
import {
  type EndpointDecl,
  endpointPath,
  matchesTemplate,
} from "../sections/contract/endpoints.js";
import { type SectionFailure, thrown } from "../sections/contract/errors.js";
import type { SectionSnapshot } from "../sections/contract/module.js";
import {
  concealedAbsenceNote,
  gatedAbsentRead,
  snapshotUnsupportedNote,
} from "../sections/contract/operations.js";
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

  /** The allowlist; its required set goes unread, since required-sections governs what must apply and a snapshot never writes, so a denial classifies on onMissingPermission alone. */
  sections: SectionSelection;

  /** Whether a denied section skips the run's document (warn) or fails it. */
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
 * policy, a failure of any other kind, a value its own schema rejects) withholds it, so a failed result cannot be
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

/** One section's snapshot: its row, and the document's value under its key when it declared one. */
type SectionRead =
  | { readonly outcome: SectionSnapshotOutcome; readonly declared: false }
  | { readonly outcome: SectionSnapshotOutcome; readonly declared: true; readonly value: unknown };

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
  const notFoundOn = (path: string, result: ClientAnswer<unknown>): boolean =>
    "error" in result && result.error.status === 404 && matchesTemplate(template, path);
  return {
    tryRequest: async (method, path, payload, options) => {
      const result = await api.tryRequest(method, path, payload, options);
      if (method === "GET" && notFoundOn(path, result)) {
        seen.notFound = true;
      }
      return result;
    },
    tryList: async (path, options) => {
      const result = await api.tryList(path, options);
      if (notFoundOn(path, result)) {
        seen.notFound = true;
      }
      return result;
    },
    tryGraphql: (op, variables, slug, options) => api.tryGraphql(op, variables, slug, options),
  };
}

/** A section whose read failed: a denial skips or fails it by the policy, anything else fails it with the section named. */
function failedSnapshot(
  io: Io,
  key: SectionKey,
  failure: SectionFailure,
  policy: OnMissingPermission,
): SectionSnapshotOutcome {
  // A denial ends the section from its primary read under both policies and from a sub-read (readOrNote)
  // under fail, so this branch classifies every denial the run sees.
  if (failure.kind === "permission-denied") {
    if (policy === "warn") {
      io.annotate("warning", `${key}: skipped - ${failure.detail}`);
      return { key, status: "skipped", detail: [failure.detail] };
    }
    io.annotate("error", `${key}: not snapshotted - ${failure.detail}`);
    return { key, status: "failed", detail: [failure.detail] };
  }

  const prefixed = failure.message.startsWith(`${key}:`)
    ? failure.message
    : `${key}: ${failure.message}`;
  io.annotate("error", prefixed);
  return { key, status: "failed", detail: [prefixed] };
}

/**
 * A section with nothing live. Chosen at the engine level so every absent-posture section behaves alike: the 404
 * keeps its "nothing exists" reading, and the note names the denial it could also be. Keyed on an observed 404, so
 * an empty 200 listing earns no note.
 */
function absentSnapshot(
  io: Io,
  section: (typeof SECTIONS)[number],
  absentRead: EndpointDecl | null,
  notFound: boolean,
  notes: readonly string[],
): SectionSnapshotOutcome {
  const detail = [...notes];
  const concealed =
    absentRead !== null && notFound ? concealedAbsenceNote(section, absentRead) : null;
  if (concealed !== null) {
    io.annotate("notice", concealed);
    detail.push(concealed);
  }
  detail.push(NOTHING_TO_DECLARE);
  return { key: section.key, status: "snapshot", detail };
}

/** One section read back: unsupported without a snapshot handler, else its row and the value its own schema accepted. */
async function snapshotSection(
  api: GitHubClient,
  opts: SnapshotRunOptions,
  io: Io,
  section: (typeof SECTIONS)[number],
): Promise<SectionRead> {
  if (section.snapshot === undefined) {
    const detail = [snapshotUnsupportedNote(section)];
    return { outcome: { key: section.key, status: "unsupported", detail }, declared: false };
  }

  const absentRead = gatedAbsentRead(section);
  const seen = { notFound: false };
  // The catch is for what still throws (the client's own transport error on an unmarked request, a BUG invariant).
  const read = await section
    .snapshot(
      snapshotContext(
        section,
        watchingNotFound(api, absentRead, seen),
        opts.repo,
        opts.onMissingPermission,
      ),
    )
    .catch((error: unknown) => err(thrown(error)));
  if (read.isErr()) {
    const outcome = failedSnapshot(io, section.key, read.error, opts.onMissingPermission);
    return { outcome, declared: false };
  }

  const snapshot: SectionSnapshot = read.value;
  // The section's notes in code-point order: a section notes its entries in the order GitHub listed them, and the
  // file's header and the annotations must read the same on every run over the same repository.
  const notes = [...snapshot.notes].sort(compareByCodePoint);
  for (const note of notes) {
    io.annotate("notice", underKey(section.key, note));
  }

  if (snapshot.value === undefined) {
    const outcome = absentSnapshot(io, section, absentRead, seen.notFound, notes);
    return { outcome, declared: false };
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
    return {
      outcome: { key: section.key, status: "failed", detail: [...notes, detail] },
      declared: false,
    };
  }

  return {
    outcome: { key: section.key, status: "snapshot", detail: [...notes] },
    declared: true,
    value: verdict.value[section.key],
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
  for (const section of SECTIONS) {
    if (opts.sections.only.size > 0 && !opts.sections.only.has(section.key)) {
      continue;
    }

    const read = await snapshotSection(api, opts, io, section);
    outcomes.push(read.outcome);
    if (read.declared) {
      document[section.key] = read.value;
    }
  }

  if (outcomes.some((outcome) => outcome.status === "failed")) {
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

  const partial = outcomes.some((outcome) => outcome.status === "skipped");
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

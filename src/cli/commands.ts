/**
 * What the file-only subcommands and init render for the program to print;
 * check, apply, render, and snapshot run through the library's executor from
 * the program.
 */

import {
  describeProblem,
  type GitHubClient,
  type Io,
  type RunOutcome,
  readSettingsFile,
  SECTIONS,
  type SectionModule,
  sectionGrant,
  type ValidatedSettings,
  validateSettings,
} from "../index.js";
import { countNoun } from "../internal.js";

/** What the CLI needs from its process: the environment and a client factory tests can stub. */
export interface CliHost {
  readonly env: Readonly<Record<string, string | undefined>>;
  createClient(token: string, io: Io, apiVersion: string): GitHubClient;
}

/**
 * What a file-only command prints; the program picks `lines` or `json` by the --json flag. The envelope is the one
 * every subcommand's --json prints: `result` always, `file` once a file is known, `problem` on a failure, then the
 * command's own data.
 */
export interface Rendered {
  readonly code: number;
  readonly lines: readonly string[];
  readonly json: Envelope;
}

/** A file-only command validated its file ("valid"), or ended as a run does. */
export type Envelope = {
  readonly result: RunOutcome | "valid";
  readonly file?: string;
  readonly problem?: string;
} & Record<string, unknown>;

/** The failed envelope of a file-only command: the problem's text, beside the file when one was named. */
export function failedEnvelope(message: string, file?: string): Envelope {
  return { result: "failed", ...(file === undefined ? {} : { file }), problem: message };
}

/** The section modules a validated document declares, in execution order. */
function declaredSections(settings: ValidatedSettings): SectionModule[] {
  return SECTIONS.filter((section) => settings[section.key] !== undefined);
}

/** Read and validate one settings file; the warnings go to `io`, the problem is the error. */
function readValidated(file: string, io: Io) {
  return readSettingsFile(file, "settings-file")
    .andThen((doc) => validateSettings(doc, { source: file, io }))
    .map(({ settings }) => settings);
}

/** `validate <file>`: the schema verdict alone, no token and no API call. */
export function validateFile(file: string, io: Io): Rendered {
  return readValidated(file, io).match(
    (settings): Rendered => {
      const sections = declaredSections(settings).map((section) => section.key);
      return {
        code: 0,
        lines: [
          `${file} is valid: ${countNoun(sections.length, "section", "sections")} declared (${sections.join(", ")})`,
        ],
        json: { result: "valid", file, sections },
      };
    },
    (problem): Rendered => {
      const message = describeProblem(problem);
      io.annotate("error", message);
      return { code: 1, lines: [], json: failedEnvelope(message, file) };
    },
  );
}

/** The PAT grant each section a document declares needs, from the section declarations, as lines and as an object. */
export function grantTable(
  settings: ValidatedSettings,
  bold: (text: string) => string,
): { sections: string[]; lines: string[]; json: Record<string, string> } {
  const grants = declaredSections(settings).map(
    (section) => [section.key, sectionGrant(section)] as const,
  );
  return {
    sections: grants.map(([key]) => key),
    lines: grants.map(([key, grant]) => `${bold(key)}: ${grant}`),
    json: Object.fromEntries(grants),
  };
}

/** `permissions <file>`: the PAT grant each declared section needs, from the section declarations. */
export function permissionsFor(file: string, io: Io, bold: (text: string) => string): Rendered {
  return readValidated(file, io).match(
    (settings): Rendered => {
      const { lines, json } = grantTable(settings, bold);
      return { code: 0, lines, json: { result: "valid", file, grant: json } };
    },
    (problem): Rendered => {
      const message = describeProblem(problem);
      io.annotate("error", message);
      return { code: 1, lines: [], json: failedEnvelope(message, file) };
    },
  );
}

/**
 * What the file-only subcommands and init render for the program to print,
 * and the CLI's own wording of a problem; check, apply, merge, and snapshot run
 * through the library's executor from the program.
 */

import {
  describeProblem,
  type GitHubClient,
  type Io,
  type Problem,
  type RunOutcome,
  readSettingsFile,
  SECTIONS,
  type SectionModule,
  sectionGrant,
  type ValidatedSettings,
  validateSettings,
} from "../index.js";
import { INPUT_DECLS, PRIVATE_REPORT_CHANNELS } from "../internal.js";

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
          `${file} is valid: ${sections.length} section(s) declared (${sections.join(", ")})`,
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

/**
 * The action's wording for a problem, except where the remedy names the
 * workflow step: from a terminal the fix is a flag or an environment variable.
 */
export function describeCliProblem(problem: Problem): string {
  switch (problem.code) {
    case "input-token-missing":
      return "cannot call the GitHub API: no token was provided. Pass --token, or export GITHUB_TOKEN";
    case "input-repository-not-slug":
      return `cannot target a repository: "${problem.value}" is not an owner/name slug. Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)`;
    default:
      return describeProblem(problem);
  }
}

/**
 * The one report channel a terminal cannot serve: the artifact upload needs
 * the Actions runner. Worded as the unsupported value it is from here.
 */
export const ARTIFACT_REFUSED: Problem = {
  code: "input-unsupported-value",
  input: "private-report",
  value: "artifact",
  noun: "private-report channel from the command line (the artifact upload needs the Actions runner)",
  allowed: PRIVATE_REPORT_CHANNELS.filter((channel) => channel !== "artifact"),
  fallback: INPUT_DECLS["private-report"].default,
};

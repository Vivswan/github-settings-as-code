/**
 * What each subcommand does once its inputs are parsed: the engine and merge
 * runs end exactly where the action's do (concludeRun, concludeMerge,
 * failRun), so the exit codes and the outputs are the action's; the two
 * file-only commands render a result for the program to print.
 */

import {
  concludeMerge,
  concludeRun,
  describeProblem,
  failRun,
  type GithubClient,
  type Io,
  type RunConfig,
  readSettingsFile,
  runMerge,
  runMulti,
  runSingle,
  SECTIONS,
  type SectionModule,
  sectionGrant,
  type ValidatedSettings,
  validateSettings,
} from "../index.js";

/** What the CLI needs from its process: the environment and a client factory tests can stub. */
export interface CliHost {
  readonly env: Readonly<Record<string, string | undefined>>;
  createClient(token: string, io: Io, apiVersion: string): GithubClient;
}

/** What a file-only command prints; the program picks `lines` or `json` by the --json flag. */
export interface Rendered {
  readonly code: number;
  readonly lines: readonly string[];
  readonly json: unknown;
}

/** Run a parsed config to its conclusion; the CLI has no artifact uploader, so that channel fails loudly. */
export async function runConfig(cfg: RunConfig, io: Io, host: CliHost): Promise<number> {
  if (cfg.kind === "merge") {
    return runMerge(cfg, io).match(
      (merged) => concludeMerge(io, merged),
      (problem) => failRun(io, problem),
    );
  }
  const api = host.createClient(cfg.token, io, cfg.apiVersion);
  if (cfg.kind === "multi") {
    return runMulti(api, cfg, io).match(
      (targets) => concludeRun(io, { kind: "multi", mode: cfg.mode, targets }),
      (problem) => failRun(io, problem),
    );
  }
  return runSingle(api, cfg, io).match(
    (target) => concludeRun(io, { kind: "single", mode: cfg.mode, target }),
    (problem) => failRun(io, problem),
  );
}

/** The section modules a validated document declares, in execution order. */
function declaredSections(settings: ValidatedSettings): SectionModule[] {
  return SECTIONS.filter((section) => settings[section.key] !== undefined);
}

/** Read and validate one settings file; the warnings go to `io`, the problem is the error. */
function readValidated(file: string, io: Io) {
  return readSettingsFile(file, "settings-file")
    .andThen((doc) => validateSettings(doc, { source: file }))
    .map(({ settings, warnings }) => {
      for (const warning of warnings) {
        io.annotate("warning", warning);
      }
      return settings;
    });
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
        json: { file, valid: true, sections },
      };
    },
    (problem): Rendered => {
      const message = describeProblem(problem);
      io.annotate("error", message);
      return { code: 1, lines: [], json: { file, valid: false, problem: message } };
    },
  );
}

/** `permissions <file>`: the PAT grant each declared section needs, from the section declarations. */
export function permissionsFor(file: string, io: Io, bold: (text: string) => string): Rendered {
  return readValidated(file, io).match(
    (settings): Rendered => {
      const grants = declaredSections(settings).map(
        (section) => [section.key, sectionGrant(section)] as const,
      );
      return {
        code: 0,
        lines: grants.map(([key, grant]) => `${bold(key)}: ${grant}`),
        json: Object.fromEntries(grants),
      };
    },
    (problem): Rendered => {
      const message = describeProblem(problem);
      io.annotate("error", message);
      return { code: 1, lines: [], json: { file, valid: false, problem: message } };
    },
  );
}

/** A command whose mode this build's library does not carry: one error line, exit 1. */
export function unavailable(command: string, io: Io): number {
  io.annotate(
    "error",
    `${command} needs mode: snapshot, which this build of github-settings-as-code does not include. ` +
      "Upgrade to a release whose inputs reference lists snapshot among the modes",
  );
  return 1;
}

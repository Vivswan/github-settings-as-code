/**
 * `init`: adoption in one command. Snapshot one repository into the settings
 * file apply and check read (the one destination mode: snapshot refuses, since
 * here that file is the point), refuse to replace a file that already exists
 * unless --force, then print the PAT grant the written sections need. A
 * command-line command alone: no action mode reaches it, so its config and its
 * own problems live here beside the library's rather than in RunConfig and
 * Problem.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  type ConfigEnv,
  DEFAULT_SETTINGS_FILE,
  type InputReader,
  type Io,
  type Problem,
  parseConfig,
  type RepoRef,
  type SectionSelection,
  type SnapshotReport,
  snapshotRepository,
} from "../index.js";
import { type CliHost, describeCliProblem, grantTable, type Rendered } from "./commands.js";

export interface InitConfig {
  readonly kind: "init";
  readonly token: string;
  readonly apiVersion: string;
  readonly repo: RepoRef;
  /** Where the document is written: the file apply and check read. */
  readonly settingsFile: string;
  readonly sections: SectionSelection;
  readonly onMissingPermission: "fail" | "warn";
  /** Replace an existing settings file instead of refusing. */
  readonly force: boolean;
}

/** The library's problems plus the ones only init raises; describeInitProblem words every one. */
export type InitProblem =
  | Problem
  | { readonly code: "init-settings-file-is-list"; readonly value: string }
  | { readonly code: "init-settings-file-exists"; readonly settingsFile: string }
  | {
      readonly code: "init-settings-file-unwritable";
      readonly settingsFile: string;
      readonly reason: string;
    }
  | {
      readonly code: "init-snapshot-failed";
      readonly repository: string;
      readonly settingsFile: string;
    }
  | {
      readonly code: "init-partial-and-empty";
      readonly repository: string;
      readonly settingsFile: string;
    };

/** The separators every mode reads as a list, which one path can therefore never contain. */
const LIST_SEPARATOR = /[\n,]/;

/**
 * Read the init flags as the snapshot of one repository they are: the library
 * validates the shared inputs (token, slug, sections, policy, API version)
 * with the settings file standing where the snapshot file would, so every
 * problem is the one the snapshot subcommand would print for the same value.
 */
export function parseInitConfig(
  read: InputReader,
  force: boolean,
  env: ConfigEnv,
): Result<InitConfig, InitProblem> {
  const settingsFile = read("settings-file") || DEFAULT_SETTINGS_FILE;
  if (LIST_SEPARATOR.test(settingsFile)) {
    return err({ code: "init-settings-file-is-list", value: settingsFile });
  }
  const asSnapshot: InputReader = (name) => {
    switch (name) {
      case "mode":
        return "snapshot";
      case "snapshot-file":
        return settingsFile;
      case "settings-file":
        return "";
      default:
        return read(name);
    }
  };
  return parseConfig(asSnapshot, env).map((cfg): InitConfig => {
    if (cfg.kind !== "snapshot" || cfg.form !== "file") {
      throw new Error(
        `BUG: the init flags parsed as a ${cfg.kind} config; with mode snapshot and a snapshot-file they can only be the file form`,
      );
    }
    return {
      kind: "init",
      token: cfg.token,
      apiVersion: cfg.apiVersion,
      repo: cfg.repo,
      settingsFile,
      sections: cfg.sections,
      onMissingPermission: cfg.onMissingPermission,
      force,
    };
  });
}

/** The wording for every problem init can end in: its own here, the library's through the CLI's rewording. */
function describeInitProblem(problem: InitProblem): string {
  switch (problem.code) {
    case "init-settings-file-is-list":
      return `the --settings-file value "${problem.value}" contains a comma or a newline, which check and apply read as a list separator. Name one path without them`;
    case "init-settings-file-exists":
      return `${problem.settingsFile} already exists: init writes the starting settings file and does not replace the one you author. Pass --force to replace it, or --settings-file <path> to write elsewhere`;
    case "init-settings-file-unwritable":
      return `cannot write the settings file ${problem.settingsFile}: ${problem.reason}. Check that --settings-file names a writable path`;
    case "init-snapshot-failed":
      return `the snapshot of ${problem.repository} failed, so ${problem.settingsFile} was not written; the errors above name the section and the fix`;
    case "init-partial-and-empty":
      return `the snapshot of ${problem.repository} is partial and its document is empty (the warnings and errors above name the sections that were skipped or failed), so ${problem.settingsFile} was not written`;
    default:
      return describeCliProblem(problem);
  }
}

export function failInit(io: Io, problem: InitProblem): Rendered {
  const message = describeInitProblem(problem);
  io.annotate("error", message);
  return { code: 1, lines: [], json: { result: "failed", problem: message } };
}

function writeSettingsFile(cfg: InitConfig, yaml: string): Result<void, InitProblem> {
  try {
    mkdirSync(dirname(cfg.settingsFile), { recursive: true });
    writeFileSync(cfg.settingsFile, yaml);
    return ok();
  } catch (error) {
    return err({
      code: "init-settings-file-unwritable",
      settingsFile: cfg.settingsFile,
      reason: String(error),
    });
  }
}

/** The outcome keys in one status, for the lines that name them. */
function keysWith(report: SnapshotReport, ...statuses: string[]): string[] {
  return report.outcomes.filter((o) => statuses.includes(o.status)).map((o) => o.key);
}

/** The existence check comes first so a refusal costs no API call. */
export function runInit(
  cfg: InitConfig,
  io: Io,
  host: CliHost,
  bold: (text: string) => string,
): Promise<Rendered> {
  if (!cfg.force && existsSync(cfg.settingsFile)) {
    return Promise.resolve(
      failInit(io, { code: "init-settings-file-exists", settingsFile: cfg.settingsFile }),
    );
  }
  const api = host.createClient(cfg.token, io, cfg.apiVersion);
  return ResultAsync.fromSafePromise(
    snapshotRepository(api, cfg.repo, {
      sections: cfg.sections,
      onMissingPermission: cfg.onMissingPermission,
      io,
    }),
  )
    .andThen((report): Result<Rendered, InitProblem> => {
      if (report.result === "failed") {
        return err({
          code: "init-snapshot-failed",
          repository: cfg.repo.slug,
          settingsFile: cfg.settingsFile,
        });
      }
      const grant = grantTable(report.settings, bold);
      // A section failing on its own (a 500, bad credentials) leaves the run partial, not failed;
      // a document those failures emptied is no starting point, and under --force it would erase the file.
      if (report.result === "partial" && grant.sections.length === 0) {
        return err({
          code: "init-partial-and-empty",
          repository: cfg.repo.slug,
          settingsFile: cfg.settingsFile,
        });
      }
      return writeSettingsFile(cfg, report.yaml).map((): Rendered => {
        const unsupported = keysWith(report, "unsupported");
        const skipped = keysWith(report, "skipped", "failed");
        return {
          code: 0,
          lines: [
            `${cfg.settingsFile} written from ${cfg.repo.slug}: ${grant.sections.length} section(s) declared (${grant.sections.join(", ")})`,
            ...(unsupported.length === 0
              ? []
              : [
                  `not read back: ${unsupported.join(", ")} (the file's header says why; declare them by hand to manage them)`,
                ]),
            ...(skipped.length === 0
              ? []
              : [
                  `skipped: ${skipped.join(", ")} (the file omits them; the warnings above say why)`,
                ]),
            "Token permissions the file needs:",
            ...grant.lines.map((line) => `  ${line}`),
          ],
          json: {
            file: cfg.settingsFile,
            repository: cfg.repo.slug,
            result: report.result,
            skippedSections: skipped,
            grant: grant.json,
          },
        };
      });
    })
    .match(
      (rendered) => rendered,
      (problem) => failInit(io, problem),
    );
}

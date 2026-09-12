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
  parseSnapshotFileConfig,
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
      readonly code: "init-empty-document";
      readonly repository: string;
      readonly settingsFile: string;
      /** Why each selected section declares nothing, keyed by the outcome's status. */
      readonly reasons: ReadonlyArray<readonly [label: string, keys: readonly string[]]>;
    };

/** The separators every mode reads as a list, which one path can therefore never contain. */
const LIST_SEPARATOR = /[\n,]/;

/** The init flags are the snapshot inputs of one repository, so every problem is the snapshot subcommand's. */
export function parseInitConfig(
  read: InputReader,
  force: boolean,
  env: ConfigEnv,
): Result<InitConfig, InitProblem> {
  const settingsFile = read("settings-file") || DEFAULT_SETTINGS_FILE;
  if (LIST_SEPARATOR.test(settingsFile)) {
    return err({ code: "init-settings-file-is-list", value: settingsFile });
  }
  return parseSnapshotFileConfig(read, env, settingsFile).map(
    (cfg): InitConfig => ({
      kind: "init",
      token: cfg.token,
      apiVersion: cfg.apiVersion,
      repo: cfg.repo,
      settingsFile,
      sections: cfg.sections,
      onMissingPermission: cfg.onMissingPermission,
      force,
    }),
  );
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
    case "init-empty-document": {
      const why = problem.reasons
        .filter(([, keys]) => keys.length > 0)
        .map(([label, keys]) => `${label}: ${keys.join(", ")}`)
        .join("; ");
      return `the snapshot of ${problem.repository} declares no section (${why}), so ${problem.settingsFile} was not written. Choose sections init can read back, or drop --sections to read every section`;
    }
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
      const unsupported = keysWith(report, "unsupported");
      const skipped = keysWith(report, "skipped", "failed");
      // An empty document is no starting point, and under --force it would erase the file:
      // a section failing on its own leaves the run partial, and an unsupported-only
      // selection reads back nothing at all.
      if (grant.sections.length === 0) {
        return err({
          code: "init-empty-document",
          repository: cfg.repo.slug,
          settingsFile: cfg.settingsFile,
          reasons: [
            ["cannot be read back", unsupported],
            ["skipped", keysWith(report, "skipped")],
            ["failed", keysWith(report, "failed")],
            ["nothing exists on the repository", keysWith(report, "snapshot")],
          ],
        });
      }
      return writeSettingsFile(cfg, report.yaml).map((): Rendered => {
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

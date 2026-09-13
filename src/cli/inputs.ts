/**
 * The CLI's read port over commander: every flag is one INPUT_DECLS entry
 * spelled `--<name> <value>`, so the help text and the action's inputs
 * reference come from one declaration. The subcommand is the `mode` input
 * and `--token` is a program-level flag; every other input is a flag of the
 * subcommands whose mode reads it. parseConfig validates the values; nothing
 * here does.
 */

import { InvalidArgumentError, Option } from "commander";
import type { InputReader } from "../index.js";
import {
  INPUT_DECLS,
  type InputDecl,
  type InputName,
  MERGE_INPUTS,
  MERGE_ONLY_INPUTS,
  MODES,
  type Mode,
  SNAPSHOT_INPUTS,
  SNAPSHOT_ONLY_INPUTS,
} from "../internal.js";

/** Declaration order is the help order, as on the inputs reference page. */
const INPUT_NAMES = Object.keys(INPUT_DECLS) as InputName[];

/** The two inputs that are not subcommand flags: the mode is the subcommand, the token is global. */
const PROGRAM_INPUTS = ["mode", "token"] as const satisfies readonly InputName[];

/**
 * Inputs no subcommand exposes: the artifact report channel needs the Actions
 * artifact service, which a terminal has no upload for, so its key has no use.
 */
export const CLI_UNSUPPORTED_INPUTS = ["report-public-key"] as const satisfies readonly InputName[];

/** The flags a mode's subcommand takes: the inputs its mode reads, in declaration order. */
export function inputsForMode(mode: Mode): InputName[] {
  const hidden: readonly InputName[] = [...PROGRAM_INPUTS, ...CLI_UNSUPPORTED_INPUTS];
  const modeOnly: readonly InputName[] = [...MERGE_ONLY_INPUTS, ...SNAPSHOT_ONLY_INPUTS];
  const reads = (name: InputName): boolean => {
    switch (mode) {
      case "merge":
        return (MERGE_INPUTS as readonly InputName[]).includes(name);
      case "snapshot":
        return (SNAPSHOT_INPUTS as readonly InputName[]).includes(name);
      case "apply":
      case "check":
        return !modeOnly.includes(name);
    }
  };
  return INPUT_NAMES.filter((name) => !hidden.includes(name) && reads(name));
}

/** What one subcommand accepts: the shape its flags' help text is worded for. */
export interface Subcommand {
  /** The inputs the subcommand takes as flags. */
  readonly flags: ReadonlySet<InputName>;
  /** The mode the subcommand runs, or null for init, which runs none. */
  readonly mode: Mode | null;
}

/** A mode's subcommand: its flags are the inputs the mode reads. */
export function modeSubcommand(mode: Mode): Subcommand {
  return { flags: new Set(inputsForMode(mode)), mode };
}

/**
 * The init subcommand: the snapshot inputs of one repository, with
 * settings-file as the destination in place of snapshot-file. No mode runs
 * it, so the clauses restricted to modes leave its help.
 */
export const INIT_SUBCOMMAND: Subcommand = {
  flags: new Set<InputName>([
    "repository",
    "settings-file",
    "on-missing-permission",
    "sections",
    "api-version",
  ]),
  mode: null,
};

/** init's flags in declaration order, the order the help keeps. */
export const INIT_INPUTS: readonly InputName[] = INPUT_NAMES.filter((name) =>
  INIT_SUBCOMMAND.flags.has(name),
);

/**
 * init's one reworded flag: the declaration describes the file apply and check
 * READ, and init WRITES it; every other init flag keeps its declared text.
 */
export const INIT_SETTINGS_FILE_DESCRIPTION =
  "Where the settings document is written: the file apply and check read. One path; an existing file is kept unless --force is passed.";

/** Every input some subcommand or the program exposes; the mode is the subcommand itself. */
export function exposedInputs(): InputName[] {
  const flags = new Set<InputName>(["token", ...MODES.flatMap(inputsForMode)]);
  return INPUT_NAMES.filter((name) => flags.has(name));
}

/** `text` as the declaration spells it; a reworded declaration fails here rather than leave the help stale. */
export function declared(input: InputName, text: string): string {
  if (!INPUT_DECLS[input].description.includes(text)) {
    throw new Error(
      `BUG: the ${input} input's description no longer says "${text}"; reword the CLI's clause with it`,
    );
  }
  return text;
}

/**
 * A stretch of a declaration's description whose truth rests on other flags
 * or on the mode, removed verbatim (its leading separator included) from the
 * help of a subcommand that does not meet the assumption.
 */
interface Clause {
  readonly input: InputName;
  readonly text: string;
  /** What stands in for `text` when it is removed; a bare removal by default. */
  readonly replacement?: string;
  /** Met when the subcommand accepts every one of these flags. */
  readonly flags?: readonly InputName[];
  /** Met when the subcommand runs one of these modes. */
  readonly modes?: readonly Mode[];
}

const MULTI_REPO_FLAGS: readonly InputName[] = ["repos", "repos-dir"];

const CLAUSES: readonly Clause[] = [
  {
    input: "repository",
    text: declared(
      "repository",
      " Single-repo mode only; cannot be combined with repos or repos-dir.",
    ),
    flags: MULTI_REPO_FLAGS,
  },
  {
    input: "settings-file",
    text: declared(
      "settings-file",
      " Single-repo and merge modes only; multi-repo targets read repos-dir files or each " +
        "repository's own .github/settings.yml, so overriding it alongside repos or repos-dir fails the run.",
    ),
    flags: MULTI_REPO_FLAGS,
  },
  {
    input: "snapshot-dir",
    text: declared("snapshot-dir", "; defaults-file does not apply"),
    flags: ["defaults-file"],
  },
  {
    input: "sections",
    text: declared(
      "sections",
      " apply, check, and snapshot only: mode: merge writes every section its layers declare, " +
        "so the allowlist belongs on the step that runs the merged document and fails the merge when set.",
    ),
    modes: ["apply", "check", "snapshot"],
  },
  {
    input: "private-report",
    text: declared(
      "private-report",
      " Under artifact, those reports are concatenated, age-encrypted to report-public-key, and " +
        "uploaded as one workflow artifact (settings-as-code-private-report) for readers who hold " +
        "the key but no GitHub access to the targets; the artifact channel needs the Actions " +
        "artifact service, so on GitHub Enterprise Server it warns and uploads nothing.",
    ),
    flags: ["report-public-key"],
  },
  {
    input: "private-report",
    text: declared("private-report", "issue, issue-on-failure, or artifact."),
    replacement: "issue, or issue-on-failure.",
    flags: ["report-public-key"],
  },
];

function meets(subcommand: Subcommand, clause: Clause): boolean {
  const flags = (clause.flags ?? []).every((flag) => subcommand.flags.has(flag));
  const mode =
    clause.modes === undefined ||
    (subcommand.mode !== null && clause.modes.includes(subcommand.mode));
  return flags && mode;
}

/** The sentence the action's `repository` description spends on a default a terminal never has. */
const ACTIONS_DEFAULT_SENTENCE = declared("repository", "Defaults to the current repository.");

/**
 * A flag's help text under `subcommand`: the declaration's, minus the clauses
 * about flags and modes the subcommand lacks, and reworded where it assumes
 * the Actions runner.
 */
export function inputDescription(name: InputName, subcommand: Subcommand): string {
  let description: string = INPUT_DECLS[name].description;
  for (const clause of CLAUSES) {
    if (clause.input === name && !meets(subcommand, clause)) {
      description = description.replace(clause.text, clause.replacement ?? "");
    }
  }
  if (name === "repository") {
    const unless = MULTI_REPO_FLAGS.every((flag) => subcommand.flags.has(flag))
      ? " unless repos or repos-dir is set"
      : "";
    description = description.replace(
      ACTIONS_DEFAULT_SENTENCE,
      `Required${unless} (inside GitHub Actions, GITHUB_REPOSITORY supplies it).`,
    );
  }
  return description;
}

/** Whether the declaration is a list; read through InputDecl since only the list members carry the field. */
export function isList(name: InputName): boolean {
  const decl: InputDecl = INPUT_DECLS[name];
  return decl.list === true;
}

/** A repeated list flag accumulates as a newline-separated list, the form parseConfig splits. */
function accumulate(value: string, previous?: string): string {
  return previous === undefined ? value : `${previous}\n${value}`;
}

/** A repeated single-value flag is refused: joined, it would form a value the action cannot receive. */
export function once(flag: string): (value: string, previous?: string) => string {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError(`--${flag} takes one value and was given more than once`);
    }
    return value;
  };
}

/**
 * The commander option for one input under `subcommand`: `--<name> <value>`,
 * repeatable when the declaration is a list; `description` replaces the
 * declaration's where the subcommand reads the input for another purpose.
 */
export function inputOption(
  name: InputName,
  subcommand: Subcommand,
  description = inputDescription(name, subcommand),
): Option {
  const parse = isList(name) ? accumulate : once(name);
  return new Option(`--${name} <value>`, description).argParser(parse);
}

/** Commander's attribute for each flag (camelCase of the name), read from commander itself. */
const ATTRIBUTE: Readonly<Record<InputName, string>> = Object.fromEntries(
  INPUT_NAMES.map((name) => [name, new Option(`--${name} <value>`).attributeName()]),
) as Record<InputName, string>;

/** A flag value as the runner would hand it over: trimmed, as @actions/core trims every input. */
function inputValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The read port for a subcommand: `mode` is the subcommand, every other
 * input is its parsed flag, empty when unset, so parseConfig sees exactly
 * what the action's runner would hand it.
 */
export function argvReader(mode: Mode, values: Readonly<Record<string, unknown>>): InputReader {
  return (name) => (name === "mode" ? mode : inputValue(values[ATTRIBUTE[name]]));
}

/**
 * Every value `--token` carries in `argv`, in both spellings commander
 * accepts, as the reader would read it. Read before parsing, so the token is
 * masked before the parser can echo it in a message of its own.
 */
export function tokenValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  argv.forEach((argument, index) => {
    if (argument === "--token") {
      values.push(inputValue(argv[index + 1]));
    } else if (argument.startsWith("--token=")) {
      values.push(inputValue(argument.slice("--token=".length)));
    }
  });
  return values.filter((value) => value !== "");
}

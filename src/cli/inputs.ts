/**
 * The CLI's read port over commander: every flag is one INPUT_DECLS entry
 * spelled `--<name> <value>`, so the help text and the action's inputs
 * reference come from one declaration. The subcommand is the `mode` input
 * and `--token` is a program-level flag; every other input is a flag of the
 * subcommands whose mode reads it. parseConfig validates the values; nothing
 * here does.
 */

import { InvalidArgumentError, Option } from "commander";
import {
  INPUT_DECLS,
  type InputDecl,
  type InputName,
  type InputReader,
  MERGE_INPUTS,
  MODES,
  type Mode,
} from "../index.js";

/** Declaration order is the help order, as on the inputs reference page. */
const INPUT_NAMES = Object.keys(INPUT_DECLS) as InputName[];

/** The two inputs that are not subcommand flags: the mode is the subcommand, the token is global. */
const PROGRAM_INPUTS = ["mode", "token"] as const satisfies readonly InputName[];

/**
 * Inputs no subcommand exposes: the artifact report channel needs the Actions
 * artifact service, which a terminal has no upload for, so its key has no use.
 */
export const CLI_UNSUPPORTED_INPUTS = ["report-public-key"] as const satisfies readonly InputName[];

/**
 * The flags a mode's subcommand takes: the inputs its mode reads. `settings-file`
 * is the one input both the merge and the engine modes read.
 */
export function inputsForMode(mode: Mode): InputName[] {
  const mergeReads = (name: InputName): boolean =>
    (MERGE_INPUTS as readonly InputName[]).includes(name);
  const hidden: readonly InputName[] = [...PROGRAM_INPUTS, ...CLI_UNSUPPORTED_INPUTS];
  return INPUT_NAMES.filter(
    (name) =>
      !hidden.includes(name) &&
      (mode === "merge" ? mergeReads(name) : !mergeReads(name) || name === "settings-file"),
  );
}

/** Every input some subcommand or the program exposes; the mode is the subcommand itself. */
export function exposedInputs(): InputName[] {
  const flags = new Set<InputName>(["token", ...MODES.flatMap(inputsForMode)]);
  return INPUT_NAMES.filter((name) => flags.has(name));
}

/** The sentence the action's `repository` description spends on a default a terminal never has. */
const ACTIONS_DEFAULT_SENTENCE = "Defaults to the current repository.";
const CLI_REPOSITORY_SENTENCE =
  "Required unless repos or repos-dir is set (inside GitHub Actions, GITHUB_REPOSITORY supplies it).";
if (!INPUT_DECLS.repository.description.includes(ACTIONS_DEFAULT_SENTENCE)) {
  throw new Error(
    `BUG: the repository input's description no longer says "${ACTIONS_DEFAULT_SENTENCE}"; reword the CLI's replacement with it`,
  );
}

/** The flag's help text: the declaration's, reworded where it assumes the Actions runner. */
export function inputDescription(name: InputName): string {
  const description = INPUT_DECLS[name].description;
  return name === "repository"
    ? description.replace(ACTIONS_DEFAULT_SENTENCE, CLI_REPOSITORY_SENTENCE)
    : description;
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

/** The commander option for one input: `--<name> <value>`, repeatable when the declaration is a list. */
export function inputOption(name: InputName): Option {
  const parse = isList(name) ? accumulate : once(name);
  return new Option(`--${name} <value>`, inputDescription(name)).argParser(parse);
}

/** Commander's attribute for each flag (camelCase of the name), read from commander itself. */
const ATTRIBUTE: Readonly<Record<InputName, string>> = Object.fromEntries(
  INPUT_NAMES.map((name) => [name, inputOption(name).attributeName()]),
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

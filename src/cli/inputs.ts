/**
 * The CLI's read port over commander: every flag is one INPUT_DECLS entry
 * spelled `--<name> <value>`, so the help text and the action's inputs
 * reference come from one declaration. The subcommand is the `mode` input
 * and `--token` is a program-level flag; every other input is a flag of the
 * subcommands whose mode reads it. parseConfig validates the values; nothing
 * here does.
 */

import { Option } from "commander";
import {
  INPUT_DECLS,
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
 * The flags a mode's subcommand takes: the inputs its mode reads. `settings-file`
 * is the one input both the merge and the engine modes read.
 */
export function inputsForMode(mode: Mode): InputName[] {
  const mergeReads = (name: InputName): boolean =>
    (MERGE_INPUTS as readonly InputName[]).includes(name);
  return INPUT_NAMES.filter(
    (name) =>
      !(PROGRAM_INPUTS as readonly InputName[]).includes(name) &&
      (mode === "merge" ? mergeReads(name) : !mergeReads(name) || name === "settings-file"),
  );
}

/** Every input some subcommand or the program exposes; the mode is the subcommand itself. */
export function exposedInputs(): InputName[] {
  const flags = new Set<InputName>(["token", ...MODES.flatMap(inputsForMode)]);
  return INPUT_NAMES.filter((name) => flags.has(name));
}

/** A repeated flag accumulates as a newline-separated list, the form parseConfig splits. */
function accumulate(value: string, previous?: string): string {
  return previous === undefined ? value : `${previous}\n${value}`;
}

/** The commander option for one input: `--<name> <value>` with the action's description. */
export function inputOption(name: InputName): Option {
  return new Option(`--${name} <value>`, INPUT_DECLS[name].description).argParser(accumulate);
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

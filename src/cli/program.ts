/**
 * The command tree: check, apply, merge, and snapshot mirror the action's modes with
 * INPUT_DECLS as their flags; validate and permissions read a file alone.
 * `--token`, `--json`, `--summary`, and `--verbose` are global. main() runs
 * argv to its exit code without touching the process.
 */

import { Command, CommanderError, Option } from "commander";
import pc from "picocolors";
import {
  failRun,
  GithubApi,
  INPUT_DECLS,
  type Io,
  type Mode,
  type MustBeNever,
  parseConfig,
  type RunConfig,
} from "../index.js";
import {
  ARTIFACT_REFUSED,
  type CliHost,
  describeCliProblem,
  permissionsFor,
  type Rendered,
  runConfig,
  validateFile,
} from "./commands.js";
import { argvReader, inputOption, inputsForMode, once, tokenValues } from "./inputs.js";
import { type CliStreams, cliIo, type MaskedStreams, maskedStreams } from "./io.js";

/** Every subcommand, in help order; the package smoke asserts the installed help names each. */
export const CLI_COMMANDS = [
  "check",
  "apply",
  "merge",
  "snapshot",
  "validate",
  "permissions",
] as const;

type CliCommand = (typeof CLI_COMMANDS)[number];

const DESCRIPTION: Readonly<Record<CliCommand, string>> = {
  check: "Report drift between a settings file and the live repository; exits 1 on any drift",
  apply: "Apply a settings file to the repository",
  merge: "Fold an ordered list of settings files into one document, with no token and no API call",
  snapshot:
    "Write a repository's live settings as a settings file, or one file per multi-repo target under a directory",
  validate: "Validate a settings file against the schema; no token, no API call",
  permissions: "Print the PAT grant each section a settings file declares needs",
};

/** The subcommands that run the engine or the merge, each under its mode. */
const MODE_COMMANDS = {
  check: "check",
  apply: "apply",
  merge: "merge",
  snapshot: "snapshot",
} as const satisfies Partial<Record<CliCommand, Mode>>;

/** Compile-time lockstep: a Mode without a subcommand fails here. */
type _UnlistedMode = MustBeNever<Exclude<Mode, (typeof MODE_COMMANDS)[keyof typeof MODE_COMMANDS]>>;

interface Globals {
  readonly token?: string;
  readonly json?: boolean;
  readonly summary?: string;
  readonly verbose?: boolean;
}

export interface ProgramOptions {
  readonly host: CliHost;
  /** The output boundary every writer, the parser included, goes through. */
  readonly streams: MaskedStreams;
  /** Color the level labels and the permissions table; defaults to picocolors' detection. */
  readonly colors?: boolean;
  /** Run a parsed config; tests capture the config here instead of running it. */
  readonly execute?: (cfg: RunConfig, io: Io) => Promise<number>;
}

/** The production host: process.env and the real client. */
export function processHost(): CliHost {
  return {
    env: process.env,
    createClient: (token, io, apiVersion) => new GithubApi({ token, io, apiVersion }),
  };
}

/**
 * The whole command tree, wired to `options`; the exit code lands in the
 * returned holder. The environment's token is masked here, before any writer
 * exists; the argv token is main()'s to register, before the parse.
 */
export function buildProgram(options: ProgramOptions): {
  program: Command;
  exitCode: () => number;
} {
  const { host, streams } = options;
  const colors = options.colors ?? pc.isColorSupported;
  const paint = pc.createColors(colors);
  const execute = options.execute ?? ((cfg, io) => runConfig(cfg, io, host));
  const envToken = host.env.GITHUB_TOKEN?.trim();
  if (envToken !== undefined && envToken !== "") {
    streams.mask(envToken);
  }
  let exitCode = 0;
  const program = new Command()
    .name("github-settings-as-code")
    .description(
      "Apply, check, merge, and validate declarative GitHub repository settings (also installed as gsac)",
    )
    .addOption(
      new Option(
        "--token <value>",
        `${INPUT_DECLS.token.description} Falls back to GITHUB_TOKEN.`,
      ).argParser(once("token")),
    )
    .option("--json", "Print the outputs as one JSON object on stdout; log lines move to stderr")
    .addOption(
      new Option("--summary <file>", "Append the run's markdown summary to this file").argParser(
        once("summary"),
      ),
    )
    .option("--verbose", "Show the debug trace on stderr")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
    });

  const openIo = (globals: Globals) =>
    cliIo({
      streams,
      json: globals.json === true,
      verbose: globals.verbose === true,
      summaryFile: globals.summary,
      colors,
    });

  /** Print a file-only command's result the way `--json` asks. */
  const present = (rendered: Rendered, globals: Globals): void => {
    if (globals.json === true) {
      streams.stdout.write(`${JSON.stringify(rendered.json)}\n`);
      return;
    }
    for (const line of rendered.lines) {
      streams.stdout.write(`${line}\n`);
    }
  };

  for (const [name, mode] of Object.entries(MODE_COMMANDS) as [CliCommand, Mode][]) {
    const command = program.command(name).description(DESCRIPTION[name]);
    for (const input of inputsForMode(mode)) {
      command.addOption(inputOption(input));
    }
    command.action(async function (this: Command) {
      const values = this.optsWithGlobals<Globals & Record<string, unknown>>();
      const { io, flush } = openIo(values);
      const read = argvReader(mode, values);
      // Refused before parseConfig, which would otherwise ask for the channel's age key first.
      exitCode =
        read("private-report") === "artifact"
          ? failRun(io, ARTIFACT_REFUSED, describeCliProblem)
          : await parseConfig(read, host.env).match(
              (cfg) => execute(cfg, io),
              async (problem) => failRun(io, problem, describeCliProblem),
            );
      flush();
    });
  }

  program
    .command("validate")
    .description(DESCRIPTION.validate)
    .argument("<file>", "the settings file to validate")
    .action(function (this: Command, file: string) {
      const globals = this.optsWithGlobals<Globals>();
      const { io } = openIo(globals);
      const rendered = validateFile(file, io);
      present(rendered, globals);
      exitCode = rendered.code;
    });

  program
    .command("permissions")
    .description(DESCRIPTION.permissions)
    .argument("<file>", "the settings file whose sections decide the grant")
    .action(function (this: Command, file: string) {
      const globals = this.optsWithGlobals<Globals>();
      const { io } = openIo(globals);
      const rendered = permissionsFor(file, io, paint.bold);
      present(rendered, globals);
      exitCode = rendered.code;
    });

  return { program, exitCode: () => exitCode };
}

/** Run `argv` (the full process.argv shape) to its exit code; every line, a crash's included, is masked. */
export async function main(
  argv: readonly string[],
  options: Omit<ProgramOptions, "streams"> & { readonly streams: CliStreams },
): Promise<number> {
  const streams = maskedStreams(options.streams);
  for (const token of tokenValues(argv)) {
    streams.mask(token);
  }
  const { program, exitCode } = buildProgram({ ...options, streams });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    const verbose = program.opts<Globals>().verbose === true;
    const detail = verbose && error instanceof Error && error.stack ? error.stack : String(error);
    // Under --verbose the stack is already printed, so asking for it again would loop.
    const remedy = verbose
      ? "The stack above is the report: if it recurs, file a bug with it attached"
      : "Re-run with --verbose for the stack; if it recurs, file a bug with that output attached";
    streams.stderr.write(
      `error: github-settings-as-code stopped unexpectedly: ${detail}. ${remedy}\n`,
    );
    return 1;
  }
  return exitCode();
}

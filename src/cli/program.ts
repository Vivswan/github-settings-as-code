/**
 * The command tree: check, apply, and merge mirror the action's modes with
 * INPUT_DECLS as their flags; validate and permissions read a file alone;
 * snapshot and init name the snapshot mode this library build may not carry.
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
  parseConfig,
  type RunConfig,
} from "../index.js";
import {
  type CliHost,
  permissionsFor,
  type Rendered,
  runConfig,
  unavailable,
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
  "init",
  "validate",
  "permissions",
] as const;

type CliCommand = (typeof CLI_COMMANDS)[number];

const DESCRIPTION: Readonly<Record<CliCommand, string>> = {
  check: "Report drift between a settings file and the live repository; exits 1 on any drift",
  apply: "Apply a settings file to the repository",
  merge: "Fold an ordered list of settings files into one document, with no token and no API call",
  snapshot:
    "Write the live repository settings as a settings file (needs a build with mode: snapshot)",
  init: "Snapshot the repository into .github/settings.yml and print the PAT grant it needs (needs a build with mode: snapshot)",
  validate: "Validate a settings file against the schema; no token, no API call",
  permissions: "Print the PAT grant each section a settings file declares needs",
};

/** The subcommands that run the engine or the merge, each under its mode. */
const MODE_COMMANDS = { check: "check", apply: "apply", merge: "merge" } as const satisfies Partial<
  Record<CliCommand, Mode>
>;

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
      exitCode = await parseConfig(argvReader(mode, values), host.env).match(
        (cfg) => execute(cfg, io),
        async (problem) => failRun(io, problem),
      );
      flush();
    });
  }

  for (const name of ["snapshot", "init"] as const) {
    program
      .command(name)
      .description(DESCRIPTION[name])
      .action(function (this: Command) {
        const { io } = openIo(this.optsWithGlobals<Globals>());
        exitCode = unavailable(name, io);
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

/**
 * Run `argv` (the full process.argv shape) to its exit code over plain
 * streams, which are wrapped in the mask boundary first. Commander's own
 * exits (help shown, a bad flag) become the code it would have exited with;
 * anything else that escapes a command is reported through the boundary
 * (the stack under --verbose) and exits 1, so no path prints unmasked.
 */
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
    streams.stderr.write(
      `error: github-settings-as-code stopped unexpectedly: ${detail}. Re-run with --verbose; if it recurs, report a bug with this output attached\n`,
    );
    return 1;
  }
  return exitCode();
}

/**
 * The command tree: check, apply, render, and snapshot mirror the action's modes with
 * INPUT_DECLS as their flags; init snapshots one repository into the settings
 * file; validate and permissions read a file alone. `--token`, `--json`,
 * `--summary`, and `--verbose` are global. main() runs argv to its exit code
 * without touching the process.
 */

import { Command, CommanderError, Option } from "commander";
import pc from "picocolors";
import {
  describeProblem,
  executeRun,
  failRun,
  GitHubApi,
  type Io,
  parseConfig,
  type RunConfig,
  type RunEnd,
} from "../index.js";
import { INPUT_DECLS, type Mode, type MustBeNever, snapshotFileDestination } from "../internal.js";
import { actionsRunner } from "./actions.js";
import {
  type CliHost,
  failedEnvelope,
  permissionsFor,
  type Rendered,
  validateFile,
} from "./commands.js";
import { failInit, type InitConfig, parseInitConfig, runInit } from "./init.js";
import {
  argvReader,
  INIT_INPUTS,
  INIT_SETTINGS_FILE_DESCRIPTION,
  INIT_SUBCOMMAND,
  inputOption,
  modeSubcommand,
  once,
  tokenValues,
} from "./inputs.js";
import { type CliStreams, cliIo, type MaskedStreams, maskedStreams } from "./io.js";

/** Every subcommand, in help order; the package smoke asserts the installed help names each. */
export const CLI_COMMANDS = [
  "check",
  "apply",
  "render",
  "snapshot",
  "init",
  "validate",
  "permissions",
] as const;

type CliCommand = (typeof CLI_COMMANDS)[number];

const DESCRIPTION: Readonly<Record<CliCommand, string>> = {
  check: "Report drift between a settings file and the live repository; exits 1 on any drift",
  apply: "Apply a settings file to the repository",
  render:
    "Fold an ordered list of settings files into one rendered document, with no token and no API call",
  snapshot:
    "Write a repository's live settings as a settings file, or one file per multi-repo target under a directory",
  init: "Start managing a repository: write its live settings to the settings file (.github/settings.yml unless --settings-file says otherwise) and print the PAT grant that file needs",
  validate: "Validate a settings file against the schema; no token, no API call",
  permissions: "Print the PAT grant each section a settings file declares needs",
};

/** The subcommands that run the engine or the render, each under its mode. */
const MODE_COMMANDS = {
  check: "check",
  apply: "apply",
  render: "render",
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
  /** Run a parsed config to its end; tests capture the config here instead of running it. */
  readonly execute?: (cfg: RunConfig, io: Io) => Promise<RunEnd>;
  /** Run a parsed init config to its rendering; tests capture the config here instead of running it. */
  readonly executeInit?: (cfg: InitConfig, io: Io) => Promise<Rendered>;
}

/** The production host: process.env and the real client. */
export function processHost(): CliHost {
  return {
    env: process.env,
    createClient: (token, io, apiVersion) => new GitHubApi({ token, io, apiVersion }),
  };
}

/** A terminal has no Actions artifact service, so the artifact report channel is refused at the parse. */
const CLI_CAPABILITIES = { artifactUpload: false } as const;

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
  const execute =
    options.execute ??
    ((cfg, io) =>
      executeRun(cfg, {
        io,
        createClient: (token, io, apiVersion) => host.createClient(token, io, apiVersion),
      }));
  const executeInit = options.executeInit ?? ((cfg, io) => runInit(cfg, io, host, paint.bold));
  const envToken = host.env.GITHUB_TOKEN?.trim();
  if (envToken !== undefined && envToken !== "") {
    streams.mask(envToken);
  }
  let exitCode = 0;
  const program = new Command()
    .name("github-settings-as-code")
    .description(
      "Apply, check, render, and validate declarative GitHub repository settings (also installed as gsac)",
    )
    .addOption(
      new Option(
        "--token <value>",
        `${INPUT_DECLS.token.description} Falls back to GITHUB_TOKEN.`,
      ).argParser(once("token")),
    )
    .option("--json", "Print the outputs as one JSON object on stdout; log lines move to stderr")
    .addOption(
      new Option(
        "--summary <file>",
        "Append the run's markdown summary to this file (under GitHub Actions, the step summary when absent)",
      ).argParser(once("summary")),
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
    const subcommand = modeSubcommand(mode);
    for (const input of subcommand.flags) {
      command.addOption(inputOption(input, subcommand));
    }
    command.action(async function (this: Command) {
      const values = this.optsWithGlobals<Globals & Record<string, unknown>>();
      const { io, flush } = openIo(values);
      const read = argvReader(mode, values);
      // The envelope carries the fatal problem's text beside the outputs; the line itself is already on stderr.
      let fatal: string | undefined;
      exitCode = await parseConfig(read, host.env, CLI_CAPABILITIES).match(
        async (cfg) => {
          const end = await execute(cfg, io);
          fatal = end.fatal === undefined ? undefined : describeProblem(end.fatal);
          return end.exitCode;
        },
        async (problem) => {
          fatal = describeProblem(problem);
          return failRun(io, problem);
        },
      );
      flush(fatal);
    });
  }

  const init = program.command("init").description(DESCRIPTION.init);
  for (const input of INIT_INPUTS) {
    init.addOption(
      input === "settings-file"
        ? inputOption(input, INIT_SUBCOMMAND, INIT_SETTINGS_FILE_DESCRIPTION)
        : inputOption(input, INIT_SUBCOMMAND),
    );
  }
  init
    .option("--force", "Replace the settings file when it already exists; without it, init refuses")
    .action(async function (this: Command) {
      const values = this.optsWithGlobals<
        Globals & { force?: boolean } & Record<string, unknown>
      >();
      const { io } = openIo(values);
      const read = argvReader("snapshot", values);
      const rendered = await parseInitConfig(read, values.force === true, host.env).match(
        (cfg) => executeInit(cfg, io),
        async (problem) => failInit(io, problem, snapshotFileDestination(read)),
      );
      present(rendered, values);
      exitCode = rendered.code;
    });

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
 * Run `argv` (the full process.argv shape) to its exit code; every line, a crash's included, is masked. Under --json a
 * failure the parser or a crash ends in prints the same failed envelope a run prints, so stdout is always one object.
 * Whether the run reports to a GitHub Actions runner is decided here, once, from the host's environment.
 */
export async function main(
  argv: readonly string[],
  options: Omit<ProgramOptions, "streams"> & { readonly streams: CliStreams },
): Promise<number> {
  const streams = maskedStreams(options.streams, actionsRunner(options.host.env));
  for (const token of tokenValues(argv)) {
    streams.mask(token);
  }
  const { program, exitCode } = buildProgram({ ...options, streams });
  // Under --json stdout is one object, a parser error's included. The parser's verdict comes first (it read every token,
  // so `--summary -- --json` is the flag); the argv scan covers an error raised before the parser reached the flag
  // (`--token a --token b --json`). Tokens after a `--` terminator are arguments, never the flag.
  const terminator = argv.indexOf("--");
  const optionTokens = argv.slice(0, terminator === -1 ? argv.length : terminator);
  const failedJson = (message: string): void => {
    if (program.opts<Globals>().json === true || optionTokens.includes("--json")) {
      streams.stdout.write(`${JSON.stringify(failedEnvelope(message))}\n`);
    }
  };
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already wrote its line (or the usage) to stderr; --help exits 0 and is no failure. A missing
      // subcommand is the usage shown as an error, whose message is commander's "(outputHelp)" sentinel.
      if (error.exitCode !== 0) {
        failedJson(
          error.code === "commander.help"
            ? "no subcommand was given; the usage above lists them"
            : error.message.replace(/^error: /, ""),
        );
      }
      return error.exitCode;
    }
    const globals = program.opts<Globals>();
    const verbose = globals.verbose === true;
    const detail = verbose && error instanceof Error && error.stack ? error.stack : String(error);
    // Under --verbose the stack is already printed, so asking for it again would loop.
    const remedy = verbose
      ? "The stack above is the report: if it recurs, file a bug with it attached"
      : "Re-run with --verbose for the stack; if it recurs, file a bug with that output attached";
    const message = `github-settings-as-code stopped unexpectedly: ${detail}. ${remedy}`;
    // The crash line goes through the same renderer as every other error line, so its label and color match.
    cliIo({
      streams,
      json: globals.json === true,
      verbose,
      colors: options.colors ?? pc.isColorSupported,
    }).io.annotate("error", message);
    failedJson(message);
    return 1;
  }
  return exitCode();
}

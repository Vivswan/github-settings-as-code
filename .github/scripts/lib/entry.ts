/**
 * How a script under .github/scripts enters and exits: the subcommand a workflow step names, and the one exit path a
 * refusal takes. A handler ends the step by returning its status or by throwing the refusal; the runner prints the
 * refusal as `<script> <command>: <message>` and sets the status, so no script prints and exits on its own.
 * Node builtins only: the release and post-green jobs run their scripts before any install.
 */

// biome-ignore lint/suspicious/noConfusingVoidType: a handler that ends without a status returns void, which TypeScript does not read as undefined
type Status = number | void;

/** A script's main, or one subcommand of it: the exit status it returns (none is 0), or the refusal it throws. */
export type Handler = (args: readonly string[]) => Status | Promise<Status>;

/** Runs `main` and sets the process's exit status from its verdict. The status is set, never exited to, so a main's
 * last stdout lines drain through a pipe before the process ends. */
export async function runMain(label: string, main: () => Status | Promise<Status>): Promise<void> {
  try {
    const status = await main();
    process.exitCode = typeof status === "number" ? status : 0;
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/** Runs the subcommand `argv` opens with, from the table, with the rest of `argv` as its arguments. A missing or
 * unknown command is refused naming the script and the commands it knows, status 1, before any handler runs.
 * Only the table's own keys are commands: `constructor` reaches no handler. */
export async function dispatch(
  script: string,
  commands: Readonly<Record<string, Handler>>,
  argv: readonly string[],
): Promise<void> {
  const [command, ...args] = argv;
  const handler =
    command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (command === undefined || handler === undefined) {
    const given =
      command === undefined ? "no command given" : `unknown command ${JSON.stringify(command)}`;
    console.error(`${script}: ${given}; expected ${Object.keys(commands).join(" | ")}`);
    process.exitCode = 1;
    return;
  }
  await runMain(`${script} ${command}`, () => handler(args));
}

/**
 * The replay block a failing artifact's report.md carries right after its title. fuzz.ts writes it (via the runner's
 * insertReplay) and .github/scripts/file-fuzz-issue.ts lifts it out again, so the replay is authored ONCE by the run
 * that knows its master seed, --iterations, and --sections; a scenario name alone cannot recover those (a battery
 * entry replays with the master seed at --iterations 0, not the seed in its name).
 */

const HEADING = "## Replay";
const FENCE_OPEN = "```sh";
const FENCE_CLOSE = "```";

export function replayBlockLines(replay: string): string[] {
  return ["", HEADING, "", FENCE_OPEN, replay, FENCE_CLOSE];
}

/** The command and the report without its block, or undefined when the report never had one. */
export function liftReplay(report: string): { replay: string; rest: string } | undefined {
  const lines = report.split("\n");
  const heading = lines.indexOf(HEADING);
  if (heading < 0) {
    return undefined;
  }
  const open = lines.indexOf(FENCE_OPEN, heading);
  if (open < 0 || lines[open + 2] !== FENCE_CLOSE) {
    throw new Error(
      `report has a "${HEADING}" heading but no ${FENCE_OPEN} block of one command under it`,
    );
  }
  // The heading's leading blank line goes with it, so the title is followed by the report's own blank line.
  const from = lines[heading - 1] === "" ? heading - 1 : heading;
  return {
    replay: lines[open + 1] as string,
    rest: [...lines.slice(0, from), ...lines.slice(open + 3)].join("\n"),
  };
}

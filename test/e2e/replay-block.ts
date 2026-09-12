/**
 * The replay block a failing artifact's report.md carries right after its title. fuzz.ts writes it (via the runner's
 * insertReplay) and .github/scripts/file-fuzz-issue.ts lifts it back out, so the replay is authored ONCE by the run
 * that knows its master seed, --iterations, and --sections; a scenario name alone cannot recover those (a battery
 * entry replays with the master seed at --iterations 0, not the seed in its name).
 */

const HEADING = "## Replay";
const FENCE_OPEN = "```sh";
const FENCE_CLOSE = "```";

export function replayBlockLines(replay: string): string[] {
  return ["", HEADING, "", FENCE_OPEN, replay, FENCE_CLOSE];
}

export function replayFromReport(report: string): string | undefined {
  const lines = report.split("\n");
  const heading = lines.indexOf(HEADING);
  if (heading < 0) {
    return undefined;
  }
  const open = lines.indexOf(FENCE_OPEN, heading);
  const close = open < 0 ? -1 : lines.indexOf(FENCE_CLOSE, open + 1);
  if (open < 0 || close !== open + 2) {
    return undefined;
  }
  return lines[open + 1];
}

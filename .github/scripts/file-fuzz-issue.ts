/**
 * Files (or comments on) the GitHub issue for a failed nightly e2e run from the failing-scenario directories dumped
 * under test/e2e/.artifacts/. A recurring failure comments on the open e2e-fuzz issue instead of opening a duplicate.
 *
 * Env: GH_TOKEN (gh auth), GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (the run link).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { replayBlockLines, replayFromReport } from "../../test/e2e/replay-block.js";

const ROOT = join(import.meta.dir, "..", "..");
const ARTIFACTS = join(ROOT, "test", "e2e", ".artifacts");
const LABEL = "e2e-fuzz";
const ISSUE_TITLE = "e2e fuzz failures (nightly)";
/** A body is a summary, not a log. */
const REPORT_LINES = 60;
/** The full file is in the uploaded artifacts. */
const SCENARIO_LINES = 80;
/** GitHub caps an issue or comment body at 65,536 characters. */
const MAX_BODY = 60_000;
/** Per-block cap after line truncation: one very long line cannot dominate the body, and the header, footer, notice,
 * and at least one full block always fit inside MAX_BODY. */
const MAX_BLOCK_CHARS = 8_000;

export type GhRunner = (args: string[]) => Promise<string>;

const gh: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
};

export function failureDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .map((name) => {
      const path = join(root, name);
      const stats = statSync(path);
      return { path, mtimeMs: stats.mtimeMs, isDir: stats.isDirectory() };
    })
    .filter((entry) => entry.isDir)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.path);
}

/** A single trailing newline is not a line, so text of exactly `limit` lines plus a trailing newline comes back whole
 * rather than reporting one phantom extra line. */
export function head(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length <= limit) {
    return text.trimEnd();
  }
  return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more lines)`;
}

export function capChars(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = "\n... (truncated)";
  const keep = Math.max(0, max - marker.length);
  return text.slice(0, keep) + marker;
}

export function runUrl(env: NodeJS.ProcessEnv): string {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) {
    return "";
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

function readIfPresent(dir: string, name: string): string {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function buildBody(dirs: string[], env: NodeJS.ProcessEnv): string {
  const date = new Date().toISOString().slice(0, 10);
  if (dirs.length === 0) {
    const parts = [
      `Nightly e2e run on ${date} failed with no failing-scenario artifact.`,
      "",
      "The failure was a non-scenario step (freshness check or coverage tripwire).",
      "See the run log for detail.",
    ];
    const bareUrl = runUrl(env);
    if (bareUrl) {
      parts.push("", `Run: ${bareUrl}`);
    }
    return parts.join("\n");
  }

  const url = runUrl(env);
  const header = `Nightly e2e run on ${date} produced ${dirs.length} failure artifact(s).\n`;
  const footer = url ? `\nRun: ${url}` : "";
  const artifactsNote =
    "\nThe full artifacts (scenario.yml, request trace, report) are attached to " +
    "the run as `e2e-artifacts`.";
  // The notice's length is reserved up front, whether or not it ends up shown, so the running total stays a real
  // character budget; sized with the full count so the digits fit.
  const omissionNotice = (count: number) =>
    `\n${count} more failure artifact(s) omitted to stay under the GitHub body limit; see the attached artifacts.`;
  const noticeReserve = omissionNotice(dirs.length).length;

  // Every block, the first included, is both character-capped and budget-checked, so no single artifact can push
  // the body past GitHub's limit and break the filing itself.
  const budget = MAX_BODY - header.length - footer.length - artifactsNote.length - noticeReserve;
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  for (const dir of dirs) {
    const scenario = readIfPresent(dir, "scenario.yml");
    const report = readIfPresent(dir, "report.md");
    const name = report.split("\n")[0]?.replace(/^#\s*/, "").trim() || "scenario";
    // A fuzz artifact's report already carries the replay its run wrote; a corpus artifact carries none.
    const replay =
      replayFromReport(report) === undefined
        ? replayBlockLines(`bun test/e2e/run.ts --scenario ${name}`)
        : [];
    const block = capChars(
      [
        `## ${name}`,
        ...replay,
        "",
        ...(report ? [head(report, REPORT_LINES), ""] : []),
        ...(scenario
          ? ["Scenario:", "", "```yaml", head(scenario, SCENARIO_LINES), "```", ""]
          : []),
      ].join("\n"),
      MAX_BLOCK_CHARS,
    );
    // +1 for the "\n" join between blocks.
    if (used + block.length + 1 > budget) {
      break;
    }
    blocks.push(block);
    used += block.length + 1;
    shown++;
  }

  const omitted = dirs.length - shown;
  const truncation = omitted > 0 ? omissionNotice(omitted) : "";
  return `${header}\n${blocks.join("\n")}${truncation}${artifactsNote}${footer}`;
}

async function openIssueNumber(run: GhRunner): Promise<number | undefined> {
  const json = await run([
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number",
  ]);
  const issues = JSON.parse(json) as Array<{ number: number }>;
  return issues[0]?.number;
}

export function issueNumberFromUrl(url: string): number | undefined {
  const match = url.trim().match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/** Assignment is left to the auto-assign workflow, which the caller dispatches at the returned number. `run` is
 * injected for tests. */
export async function fileIssue(run: GhRunner, body: string): Promise<number | undefined> {
  // --force updates an existing label's color and description instead of failing on it.
  await run([
    "label",
    "create",
    LABEL,
    "--force",
    "--color",
    "B60205",
    "--description",
    "e2e fuzz failure",
  ]);

  const existing = await openIssueNumber(run);
  if (existing !== undefined) {
    await run(["issue", "comment", String(existing), "--body", body]);
    console.log(`commented on existing #${existing}`);
    return existing;
  }
  const url = await run([
    "issue",
    "create",
    "--label",
    LABEL,
    "--title",
    ISSUE_TITLE,
    "--body",
    body,
  ]);
  console.log(`opened ${url.trim()}`);
  return issueNumberFromUrl(url);
}

async function main(): Promise<number> {
  const dirs = failureDirs(ARTIFACTS);
  const body = buildBody(dirs, process.env);
  const number = await fileIssue(gh, body);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (number !== undefined && outputFile) {
    appendFileSync(outputFile, `issue-number=${number}\n`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

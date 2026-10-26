/**
 * The e2e scenario runner: build src/main.ts, spawn the bundle under `node` against a fresh mock
 * GitHub server, and assert the scenario's expectations on the exit code, GITHUB_OUTPUT, the step
 * summary, and the mock's request log.
 *
 *   hermetic  -> the child environment is built FROM SCRATCH, never spread from process.env, so a
 *                developer's real token or GitHub URL cannot leak into a run
 *   parity    -> the child runs the same single-file bundle a release ships, built once per
 *                process so a run never tests stale code
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseRepoSlug } from "../../../src/discovery/targets.js";
import { type OutputName, redactRanges } from "../../../src/io.js";
import { ROOT } from "../../root.js";
import {
  ARTIFACTS_DIR,
  E2E_TOKEN,
  layerFile,
  ADMIN_SLUG as REPO_SLUG,
  RUNNER_ROOT_FILES,
} from "../constants.js";
import { type LoggedRequest, renderRequest } from "../mock/contract.js";
import { isWriteRequest } from "../mock/dispatch.js";
import { type MockHandle, type ServerOptions, startMockServer } from "../mock/server.js";
import { sharedValidator } from "../openapi/validate.js";
import { collectYmlFiles, type Expect, type Scenario, settingsYamlFor } from "../scenario.js";
import {
  assertApplyIdempotent,
  captureRerun,
  type Invocation,
  type RerunCapture,
} from "./apply-idempotence-proof.js";
import { assertIssueReport, checkReportLeaks } from "./issue-report-assert.js";

/** Memoized as a promise so concurrent scenarios share the one build instead of racing their own. */
let bundleBuild: Promise<string> | undefined;

/** Monotonic per-process counter so repeated same-name failures never collide. */
let artifactCounter = 0;

/** Pinned to the action's OUTPUT_DECLS (src/action/io.ts): a rename there fails compilation here instead of reading nothing. */
const SKIPPED_SECTIONS_OUTPUT = "skipped-sections" satisfies OutputName;

/** Hard cap so a hung child never wedges the suite: the fuzz battery's multi/apply-idempotent leg needs ~200s at some seeds (a 120s cap killed it); killNote() marks a kill, so it never reads as the action exiting on its own. */
export const KILL_AFTER_MS = 300_000;

/** The harness's own files at the root of the child's working directory, by role. */
const {
  settings: SETTINGS_FILE,
  output: OUTPUT_FILE,
  summary: SUMMARY_FILE,
  rendered: RENDERED_FILE,
  defaults: DEFAULTS_FILE,
} = RUNNER_ROOT_FILES;

/** The scenario inputs forwarded verbatim, each under the INPUT_<NAME> variable @actions/core reads (uppercased, dashes kept); the two snapshot destinations are wired by mode instead. */
const FORWARDED_INPUTS: ReadonlyArray<[input: ForwardedInput, variable: string]> = [
  ["mode", "INPUT_MODE"],
  ["layering", "INPUT_LAYERING"],
  ["undeclared", "INPUT_UNDECLARED"],
  ["on_missing_permission", "INPUT_ON-MISSING-PERMISSION"],
  ["required_sections", "INPUT_REQUIRED-SECTIONS"],
  ["sections", "INPUT_SECTIONS"],
  ["private_repos", "INPUT_PRIVATE-REPOS"],
  ["private_report", "INPUT_PRIVATE-REPORT"],
  ["report_public_key", "INPUT_REPORT-PUBLIC-KEY"],
];

/** The workflow command core.setSecret emits, one line per value. */
const MASK_PREFIX = "::add-mask::";

/** @actions/core command-encodes every payload it prints, mask and annotation alike (%, CR, LF as %25, %0D, %0A); a masked value sits decoded in the registry and encoded in the annotation line, so the redaction knows both spellings. */
const COMMAND_ENCODING: ReadonlyArray<[raw: string, encoded: string]> = [
  ["%", "%25"],
  ["\r", "%0D"],
  ["\n", "%0A"],
];

/** The index of the command line inside replayBlockLines' block, the one line setReplay swaps. */
const REPLAY_LINE = 4;

type ScenarioInputs = NonNullable<Scenario["inputs"]>;

type ForwardedInput = Exclude<keyof ScenarioInputs, "snapshot_file" | "snapshot_dir">;

export interface ScenarioReport {
  /** The scenario's name, the artifact directory's key. */
  scenario: string;

  /** No failure of any kind: the runner's assertions, the fixpoint proofs, the contract validator, and the leak sweeps. */
  ok: boolean;

  /** Every failed assertion, each a sentence report.md lists. */
  failures: string[];

  /** The PRIMARY invocation's exit code; the re-runs' live in `reruns`. */
  exitCode: number;

  /** The primary invocation's GITHUB_OUTPUT, parsed. */
  outputs: Record<string, string>;

  /** The primary invocation's step summary. */
  summary: string;

  /** The primary invocation's stdout, mask lines included. */
  stdout: string;

  /** The primary invocation's stderr. */
  stderr: string;

  /** The artifact directory written on failure, for the CLI to surface. */
  artifactDir?: string;

  /** Full request log snapshot, for coverage and validation consumers. */
  requests: LoggedRequest[];

  /** How often each injected fault key fired during the PRIMARY invocation only, so the re-runs never inflate it; the fuzzer's non-vacuity assertion reads it, so a declared fault absent here never fired. */
  faultsFired: Record<string, number>;

  /** The multi-repo per-target rollup, display key -> result; empty for single-repo runs AND for multi runs that failed before any target ran, since a config or discovery fatal never writes the output. */
  reposResult: Record<string, string>;

  /** Every internal re-run's surfaces, in execution order; the top-level surfaces describe ONLY the primary invocation, so leak invariants must sweep these too. */
  reruns: RerunCapture[];
}

/** One scenario's run as its assertions read it: the mock, the working directory, the primary invocation, and the re-runs so far. */
interface Run {
  scenario: Scenario;
  dir: string;
  handle: MockHandle;
  first: Invocation;
  reruns: RerunCapture[];
}

/** A dir-form snapshot pin resolved to the file the run must have written. */
interface PinnedSnapshot {
  slug: string;
  path: string;
  expected: Record<string, unknown>;
}

function builtBundle(): Promise<string> {
  bundleBuild ??= (async () => {
    const outdir = mkdtempSync(join(tmpdir(), "e2e-bundle-"));
    process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));
    const outfile = join(outdir, "index.js");
    // package.json's own build:bundle, so the harness cannot build a different artifact than a release ships;
    // bun appends run arguments to the script and the last --outfile wins, which keeps lib/ untouched.
    const build = Bun.spawn([process.execPath, "run", "build:bundle", "--outfile", outfile], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    if (status !== 0 || !existsSync(outfile)) {
      throw new Error(
        `bun run build:bundle exited ${status} without ${outfile}:\n${stdout}${stderr}`,
      );
    }
    return outfile;
  })();
  return bundleBuild;
}

/** Marks a harness kill, so a timeout is never misread as the action exiting with the kill signal on its own. */
function killNote(run: Invocation): string {
  return run.killedByHarness ? ` (the harness killed the child after ${KILL_AFTER_MS}ms)` : "";
}

/**
 * A one-element expectation keeps the single-code message the curated corpus grew up with; a
 * multi-element set renders sorted, so the text is stable whatever the set's insertion order.
 */
export function exitCodeFailure(actual: number, expected: number | number[]): string | undefined {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (allowed.includes(actual)) {
    return undefined;
  }
  return allowed.length === 1
    ? `exit code ${actual} != expected ${allowed[0]}`
    : `exit code ${actual} not in [${[...allowed].sort((a, b) => a - b).join(", ")}]`;
}

/**
 * @actions/core writes two forms: the simple `name=value` line and, for values that may contain
 * newlines, the heredoc block `name<<ghadelimiter_UUID\n...\ndelim`.
 */
export function parseGithubOutput(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heredoc = line.match(/^([^<=]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        body.push(lines[i] ?? "");
        i++;
      }
      outputs[(name ?? "").trim()] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) {
      outputs[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  }
  return outputs;
}

/** Each managed section renders as `| <key> | :<icon>: <status> | <detail> |`. */
export function parseSummaryOutcomes(summary: string): Record<string, string> {
  const outcomes: Record<string, string> = {};
  for (const line of summary.split("\n")) {
    const row = line.match(/^\|\s*([a-z_]+)\s*\|\s*:[a-z_]+:\s*([a-z]+)\s*\|/);
    if (row) {
      const [, key, status] = row;
      if (key && status) {
        outcomes[key] = status;
      }
    }
  }
  return outcomes;
}

/** A missing or unparseable output yields {} instead of throwing, so the expectation reports the gap as a failure. */
export function parseReposResult(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    const result = (value as { result?: unknown })?.result;
    if (typeof result === "string") {
      out[slug] = result;
    }
  }
  return out;
}

/** The TOP-LEVEL expect.repos_result wins over a co-located repos.*.expect.result: it is the single place to override one. */
function expectedReposResult(scenario: Scenario): Record<string, string> | null {
  const merged: Record<string, string> = {};
  for (const [slug, spec] of Object.entries(scenario.repos ?? {})) {
    if (spec.expect?.result !== undefined) {
      merged[slug] = spec.expect.result;
    }
  }
  for (const [slug, want] of Object.entries(scenario.expect.repos_result ?? {})) {
    merged[slug] = want;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function renderedFilePath(dir: string): string {
  return join(dir, RENDERED_FILE);
}

function documentFileFailures(
  label: string,
  path: string,
  expected: Record<string, unknown>,
): string[] {
  let live: unknown;
  try {
    live = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return [
      `${label} file ${path} unreadable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (Bun.deepEquals(live, expected)) {
    return [];
  }
  if (typeof live !== "object" || live === null || Array.isArray(live)) {
    return [`${label} document is not a mapping: ${JSON.stringify(live)}`];
  }
  const record = live as Record<string, unknown>;
  const keys = new Set([...Object.keys(expected), ...Object.keys(record)]);
  const failures: string[] = [];
  for (const key of keys) {
    if (!Bun.deepEquals(record[key], expected[key])) {
      failures.push(
        `${label}.${key}: ${JSON.stringify(record[key])} != expected ${JSON.stringify(expected[key])}`,
      );
    }
  }
  return failures;
}

/**
 * The snapshot files a dir-form scenario pins, each resolved to its
 * `<snapshot_dir>/<owner>/<name>.yml` path under the scenario's temp dir.
 */
function pinnedDirSnapshots(scenario: Scenario, dir: string): PinnedSnapshot[] {
  const snapshotDir = scenario.inputs?.snapshot_dir;
  if (snapshotDir === undefined) {
    return [];
  }
  const pinned: PinnedSnapshot[] = [];
  for (const [slug, spec] of Object.entries(scenario.repos ?? {})) {
    const expected = spec.expect?.snapshot;
    const repo = parseRepoSlug(slug);
    if (expected === undefined || repo.isErr()) {
      continue;
    }
    pinned.push({
      slug,
      path: join(dir, snapshotDir, repo.value.owner, `${repo.value.name}.yml`),
      expected,
    });
  }
  return pinned;
}

/**
 * The check run that proves a snapshot round-trips takes every input the scenario set, minus the two
 * destinations check mode rejects; derived by exclusion so a target-selecting input added later still rides along.
 */
export function snapshotCheckInputs(inputs: ScenarioInputs): ScenarioInputs {
  const { snapshot_file: _file, snapshot_dir: _dir, ...carried } = inputs;
  return { ...carried, mode: "check" };
}

/**
 * Every document a mode: snapshot run wrote, relative to the scenario's temp dir: the one file of the
 * file form, or every .yml under the dir form's directory. Read off the filesystem, not the pins, so a
 * file the run wrote without a pin is still swept and round-tripped.
 */
export function writtenSnapshotPaths(inputs: ScenarioInputs, dir: string): string[] {
  if (inputs.snapshot_file !== undefined) {
    return existsSync(join(dir, inputs.snapshot_file)) ? [inputs.snapshot_file] : [];
  }
  if (inputs.snapshot_dir !== undefined) {
    return collectYmlFiles(join(dir, inputs.snapshot_dir))
      .map((path) => relative(dir, path))
      .sort();
  }
  return [];
}

/** Every key and string leaf of a parsed YAML document, so a value is matched whole however the emitter wrapped it. */
export function yamlStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(yamlStrings);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...yamlStrings(nested)]);
  }
  return [];
}

/**
 * The leak sweep over the written snapshots: a document is a private surface like the delivered
 * report (a private slug or a private live value belongs in it), so only the secret needles are
 * forbidden, never the whole leaks_nowhere list. Matched against the raw text AND every parsed
 * string: a multi-line value serializes as a block scalar whose lines are indented, so the raw
 * text alone would miss it. An unparseable document fails on its own.
 */
export function writtenSnapshotLeaks(dir: string, paths: string[], secrets: string[]): string[] {
  const failures: string[] = [];
  for (const path of paths) {
    const text = readFileSync(join(dir, path), "utf8");
    let strings: string[] = [];
    try {
      strings = yamlStrings(parseYaml(text));
    } catch (error) {
      failures.push(
        `the written snapshot ${path} is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const needle of secrets) {
      if (text.includes(needle) || strings.some((s) => s.includes(needle))) {
        failures.push(`leak: "${needle}" present in the written snapshot ${path}`);
      }
    }
  }
  return failures;
}

/** The round-trip verdict both snapshot forms share: the check reads clean and neither writes nor trips the mock. */
export function roundTripFailures(
  label: string,
  check: Invocation,
  requests: LoggedRequest[],
  violations: string[],
): string[] {
  const failures: string[] = [];
  if (check.exitCode !== 0) {
    failures.push(`${label}: the check exited ${check.exitCode}, expected 0${killNote(check)}`);
  }
  if (check.outputs.result !== "clean") {
    failures.push(`${label}: the check's result is "${check.outputs.result}", expected "clean"`);
  }
  const writes = requests.filter(isWriteRequest);
  if (writes.length > 0) {
    failures.push(
      `${label}: the check wrote ${writes.length} time(s): ${writes.map((r) => renderRequest(r, false)).join(", ")}`,
    );
  }
  if (violations.length > 0) {
    failures.push(`${label}: mock violations:\n  ${violations.join("\n  ")}`);
  }
  return failures;
}

/**
 * settings-file is a single-repo input the action rejects beside the multi-repo inputs and in
 * snapshot mode. A merge lists every layer file below settings.yml, lowest first; a snapshot names
 * its destination relative to the child's working directory (this temp dir).
 */
function settingsFileEnv(
  scenario: Scenario,
  dir: string,
  multi: boolean,
  env: Record<string, string>,
): void {
  const inputs = scenario.inputs ?? {};
  if (inputs.mode === "render") {
    const layers = (scenario.settings_layers ?? []).map((layer, i) => {
      const path = join(dir, layerFile(i));
      writeFileSync(path, stringifyYaml(layer));
      return path;
    });
    env["INPUT_SETTINGS-FILE"] = [...layers, join(dir, SETTINGS_FILE)].join("\n");
    env["INPUT_RENDERED-FILE"] = renderedFilePath(dir);
  } else if (inputs.mode === "snapshot") {
    if (inputs.snapshot_file !== undefined) {
      env["INPUT_SNAPSHOT-FILE"] = inputs.snapshot_file;
    }
    if (inputs.snapshot_dir !== undefined) {
      env["INPUT_SNAPSHOT-DIR"] = inputs.snapshot_dir;
    }
  } else if (!multi) {
    env["INPUT_SETTINGS-FILE"] = join(dir, SETTINGS_FILE);
  }
}

/** GITHUB_REPOSITORY stays the admin repo in multi-repo mode; INPUT_REPOS, or a repos-dir, selects the targets. */
function targetEnv(
  scenario: Scenario,
  dir: string,
  reposDir: string | undefined,
  env: Record<string, string>,
): void {
  if (scenario.discovery) {
    env.INPUT_REPOS = "*";
    for (const [name, value] of Object.entries(scenario.discovery.inputs)) {
      env[`INPUT_${name.toUpperCase()}`] = value;
    }
  } else if (scenario.repos) {
    env.INPUT_REPOS = Object.keys(scenario.repos).join(",");
  }
  if (reposDir !== undefined) {
    env["INPUT_REPOS-DIR"] = reposDir;
  }
  if (scenario.defaults_file) {
    const defaultsPath = join(dir, DEFAULTS_FILE);
    writeFileSync(defaultsPath, stringifyYaml(scenario.defaults_file));
    env["INPUT_DEFAULTS-FILE"] = defaultsPath;
  }
}

/**
 * Built from scratch: only PATH and HOME are taken from process.env. `reposDir` is the one input the
 * scenario schema has no key for: the dir-form round trip feeds a written snapshot back as a
 * central-mode target, so it selects the multi-repo path without a `repos` map.
 */
function childEnv(
  scenario: Scenario,
  dir: string,
  apiUrl: string,
  reposDir?: string,
): NodeJS.ProcessEnv {
  const inputs = scenario.inputs ?? {};
  const multi = Boolean(scenario.repos || scenario.discovery || reposDir !== undefined);
  const env: Record<string, string> = {
    ...(scenario.env ?? {}),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // @actions/core reads INPUT_<NAME> (uppercased, dashes kept).
    INPUT_TOKEN: E2E_TOKEN,
    GITHUB_REPOSITORY: REPO_SLUG,
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: join(dir, OUTPUT_FILE),
    GITHUB_STEP_SUMMARY: join(dir, SUMMARY_FILE),
    RUNNER_DEBUG: "1",
    // A test knob: millisecond plugin units and the immediate scheduler, so retry scenarios run in milliseconds instead of seconds.
    GSAC_RETRY_BASE_MS: "1",
  };
  settingsFileEnv(scenario, dir, multi, env);
  for (const [input, variable] of FORWARDED_INPUTS) {
    const value = inputs[input];
    if (value) {
      env[variable] = value;
    }
  }
  targetEnv(scenario, dir, reposDir, env);
  return env;
}

async function invoke(
  scenario: Scenario,
  dir: string,
  apiUrl: string,
  reposDir?: string,
): Promise<Invocation> {
  const outputFile = join(dir, OUTPUT_FILE);
  const summaryFile = join(dir, SUMMARY_FILE);
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  const proc = Bun.spawn(["node", await builtBundle()], {
    cwd: dir,
    env: childEnv(scenario, dir, apiUrl, reposDir),
    stdout: "pipe",
    stderr: "pipe",
  });
  let killedByHarness = false;
  const killer = setTimeout(() => {
    killedByHarness = true;
    proc.kill();
  }, KILL_AFTER_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);

  return {
    exitCode,
    outputs: parseGithubOutput(readFileSync(outputFile, "utf8")),
    summary: readFileSync(summaryFile, "utf8"),
    stdout,
    stderr,
    killedByHarness,
  };
}

/**
 * `{repo}` in a request-path expectation is the mock's owner/name. Every list goes through this one
 * expansion: a list left raw is always-red under requests_contain and always-green under never.
 */
function expandRepoPatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).map((pattern) => pattern.replaceAll("{repo}", REPO_SLUG));
}

function stripLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(prefix))
    .join("\n");
}

function decodeCommandData(encoded: string): string {
  return encoded.replace(
    /%(25|0D|0A)/g,
    (code) => COMMAND_ENCODING.find(([, e]) => e === code)?.[0] ?? code,
  );
}

function encodeCommandData(raw: string): string {
  return COMMAND_ENCODING.reduce((text, [r, e]) => text.replaceAll(r, e), raw);
}

/**
 * The `::add-mask::<value>` lines core.setSecret emits legitimately carry the raw slug so the real
 * runner can mask every later line; the runner consumes and never echoes them. A CRLF stdout leaves
 * the line's CR on the payload, which is not part of the value.
 */
function partitionMaskLines(stdout: string): { values: string[]; rest: string } {
  const values: string[] = [];
  const rest: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(MASK_PREFIX)) {
      values.push(decodeCommandData(line.slice(MASK_PREFIX.length).replace(/\r$/, "")));
    } else {
      rest.push(line);
    }
  }
  return { values, rest: rest.join("\n") };
}

/** What stdout carries once the mask lines are gone: the surface a redacted slug must leak NOWHERE on. */
export function stripMaskLines(stdout: string): string {
  return partitionMaskLines(stdout).rest;
}

/**
 * A scenario's captured stdout as --print-stdout echoes it, indented under the PASS or FAIL line.
 * The mask lines go, and every value they named prints as `***` wherever it occurs, raw or
 * command-encoded: indented, a workflow command is plain text to the Actions runner, so no mask is
 * registered for the echo and a leaked value (the very thing a FAIL reports) would print in clear.
 */
export function indentedStdout(stdout: string): string {
  const { values, rest } = partitionMaskLines(stdout);
  const spellings = new Set(values.flatMap((value) => [value, encodeCommandData(value)]));
  const redacted = redactRanges(rest, spellings).trimEnd();
  return redacted === "" ? "" : redacted.replace(/^/gm, "        ");
}

/**
 * `::debug::` lines carry API request TRACES, not rendered output. The unredacted counterfactual
 * judges whether a canary reached a RENDERED surface (summary, annotation, plain log line), since that
 * is what a detail-suppression regression affects; a canary only in a trace proves nothing.
 */
export function stripDebugLines(text: string): string {
  return stripLines(text, "::debug::");
}

/**
 * The redaction LEAK INVARIANT, implemented once so a scenario and a fuzz iteration prove the exact
 * same property: no forbidden string on any publicly-readable surface. stderr counts because the
 * Actions run log captures it too; the `::add-mask::` lines are stripped first, since they carry the
 * raw slug for the real runner by design.
 */
export function checkLeaks(
  observed: { summary: string; stdout: string; stderr: string; outputs: Record<string, string> },
  forbidden: string[],
): string[] {
  const failures: string[] = [];
  const maskedStdout = stripMaskLines(observed.stdout);
  const maskedStderr = stripMaskLines(observed.stderr);
  for (const needle of forbidden) {
    if (observed.summary.includes(needle)) {
      failures.push(`leak: "${needle}" present in the step summary`);
    }
    if (maskedStdout.includes(needle)) {
      failures.push(`leak: "${needle}" present in stdout (after stripping ::add-mask:: lines)`);
    }
    if (maskedStderr.includes(needle)) {
      failures.push(`leak: "${needle}" present in stderr (after stripping ::add-mask:: lines)`);
    }
    for (const [name, value] of Object.entries(observed.outputs)) {
      if (value.includes(needle)) {
        failures.push(`leak: "${needle}" present in the "${name}" output`);
      }
    }
  }
  return failures;
}

export function isSubsequence(patterns: string[], log: string[]): boolean {
  let i = 0;
  for (const entry of log) {
    if (i < patterns.length && entry.startsWith(patterns[i] as string)) {
      i++;
    }
  }
  return i === patterns.length;
}

export function forbiddenPresent(patterns: string[], log: string[]): string[] {
  return patterns.filter((pattern) => log.some((entry) => entry.startsWith(pattern)));
}

/**
 * The three request-log rules over the recorded requests. A write's query is never part of its identity, so
 * `mutations` match "METHOD /path"; `never` and `requests_contain` match "METHOD /path?query", so one lookup on a path
 * other lookups share can be forbidden or required.
 */
export function requestLogFailures(
  exp: Partial<Pick<Expect, "mutations" | "never" | "requests_contain">>,
  requests: LoggedRequest[],
): string[] {
  const failures: string[] = [];
  const writes = requests.filter(isWriteRequest).map((r) => renderRequest(r, false));
  const mutations = expandRepoPatterns(exp.mutations);
  if (!isSubsequence(mutations, writes)) {
    failures.push(
      `mutations not found as a subsequence:\n  want: ${mutations.join(", ")}\n  writes: ${writes.join(", ")}`,
    );
  }
  const fullLog = requests.map((r) => renderRequest(r, true));
  for (const pattern of forbiddenPresent(expandRepoPatterns(exp.never), fullLog)) {
    failures.push(`forbidden request present: ${pattern}`);
  }
  for (const needle of expandRepoPatterns(exp.requests_contain)) {
    if (!fullLog.some((entry) => entry.includes(needle))) {
      failures.push(`no request contains: ${needle}`);
    }
  }
  return failures;
}

/** The mock's own contract violations, and the verdicts on the primary invocation's exit code, request count, and `result` output. */
function verdictFailures({ scenario, handle, first }: Run): string[] {
  const exp = scenario.expect;
  const failures: string[] = [];
  if (handle.violations.length > 0) {
    failures.push(`mock violations:\n  ${handle.violations.join("\n  ")}`);
  }
  const exitFailure = exitCodeFailure(first.exitCode, exp.exit_code);
  if (exitFailure !== undefined) {
    failures.push(`${exitFailure}${killNote(first)}`);
  }
  if (exp.zero_requests && handle.requests.length > 0) {
    const sample = handle.requests
      .slice(0, 3)
      .map((r) => renderRequest(r, false))
      .join(", ");
    failures.push(
      `expected zero API requests, but the mock saw ${handle.requests.length}: ${sample}`,
    );
  }
  if (exp.result !== undefined && first.outputs.result !== exp.result) {
    failures.push(`result "${first.outputs.result}" != expected "${exp.result}"`);
  }
  return failures;
}

/** The documents a render or snapshot run wrote, each compared whole after a YAML parse, so the comment header is ignored. */
function documentFailures({ scenario, dir }: Run): string[] {
  const exp = scenario.expect;
  const failures: string[] = [];
  if (exp.rendered !== undefined) {
    failures.push(...documentFileFailures("rendered", renderedFilePath(dir), exp.rendered));
  }
  const snapshotFile = scenario.inputs?.snapshot_file;
  if (exp.snapshot !== undefined && snapshotFile !== undefined) {
    failures.push(...documentFileFailures("snapshot", join(dir, snapshotFile), exp.snapshot));
  }
  for (const pinned of pinnedDirSnapshots(scenario, dir)) {
    failures.push(
      ...documentFileFailures(`snapshot[${pinned.slug}]`, pinned.path, pinned.expected),
    );
  }
  return failures;
}

/**
 * The `skipped-sections` output is compared as a set: the engine emits SECTION_KEYS order, which
 * the expectation should not restate. An ABSENT output fails even against an empty expectation:
 * publishing nothing is a different regression from publishing an empty list.
 */
function skippedSectionsFailures(exp: Expect, first: Invocation): string[] {
  if (exp.skipped_sections === undefined) {
    return [];
  }
  const published = first.outputs[SKIPPED_SECTIONS_OUTPUT];
  if (published === undefined) {
    return [`the ${SKIPPED_SECTIONS_OUTPUT} output was not published at all`];
  }
  const live = published.split(",").filter(Boolean).sort();
  const want = [...exp.skipped_sections].sort();
  if (JSON.stringify(live) === JSON.stringify(want)) {
    return [];
  }
  return [
    `${SKIPPED_SECTIONS_OUTPUT} output [${live.join(", ")}] != expected [${want.join(", ")}]`,
  ];
}

/** The per-target rollup against the merged expectation: the target set, then each target's result. */
function reposResultFailures(scenario: Scenario, first: Invocation): string[] {
  const expectedRepos = expectedReposResult(scenario);
  if (!expectedRepos) {
    return [];
  }
  const failures: string[] = [];
  const live = parseReposResult(first.outputs["repos-result"]);
  const liveSlugs = Object.keys(live).sort();
  const wantSlugs = Object.keys(expectedRepos).sort();
  if (JSON.stringify(liveSlugs) !== JSON.stringify(wantSlugs)) {
    failures.push(
      `repos_result targets [${liveSlugs.join(", ")}] != expected [${wantSlugs.join(", ")}]`,
    );
  }
  for (const [slug, want] of Object.entries(expectedRepos)) {
    if (live[slug] !== want) {
      failures.push(`repos_result[${slug}] "${live[slug]}" != expected "${want}"`);
    }
  }
  return failures;
}

function outcomeFailures(exp: Expect, first: Invocation): string[] {
  if (!exp.outcomes) {
    return [];
  }
  const failures: string[] = [];
  const live = parseSummaryOutcomes(first.summary);
  for (const [key, want] of Object.entries(exp.outcomes)) {
    if (live[key] !== want) {
      failures.push(`outcome ${key} "${live[key]}" != expected "${want}"`);
    }
  }
  return failures;
}

function surfaceContainsFailures(exp: Expect, first: Invocation): string[] {
  const failures: string[] = [];
  for (const needle of exp.summary_contains ?? []) {
    if (!first.summary.includes(needle)) {
      failures.push(`summary missing: ${needle}`);
    }
  }
  for (const needle of exp.stdout_contains ?? []) {
    if (!first.stdout.includes(needle)) {
      failures.push(`stdout missing: ${needle}`);
    }
  }
  return failures;
}

/** stdout_lacks matches AFTER stripping the ::add-mask:: lines, which carry the raw slug for the real runner by design; summary_lacks matches the summary as-is. */
function surfaceLacksFailures(exp: Expect, first: Invocation): string[] {
  const failures: string[] = [];
  const maskedStdout = stripMaskLines(first.stdout);
  for (const needle of exp.summary_lacks ?? []) {
    if (first.summary.includes(needle)) {
      failures.push(`summary must not contain: ${needle}`);
    }
  }
  for (const needle of exp.stdout_lacks ?? []) {
    if (maskedStdout.includes(needle)) {
      failures.push(`stdout must not contain: ${needle}`);
    }
  }
  return failures;
}

/**
 * Every assertion on the primary invocation, in the order report.md lists them. The private-report issue
 * delivery is the one channel where the private slug and sentinel may legitimately appear, inside the
 * target repo's own issue.
 */
function primaryFailures(run: Run): string[] {
  const exp = run.scenario.expect;
  return [
    ...verdictFailures(run),
    ...documentFailures(run),
    ...skippedSectionsFailures(exp, run.first),
    ...reposResultFailures(run.scenario, run.first),
    ...outcomeFailures(exp, run.first),
    ...requestLogFailures(exp, run.handle.requests),
    ...surfaceContainsFailures(exp, run.first),
    ...surfaceLacksFailures(exp, run.first),
    ...(exp.issue_report ? assertIssueReport(exp.issue_report, run.handle.requests) : []),
  ];
}

async function applyIdempotenceFailures({ scenario, dir, handle, reruns }: Run): Promise<string[]> {
  const idempotence = await assertApplyIdempotent(scenario, handle, {
    invoke: (rerun) => invoke(rerun, dir, handle.url),
    killNote,
  });
  reruns.push(...idempotence.reruns);
  return idempotence.failures;
}

/**
 * Convergence: rerun in check mode against the SAME mutated server. The mock's check-mode write
 * barrier is armed first: the server still holds the apply-mode scenario, so without it a stray
 * write would not be a violation.
 */
async function convergenceFailures({ scenario, dir, handle, reruns }: Run): Promise<string[]> {
  const violationsBefore = handle.violations.length;
  const requestsBefore = handle.requests.length;
  handle.enterCheckMode();
  const converge = await invoke(
    { ...scenario, inputs: { ...scenario.inputs, mode: "check" } },
    dir,
    handle.url,
  );
  const rerunRequests = handle.requests.slice(requestsBefore);
  reruns.push(captureRerun("converges check", converge, rerunRequests));
  const failures: string[] = [];
  const newWrites = rerunRequests.filter(isWriteRequest);
  if (converge.exitCode !== 0) {
    failures.push(
      `convergence: rerun exited ${converge.exitCode}, expected 0${killNote(converge)}`,
    );
  }
  if (newWrites.length > 0) {
    failures.push(
      `convergence: rerun wrote ${newWrites.length} time(s): ${newWrites.map((r) => renderRequest(r, false)).join(", ")}`,
    );
  }
  const newViolations = handle.violations.slice(violationsBefore);
  if (newViolations.length > 0) {
    failures.push(`convergence: mock violations:\n  ${newViolations.join("\n  ")}`);
  }
  return failures;
}

/**
 * assertApplyIdempotent's own final step arms the one-way check-mode barrier and proves
 * convergence, which is why `fixpoint` is a single enum: only one of the two proofs can ever run.
 */
async function fixpointFailures(run: Run): Promise<string[]> {
  if (run.scenario.expect.fixpoint === "apply_idempotent") {
    return applyIdempotenceFailures(run);
  }
  if (run.scenario.expect.fixpoint === "converges") {
    return convergenceFailures(run);
  }
  return [];
}

/**
 * One written snapshot fed back as a CHECK run's settings document: the file form copies it over
 * settings.yml; the dir form feeds it through its own one-file repos-dir, so the check targets exactly
 * that repository and a non-converging file names itself.
 */
async function invokeSnapshotCheck(
  { scenario, dir, handle }: Run,
  checkInputs: ScenarioInputs,
  path: string,
  reposDir: () => string,
): Promise<Invocation> {
  const snapshotDir = scenario.inputs?.snapshot_dir;
  if (snapshotDir === undefined) {
    copyFileSync(join(dir, path), join(dir, SETTINGS_FILE));
    return invoke({ ...scenario, inputs: checkInputs }, dir, handle.url);
  }
  const target = reposDir();
  const central = join(target, relative(join(dir, snapshotDir), join(dir, path)));
  mkdirSync(dirname(central), { recursive: true });
  copyFileSync(join(dir, path), central);
  const { repos: _repos, discovery: _discovery, ...single } = scenario;
  return invoke({ ...single, inputs: checkInputs }, dir, handle.url, target);
}

/**
 * Every written snapshot, fed back as the settings document of a CHECK run against the SAME seeded
 * state, must read clean without a write. `scratchDir` creates the round trip's scratch directory on
 * first use, a sibling of `dir` so a repos-dir can never fall under the snapshot dir.
 */
async function snapshotRoundTripFailures(
  run: Run,
  written: string[],
  scratchDir: () => string,
): Promise<string[]> {
  const { scenario, handle, reruns } = run;
  if (!scenario.expect.snapshot_converges) {
    return [];
  }
  const failures: string[] = [];
  const checkInputs = snapshotCheckInputs(scenario.inputs ?? {});
  if (written.length === 0) {
    failures.push("snapshot round trip: the run wrote no snapshot document to feed back");
  }
  handle.enterCheckMode();
  for (const [i, path] of written.entries()) {
    const violationsBefore = handle.violations.length;
    const requestsBefore = handle.requests.length;
    const check = await invokeSnapshotCheck(run, checkInputs, path, () =>
      join(scratchDir(), String(i)),
    );
    const rerunRequests = handle.requests.slice(requestsBefore);
    reruns.push(captureRerun(`snapshot check ${path}`, check, rerunRequests));
    failures.push(
      ...roundTripFailures(
        `snapshot round trip[${path}]`,
        check,
        rerunRequests,
        handle.violations.slice(violationsBefore),
      ),
    );
  }
  return failures;
}

/** Always on: the mock is our stand-in for GitHub, so any drift from the published contract is a mock bug. */
function openApiFailures(handle: MockHandle): string[] {
  const openApiViolations = sharedValidator().validateLog(handle.requests);
  if (openApiViolations.length === 0) {
    return [];
  }
  const lines = openApiViolations.map((v) => `${v.request} [${v.kind}]: ${v.detail}`);
  return [`OpenAPI contract violations:\n  ${lines.join("\n  ")}`];
}

/**
 * The whole-surface leak sweep runs on EVERY scenario, after the re-runs so it covers the primary
 * invocation and every internal one. Two needle families join the declared ones:
 *   E2E_TOKEN                -> never add-mask'd, so any echo on a public surface is a real leak
 *   every scenario env value -> by definition a resolved secret plaintext, listed by the author or not
 * An EMPTY env value is skipped: a set-but-empty variable is a scenario about the resolver's
 * empty-value error, not a leakable secret. Those two families are secrets, forbidden on the
 * private-report surface and in the written snapshots too, where a leaks_nowhere needle (a slug, a
 * private live value) belongs. The request log spans every invocation, so one report sweep covers each delivered body.
 */
function leakFailures({ scenario, dir, handle, first, reruns }: Run, written: string[]): string[] {
  const secretNeedles = [
    ...new Set([E2E_TOKEN, ...Object.values(scenario.env ?? {})].filter((needle) => needle !== "")),
  ];
  const leakNeedles = [...new Set([...secretNeedles, ...(scenario.expect.leaks_nowhere ?? [])])];
  const failures = checkLeaks(first, leakNeedles);
  for (const rerun of reruns) {
    failures.push(...checkLeaks(rerun, leakNeedles).map((failure) => `${rerun.label}: ${failure}`));
  }
  failures.push(...checkReportLeaks(handle.requests, secretNeedles));
  failures.push(...writtenSnapshotLeaks(dir, written, secretNeedles));
  return failures;
}

/**
 * The nightly issue action keeps only the head of each report.md (60 lines, 8000 chars) when an artifact name is
 * given, so the replay sits right under the title; writeReport puts the curated command there and setReplay swaps in
 * the fuzzer's.
 */
function replayBlockLines(replay: string): string[] {
  return ["", "## Replay", "", "```sh", replay, "```"];
}

export function setReplay(artifactDir: string, replay: string): void {
  const path = join(artifactDir, "report.md");
  const lines = readFileSync(path, "utf8").split("\n");
  const block = replayBlockLines(replay);
  const slot = lines.slice(1, 1 + block.length);
  if (block.some((line, i) => i !== REPLAY_LINE && slot[i] !== line)) {
    throw new Error(
      `E2E BUG: ${path} carries no replay block under its title; writeReport always writes one`,
    );
  }
  lines.splice(1, block.length, ...block);
  writeFileSync(path, lines.join("\n"));
}

/**
 * The nightly issue action heads each issue section with the title line, and the redaction
 * counterfactual re-runs the SAME scenario name: unmarked, its failure section would be
 * indistinguishable from the primary run's.
 */
export function markReportTitle(artifactDir: string, marker: string): void {
  const path = join(artifactDir, "report.md");
  const [title, ...rest] = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, [`${title} (${marker})`, ...rest].join("\n"));
}

/** Sanitized to [a-z0-9-] so a scenario name or a re-run label cannot escape its artifact directory. */
function artifactName(raw: string, fallback: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-") || fallback;
}

/** The four surfaces every invocation, primary or re-run, leaves behind. */
function dumpInvocation(
  dir: string,
  run: { stdout: string; stderr: string; summary: string },
  requests: LoggedRequest[],
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.txt"), run.stdout);
  writeFileSync(join(dir, "stderr.txt"), run.stderr);
  writeFileSync(join(dir, "summary.md"), run.summary);
  writeFileSync(join(dir, "requests.json"), JSON.stringify(requests, null, 2));
}

/** The nightly issue action reads this report.md; its headings are the contract. */
function writeReport(
  dir: string,
  scenario: Scenario,
  report: ScenarioReport,
  failures: readonly string[],
): void {
  const md = [
    `# ${scenario.name}`,
    ...replayBlockLines(`bun test/e2e/run.ts --scenario ${scenario.name}`),
    "",
    `Artifact directory: ${dir}`,
    "",
    "## Failures",
    "",
    ...failures.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
    "",
    `Exit code: ${report.exitCode}`,
  ].join("\n");
  writeFileSync(join(dir, "report.md"), `${md}\n`);
}

/**
 * The debugging dump for a failing scenario, keyed by name, pid, and a counter so parallel or repeated
 * runs never collide. `failures` is what report.md lists: the runner's own by default, or a caller's
 * judgment of a run the runner itself passed (the fuzz oracle's). Each re-run's surfaces land in a
 * `rerun-<n>-<label>/` subdirectory, in execution order, so a re-run failure is diagnosable from the artifact.
 */
function dumpArtifacts(
  scenario: Scenario,
  report: ScenarioReport,
  requests: LoggedRequest[],
  failures: readonly string[] = report.failures,
): string {
  const dir = join(
    ARTIFACTS_DIR,
    `${artifactName(scenario.name, "scenario")}-${process.pid}-${artifactCounter++}`,
  );
  dumpInvocation(dir, report, requests);
  writeFileSync(join(dir, "scenario.yml"), stringifyYaml(scenario));
  for (const [i, rerun] of report.reruns.entries()) {
    dumpInvocation(
      join(dir, `rerun-${i}-${artifactName(rerun.label, "rerun")}`),
      rerun,
      rerun.requests,
    );
  }
  writeReport(dir, scenario, report, failures);
  return dir;
}

/**
 * The nightly issue action reads report.md, not the log, so every failure judged against a run,
 * the runner's own and a caller's (the fuzz oracle's verdicts), must land in it.
 */
export function failureArtifacts(
  scenario: Scenario,
  report: ScenarioReport,
  failures: readonly string[],
): string | undefined {
  if (failures.length === 0) {
    return report.artifactDir;
  }
  if (report.artifactDir === undefined) {
    return dumpArtifacts(scenario, report, report.requests, failures);
  }
  const extra = failures.filter((failure) => !report.failures.includes(failure));
  if (extra.length > 0) {
    writeReport(report.artifactDir, scenario, report, [...new Set(report.failures), ...extra]);
  }
  return report.artifactDir;
}

/**
 * Run one scenario end to end and dump an artifact directory on any failure. `opts.serverOptions`
 * merges over the scenario's own base_prefix, so the fuzz CLI can inject the chaos `corrupt` directive.
 */
export async function runScenario(
  scenario: Scenario,
  opts?: { serverOptions?: ServerOptions },
): Promise<ScenarioReport> {
  let dir: string | undefined;
  let scratch: string | undefined;
  let handle: MockHandle | undefined;

  try {
    dir = mkdtempSync(join(tmpdir(), "e2e-"));
    handle = await startMockServer(scenario, {
      ...(scenario.base_prefix ? { basePrefix: scenario.base_prefix } : {}),
      ...(scenario.faults
        ? {
            faults: scenario.faults.map((f) => ({ key: f.endpoint, kind: f.kind, times: f.times })),
          }
        : {}),
      ...opts?.serverOptions,
    });
    writeFileSync(join(dir, SETTINGS_FILE), settingsYamlFor(scenario));
    const first = await invoke(scenario, dir, handle.url);
    // Snapshot NOW: a fault that fires only during an optional re-run must not read as non-vacuous
    // for the primary outcome exitCode, outputs, and reposResult describe.
    const faultsFired = Object.fromEntries(handle.faultCounts);
    const run: Run = { scenario, dir, handle, first, reruns: [] };

    const failures = primaryFailures(run);
    failures.push(...(await fixpointFailures(run)));
    const written = writtenSnapshotPaths(scenario.inputs ?? {}, dir);
    const scratchDir = (): string => {
      scratch ??= mkdtempSync(join(tmpdir(), "e2e-round-trip-"));
      return scratch;
    };
    failures.push(...(await snapshotRoundTripFailures(run, written, scratchDir)));
    failures.push(...openApiFailures(handle));
    failures.push(...leakFailures(run, written));

    const report: ScenarioReport = {
      scenario: scenario.name,
      ok: failures.length === 0,
      failures,
      exitCode: first.exitCode,
      outputs: first.outputs,
      summary: first.summary,
      stdout: first.stdout,
      stderr: first.stderr,
      requests: [...handle.requests],
      faultsFired,
      reposResult: parseReposResult(first.outputs["repos-result"]),
      reruns: run.reruns,
    };
    if (!report.ok) {
      report.artifactDir = dumpArtifacts(scenario, report, handle.requests);
    }
    return report;
  } finally {
    if (handle) {
      await handle.stop();
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

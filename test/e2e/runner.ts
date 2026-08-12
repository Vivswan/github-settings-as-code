/**
 * The e2e scenario runner: bundle src/main.ts, spawn that bundle as a real
 * subprocess against a fresh mock GitHub server, then assert the scenario's
 * expectations against the process exit code, its GITHUB_OUTPUT, the step
 * summary, and the mock's request log and violations.
 *
 * Two tenets shape this file:
 * - Hermetic: the child environment is built FROM SCRATCH, never spread from
 *   process.env, so a developer's real token or GitHub URL can never leak into
 *   a run. The token is the inert E2E_TOKEN constant (constants.ts).
 * - Production parity: the child runs under `node` (the action's node24
 *   runtime), against a bundle built once per process from src/main.ts - the
 *   same single-file shape a release ships, freshly built so a run can never
 *   test stale code.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { OUTPUT_NAMES } from "../../src/action/io.js";
import {
  assertApplyIdempotent,
  captureRerun,
  type Invocation,
  type RerunCapture,
} from "./apply-idempotence-proof.js";
import { E2E_TOKEN, ADMIN_SLUG as REPO_SLUG } from "./constants.js";
import { assertIssueReport } from "./issue-report-assert.js";
import { type LoggedRequest, renderRequest } from "./mock/contract.js";
import { isWriteRequest } from "./mock/dispatch.js";
import { type ServerOptions, startMockServer } from "./mock/server.js";
import { sharedValidator } from "./openapi/validate.js";
import { type Scenario, settingsYamlFor } from "./schema.js";

const ROOT = join(import.meta.dir, "..", "..");
/**
 * The CLI command production bundles are built with, pinned verbatim so the
 * harness's Bun.build call below cannot silently drift from it: a flag added
 * to build:bundle (minify, sourcemap, define) would make e2e exercise a
 * different artifact than a release ships, with nothing failing. The two
 * must stay equivalent - a build:bundle change updates this pin AND the
 * Bun.build options together.
 */
const BUILD_BUNDLE_SCRIPT = "bun build src/main.ts --target=node --outfile lib/index.js";

/**
 * The parity verdict for a package.json `build:bundle` script: failure text
 * when it no longer matches BUILD_BUNDLE_SCRIPT, undefined when it does.
 * Pure over its argument and exported so a UNIT test can assert it on every
 * PR: builtBundle() below only runs when a scenario runs, and the e2e smoke
 * job skips on a package.json-only diff - exactly the PR that changes this
 * script - so the harness-side check alone could never fire on the change it
 * guards.
 */
export function bundleBuildParityFailure(script: string | undefined): string | undefined {
  return script === BUILD_BUNDLE_SCRIPT
    ? undefined
    : `package.json build:bundle is "${script}", but the e2e harness builds with "${BUILD_BUNDLE_SCRIPT}"; mirror the change in the harness's Bun.build options and update BUILD_BUNDLE_SCRIPT (test/e2e/runner.ts) to keep production parity`;
}

/** The `build:bundle` script this repository's package.json declares. */
export function declaredBuildBundleScript(): string | undefined {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.["build:bundle"];
}

/**
 * Build src/main.ts into a temp-directory bundle once per process, memoized
 * as a promise so concurrent scenarios share the one build instead of racing
 * their own. The bundle is not committed; this is where every e2e child gets
 * the file it runs.
 */
let bundleBuild: Promise<string> | undefined;
function builtBundle(): Promise<string> {
  bundleBuild ??= (async () => {
    // A fast local signal; the binding assertion is the unit test.
    const parityFailure = bundleBuildParityFailure(declaredBuildBundleScript());
    if (parityFailure !== undefined) {
      throw new Error(parityFailure);
    }
    const outdir = mkdtempSync(join(tmpdir(), "e2e-bundle-"));
    process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));
    const build = await Bun.build({
      entrypoints: [join(ROOT, "src", "main.ts")],
      target: "node",
      outdir,
      naming: "index.js",
    });
    if (!build.success) {
      throw new Error(`bundling src/main.ts failed:\n${build.logs.join("\n")}`);
    }
    return join(outdir, "index.js");
  })();
  return bundleBuild;
}
/**
 * The published output the skipped-sections assertion reads, pinned to the
 * action's own OUTPUT_NAMES declaration (src/action/io.ts): a rename there
 * fails compilation here instead of leaving a stale string reading nothing.
 */
const SKIPPED_SECTIONS_OUTPUT = "skipped-sections" satisfies (typeof OUTPUT_NAMES)[number];
/**
 * Hard cap so a hung child never wedges the suite. Sized for the observed
 * worst case, not the typical one: chatty multi-repo children legitimately
 * exceed 30 seconds when several suites run in parallel on one machine, and
 * a wrongly killed child fails its scenario with a misleading exit code.
 * killNote() marks every harness kill in the failure text, so the cap stays
 * a safety net rather than a diagnosis. The directed fuzz battery's
 * multi/apply-idempotent leg legitimately needs ~200s at some seeds
 * (~190 requests behind ~500ms injected latencies, applied twice), which
 * 120s killed - a latent seed-dependent flake, reproduced on two trees.
 */
const KILL_AFTER_MS = 300_000;

/** Monotonic per-process counter so repeated same-name failures never collide. */
let artifactCounter = 0;

/** The outcome of running one scenario: pass/fail plus everything observed. */
export interface ScenarioReport {
  scenario: string;
  ok: boolean;
  /** Human-readable failures; empty when the scenario met every expectation. */
  failures: string[];
  exitCode: number;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  /** The artifact directory written on failure, for the CLI to surface. */
  artifactDir?: string;
  /** Full request log snapshot, for coverage and validation consumers. */
  requests: LoggedRequest[];
  /**
   * How many times each injected fault key fired during the PRIMARY invocation
   * (key -> count), snapshotted immediately after it - the optional re-runs
   * (converges / apply_idempotent) never inflate it, so it describes the same
   * run as exitCode/outputs/reposResult. The fuzzer's non-vacuity assertion
   * reads it: a declared fault absent from this map never fired, so the
   * iteration did not actually test fault handling.
   */
  faultsFired: Record<string, number>;
  /**
   * The multi-repo per-target rollup, parsed from the `repos-result` output:
   * display key (the slug, or "private repository #N" under redaction) ->
   * result string. Empty for single-repo runs AND for multi runs that failed
   * before any target executed - a config or discovery fatal never writes the
   * output, which is the mechanical marker for "no per-target results exist".
   */
  reposResult: Record<string, string>;
  /**
   * Output surfaces of every internal re-run this scenario triggered, in
   * execution order: the converges check, and apply_idempotent's second apply
   * plus its final check. Leak invariants must sweep these alongside the
   * primary surfaces - the top-level stdout/stderr/summary/outputs describe
   * ONLY the primary invocation. Empty when the scenario declares no re-run.
   */
  reruns: RerunCapture[];
}

/**
 * The suffix every exit-code failure line carries when the harness itself
 * killed the child, so a timeout is never misread as the action exiting
 * with the kill signal on its own.
 */
function killNote(run: Invocation): string {
  return run.killedByHarness ? ` (the harness killed the child after ${KILL_AFTER_MS}ms)` : "";
}

/**
 * The expect.exit_code assertion: a plain number pins one code, an array pins
 * the allowed set (the fuzz oracle predicts a set of legal exits). Returns the
 * failure text, or undefined when the exit code is accepted. A one-element
 * expectation keeps the single-code message the curated corpus grew up with;
 * a multi-element set renders sorted, so the text is stable regardless of the
 * set's insertion order.
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
 * Parse a GITHUB_OUTPUT file, honoring @actions/core's two forms: the simple
 * `name=value` line and the heredoc block `name<<ghadelimiter_UUID\n...\ndelim`
 * that core uses for values that may contain newlines.
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

/**
 * Parse the per-section outcome rows from the step summary. Each managed
 * section renders as `| <key> | :<icon>: <status> | <detail> |`; return
 * key -> status.
 */
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

/**
 * Parse the multi-repo `repos-result` output: a JSON object mapping each
 * target slug to `{ result, source, skippedSections }`. Returns slug -> result
 * string, the per-target rollup a multi-repo scenario asserts on. A missing or
 * unparseable output yields an empty map (the assertion then reports the gap).
 */
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

/**
 * The expected per-target rollup for a multi-repo scenario, merging the
 * top-level expect.repos_result with each repos.*.expect.result. The per-repo
 * results are applied first and the top-level map overwrites them, so the
 * TOP-LEVEL entry wins on conflict (it is the single place to override a
 * co-located per-repo expectation). Returns null for a scenario that pins
 * neither, so single-repo scenarios skip the assertion.
 */
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

/** Build the child environment from scratch: nothing leaks from process.env. */
function childEnv(scenario: Scenario, dir: string, apiUrl: string): NodeJS.ProcessEnv {
  const inputs = scenario.inputs ?? {};
  const multi = Boolean(scenario.repos || scenario.discovery);
  const env: Record<string, string> = {
    // Scenario-declared child env FIRST (secret-reference material for the
    // secrets sections), so the harness-owned keys below always win on a
    // name collision; the schema already rejects reserved runner prefixes.
    ...(scenario.env ?? {}),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Inputs: @actions/core reads INPUT_<NAME> (uppercased, dashes kept).
    INPUT_TOKEN: E2E_TOKEN,
    GITHUB_REPOSITORY: REPO_SLUG,
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: join(dir, "output.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    RUNNER_DEBUG: "1",
    // A test knob so retry scenarios run in milliseconds instead of seconds.
    RETRY_BASE_MS: "1",
  };
  // settings-file is a single-repo input; the action rejects it alongside the
  // multi-repo inputs, so it is set only in single-repo mode.
  if (!multi) {
    env["INPUT_SETTINGS-FILE"] = join(dir, "settings.yml");
  }
  if (inputs.mode) {
    env.INPUT_MODE = inputs.mode;
  }
  if (inputs.on_missing_permission) {
    env["INPUT_ON-MISSING-PERMISSION"] = inputs.on_missing_permission;
  }
  if (inputs.required_sections) {
    env["INPUT_REQUIRED-SECTIONS"] = inputs.required_sections;
  }
  if (inputs.sections) {
    env.INPUT_SECTIONS = inputs.sections;
  }
  if (inputs.private_repos) {
    env["INPUT_PRIVATE-REPOS"] = inputs.private_repos;
  }
  if (inputs.private_report) {
    env["INPUT_PRIVATE-REPORT"] = inputs.private_report;
  }
  if (inputs.report_public_key) {
    env["INPUT_REPORT-PUBLIC-KEY"] = inputs.report_public_key;
  }

  // Multi-repo mode: the presence of `repos` or `discovery` switches the action
  // into its multi-repo path. GITHUB_REPOSITORY stays the admin repo; INPUT_REPOS
  // is "*" for discovery or the explicit target slugs; the discovery filter
  // inputs pass through verbatim; and the defaults file (if any) is written to
  // the temp dir and pointed at by INPUT_DEFAULTS-FILE.
  if (scenario.discovery) {
    env.INPUT_REPOS = "*";
    for (const [name, value] of Object.entries(scenario.discovery.inputs)) {
      env[`INPUT_${name.toUpperCase()}`] = value;
    }
  } else if (scenario.repos) {
    env.INPUT_REPOS = Object.keys(scenario.repos).join(",");
  }
  if (scenario.defaults_file) {
    const defaultsPath = join(dir, "defaults.yml");
    writeFileSync(defaultsPath, stringifyYaml(scenario.defaults_file));
    env["INPUT_DEFAULTS-FILE"] = defaultsPath;
  }
  return env;
}

/** Spawn one child run against the mock and collect its I/O. */
async function invoke(scenario: Scenario, dir: string, apiUrl: string): Promise<Invocation> {
  const outputFile = join(dir, "output.txt");
  const summaryFile = join(dir, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  const proc = Bun.spawn(["node", await builtBundle()], {
    cwd: dir,
    env: childEnv(scenario, dir, apiUrl),
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

/** Expand the {repo} placeholder a scenario uses in mutation/never patterns. */
function expandRepo(pattern: string): string {
  return pattern.replaceAll("{repo}", REPO_SLUG);
}

/** Drop every line starting with `prefix`; every other line is matched as-is. */
function stripLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(prefix))
    .join("\n");
}

/**
 * Strip the `::add-mask::<value>` workflow-command lines core.setSecret emits.
 * Those lines legitimately carry the raw slug so the real GitHub runner can
 * mask it in every later line; the runner consumes and never echoes them, so
 * the harness must drop them before checking that a redacted slug leaked
 * NOWHERE else on stdout.
 */
export function stripMaskLines(stdout: string): string {
  return stripLines(stdout, "::add-mask::");
}

/**
 * Drop `::debug::` workflow-command lines. These carry API request TRACES (path,
 * status, and under RUNNER_DEBUG the octokit request log), NOT the run's rendered
 * output. The unredacted counterfactual must judge whether a canary reached a
 * RENDERED public surface - the summary, annotations, or a plain log line -
 * because that is what detail-suppression regressions affect; a canary appearing
 * only in a debug trace does not prove the rendered detail was ever produced.
 */
export function stripDebugLines(text: string): string {
  return stripLines(text, "::debug::");
}

/**
 * The redaction LEAK INVARIANT, shared by curated scenarios and the fuzzer: no
 * forbidden string (a redacted slug or a planted canary) may appear in any
 * publicly-readable surface - the step summary, stdout and stderr (both with the
 * `::add-mask::` lines stripped, since those carry the raw slug for the real
 * runner by design), or any action output value. stderr is included because a
 * GitHub Actions run log captures it too, so a slug printed there leaks just as
 * a stdout one would. Returns one failure line per surface a forbidden string
 * reached; an empty array means no leak. Implemented once here so a scenario and
 * a fuzz iteration prove the exact same property.
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

/**
 * True when `patterns` appear as an in-order subsequence of `log`, each
 * matched as a prefix. This is the mutations rule: the declared writes must
 * occur in order, though other requests may interleave.
 */
export function isSubsequence(patterns: string[], log: string[]): boolean {
  let i = 0;
  for (const entry of log) {
    if (i < patterns.length && entry.startsWith(patterns[i] as string)) {
      i++;
    }
  }
  return i === patterns.length;
}

/**
 * The subset of `patterns` that appear as a prefix of some `log` entry. This is
 * the never rule: any forbidden pattern present in the log is a failure.
 */
export function forbiddenPresent(patterns: string[], log: string[]): string[] {
  return patterns.filter((pattern) => log.some((entry) => entry.startsWith(pattern)));
}

/**
 * Run one scenario end to end: start a fresh mock, spawn the bundle, assert
 * every declared expectation in a fixed order (violations first, then exit
 * code, then outputs, outcomes, mutations, never-patterns, substring checks),
 * and finally the optional convergence re-run against the SAME mutated server.
 * On any failure, dump an artifact directory for debugging.
 *
 * `opts.serverOptions` is merged into the mock's ServerOptions (over the
 * scenario's base_prefix), so the fuzz CLI can inject the chaos `corrupt`
 * directive programmatically. Existing single-arg callers are unaffected.
 */
export async function runScenario(
  scenario: Scenario,
  opts?: { serverOptions?: ServerOptions },
): Promise<ScenarioReport> {
  // Create the temp dir and the mock inside try/finally so a failure setting
  // up either one tears down whatever was already created. Both start
  // undefined and the finally cleans up only what exists.
  let dir: string | undefined;
  let handle: Awaited<ReturnType<typeof startMockServer>> | undefined;
  const failures: string[] = [];
  const reruns: RerunCapture[] = [];
  let first: Invocation | undefined;

  try {
    dir = mkdtempSync(join(tmpdir(), "e2e-"));
    handle = await startMockServer(scenario, {
      ...(scenario.base_prefix ? { basePrefix: scenario.base_prefix } : {}),
      // The scenario spells a fault's target as `endpoint`; the mock's
      // FaultOption keys it as `key`. Map the field name here.
      ...(scenario.faults
        ? {
            faults: scenario.faults.map((f) => ({ key: f.endpoint, kind: f.kind, times: f.times })),
          }
        : {}),
      ...opts?.serverOptions,
    });
    writeFileSync(join(dir, "settings.yml"), settingsYamlFor(scenario));
    first = await invoke(scenario, dir, handle.url);
    // Snapshot the fault fire counts NOW: every other report field (exit code,
    // outputs, reposResult) describes this primary invocation, so a fault that
    // only fires during an optional re-run (converges / apply_idempotent) must
    // not read as non-vacuous for the primary outcome.
    const faultsFired = Object.fromEntries(handle.faultCounts);
    const exp = scenario.expect;

    // 1. Mock-detected contract violations are always fatal and come first.
    if (handle.violations.length > 0) {
      failures.push(`mock violations:\n  ${handle.violations.join("\n  ")}`);
    }
    // 2. Exit code: a plain number pins one code, an array pins the allowed
    // set (the fuzz oracle predicts a set of legal exits).
    const exitFailure = exitCodeFailure(first.exitCode, exp.exit_code);
    if (exitFailure !== undefined) {
      failures.push(`${exitFailure}${killNote(first)}`);
    }
    // 2b. Zero-request invariant: a failure that must fire before any API
    // contact (e.g. a settings_raw parse failure, read from the local
    // filesystem before the client is used) leaves the mock untouched.
    if (exp.zero_requests && handle.requests.length > 0) {
      const sample = handle.requests
        .slice(0, 3)
        .map((r) => renderRequest(r, false))
        .join(", ");
      failures.push(
        `expected zero API requests, but the mock saw ${handle.requests.length}: ${sample}`,
      );
    }
    // 3. The `result` output.
    if (exp.result !== undefined && first.outputs.result !== exp.result) {
      failures.push(`result "${first.outputs.result}" != expected "${exp.result}"`);
    }
    // 3a. The `skipped-sections` output, compared as a set (the engine emits
    // a comma-joined list whose order is SECTION_KEYS order; the expectation
    // should not have to restate that). An ABSENT output is a failure even
    // against an empty expectation - the action publishing nothing is a
    // different regression from it publishing an empty list.
    if (exp.skipped_sections !== undefined) {
      const published = first.outputs[SKIPPED_SECTIONS_OUTPUT];
      if (published === undefined) {
        failures.push(`the ${SKIPPED_SECTIONS_OUTPUT} output was not published at all`);
      } else {
        const live = published.split(",").filter(Boolean).sort();
        const want = [...exp.skipped_sections].sort();
        if (JSON.stringify(live) !== JSON.stringify(want)) {
          failures.push(
            `${SKIPPED_SECTIONS_OUTPUT} output [${live.join(", ")}] != expected [${want.join(", ")}]`,
          );
        }
      }
    }
    // 3b. Multi-repo per-target rollup. The expected map merges the top-level
    // expect.repos_result with any per-repo repos.*.expect.result (the latter
    // co-locates a target's expectation with its definition). When the scenario
    // pins any target's result, the live repos-result map must EXACTLY match the
    // expected one - no unexpected targets, none missing.
    const expectedRepos = expectedReposResult(scenario);
    if (expectedRepos) {
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
    }
    // 4. Per-section outcomes from the summary table.
    if (exp.outcomes) {
      const live = parseSummaryOutcomes(first.summary);
      for (const [key, want] of Object.entries(exp.outcomes)) {
        if (live[key] !== want) {
          failures.push(`outcome ${key} "${live[key]}" != expected "${want}"`);
        }
      }
    }
    const pathLog = handle.requests.map((r) => renderRequest(r, false));
    const writes = handle.requests.filter(isWriteRequest).map((r) => renderRequest(r, false));
    // 5. Mutations as an ordered subsequence of the non-GET log.
    if (exp.mutations) {
      const want = exp.mutations.map(expandRepo);
      if (!isSubsequence(want, writes)) {
        failures.push(
          `mutations not found as a subsequence:\n  want: ${want.join(", ")}\n  writes: ${writes.join(", ")}`,
        );
      }
    }
    // 6. Forbidden patterns.
    if (exp.never) {
      for (const pattern of forbiddenPresent(exp.never.map(expandRepo), pathLog)) {
        failures.push(`forbidden request present: ${pattern}`);
      }
    }
    // 7. Substring checks.
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
    // 7b. Negative substring checks (the redaction leak guard). stdout_lacks
    // matches AFTER stripping the ::add-mask:: lines, which carry the raw slug
    // for the real runner by design; summary_lacks matches the summary as-is.
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
    // 7b-ii. Whole-surface leak invariant, centralized: leaks_nowhere runs
    // the SAME checkLeaks primitive on every scenario, and two needle
    // families join the declared ones automatically. The runner's inert
    // INPUT_TOKEN (E2E_TOKEN) is ALWAYS a needle: it is never add-mask'd, so
    // any echo on a public surface is a real leak - centralizing it here
    // covers the curated corpus and every fuzz mode with one sweep. Every
    // scenario env value joins too - a scenario env value is by definition a
    // resolved secret plaintext, so it must never reach any public surface
    // whether or not the author remembered to list it. The set dedupes an
    // env value the author also listed explicitly, and an EMPTY env value is
    // skipped (a set-but-empty variable is a scenario about the resolver's
    // empty-value error, not a leakable secret). The sweep is deferred past
    // the rerun blocks below so it covers the primary invocation AND every
    // internal re-run (a converges check or idempotence re-apply must not
    // leak what the first run masked).
    const leakNeedles = [
      ...new Set(
        [E2E_TOKEN, ...(exp.leaks_nowhere ?? []), ...Object.values(scenario.env ?? {})].filter(
          (needle) => needle !== "",
        ),
      ),
    ];
    // requests_contain may assert on a query string, so match the full form.
    const fullLog = handle.requests.map((r) => renderRequest(r, true));
    for (const needle of exp.requests_contain ?? []) {
      if (!fullLog.some((entry) => entry.includes(needle))) {
        failures.push(`no request contains: ${needle}`);
      }
    }
    // 7c. Private-report issue delivery: inspect the recorded issue writes for
    // the named slug (the one channel where the private slug/sentinel may
    // legitimately appear - inside the target repo's own issue).
    if (exp.issue_report) {
      failures.push(...assertIssueReport(exp.issue_report, handle.requests));
    }
    // 7d. Apply-idempotence: a second apply against the same mutated mock must
    // be a fixpoint (see assertApplyIdempotent). Its own final step arms the
    // one-way check-mode barrier and proves convergence, which is why
    // `fixpoint` is a single enum: only one of these blocks can ever run. The
    // proof engine drives its re-runs through this runner's own invoke, bound
    // to the same temp dir and mock the primary invocation used.
    if (exp.fixpoint === "apply_idempotent") {
      // Bound copies on purpose: `dir` and `handle` are mutable lets (the
      // finally block owns their cleanup), so a closure over them widens back
      // to `| undefined`; the consts carry the narrowed values into the
      // invoker.
      const boundDir = dir;
      const mockUrl = handle.url;
      const idempotence = await assertApplyIdempotent(scenario, handle, {
        invoke: (rerun) => invoke(rerun, boundDir, mockUrl),
        killNote,
      });
      failures.push(...idempotence.failures);
      reruns.push(...idempotence.reruns);
    }
    // 8. Convergence: rerun in check mode against the SAME mutated server. Arm
    // the mock's check-mode write barrier first (the server still holds the
    // apply-mode scenario, so without this a stray write would not be a
    // violation), then require exit 0 and zero new writes, and re-check the
    // mock's violations for anything the re-run tripped.
    if (exp.fixpoint === "converges") {
      const violationsBefore = handle.violations.length;
      const writesBefore = handle.requests.length;
      handle.enterCheckMode();
      const converge = await invoke(
        { ...scenario, inputs: { ...scenario.inputs, mode: "check" } },
        dir,
        handle.url,
      );
      reruns.push(captureRerun("converges check", converge));
      const newWrites = handle.requests.slice(writesBefore).filter(isWriteRequest);
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
    }

    // 9. OpenAPI contract: every logged request (including the convergence
    // re-run's) must match a documented path/method, and every request/response
    // body must satisfy the trimmed spec. Always on: the mock is our stand-in
    // for GitHub, so any drift from the published contract is a mock bug. Denied
    // and mock-violation traffic is excluded inside the validator.
    const openApiViolations = sharedValidator().validateLog(handle.requests);
    if (openApiViolations.length > 0) {
      const lines = openApiViolations.map((v) => `${v.request} [${v.kind}]: ${v.detail}`);
      failures.push(`OpenAPI contract violations:\n  ${lines.join("\n  ")}`);
    }

    // The deferred leak sweep (see 7b-ii): primary run plus every rerun. The
    // needle set is never empty (E2E_TOKEN is always in it), so the sweep is
    // unconditional.
    failures.push(
      ...checkLeaks(
        {
          summary: first.summary,
          stdout: first.stdout,
          stderr: first.stderr,
          outputs: first.outputs,
        },
        leakNeedles,
      ),
    );
    for (const rerun of reruns) {
      failures.push(
        ...checkLeaks(
          {
            summary: rerun.summary,
            stdout: rerun.stdout,
            stderr: rerun.stderr,
            outputs: rerun.outputs,
          },
          leakNeedles,
        ).map((failure) => `${rerun.label}: ${failure}`),
      );
    }

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
      reruns,
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
  }
}

/**
 * Insert a `## Replay` section right after the title line of an artifact
 * directory's report.md. The fuzz-issue action's failure-report contract
 * wants the exact replay command in a fenced block, and it only keeps the
 * head of the report, so the block goes at the top rather than appended
 * after the failure list.
 */
export function insertReplay(artifactDir: string, replay: string): void {
  const path = join(artifactDir, "report.md");
  const [title, ...rest] = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, [title, "", "## Replay", "", "```sh", replay, "```", ...rest].join("\n"));
}

/**
 * Append a marker to a report.md's title line. The fuzz-issue action heads
 * each issue section with that line, and the redaction counterfactual re-runs
 * the SAME scenario name - unmarked, its failure section would be
 * indistinguishable from the primary run's.
 */
export function markReportTitle(artifactDir: string, marker: string): void {
  const path = join(artifactDir, "report.md");
  const [title, ...rest] = readFileSync(path, "utf8").split("\n");
  writeFileSync(path, [`${title} (${marker})`, ...rest].join("\n"));
}

/**
 * Write a failing scenario's inputs and observed I/O for debugging, and
 * return the directory so the CLI can point the reader at it. Keyed by
 * scenario name and pid so parallel or repeated runs never collide.
 */
function dumpArtifacts(
  scenario: Scenario,
  report: ScenarioReport,
  requests: LoggedRequest[],
): string {
  // Sanitize the scenario name to [a-z0-9-] so it cannot escape the .artifacts
  // root or collide via odd characters; a per-process counter disambiguates
  // repeated failures of the same scenario name.
  const safeName = scenario.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "scenario";
  const dir = join(
    ROOT,
    "test",
    "e2e",
    ".artifacts",
    `${safeName}-${process.pid}-${artifactCounter++}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scenario.yml"), stringifyYaml(scenario));
  writeFileSync(join(dir, "stdout.txt"), report.stdout);
  writeFileSync(join(dir, "stderr.txt"), report.stderr);
  writeFileSync(join(dir, "summary.md"), report.summary);
  writeFileSync(join(dir, "requests.json"), JSON.stringify(requests, null, 2));
  const md = [
    `# ${scenario.name}`,
    "",
    `Artifact directory: ${dir}`,
    "",
    "## Failures",
    "",
    ...report.failures.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
    "",
    `Exit code: ${report.exitCode}`,
  ].join("\n");
  writeFileSync(join(dir, "report.md"), `${md}\n`);
  return dir;
}

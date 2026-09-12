/**
 * The oracle predicts outcome CLASSES, never drift content, so a disagreement with the bundle's observed outcome is
 * an engine or oracle bug, never a flaky expectation. Every iteration is a pure function of its seed and the
 * --sections flag; a failure replays with its printed `replay:` line.
 *
 * standard   -> per-section outcome classes; a fully-granted apply also proves the fixpoint
 * input      -> a mangled document must fail before any API contact
 * chaos      -> one corrupt response is absorbed, a persistent one fails loudly
 * multi      -> per-target outcome classes plus the worst-of rollup
 * discovery  -> a `repos: "*"` pool filtered by the independent predictDiscovery mirror
 * merge      -> a layered mode: merge stack whose written document the oracle's fold predicts whole
 */

import { describeOptOut } from "../../src/engine/layers.js";
import { MAX_RETRIES } from "../../src/github/api.js";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { endpointPath } from "../../src/sections/contract/endpoints.js";
import { sectionModule } from "../../src/sections/registry.js";
import type { LiveWitness, LiveWitnessKind } from "./gen-support.js";
import {
  canariesOf,
  displayKeyOf,
  type FaultableSection,
  genDiscoveryScenario,
  genInvalidSettings,
  genLiveWitness,
  genMergeScenario,
  genMultiScenario,
  genScenario,
  genSettings,
  INVALID_SETTINGS_CASES,
  MERGE_REFUSAL_KINDS,
  type MergeForce,
  type MergeScenarioMeta,
  type MultiRepoMeta,
  type MultiScenarioMeta,
  NON_MAPPING_YAML,
  presenceLiveState,
  redactionPlaceholder,
  type ScenarioMeta,
  SECTION_FAULT_FIXTURE,
  SECTION_PRIMARY_READ,
  scenarioSecretEnv,
  UNFAULTABLE_APPLY_SETTINGS,
  UNFAULTABLE_SECTIONS,
  UNPARSEABLE_YAML,
  type UnfaultableSection,
  unfaultableReadKeys,
  validateAgainstPublishedSchema,
  WITNESS_KINDS,
  WITNESS_SECTIONS,
  type WitnessSection,
} from "./generators.js";
import { deliveredIssueBody } from "./issue-report-assert.js";
import type { LoggedRequest } from "./mock/contract.js";
import {
  foldRepoResults,
  foldSectionOutcomes,
  judgePreflightAbort,
  NO_READ_SECTIONS,
  predictDiscovery,
  predictMerge,
  predictMulti,
  predictOutcomes,
} from "./oracle.js";
import { Rng } from "./prng.js";
import {
  checkLeaks,
  failureArtifacts,
  markReportTitle,
  parseReposResult,
  parseSummaryOutcomes,
  runScenario,
  setReplay,
  stripDebugLines,
  stripMaskLines,
} from "./runner.js";
import type { Scenario } from "./schema.js";

const FAILURE_CAP = 5;

function iterationSeed(master: number, i: number): number {
  let h = (master ^ (i + 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

interface Flags {
  iterations: number;
  seed?: number;
  sections?: SectionKey[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { iterations: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--iterations") {
      flags.iterations = Number(argv[++i]);
    } else if (arg === "--seed") {
      flags.seed = Number(argv[++i]);
    } else if (arg === "--sections") {
      // Parse, don't cast: a typo'd section would otherwise crash deep inside
      // the generator pool several green iterations later.
      const parsed = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const isSection = (s: string): s is SectionKey =>
        (SECTION_KEYS as readonly string[]).includes(s);
      const unknown = parsed.filter((s) => !isSection(s));
      if (unknown.length > 0) {
        throw new Error(
          `--sections names unknown section(s) [${unknown.join(", ")}]; known sections: ${SECTION_KEYS.join(", ")}`,
        );
      }
      if (parsed.length === 0) {
        throw new Error("--sections got an empty list; name at least one section or drop the flag");
      }
      flags.sections = parsed.filter(isSection);
    }
  }
  return flags;
}

/** The runner wrote the curated replay; a fuzz artifact replays by seed, never by name (a fuzz scenario is not a file). */
function reportArtifacts(result: IterationResult, replay: string): void {
  for (const dir of [result.artifactDir, ...(result.extraArtifactDirs ?? [])]) {
    if (dir === undefined) {
      continue;
    }
    console.log(`    artifact: ${dir}`);
    setReplay(dir, replay);
  }
}

/** `explicit` covers both pinning styles, so `FUZZ_SEED=X --iterations 1` replays exactly like `--seed X --iterations 1`. */
function masterSeed(flags: Flags): { seed: number; explicit: boolean } {
  if (flags.seed !== undefined && Number.isFinite(flags.seed)) {
    return { seed: flags.seed >>> 0, explicit: true };
  }
  const raw = (process.env.FUZZ_SEED ?? "").trim();
  const env = Number(raw);
  if (raw !== "" && Number.isFinite(env)) {
    return { seed: env >>> 0, explicit: true };
  }
  return { seed: crypto.getRandomValues(new Uint32Array(1))[0] as number, explicit: false };
}

interface IterationBase {
  artifactDir?: string;
  /** Artifact dirs beyond the primary run's (the redaction counterfactual). */
  extraArtifactDirs?: string[];
  sections: SectionKey[];
  coverage?: CoverageEvent[];
  faultClass?: string;
  proof?: "apply_idempotent" | "converges";
  mergeFeatures?: string[];
}

type IterationResult = IterationBase &
  ({ ok: true; failure?: never } | { ok: false; failure: string });

function iterationResult(problems: string[], base: IterationBase, prefix = ""): IterationResult {
  if (problems.length === 0) {
    return { ok: true, ...base };
  }
  return { ok: false, failure: `${prefix}${problems.join("; ")}`, ...base };
}

/**
 * The write classes come from the mock's request log, not the summary: "applied" alone does not prove a
 * mutation happened, a successful PATCH does.
 */
type MutationClass = "create" | "update" | "delete" | "clean";

type CoverageEvent = [WitnessSection, MutationClass];

const CLASS_BY_METHOD: Record<string, MutationClass> = {
  POST: "create",
  PATCH: "update",
  DELETE: "delete",
};

/**
 * A pipe is a delimiter only after an EVEN run of backslashes: the engine escapes cells with
 * backslash-then-pipe (markdownCell, src/report/markdown.ts); under HOSTILE_NAMES a broken escape changes a row's separator count.
 */
function summaryTableProblems(summary: string, expectedRows: number): string[] {
  const lines = summary.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith("|"));
  if (start === -1) {
    // A completed run renders the header and separator even with zero data rows, so absence is an error at any expectedRows.
    return ["summary carries no markdown table"];
  }
  const table: string[] = [];
  for (let i = start; i < lines.length && lines[i]?.startsWith("|"); i++) {
    table.push(lines[i] as string);
  }
  const separators = (row: string): number => {
    let count = 0;
    let backslashes = 0;
    for (const ch of row) {
      if (ch === "\\") {
        backslashes++;
        continue;
      }
      if (ch === "|" && backslashes % 2 === 0) {
        count++;
      }
      backslashes = 0;
    }
    return count;
  };
  const problems: string[] = [];
  if (table.length < 2 + expectedRows) {
    problems.push(
      `summary table has ${table.length} row(s), expected a header + separator + at least ${expectedRows} data row(s)`,
    );
  }
  // The loose "any of -:| whitespace" form would accept an empty separator cell.
  const separatorCells = (table[1] ?? "").split("|").slice(1, -1);
  if (separatorCells.length === 0 || !separatorCells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) {
    problems.push(`summary table separator row is malformed: "${table[1] ?? "(absent)"}"`);
  }
  const headerCount = separators(table[0] ?? "");
  for (const [index, row] of table.entries()) {
    if (separators(row) !== headerCount) {
      problems.push(
        `summary table row ${index} has ${separators(row)} cell separator(s), the header has ${headerCount} - a broken pipe escape?`,
      );
      break;
    }
  }
  return problems;
}

const WITNESS_PATHS: Record<WitnessSection, string> = Object.fromEntries(
  WITNESS_SECTIONS.map((key) => {
    const list = sectionModule(key).endpoints.list;
    if (list === undefined) {
      throw new Error(`${key} declares no "list" role, so its writes cannot be attributed`);
    }
    return [key, endpointPath(list.route).replace("/repos/{owner}/{repo}", "")];
  }),
) as Record<WitnessSection, string>;

/** A denied write mutated nothing, so only 2xx writes count as reached mutation classes. */
function witnessCoverage(
  requests: LoggedRequest[],
  meta: ScenarioMeta,
  observed: Record<string, string>,
): CoverageEvent[] {
  const events: CoverageEvent[] = [];
  for (const request of requests) {
    const cls = CLASS_BY_METHOD[request.method];
    if (cls === undefined || request.status < 200 || request.status >= 300) {
      continue;
    }
    const section = WITNESS_SECTIONS.find((key) => {
      const path = WITNESS_PATHS[key];
      return request.pathname.endsWith(path) || request.pathname.includes(`${path}/`);
    });
    if (section !== undefined) {
      events.push([section, cls]);
    }
  }
  for (const key of WITNESS_SECTIONS) {
    if (meta.liveKinds?.[key] === "matching" && observed[key] === "clean") {
      events.push([key, "clean"]);
    }
  }
  return events;
}

/**
 * faultsFired covers the PRIMARY invocation only, so a fault that would first fire during a re-run reads
 * as not fired: the budget must be consumed by the run whose exit code and outcomes were asserted.
 */
function assertFaultFired(
  faultsFired: Record<string, number>,
  key: string,
  problems: string[],
): boolean {
  const fired = (faultsFired[key] ?? 0) >= 1;
  if (!fired) {
    problems.push(`fault on ${key} never fired - the iteration is vacuous`);
  }
  return fired;
}

/** The key and its histogram label travel as one value: a key without a label starves the histogram, a label without a key is dead configuration. */
interface InjectedFault {
  key: string;
  classLabel: string;
}

async function runPredicted(
  scenario: Scenario,
  meta: ScenarioMeta,
  opts: { fault?: InjectedFault } = {},
): Promise<IterationResult> {
  const prediction = predictOutcomes(meta);
  const fixpoint = prediction.fullyGranted && meta.mode === "apply";
  const proof: IterationResult["proof"] =
    fixpoint && opts.fault === undefined ? "apply_idempotent" : fixpoint ? "converges" : undefined;
  scenario.expect = {
    exit_code: [...prediction.allowedExitCodes],
    fixpoint: proof,
  };

  const report = await runScenario(scenario);
  const problems: string[] = [];

  problems.push(...report.failures);
  let faultClass: string | undefined;
  if (opts.fault !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.fault.key, problems);
    faultClass = fired ? opts.fault.classLabel : undefined;
  }
  // A preflight abort reports "failed" over an EMPTY table by design, so the per-section checks and
  // the result fold (foldSectionOutcomes mirrors orchestrate.ts's rollup) run only on a "ran" verdict.
  const observed = parseSummaryOutcomes(report.summary);
  const verdict = judgePreflightAbort(prediction.preflightAborts, {
    summary: report.summary,
    result: report.outputs.result,
    stdout: report.stdout,
  });
  if (verdict.kind === "contradiction") {
    problems.push(verdict.problem);
  }
  if (verdict.kind === "ran") {
    for (const section of prediction.sections) {
      const got = observed[section.key];
      if (got === undefined) {
        problems.push(
          `${section.key}: predicted {${[...section.allowed].join(",")}} but the section is absent from the summary`,
        );
        continue;
      }
      if (!section.allowed.has(got as never)) {
        problems.push(
          `${section.key}: observed "${got}" not in predicted {${[...section.allowed].join(",")}} (grades ${section.grades.join("|")})`,
        );
      }
    }
    const folded = foldSectionOutcomes(Object.values(observed), meta.mode === "check");
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from the summary outcomes`,
      );
    }
    problems.push(...summaryTableProblems(report.summary, prediction.sections.length));
  }
  // The leak sweeps run in runScenario over the primary run and every rerun; a fuzz-side sweep would double-report.

  return iterationResult(problems, {
    artifactDir: failureArtifacts(scenario, report, problems),
    sections: meta.sections,
    coverage: witnessCoverage(report.requests, meta, observed),
    faultClass,
    proof,
  });
}

async function standardIteration(
  seed: number,
  opts: { sections?: SectionKey[] },
): Promise<IterationResult> {
  const { scenario, meta } = genScenario(new Rng(seed), opts);
  return runPredicted(scenario, meta);
}

/**
 * Fully granted under warn policy, so the witness alone decides the outcome class. The random stream
 * reaches these combinations only probabilistically; this battery makes the mutation-class guard deterministic.
 */
async function witnessIteration(
  seed: number,
  key: WitnessSection,
  kind: LiveWitnessKind,
  mode: "apply" | "check",
): Promise<IterationResult> {
  const rng = new Rng(seed);
  // milestones' drift-update degrades to matching when no milestone declares a
  // perturbable field; redraw (deterministically) until the kind holds.
  let settings: unknown;
  let witness: LiveWitness | undefined;
  for (let attempt = 0; attempt < 20 && witness?.kind !== kind; attempt++) {
    const draw = rng.fork(`draw:${attempt}`);
    settings = genSettings(draw.fork("settings"), key);
    witness = genLiveWitness(draw.fork("live"), key, settings, kind);
  }
  if (witness === undefined || witness.kind !== kind) {
    return {
      ok: false,
      failure: `could not draw a "${kind}" ${key} witness in 20 attempts`,
      sections: [key],
    };
  }

  const settingsDoc = { [key]: settings };
  validateAgainstPublishedSchema(settingsDoc);
  const meta: ScenarioMeta = {
    sections: [key],
    mask: {},
    mode,
    policy: "warn",
    ownerKind: "org",
    denialStyle: "fine_grained",
    requiredSections: [],
    liveKinds: { [key]: witness.kind },
  };
  const scenario: Scenario = {
    name: `fuzz-witness-${key}-${kind}-${mode}-${seed}`,
    tiers: ["mock"],
    settings: settingsDoc,
    inputs: { mode, on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    live_state: witness.state,
    expect: { exit_code: 0 },
  };
  return runPredicted(scenario, meta);
}

type RejectionSpec = {
  label: string;
  tokens: string[];
  mode?: "apply" | "check";
} & (
  | { settings: Record<string, unknown>; settingsRaw?: never }
  | { settingsRaw: string; settings?: never }
);

/**
 * The zero-request check is duplicated on purpose: the runner's zero_requests expectation fails the
 * scenario, the sample here names the offending calls.
 */
async function rejectionIteration(seed: number, spec: RejectionSpec): Promise<IterationResult> {
  const rng = new Rng(seed);
  const scenario: Scenario = {
    name: `fuzz-input-${spec.label}-${seed}`,
    tiers: ["mock"],
    ...(spec.settingsRaw !== undefined
      ? { settings_raw: spec.settingsRaw }
      : { settings: spec.settings }),
    inputs: { mode: spec.mode ?? rng.pick(["apply", "check"]) },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 1, stdout_contains: spec.tokens, zero_requests: true },
  };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  if (report.requests.length > 0) {
    const sample = report.requests
      .slice(0, 3)
      .map((r) => `${r.method} ${r.pathname}`)
      .join(", ");
    problems.push(
      `input fuzz reached the API ${report.requests.length} time(s) before rejecting the doc: ${sample}`,
    );
  }
  return iterationResult(
    problems,
    { artifactDir: failureArtifacts(scenario, report, problems), sections: [] },
    `[${spec.label}] `,
  );
}

function invalidDocSpec(rng: Rng): RejectionSpec {
  const { name, doc, offendingToken } = genInvalidSettings(rng);
  return { label: `invalid-${name}`, settings: doc, tokens: [offendingToken] };
}

/** The tokens are the single-repo flow's advice (src/flows/single.ts): the parse fails on the local file, before any API call. */
function unparseableRawSpec(rng: Rng): RejectionSpec {
  return {
    label: "raw-unparseable",
    settingsRaw: rng.pick(UNPARSEABLE_YAML),
    tokens: ["cannot read settings", "valid YAML"],
  };
}

/** The parse succeeds, so the token is validateSettingsDoc's top-level check, not the reader's. */
function nonMappingRawSpec(rng: Rng): RejectionSpec {
  return {
    label: "raw-non-mapping",
    settingsRaw: rng.pick(NON_MAPPING_YAML),
    tokens: ["must be a YAML mapping"],
  };
}

/**
 * The roll gives the validator catalog half the stream: it is the richest shape (wrong
 * container/item/enum/nested types, an unknown top-level key).
 */
async function inputFuzzIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const roll = rng.int(4);
  const spec =
    roll === 2
      ? unparseableRawSpec(rng)
      : roll === 3
        ? nonMappingRawSpec(rng)
        : invalidDocSpec(rng.fork("case"));
  return rejectionIteration(seed, spec);
}

/** Mirrors the mock's CorruptOption modes. */
const CHAOS_MODES = ["invalid_json", "wrong_shape", "missing_envelope"] as const;

/**
 * Chaos fuzz corrupts the labels-list response: labels.list is the labels section's first read, and its
 * enveloped-or-bare list is mangled by all three modes. A single corrupt body is absorbed
 * before the apply pass reads (the preflight probe in orchestrate.ts ignores non-permission errors).
 *
 * one corrupt response      -> the apply succeeds AND converges
 * corrupt on every attempt  -> exit 1, an error naming labels, no write after the read, no stack
 */
async function chaosFuzzIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const mode = rng.pick([...CHAOS_MODES]);
  const persistent = rng.int(3) === 0;
  return persistent ? persistentChaosIteration(seed, mode) : singleShotChaosIteration(seed, mode);
}

async function singleShotChaosIteration(
  seed: number,
  mode: (typeof CHAOS_MODES)[number],
): Promise<IterationResult> {
  const scenario: Scenario = {
    name: `fuzz-chaos-single-${seed}`,
    tiers: ["mock"],
    // Fully granted by default, so the list read reaches the mock and the corruption fires.
    settings: { labels: [{ name: "chaos", color: "d73a4a" }] },
    inputs: { mode: "apply" },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 0, fixpoint: "converges" },
  };
  const report = await runScenario(scenario, {
    serverOptions: { corrupt: { key: "labels.list", mode } },
  });
  // The mock marks a corrupt body offSpec, so the OpenAPI validator skips it and no failure needs filtering here.
  const problems = [...report.failures];
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push(`unhandled stack in stderr under ${mode}`);
  }
  const observed = parseSummaryOutcomes(report.summary);
  if (observed.labels === undefined) {
    problems.push(`labels row absent from the summary under ${mode}, expected applied`);
  } else if (observed.labels !== "applied") {
    problems.push(`labels observed "${observed.labels}" under ${mode}, expected applied`);
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: ["labels"],
      proof: "converges",
    },
    `[single ${mode}] `,
  );
}

async function persistentChaosIteration(
  seed: number,
  mode: (typeof CHAOS_MODES)[number],
): Promise<IterationResult> {
  const scenario: Scenario = {
    name: `fuzz-chaos-persist-${seed}`,
    tiers: ["mock"],
    settings: { labels: [{ name: "chaos", color: "d73a4a" }] },
    inputs: { mode: "apply" },
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 1 },
  };
  const report = await runScenario(scenario, {
    serverOptions: { corrupt: { key: "labels.list", mode, times: "always" } },
  });
  const problems = [...report.failures];
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push(`unhandled stack in stderr under persistent ${mode}`);
  }
  const errorNamesSection = /::error::[^\n]*labels/.test(report.stdout);
  if (!errorNamesSection) {
    problems.push(`persistent ${mode}: no actionable error naming the labels section`);
  }
  const writes = (report.requests ?? []).filter(
    (r) => r.method !== "GET" && /\/labels/.test(r.pathname),
  );
  if (writes.length > 0) {
    problems.push(
      `persistent ${mode}: ${writes.length} label write(s) after the corrupted read - must not mutate`,
    );
  }
  return iterationResult(
    problems,
    { artifactDir: failureArtifacts(scenario, report, problems), sections: ["labels"] },
    `[persist ${mode}] `,
  );
}

async function multiRepoFuzzIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genMultiScenario(new Rng(seed));
  return runMultiPredicted(scenario, meta);
}

interface MultiRunOptions {
  fault?: InjectedFault;
  reportFaultDegrades?: boolean;
}

/**
 * One predicate for the random-stream gate and the fixpoint battery draw, so the two cannot diverge.
 * Empty per-target masks is deliberately NARROWER than fully granted (a mask granting write everywhere
 * would also qualify); fully granted is required because secondApplyWriteFailures judges every
 * second-apply request by declared recurrence, and a denied write recurs.
 *
 * issue channel      -> rejected: the delivery embeds fresh timestamps and the marker label ties labels to the channel
 * raw-invalid target -> rejected: its exit 1 fails the second-apply-exit-0 property
 */
function multiIdempotenceEligible(meta: MultiScenarioMeta): boolean {
  return (
    meta.mode === "apply" &&
    meta.privateReport !== "issue" &&
    // Under a denied org gate a declared teams section reads back as drift (declared team, no access), which the proof cannot accept.
    meta.globalMask.org_members !== "none" &&
    meta.repos.every((r) => r.target.kind !== "raw-invalid") &&
    meta.repos.every(
      (r) => r.target.kind !== "normal" || Object.keys(r.target.meta.mask).length === 0,
    )
  );
}

/** Shared by the gate and the battery draw so they cannot diverge; an empty kept set exits 1 by design. */
function discoveryConvergeEligible(meta: ReturnType<typeof genDiscoveryScenario>["meta"]): boolean {
  return predictDiscovery(meta.pool, meta.filters).length > 0;
}

async function runMultiPredicted(
  scenario: Scenario,
  meta: MultiScenarioMeta,
  opts: MultiRunOptions = {},
): Promise<IterationResult> {
  const prediction = predictMulti(meta);
  const idempotent =
    multiIdempotenceEligible(meta) &&
    opts.fault === undefined &&
    meta.coreFault === undefined &&
    prediction.allowedExitCodes.size === 1 &&
    prediction.allowedExitCodes.has(0);
  const proof = idempotent ? ("apply_idempotent" as const) : undefined;
  scenario.expect = {
    exit_code: [...prediction.allowedExitCodes],
    fixpoint: proof,
  };

  const report = await runScenario(scenario);
  const problems: string[] = [];
  const extraArtifactDirs: string[] = [];
  let faultClass: string | undefined;
  if (opts.fault !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.fault.key, problems);
    faultClass = fired ? opts.fault.classLabel : undefined;
  }
  // The generator forces one private target, so an empty forbidden set is a generator regression that would make the leak check vacuous.
  if (meta.privateRepos === "redact" && prediction.forbidden.length === 0) {
    problems.push("redact run produced an empty forbidden set - the leak check would be vacuous");
  }
  problems.push(...report.failures);
  // Compared on displayKey: a redacted target is keyed "private repository #N", never its slug.
  const results = parseReposResult(report.outputs["repos-result"]);
  for (const repo of prediction.repos) {
    const got = results[repo.displayKey];
    if (got === undefined) {
      problems.push(
        `${repo.displayKey}: predicted {${[...repo.allowedResults].join(",")}} but the repo is absent from repos-result`,
      );
      continue;
    }
    if (!repo.allowedResults.has(got)) {
      problems.push(
        `${repo.displayKey}: result "${got}" not in predicted {${[...repo.allowedResults].join(",")}}`,
      );
    }
  }
  // A real slug where a placeholder was expected shows up here as an unpredicted key.
  const predictedKeys = new Set(prediction.repos.map((r) => r.displayKey));
  for (const key of Object.keys(results)) {
    if (!predictedKeys.has(key)) {
      problems.push(`${key}: reported in repos-result but not predicted`);
    }
  }
  // {failed} alone would also cover an unrelated pre-validation exception, so a raw target must show ITS
  // gate wording on a public surface; a redacted one must NOT, and this target is the only source of that wording.
  const renderedPublic = [
    stripDebugLines(stripMaskLines(report.stdout)),
    stripDebugLines(stripMaskLines(report.stderr)),
    report.summary,
    ...Object.values(report.outputs),
  ].join("\n");
  for (const repo of meta.repos) {
    if (repo.target.kind !== "raw-invalid") {
      continue;
    }
    const wording = repo.target.raw === "unparseable" ? "cannot parse" : "must be a YAML mapping";
    if (repo.redaction.kind === "redacted") {
      if (renderedPublic.includes(wording)) {
        problems.push(
          `raw target ${displayKeyOf(repo)}: gate wording "${wording}" leaked to a public surface despite redaction`,
        );
      }
    } else if (!renderedPublic.includes(wording)) {
      problems.push(
        `raw target ${repo.slug}: failure does not carry the promised gate wording "${wording}"`,
      );
    }
    // The parse gate stops the target before any section call; the report channel's marker-label
    // ensure-create is POST-only, so a labels list or edit here is a section call leaking through.
    const probePath = `/repos/${repo.slug}`;
    const base = `${probePath}/`;
    const allowedByHead: Record<string, ReadonlySet<string>> = {
      contents: new Set(["GET"]),
      labels: new Set(["POST"]),
      issues: new Set(["GET", "POST", "PATCH"]),
    };
    for (const request of report.requests) {
      const isProbe = request.pathname === probePath;
      if (!isProbe && !request.pathname.startsWith(base)) {
        continue;
      }
      const head = isProbe ? "" : (request.pathname.slice(base.length).split("/")[0] ?? "");
      const allowed = isProbe
        ? request.method === "GET"
        : (allowedByHead[head]?.has(request.method) ?? false);
      if (!allowed) {
        problems.push(
          `raw target ${repo.slug}: unexpected request ${request.method} ${request.pathname} - the parse gate must stop the target before any section call`,
        );
      }
    }
  }
  problems.push(...checkLeaks(report, prediction.forbidden));

  // The counterfactual proves the leak test is not vacuous: the SAME scenario under private-repos: show
  // must surface a canary on a RENDERED surface, not merely a ::debug:: trace, because detail-suppression
  // regressions affect rendered output. Only canaries are checked: it is DETAIL suppression this guards.
  if (meta.privateRepos === "redact") {
    const canaries = meta.repos.flatMap(canariesOf);
    if (canaries.length > 0) {
      // The counterfactual runs fault-free, so its exit set is priced without the core fault; coreFault
      // is the only fault the oracle prices in (a report failure never fails the run).
      const shownExits =
        meta.coreFault === undefined
          ? prediction.allowedExitCodes
          : predictMulti({ ...meta, coreFault: undefined }).allowedExitCodes;
      const shown = await runScenario({
        ...scenario,
        // Anything that stops the counterfactual from starting, or kills the canary's target, would read as "no canary surfaced".
        //   a delivering channel + show         -> rejected at config parse (show redacts nothing)
        //   report_public_key without artifact  -> rejected too
        //   an exhausting fault                 -> could kill the very target whose canary must surface
        faults: undefined,
        expect: { exit_code: [...shownExits] },
        inputs: {
          ...scenario.inputs,
          private_repos: "show",
          private_report: "none",
          report_public_key: undefined,
        },
      });
      // A rejected counterfactual proves nothing about canary flow, and swallowing it would strand the artifact the runner dumped.
      if (!shown.ok) {
        const where = shown.artifactDir === undefined ? "" : ` (artifact: ${shown.artifactDir})`;
        problems.push(`counterfactual run${where}: ${shown.failures.join("; ")}`);
      }
      if (shown.artifactDir !== undefined) {
        markReportTitle(shown.artifactDir, "redaction counterfactual");
        extraArtifactDirs.push(shown.artifactDir);
      }
      const rendered = [
        stripDebugLines(stripMaskLines(shown.stdout)),
        stripDebugLines(stripMaskLines(shown.stderr)),
        shown.summary,
        ...Object.values(shown.outputs),
      ].join("\n");
      if (!canaries.some((c) => rendered.includes(c))) {
        problems.push(
          "counterfactual: no canary surfaced in a rendered surface under private-repos: show, so the redacted leak check is vacuous",
        );
      }
    }
  }

  // A delivering redacted target's OWN report issue is the one private surface where full detail
  // legitimately lands, so its canaries must reach the recorded body (suppression did not eat the report).
  // Under a faulted lookup the contract flips to the degrade: no issue created or patched, the safe warning at least once.
  if (meta.privateReport === "issue" && opts.reportFaultDegrades === true) {
    const issueWrites = report.requests.filter(
      (r) => r.method !== "GET" && /\/issues(\/|$|\?)/.test(r.pathname),
    );
    if (issueWrites.length > 0) {
      const sample = issueWrites.map((r) => `${r.method} ${r.pathname}`).join(", ");
      problems.push(`report fault: issue writes happened despite the faulted lookup: ${sample}`);
    }
    const degradeWarnings = report.stdout
      .split("\n")
      .filter((line) => line.includes("could not deliver the private report")).length;
    if (degradeWarnings < 1) {
      problems.push(
        "report fault: no safe degrade warning fired despite a delivering target attempting the report",
      );
    }
  } else if (meta.privateReport === "issue") {
    for (const repo of meta.repos) {
      const canaries = canariesOf(repo);
      if (!reportDelivers(repo) || canaries.length === 0) {
        continue;
      }
      const body = deliveredIssueBody(report.requests, repo.slug);
      if (body === undefined) {
        problems.push(`report: no issue body delivered for the redacted target ${repo.slug}`);
        continue;
      }
      // Only the -name canary is asserted: the label name reaches the report in every mode, the
      // description canaries surface in check mode only. A carrier without one is a convention drift, not a skip.
      const nameCanary = canaries.find((c) => c.endsWith("-name"));
      if (nameCanary === undefined) {
        problems.push(
          `report: ${repo.slug} has canaries but no -name canary to assert in the body`,
        );
      } else if (!body.includes(nameCanary)) {
        problems.push(`report: issue body for ${repo.slug} is missing canary ${nameCanary}`);
      }
    }
  }

  // Under the artifact channel the harness never sees a delivered body (the upload fails safely:
  // ACTIONS_RUNTIME_TOKEN is absent), so the leak invariant above is the positive proof.
  if (meta.privateReport === "artifact") {
    const issueWrites = report.requests.filter(
      (r) => r.method !== "GET" && /\/issues(\/|$|\?)/.test(r.pathname),
    );
    if (issueWrites.length > 0) {
      const sample = issueWrites.map((r) => `${r.method} ${r.pathname}`).join(", ");
      problems.push(`artifact channel wrote to the issue routes: ${sample}`);
    }
    const composed = meta.repos.some((r) => reportDelivers(r));
    // One artifact is uploaded after the whole loop, so exactly one warning: a per-target repeat or a silent zero fails here.
    const uploadWarnings = report.stdout
      .split("\n")
      .filter((line) => line.includes("could not upload the private report artifact")).length;
    if (composed && uploadWarnings !== 1) {
      problems.push(
        `artifact channel composed a report but emitted ${uploadWarnings} upload-failure warning(s), expected exactly 1`,
      );
    }
  }

  // Folded from repos-result, not the summary: a multi summary repeats section keys per target, which
  // parseSummaryOutcomes would overwrite. A config-fatal run emits no repos-result by design.
  if (Object.keys(report.reposResult).length > 0) {
    const folded = foldRepoResults(Object.values(report.reposResult), meta.mode === "check");
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from repos-result`,
      );
    }
  }

  return iterationResult(problems, {
    artifactDir: failureArtifacts(scenario, report, problems),
    extraArtifactDirs,
    sections: [],
    faultClass,
    proof,
  });
}

/**
 * Only the forced-private target (redacted, normal, empty mask) delivers for certain: it has a settings
 * file, Issues write, and Contents read. Another redacted target may have Issues denied (a safe warning,
 * no body), so it is left to the leak invariant.
 */
function reportDelivers(repo: MultiRepoMeta): boolean {
  return (
    repo.redaction.kind === "redacted" &&
    repo.target.kind === "normal" &&
    Object.keys(repo.target.meta.mask).length === 0
  );
}

async function discoveryFuzzIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  return runDiscoveryPredicted(scenario, meta);
}

async function runDiscoveryPredicted(
  scenario: Scenario,
  meta: ReturnType<typeof genDiscoveryScenario>["meta"],
  opts: { fault?: InjectedFault } = {},
): Promise<IterationResult> {
  const kept = predictDiscovery(meta.pool, meta.filters);
  // An empty kept set exits 1 by design. The discovery scenario pins fully-granted labels in apply
  // mode, so a fault-free non-empty run must converge.
  const proof =
    discoveryConvergeEligible(meta) && opts.fault === undefined
      ? ("converges" as const)
      : undefined;
  scenario.expect = {
    exit_code: kept.length === 0 ? 1 : 0,
    fixpoint: proof,
  };

  const report = await runScenario(scenario);
  const problems: string[] = [...report.failures];
  let faultClass: string | undefined;
  if (opts.fault !== undefined) {
    const fired = assertFaultFired(report.faultsFired, opts.fault.key, problems);
    faultClass = fired ? opts.fault.classLabel : undefined;
  }
  const results = parseReposResult(report.outputs["repos-result"]);
  const got = new Set(Object.keys(results));

  const redact = meta.privateRepos === "redact";
  const visibilityOf = new Map(meta.pool.map((r) => [r.slug, r.visibility ?? "public"]));
  // Placeholders are numbered over the kept repos in kept order (matching planRedaction); discovery
  // has no per-repo probe, so the planted visibility is the only one.
  const expectedKeys = new Set<string>();
  let ordinal = 0;
  for (const slug of kept) {
    const isPrivate = redact && visibilityOf.get(slug) !== "public";
    if (isPrivate) {
      ordinal += 1;
      expectedKeys.add(redactionPlaceholder(ordinal));
    } else {
      expectedKeys.add(slug);
    }
  }
  for (const key of expectedKeys) {
    if (!got.has(key)) {
      problems.push(`discovery expected key ${key} but it is absent from repos-result`);
    }
  }
  for (const key of got) {
    if (!expectedKeys.has(key)) {
      problems.push(`discovery processed ${key} but it was not an expected key`);
    }
  }
  if (redact) {
    const forbidden = meta.pool
      .filter((r) => (r.visibility ?? "public") !== "public")
      .map((r) => r.slug);
    // The generator forces one non-public pool repo, so an empty forbidden set is a generator regression.
    if (forbidden.length === 0) {
      problems.push(
        "redact discovery run produced an empty forbidden set - the leak check would be vacuous",
      );
    }
    problems.push(...checkLeaks(report, forbidden));
  }
  // Discovery is always apply mode; the kept-empty error and the discovery-fatal path emit no repos-result by design.
  if (Object.keys(report.reposResult).length > 0) {
    const folded = foldRepoResults(Object.values(report.reposResult), false);
    if (report.outputs.result !== folded) {
      problems.push(
        `self-consistency: result output "${report.outputs.result}" != "${folded}" folded from repos-result`,
      );
    }
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: [],
      faultClass,
      proof,
    },
    `filters ${JSON.stringify(meta.filters)}: `,
  );
}

// --- Merge-mode fuzz --------------------------------------------------------

/** A merge never touches GitHub, so every iteration also pins zero requests. */
async function mergeFuzzIteration(
  seed: number,
  opts: { sections?: SectionKey[]; force?: MergeForce },
): Promise<IterationResult> {
  const { scenario, meta } = genMergeScenario(new Rng(seed), opts);
  return runMergePredicted(scenario, meta);
}

/** The valid force guarantees a merged fold, so the whole-document comparison runs every soak per layering. */
async function mergeValidBatteryRun(
  seed: number,
  layering: "merge" | "replace",
): Promise<IterationResult> {
  const { scenario, meta } = genMergeScenario(new Rng(seed), {
    force: { kind: "valid", layering },
  });
  const prediction = predictMerge(meta);
  if (prediction.kind !== "merged") {
    return {
      ok: false,
      failure: `the valid force produced a stack the oracle reads as ${prediction.kind} - the force and predictMerge drifted apart`,
      sections: [],
    };
  }
  return runMergePredicted(scenario, meta);
}

async function runMergePredicted(
  scenario: Scenario,
  meta: MergeScenarioMeta,
): Promise<IterationResult> {
  const prediction = predictMerge(meta);
  scenario.expect =
    prediction.kind !== "merged"
      ? { exit_code: 1, result: "failed", zero_requests: true }
      : {
          exit_code: 0,
          result: "merged",
          zero_requests: true,
          merged: prediction.merged,
          stdout_contains: prediction.notices.map(describeOptOut),
          summary_contains: ["Merged document written to "],
        };
  const report = await runScenario(scenario);
  const problems = [...report.failures];
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push("unhandled stack in stderr from a merge run");
  }
  // Matched on ::error:: lines only: an opt-out ::notice:: line also starts with the layer name (describeOptOut).
  const errorNames = (site: string): boolean =>
    report.stdout.split("\n").some((line) => line.startsWith("::error::") && line.includes(site));
  if (prediction.kind === "refused") {
    if (!errorNames(prediction.layer)) {
      problems.push(`refused stack: no ::error:: line names the refused layer ${prediction.layer}`);
    }
  } else if (prediction.kind === "invalid") {
    if (!errorNames("the merged settings document")) {
      problems.push("invalid fold: no ::error:: line names the merged settings document");
    }
  } else {
    // mode: merge emits no other notices, so the count catches a deletion the oracle did not predict.
    const announced = report.stdout.split("\n").filter((line) => line.startsWith("::notice::"));
    if (announced.length !== prediction.notices.length) {
      problems.push(
        `the run announced ${announced.length} null deletion(s); the oracle predicted ${prediction.notices.length}`,
      );
    }
  }
  const sections = new Set<SectionKey>();
  for (const layer of meta.layers) {
    for (const key of Object.keys(layer.doc)) {
      if ((SECTION_KEYS as readonly string[]).includes(key)) {
        sections.add(key as SectionKey);
      }
    }
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: [...sections],
      mergeFeatures: meta.features,
    },
    `[merge ${prediction.kind}] `,
  );
}

// --- Transport-fault fuzz ---------------------------------------------------

/** The mock's transport FaultOption kinds; echo_422, a validation rejection with no transient form, stays with the curated scenarios. */
const FAULT_KINDS = ["rate_limit_403", "429_then_200", "connection_drop", "server_error"] as const;
type FaultKind = (typeof FAULT_KINDS)[number];

/** A budget of RETRY_BUDGET outlasts the client's retries; a budget of 1 is a transient (for the kinds it retries at all, see faultKills). */
const RETRY_BUDGET = 1 + MAX_RETRIES;

/** Classed by the VERDICT, not the budget: a one-shot rate_limit_403 is fatal, so "transient" would misstate it. */
function faultClassLabel(key: string, kind: FaultKind, fatal: boolean): string {
  return `${key} ${kind}/${fatal ? "fatal" : "transient"}`;
}

/**
 * rate_limit_403 kills on its FIRST firing whatever the budget: the mock's 403 carries neither the secondary-rate
 * phrase nor a zero-quota header, so the throttling plugin declines it, and 403 is on the retry plugin's doNotRetry list.
 */
function faultKills(kind: FaultKind, exhausting: boolean): boolean {
  return exhausting || kind === "rate_limit_403";
}

interface SectionFaultPlan {
  section: FaultableSection;
  key: string;
  kind: FaultKind;
  exhausting: boolean;
  mode: "apply" | "check";
}

function allFaultCombos(): Array<[FaultKind, boolean]> {
  const combos: Array<[FaultKind, boolean]> = [];
  for (const kind of FAULT_KINDS) {
    combos.push([kind, false], [kind, true]);
  }
  return combos;
}

/**
 * There are more sections than combos, so every section AND every combo fires every soak; the pairing
 * and the mode rotate with the master seed, so consecutive soaks walk the full section x kind x budget
 * cross product without one soak paying for all of it.
 */
function faultBatteryPlan(master: number): SectionFaultPlan[] {
  const sections = Object.keys(SECTION_PRIMARY_READ) as FaultableSection[];
  const combos = allFaultCombos();
  const offset = master % combos.length; // codeql[js/biased-cryptographic-random] -- fuzz seed rotation, not key material
  const plans = sections.map((section, index): SectionFaultPlan => {
    const [kind, exhausting] = combos[(index + offset) % combos.length] as [FaultKind, boolean];
    return {
      section,
      key: SECTION_PRIMARY_READ[section],
      kind,
      exhausting,
      mode: (index + master) % 2 === 0 ? ("apply" as const) : ("check" as const),
    };
  });
  assertFaultBatteryCoverage(plans, sections, combos);
  return plans;
}

/**
 * The section half cannot fire today (the plan derives from the full SECTION_PRIMARY_READ list) and
 * exists to survive a rewrite; the combo half fires if the section list shrinks below the combo count.
 * Throws rather than returning a failure: a hole here is a plan bug no seed can route around.
 */
function assertFaultBatteryCoverage(
  plans: readonly SectionFaultPlan[],
  sections: readonly FaultableSection[],
  combos: ReadonlyArray<[FaultKind, boolean]>,
): void {
  const plannedSections = new Set(plans.map((plan) => plan.section));
  const missingSections = sections.filter((section) => !plannedSections.has(section));
  const comboKey = (kind: FaultKind, exhausting: boolean): string =>
    `${kind}/x${exhausting ? RETRY_BUDGET : 1}`;
  const plannedCombos = new Set(plans.map((plan) => comboKey(plan.kind, plan.exhausting)));
  const missingCombos = combos
    .map(([kind, exhausting]) => comboKey(kind, exhausting))
    .filter((combo) => !plannedCombos.has(combo));
  if (missingSections.length > 0 || missingCombos.length > 0) {
    throw new Error(
      `fault battery plan lost per-soak coverage: missing section(s) [${missingSections.join(", ")}], missing kind/budget combo(s) [${missingCombos.join(", ")}]`,
    );
  }
}

async function sectionFaultIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const section = rng.pick(Object.keys(SECTION_PRIMARY_READ) as FaultableSection[]);
  return faultedSectionRun(seed, {
    section,
    key: SECTION_PRIMARY_READ[section],
    kind: rng.pick([...FAULT_KINDS]),
    exhausting: rng.bool(),
    mode: rng.pick(["apply", "check"] as const),
  });
}

async function faultedSectionRun(seed: number, plan: SectionFaultPlan): Promise<IterationResult> {
  const rng = new Rng(seed).fork("fault-scenario");
  // A key-gated section needs its fixture for the primary read to fire at all.
  const settings: Record<string, unknown> = {
    [plan.section]:
      SECTION_FAULT_FIXTURE[plan.section] ?? genSettings(rng.fork("settings"), plan.section),
  };
  const liveKinds: NonNullable<ScenarioMeta["liveKinds"]> = {};
  // Presence live state first: a declared workflow whose file is absent would drift the converge re-run for good.
  const combinedLive: LiveWitness["state"] = { ...(presenceLiveState(settings) ?? {}) };
  const witnessed = WITNESS_SECTIONS.find((key) => key === plan.section);
  if (witnessed !== undefined) {
    // A matching witness pins the prediction exactly, so "retried away" means indistinguishable from healthy.
    const witness = genLiveWitness(rng.fork("witness"), witnessed, settings[witnessed], "matching");
    liveKinds[witnessed] = witness.kind;
    Object.assign(combinedLive, witness.state);
  }
  const liveState = Object.keys(combinedLive).length > 0 ? combinedLive : undefined;
  // Without the secret pool's env an apply would fail on an unset variable instead of the injected fault.
  const secretEnv = scenarioSecretEnv(settings);
  const meta: ScenarioMeta = {
    sections: [plan.section],
    mask: {},
    mode: plan.mode,
    // warn keeps the oracle general; the apply + fail preflight interaction lives in preflightFaultRun.
    policy: "warn",
    ownerKind: "org",
    denialStyle: "fine_grained",
    requiredSections: [],
    liveKinds,
  };
  const scenario: Scenario = {
    name: `fuzz-fault-${plan.section}-${plan.kind}-x${plan.exhausting ? RETRY_BUDGET : 1}-${seed}`,
    tiers: ["mock"],
    settings,
    inputs: { mode: plan.mode, on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    ...(liveState ? { live_state: liveState } : {}),
    ...(secretEnv === undefined ? {} : { env: secretEnv }),
    faults: [{ endpoint: plan.key, kind: plan.kind, times: plan.exhausting ? RETRY_BUDGET : 1 }],
    expect: { exit_code: 0 },
  };
  const label = faultClassLabel(plan.key, plan.kind, faultKills(plan.kind, plan.exhausting));
  return faultKills(plan.kind, plan.exhausting)
    ? exhaustedSectionRun(scenario, plan.section, plan.key, label)
    : runPredicted(scenario, meta, { fault: { key: plan.key, classLabel: label } });
}

/**
 * An UNFAULTABLE_SECTIONS entry is exempt because every read it could make is conditional or check-mode-only;
 * the faults are armed from unfaultableReadKeys so no hand-picked endpoint goes stale.
 */
async function unfaultableSectionRun(
  seed: number,
  section: UnfaultableSection,
): Promise<IterationResult> {
  const readKeys = unfaultableReadKeys(section);
  const problems: string[] = [];
  // A NO_READ_SECTIONS member has nothing to arm by construction; the outcome pin still proves its apply healthy.
  if (readKeys.length === 0 && !NO_READ_SECTIONS.has(section)) {
    problems.push(
      `no GET endpoints derived for "${section}" - the unfaultable battery run is vacuous; fix ` +
        `the endpoint keying in unfaultableReadKeys (generators.ts), or if the section genuinely ` +
        `declares no GET it should already appear in NO_READ_SECTIONS (oracle.ts)`,
    );
    return iterationResult(problems, { sections: [section] }, `[unfaultable ${section}] `);
  }
  const scenario: Scenario = {
    name: `fuzz-unfaultable-${section}-${seed}`,
    tiers: ["mock"],
    settings: { [section]: UNFAULTABLE_APPLY_SETTINGS[section] },
    inputs: { mode: "apply", on_missing_permission: "warn" },
    denial_style: "fine_grained",
    owner_kind: "org",
    faults: readKeys.map((key) => ({ endpoint: key, kind: "server_error" as const, times: 1 })),
    // Under warn a SKIPPED section would also exit 0 with every fault cold, so the outcome pin is the non-vacuity guard.
    expect: { exit_code: 0, outcomes: { [section]: "applied" } },
  };
  const report = await runScenario(scenario);
  if (!report.ok) {
    problems.push(...report.failures);
  }
  for (const key of readKeys) {
    if ((report.faultsFired[key] ?? 0) > 0) {
      problems.push(
        `fault on ${key} FIRED during an apply of "${section}" - the read is unconditional after all; move the section into SECTION_PRIMARY_READ so the fault battery covers it`,
      );
    }
  }
  return iterationResult(
    problems,
    { artifactDir: failureArtifacts(scenario, report, problems), sections: [section] },
    `[unfaultable ${section}] `,
  );
}

async function exhaustedSectionRun(
  scenario: Scenario,
  section: FaultableSection,
  faultKey: string,
  faultClass: string,
): Promise<IterationResult> {
  scenario.expect = { exit_code: 1 };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, faultKey, problems);
  const observed = parseSummaryOutcomes(report.summary);
  if (observed[section] !== "failed") {
    problems.push(
      `${section}: observed "${observed[section] ?? "(absent)"}" under an exhausted fault, expected failed`,
    );
  }
  if (!new RegExp(`::error::[^\\n]*${section}`).test(report.stdout)) {
    problems.push(`no actionable error naming the ${section} section`);
  }
  if (/\n\s+at\s+\S+ \(/.test(report.stderr)) {
    problems.push("unhandled stack in stderr under an exhausted fault");
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: [section],
      faultClass: fired ? faultClass : undefined,
    },
    `[fault ${faultKey}] `,
  );
}

/**
 * core.contentsGet is the settings fetch every target makes; an exhausting budget is eaten whole by the
 * FIRST target in generation order, which fails outright (predictMulti's coreFault override).
 *   first target raw-invalid       -> plain multi iteration; its gate-wording assertion stays unconditional
 *   first target a canary carrier  -> plain multi iteration; its report delivery and counterfactual stay guaranteed
 */
async function multiContentsFaultIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genMultiScenario(new Rng(seed));
  const victim = meta.repos[0];
  if (
    victim === undefined ||
    victim.target.kind === "raw-invalid" ||
    canariesOf(victim).length > 0
  ) {
    return runMultiPredicted(scenario, meta);
  }
  const roll = new Rng(seed ^ 0x51ed2701);
  const kind = roll.pick([...FAULT_KINDS]);
  const exhausting = roll.bool();
  return runMultiPredicted(scenario, meta, injectContentsFault(scenario, meta, kind, exhausting));
}

/**
 * The scenario's fault and the oracle's coreFault verdict are ONE decision written together, so a caller
 * cannot set one and forget the other. rate_limit_403 gets one firing whatever the budget: it kills on its
 * first, and the leftover firings would spill into the NEXT targets' fetches, beyond the single-victim model.
 */
function injectContentsFault(
  scenario: Scenario,
  meta: MultiScenarioMeta,
  kind: FaultKind,
  exhausting: boolean,
): { fault: InjectedFault } {
  const fatal = faultKills(kind, exhausting);
  const times = kind === "rate_limit_403" ? 1 : exhausting ? RETRY_BUDGET : 1;
  scenario.faults = [{ endpoint: "core.contentsGet", kind, times }];
  meta.coreFault = { key: "core.contentsGet", fatal };
  return {
    fault: {
      key: "core.contentsGet",
      classLabel: faultClassLabel("core.contentsGet", kind, fatal),
    },
  };
}

/** A fatal listing fault must exit 1 before any target runs: a silent empty pool instead of a loud failure is the bug this hunts. */
async function discoveryFaultIteration(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  const roll = new Rng(seed ^ 0x2545f491);
  const kind = roll.pick([...FAULT_KINDS]);
  const exhausting = roll.bool();
  const fatal = faultKills(kind, exhausting);
  scenario.faults = [
    { endpoint: "core.discoveryList", kind, times: exhausting ? RETRY_BUDGET : 1 },
  ];
  const faultClass = faultClassLabel("core.discoveryList", kind, fatal);
  if (!fatal) {
    return runDiscoveryPredicted(scenario, meta, {
      fault: { key: "core.discoveryList", classLabel: faultClass },
    });
  }
  return fatalDiscoveryRun(scenario, meta, faultClass);
}

/** Checked on the raw output, not parseReposResult: it maps absent, malformed, and {} to the same empty object, hiding a stray emit. */
async function fatalDiscoveryRun(
  scenario: Scenario,
  meta: ReturnType<typeof genDiscoveryScenario>["meta"],
  faultClass: string,
): Promise<IterationResult> {
  scenario.expect = { exit_code: 1 };
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, "core.discoveryList", problems);
  const touched = report.requests.filter((r) =>
    meta.pool.some((p) => r.pathname.startsWith(`/repos/${p.slug}`)),
  );
  if (touched.length > 0) {
    problems.push(
      `discovery-fatal: ${touched.length} target request(s) after the failed listing, e.g. ${touched[0]?.method} ${touched[0]?.pathname}`,
    );
  }
  if (report.outputs["repos-result"] !== undefined) {
    problems.push(
      `discovery-fatal: repos-result was emitted (${report.outputs["repos-result"]}), expected no output at all`,
    );
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: [],
      faultClass: fired ? faultClass : undefined,
    },
    "[fault core.discoveryList] ",
  );
}

function discoveryFaultBatteryRun(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed));
  scenario.faults = [{ endpoint: "core.discoveryList", kind: "server_error", times: RETRY_BUDGET }];
  return fatalDiscoveryRun(
    scenario,
    meta,
    faultClassLabel("core.discoveryList", "server_error", true),
  );
}

/**
 * The fault stream pins policy at warn (faultedSectionRun), so these entries pin apply + fail. The preflight barrier
 * re-runs every section read first and IGNORES non-permission errors (orchestrate.ts), so the probe consumes fault budget.
 *   budget = RETRY_BUDGET      -> the probe burns it all, the apply-pass read succeeds: applied, exit 0
 *   budget = 2 x RETRY_BUDGET  -> the budget survives preflight, the apply-pass read dies too: exit 1
 */
async function preflightFaultRun(seed: number, surviving: boolean): Promise<IterationResult> {
  const rng = new Rng(seed).fork("preflight");
  const settings: Record<string, unknown> = { labels: genSettings(rng.fork("settings"), "labels") };
  const witness = genLiveWitness(rng.fork("witness"), "labels", settings.labels, "matching");
  const times = surviving ? 2 * RETRY_BUDGET : RETRY_BUDGET;
  const scenario: Scenario = {
    name: `fuzz-preflight-fault-${surviving ? "survives" : "consumed"}-${seed}`,
    tiers: ["mock"],
    settings,
    inputs: { mode: "apply", on_missing_permission: "fail" },
    denial_style: "fine_grained",
    owner_kind: "org",
    live_state: witness.state,
    faults: [{ endpoint: "labels.list", kind: "server_error", times }],
    expect: { exit_code: surviving ? 1 : 0 },
  };
  const faultClass = faultClassLabel("labels.list", "server_error", surviving);
  if (surviving) {
    return exhaustedSectionRun(scenario, "labels", "labels.list", faultClass);
  }
  const report = await runScenario(scenario);
  const problems = report.ok ? [] : [...report.failures];
  const fired = assertFaultFired(report.faultsFired, "labels.list", problems);
  const observed = parseSummaryOutcomes(report.summary);
  if (observed.labels !== "applied") {
    problems.push(
      `preflight-consumed: labels observed "${observed.labels ?? "(absent)"}", expected applied - the probe should have eaten the budget and the apply read succeeded`,
    );
  }
  return iterationResult(
    problems,
    {
      artifactDir: failureArtifacts(scenario, report, problems),
      sections: ["labels"],
      faultClass: fired ? faultClass : undefined,
    },
    "[preflight consumed] ",
  );
}

/**
 * core.issuesList fires for EVERY delivering target, the forced-private one included, so faulting it
 * `always` leaves no delivery half-done. server_error is pinned because the degrade contract is the HTTP-status warning path.
 */
async function reportFaultIteration(seed: number): Promise<IterationResult> {
  const drawn = drawIssueChannelScenario(new Rng(seed), 12);
  if (drawn === null) {
    return multiRepoFuzzIteration(seed);
  }
  return injectedReportFaultRun(drawn);
}

function drawIssueChannelScenario(
  base: Rng,
  attempts: number,
): { scenario: Scenario; meta: MultiScenarioMeta } | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const drawn = genMultiScenario(base.fork(`report:${attempt}`));
    if (drawn.meta.privateReport === "issue") {
      return drawn;
    }
  }
  return null;
}

function injectedReportFaultRun(drawn: {
  scenario: Scenario;
  meta: MultiScenarioMeta;
}): Promise<IterationResult> {
  drawn.scenario.faults = [{ endpoint: "core.issuesList", kind: "server_error", times: "always" }];
  return runMultiPredicted(drawn.scenario, drawn.meta, {
    fault: {
      key: "core.issuesList",
      classLabel: faultClassLabel("core.issuesList", "server_error", true),
    },
    reportFaultDegrades: true,
  });
}

/**
 * The random stream reaches the core-path fault iterations only ~1/80 per iteration. Eligibility is
 * CONSTRUCTED by a generator force, never rejection-sampled: any fork budget has miss seeds, and a live CI seed turns each into a spurious failure.
 */
async function contentsFaultBatteryRun(seed: number): Promise<IterationResult> {
  // "plain-first-target" keeps the raw target off index 0 and runs under show, so the victim guard holds by generator structure.
  const { scenario, meta } = genMultiScenario(new Rng(seed), "plain-first-target");
  const victim = meta.repos[0];
  if (
    victim === undefined ||
    victim.target.kind === "raw-invalid" ||
    canariesOf(victim).length > 0
  ) {
    return iterationResult(
      [
        "the plain-first-target force produced an ineligible first target - the force and the victim guard drifted apart",
      ],
      { sections: [] },
    );
  }
  return runMultiPredicted(
    scenario,
    meta,
    injectContentsFault(scenario, meta, "server_error", true),
  );
}

function reportFaultBatteryRun(seed: number): Promise<IterationResult> {
  // The force pins the channel inside generation: seed 8181 proved a 40-fork rejection draw can miss.
  const drawn = genMultiScenario(new Rng(seed), "issue-report");
  if (drawn.meta.privateReport !== "issue") {
    return Promise.resolve({
      ok: false,
      failure:
        "the issue-report force did not produce an issue-channel scenario - the force and the generator drifted apart",
      sections: [],
    });
  }
  return injectedReportFaultRun(drawn);
}

// --- Fixpoint battery --------------------------------------------------------

/**
 * The random gate fires on only ~5% of multi iterations, so a 30-iteration soak would exercise it with
 * ~30% probability. The "idempotence-eligible" force constructs eligibility for every master seed; the
 * predicate assert is the drift tripwire between the force and the gate.
 */
async function multiIdempotenceBatteryRun(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genMultiScenario(new Rng(seed), "idempotence-eligible");
  if (!multiIdempotenceEligible(meta)) {
    return {
      ok: false,
      failure:
        "the idempotence-eligible force produced an ineligible scenario - the force and multiIdempotenceEligible drifted apart",
      sections: [],
    };
  }
  const result = await runMultiPredicted(scenario, meta);
  if (result.ok && result.proof !== "apply_idempotent") {
    return {
      ...result,
      ok: false,
      failure:
        "an eligible multi scenario did not arm the apply-idempotence gate - the exit-0 belt blocked it, which the shared predicate cannot express; investigate the prediction",
    };
  }
  return result;
}

/** The "converges" force pins pool repo 0 non-archived with no filters, so the kept set holds it for every master seed. */
async function discoveryConvergesBatteryRun(seed: number): Promise<IterationResult> {
  const { scenario, meta } = genDiscoveryScenario(new Rng(seed), "converges");
  if (!discoveryConvergeEligible(meta)) {
    return {
      ok: false,
      failure:
        "the converges force produced an empty kept set - the force and discoveryConvergeEligible drifted apart",
      sections: [],
    };
  }
  const result = await runDiscoveryPredicted(scenario, meta);
  if (result.ok && result.proof !== "converges") {
    return {
      ...result,
      ok: false,
      failure:
        "a non-empty discovery scenario did not arm the converges gate - the battery draw predicate and runDiscoveryPredicted's gate drifted apart",
    };
  }
  return result;
}
async function faultFuzzIteration(seed: number): Promise<IterationResult> {
  const roll = new Rng(seed ^ 0x7f4a7c15).int(5);
  if (roll === 0) {
    return multiContentsFaultIteration(seed);
  }
  if (roll === 1) {
    return discoveryFaultIteration(seed);
  }
  if (roll === 2) {
    return reportFaultIteration(seed);
  }
  return sectionFaultIteration(seed);
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const { seed: master, explicit } = masterSeed(flags);
  // One iteration under an explicit seed runs THAT iteration seed, so a printed seed replays directly.
  const replayOne = flags.iterations === 1 && explicit;
  console.log(`fuzz master seed: ${master} (replay: --seed ${master})`);
  console.log(`iterations: ${flags.iterations}`);

  const coverage = new Map<SectionKey, number>();
  const mutationHistogram = new Map<WitnessSection, Map<MutationClass, number>>();
  const recordCoverage = (events: CoverageEvent[] | undefined): void => {
    for (const [section, cls] of events ?? []) {
      const counts = mutationHistogram.get(section) ?? new Map<MutationClass, number>();
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      mutationHistogram.set(section, counts);
    }
  };
  const failingSeeds: number[] = [];
  let failures = 0;
  const faultHistogram = new Map<string, number>();
  const recordFaultClass = (cls: string | undefined): void => {
    if (cls !== undefined) {
      faultHistogram.set(cls, (faultHistogram.get(cls) ?? 0) + 1);
    }
  };
  // Makes a starving gate visible (multi idempotence at ~5% eligibility); the battery guarantees each proof once per soak regardless.
  const proofCounts = new Map<string, number>();
  const mergeHistogram = new Map<string, number>();
  const recordMergeFeatures = (features: string[] | undefined): void => {
    for (const feature of features ?? []) {
      mergeHistogram.set(feature, (mergeHistogram.get(feature) ?? 0) + 1);
    }
  };

  for (let i = 0; i < flags.iterations; i++) {
    const seed = replayOne ? master : iterationSeed(master, i);
    const roll = new Rng(seed ^ 0x5bd1e995).int(8);
    let result: IterationResult;
    let mode: string;
    if (roll < 2) {
      mode = "multi";
      result = await multiRepoFuzzIteration(seed);
    } else if (roll === 2) {
      mode = "input";
      result = await inputFuzzIteration(seed);
    } else if (roll === 3) {
      if (new Rng(seed ^ 0x1b873593).bool()) {
        mode = "fault";
        result = await faultFuzzIteration(seed);
      } else {
        mode = "chaos";
        result = await chaosFuzzIteration(seed);
      }
    } else if (roll === 4) {
      mode = "discovery";
      result = await discoveryFuzzIteration(seed);
    } else if (new Rng(seed ^ 0x27d4eb2f).int(4) === 0) {
      mode = "merge";
      result = await mergeFuzzIteration(seed, { sections: flags.sections });
    } else {
      mode = "standard";
      result = await standardIteration(seed, { sections: flags.sections });
    }
    for (const section of result.sections) {
      coverage.set(section, (coverage.get(section) ?? 0) + 1);
    }
    recordCoverage(result.coverage);
    recordFaultClass(result.faultClass);
    recordMergeFeatures(result.mergeFeatures);
    if (result.proof !== undefined) {
      const key = `${mode}:${result.proof}`;
      proofCounts.set(key, (proofCounts.get(key) ?? 0) + 1);
    }
    if (!result.ok) {
      failures++;
      failingSeeds.push(seed);
      // The seed alone draws from the full section pool, so a replay must carry the same --sections.
      const sectionsFlag =
        (mode === "standard" || mode === "merge") && flags.sections
          ? ` --sections ${flags.sections.join(",")}`
          : "";
      const replay = `bun test/e2e/fuzz.ts --seed ${seed} --iterations 1${sectionsFlag}`;
      console.log(`  iter ${i} [${mode}] seed ${seed} FAIL: ${result.failure}`);
      console.log(`    replay: ${replay}`);
      reportArtifacts(result, replay);
      if (failures >= FAILURE_CAP) {
        console.log(`\nfailure cap (${FAILURE_CAP}) reached; stopping`);
        break;
      }
    } else {
      console.log(`  iter ${i} [${mode}] seed ${seed} ok`);
    }
  }

  let batteryFailures = 0;
  if (!replayOne) {
    const batteryReplay = `bun test/e2e/fuzz.ts --seed ${master} --iterations 0`;
    type BatteryEntry = [string, (seed: number) => Promise<IterationResult>];
    const runBattery = async (
      header: string,
      seedBase: number,
      entries: readonly BatteryEntry[],
    ): Promise<void> => {
      console.log(`\n${header}:`);
      for (const [index, [name, run]] of entries.entries()) {
        const seed = iterationSeed(master, seedBase + index);
        const result = await run(seed);
        recordCoverage(result.coverage);
        recordFaultClass(result.faultClass);
        recordMergeFeatures(result.mergeFeatures);
        if (result.ok) {
          console.log(`  ${name} ok`);
          continue;
        }
        batteryFailures++;
        console.log(`  ${name} seed ${seed} FAIL: ${result.failure}`);
        console.log(`    replay: ${batteryReplay}`);
        reportArtifacts(result, batteryReplay);
      }
    };

    const witnessEntries: BatteryEntry[] = [];
    for (const key of WITNESS_SECTIONS) {
      for (const kind of WITNESS_KINDS[key]) {
        for (const mode of ["apply", "check"] as const) {
          witnessEntries.push([
            `${key}/${kind}/${mode}`,
            (seed) => witnessIteration(seed, key, kind, mode),
          ]);
        }
      }
    }
    await runBattery("witness battery (directed live-state witnesses)", 0x100000, witnessEntries);

    // The random stream covers a sparse subset of the catalog per run; this pass runs all of it, and pins
    // that every raw pool string still fails the way its pool promises (a yaml upgrade fails here, not in a nightly).
    const inputSpecs: Array<{ name: string; spec: (rng: Rng) => RejectionSpec }> = [
      ...INVALID_SETTINGS_CASES.map(({ name, build }) => ({
        name,
        spec: (rng: Rng): RejectionSpec => {
          const { doc, offendingToken } = build(rng);
          return { label: name, settings: doc, tokens: [offendingToken] };
        },
      })),
      ...UNPARSEABLE_YAML.map((raw, i) => ({
        name: `raw-unparseable-${i}`,
        spec: (): RejectionSpec => ({
          label: `raw-unparseable-${i}`,
          settingsRaw: raw,
          tokens: ["cannot read settings", "valid YAML"],
        }),
      })),
      ...NON_MAPPING_YAML.map((raw, i) => ({
        name: `raw-non-mapping-${i}`,
        spec: (): RejectionSpec => ({
          label: `raw-non-mapping-${i}`,
          settingsRaw: raw,
          tokens: ["must be a YAML mapping"],
        }),
      })),
    ];
    await runBattery(
      "input battery (directed rejection catalog)",
      0x200000,
      inputSpecs.map(({ name, spec }, index): BatteryEntry => {
        const mode = index % 2 === 0 ? ("apply" as const) : ("check" as const);
        return [
          `${name} [${mode}]`,
          (seed) => rejectionIteration(seed, { ...spec(new Rng(seed)), mode }),
        ];
      }),
    );

    await runBattery(
      "fault battery (directed transport faults, every faultable section)",
      0x300000,
      faultBatteryPlan(master).map(
        (plan): BatteryEntry => [
          `${plan.section}:${plan.kind}/x${plan.exhausting ? RETRY_BUDGET : 1} [${plan.mode}]`,
          (seed) => faultedSectionRun(seed, plan),
        ],
      ),
    );

    await runBattery(
      "unfaultable battery (declared reads stay cold in apply)",
      0x310000,
      UNFAULTABLE_SECTIONS.map(
        (section): BatteryEntry => [section, (seed) => unfaultableSectionRun(seed, section)],
      ),
    );

    await runBattery("core-fault battery (directed core-path faults)", 0x400000, [
      ["core.contentsGet/fatal", contentsFaultBatteryRun],
      ["core.discoveryList/fatal", discoveryFaultBatteryRun],
      ["core.issuesList/degrade", reportFaultBatteryRun],
      ["preflight/budget-consumed", (seed) => preflightFaultRun(seed, false)],
      ["preflight/budget-survives", (seed) => preflightFaultRun(seed, true)],
    ]);

    // No standard-mode entry: the witness battery's apply combos already arm apply_idempotent.
    await runBattery("fixpoint battery (directed apply-idempotence / convergence)", 0x500000, [
      ["multi/apply-idempotent", multiIdempotenceBatteryRun],
      ["discovery/converges", discoveryConvergesBatteryRun],
    ]);

    // Forced by the generator, so every refusal kind fires each soak instead of waiting on the ~1/30 random draw.
    await runBattery("merge battery (directed layered merges)", 0x600000, [
      ...(["merge", "replace"] as const).map(
        (layering): BatteryEntry => [
          `merge/valid/${layering}`,
          (seed) => mergeValidBatteryRun(seed, layering),
        ],
      ),
      ...MERGE_REFUSAL_KINDS.map(
        (refusal): BatteryEntry => [
          `merge/refused/${refusal}`,
          (seed) => mergeFuzzIteration(seed, { force: { kind: "refused", refusal } }),
        ],
      ),
    ]);
  }

  console.log("\ncoverage (sections exercised):");
  for (const key of [...coverage.keys()].sort()) {
    console.log(`  ${key}: ${coverage.get(key)}`);
  }
  // A standalone create needs live state the battery never seeds, so create is required only where
  // delete plus create is the drift write (no update role).
  const REQUIRED_CLASSES: Record<WitnessSection, MutationClass[]> = {
    labels: ["update", "delete", "clean"],
    autolinks: ["create", "delete", "clean"],
    milestones: ["update", "clean"],
    deploy_keys: ["create", "delete", "clean"],
  };
  console.log("\nmutation-class coverage (successful writes from the mock's request log):");
  let coverageFailures = 0;
  for (const key of WITNESS_SECTIONS) {
    const counts = mutationHistogram.get(key) ?? new Map<MutationClass, number>();
    const rendered =
      [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cls, count]) => `${cls}=${count}`)
        .join(" ") || "(none)";
    console.log(`  ${key}: ${rendered}`);
    if (replayOne) {
      continue;
    }
    const missing = REQUIRED_CLASSES[key].filter((cls) => !counts.has(cls));
    if (missing.length > 0) {
      coverageFailures++;
      console.log(
        `  ${key}: MISSING required class(es) ${missing.join(", ")} - the witness generator or the engine stopped producing real mutations`,
      );
    }
  }

  // The battery guarantees every faultable section's primary read and every kind x budget combo per soak,
  // not their cross product, so an absent class here is not by itself a failure; the histogram is the visibility.
  console.log("\nfault-class coverage (endpoint kind/verdict fired):");
  if (faultHistogram.size === 0) {
    console.log("  (none)");
  } else {
    for (const [cls, count] of [...faultHistogram.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`  ${cls}: ${count}`);
    }
  }

  // The generator test pins that every merge axis is drawn; this is the per-soak visibility.
  console.log("\nmerge-feature coverage (layered merge axes exercised):");
  if (mergeHistogram.size === 0) {
    console.log("  (none)");
  } else {
    for (const [feature, count] of [...mergeHistogram.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`  ${feature}: ${count}`);
    }
  }

  console.log("\nfixpoint-proof coverage (random stream, mode:proof):");
  if (proofCounts.size === 0) {
    console.log("  (none)");
  } else {
    for (const [key, count] of [...proofCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log(`\n${flags.iterations - failures}/${flags.iterations} iterations ok`);
  if (batteryFailures > 0) {
    console.log(
      `directed battery failures (witness + input + fault + fixpoint + merge): ${batteryFailures}`,
    );
  }
  if (failingSeeds.length > 0) {
    console.log(`failing seeds: ${failingSeeds.join(", ")}`);
    console.log(
      "replay one with the per-failure `replay:` line above (it carries --sections when set)",
    );
  }
  return failures + batteryFailures + coverageFailures > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  // The stack's first line IS the message, so deliberate errors stay readable
  // while a generator/oracle crash mid-soak gains its origin.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}

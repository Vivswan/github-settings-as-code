/**
 * The curated e2e entrypoint: `bun test/e2e/run.ts`. Exits 1 on any failure so CI gates on it.
 *
 *   --sections a,b|all   only scenarios touching one of these sections (a key of the settings, a multi
 *                        target's settings, the defaults_file, or a merge layer); default all
 *   --scenario <name>    only the scenario with this exact name
 *   --print-stdout       echo each scenario's captured stdout under its PASS or FAIL line, minus its
 *                        ::add-mask:: lines, with every masked value printed as *** (indented, the
 *                        runner registers no mask, so the echo redacts on its own); a failure's
 *                        artifact directory holds the whole of it anyway, a pass otherwise leaves no
 *                        trace of it
 *
 * An unknown flag, a stray argument, a flag without its value, or an empty section list is refused at
 * the entry with exit 2, before any scenario runs.
 */

import { parseArgs } from "node:util";
import { quote } from "../../src/text.js";
import { corpusUnwitnessedExemptEndpoints } from "./runner/apply-idempotence-proof.js";
import { indentedStdout, runScenario, type ScenarioReport } from "./runner/runner.js";
import { loadScenarios, type Scenario, scenarioRoots } from "./scenario.js";

const FLAGS = {
  sections: { type: "string" },
  scenario: { type: "string" },
  "print-stdout": { type: "boolean" },
} as const;
const USAGE = "the flags are --sections <key,key|all>, --scenario <name>, --print-stdout";

interface Flags {
  sections?: string[];
  scenario?: string;
  printStdout?: boolean;
}

type ParsedFlags = { ok: true; flags: Flags } | { ok: false; error: string };

/** parseArgs's option token, which node:util declares but does not export. */
type OptionToken = Extract<
  ReturnType<typeof parseArgs<{ tokens: true; strict: false }>>["tokens"][number],
  { kind: "option" }
>;

/** The run's result table and counts, grown one scenario at a time. */
interface Tally {
  table: string[];
  artifacts: string[];
  total: number;
  failed: number;
}

function refuse(error: string): ParsedFlags {
  return { ok: false, error: `e2e: ${error}; ${USAGE}` };
}

/** `all` clears an earlier list, so the last `--sections` wins whichever word it carries. */
function applySections(flags: Flags, value: string): string | undefined {
  if (value === "all") {
    flags.sections = undefined;
    return undefined;
  }
  const keys = value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  if (keys.length === 0) {
    return "--sections got an empty list; name at least one section, or all";
  }
  flags.sections = keys;
  return undefined;
}

/** One flag applied to `flags`, or the refusal it earns. */
function applyFlag(flags: Flags, token: OptionToken): string | undefined {
  if (!Object.hasOwn(FLAGS, token.name)) {
    return `unknown flag ${token.rawName}`;
  }
  if (token.name === "print-stdout") {
    if (token.value !== undefined) {
      return "--print-stdout takes no value";
    }
    flags.printStdout = true;
    return undefined;
  }
  if (token.value === undefined) {
    return `${token.rawName} needs a value`;
  }
  if (token.name === "scenario") {
    flags.scenario = token.value;
    return undefined;
  }
  return applySections(flags, token.value);
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const { tokens } = parseArgs({
    args: [...argv],
    options: FLAGS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const flags: Flags = {};
  for (const token of tokens) {
    if (token.kind !== "option") {
      const argument = token.kind === "positional" ? token.value : "--";
      return refuse(`unexpected argument ${quote(argument)}`);
    }
    const problem = applyFlag(flags, token);
    if (problem !== undefined) {
      return refuse(problem);
    }
  }
  return { ok: true, flags };
}

/**
 * A multi scenario declares sections per target, a merge one may declare a section only in a lower
 * layer, and a snapshot one declares none (its pinned documents and `sections` allowlist name them),
 * so filtering on settings alone would drop all three.
 */
function scenarioSections(scenario: Scenario): Set<string> {
  const keys = new Set<string>(Object.keys(scenario.settings ?? {}));
  for (const key of (scenario.inputs?.sections ?? "").split(",")) {
    if (key.trim() !== "") {
      keys.add(key.trim());
    }
  }
  const docs: Array<Record<string, unknown> | undefined> = [
    scenario.defaults_file,
    ...(scenario.settings_layers ?? []),
    scenario.expect.snapshot,
  ];
  for (const spec of Object.values(scenario.repos ?? {})) {
    docs.push(spec.settings ?? undefined, spec.expect?.snapshot);
  }
  for (const doc of docs) {
    for (const key of Object.keys(doc ?? {})) {
      keys.add(key);
    }
  }
  return keys;
}

function selectScenarios(all: Scenario[], flags: Flags): Scenario[] {
  let selected = all;
  if (flags.scenario) {
    selected = selected.filter((s) => s.name === flags.scenario);
  }
  if (flags.sections) {
    const wanted = new Set(flags.sections);
    selected = selected.filter((s) => {
      for (const key of scenarioSections(s)) {
        if (wanted.has(key)) {
          return true;
        }
      }
      return false;
    });
  }
  return selected;
}

/**
 * A filter that matches nothing is a broken filter (a typo'd name or a section no scenario touches), not a
 * green run. An unreadable root already failed in loadScenarios, so an unfiltered empty corpus is genuinely
 * empty: exit 0, the line is the signal.
 */
function reportEmptySelection(flags: Flags, all: Scenario[], roots: string[]): number {
  if (flags.sections || flags.scenario) {
    const filters = [
      flags.scenario === undefined ? [] : [`--scenario "${flags.scenario}"`],
      flags.sections === undefined ? [] : [`--sections "${flags.sections.join(",")}"`],
    ].flat();
    console.error(
      `none of the ${all.length} scenario(s) under ${roots.join(", ")} match ${filters.join(" / ")}; check the value against the scenario files' name: fields (or their settings keys for --sections)`,
    );
    return 1;
  }
  console.log(`no scenario .yml files found under ${roots.join(", ")}`);
  return 0;
}

/** --print-stdout: the scenario's captured stdout under its line, redacted by indentedStdout; nothing when it is empty. */
function echoStdout(report: ScenarioReport, flags: Flags): void {
  if (!flags.printStdout) {
    return;
  }
  const stdout = indentedStdout(report.stdout);
  if (stdout !== "") {
    console.log(stdout);
  }
}

async function runSelected(scenarios: Scenario[], flags: Flags): Promise<Tally> {
  const tally: Tally = { table: [], artifacts: [], total: scenarios.length, failed: 0 };
  for (const scenario of scenarios) {
    const started = Date.now();
    const report = await runScenario(scenario);
    const ms = Date.now() - started;
    if (report.ok) {
      console.log(`  PASS  ${scenario.name} (${ms}ms)`);
      tally.table.push(`  PASS  ${scenario.name}`);
    } else {
      tally.failed++;
      console.log(`  FAIL  ${scenario.name} (${ms}ms)`);
      tally.table.push(`  FAIL  ${scenario.name}`);
      for (const failure of report.failures) {
        tally.table.push(`          ${failure.replace(/\n/g, "\n          ")}`);
      }
      if (report.artifactDir) {
        tally.artifacts.push(report.artifactDir);
      }
    }
    echoStdout(report, flags);
  }
  return tally;
}

/**
 * The corpus witness is meaningful over the FULL corpus only: a --sections/--scenario slice can
 * legitimately starve an exempt endpoint. Its own line keeps the tally honest.
 */
function addCorpusWitness(tally: Tally): void {
  tally.total++;
  const unwitnessed = corpusUnwitnessedExemptEndpoints();
  if (unwitnessed.length > 0) {
    tally.failed++;
    tally.table.push("  FAIL  apply-idempotence corpus witness");
    for (const failure of unwitnessed) {
      tally.table.push(`          ${failure}`);
    }
  } else {
    tally.table.push("  PASS  apply-idempotence corpus witness");
  }
}

async function main(): Promise<number> {
  const parsed = parseFlags(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { flags } = parsed;
  const roots = scenarioRoots();
  const all = loadScenarios(roots);
  const scenarios = selectScenarios(all, flags);
  if (scenarios.length === 0) {
    return reportEmptySelection(flags, all, roots);
  }

  const tally = await runSelected(scenarios, flags);
  if (!flags.sections && !flags.scenario) {
    addCorpusWitness(tally);
  }

  console.log(`\n${tally.table.join("\n")}`);
  console.log(`\n${tally.total - tally.failed}/${tally.total} passed`);
  if (tally.artifacts.length > 0) {
    console.log(`\nartifacts:\n  ${tally.artifacts.join("\n  ")}`);
  }
  return tally.failed > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  // The stack's first line IS the message, so deliberate errors stay readable
  // while an unexpected harness error gains its origin.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}

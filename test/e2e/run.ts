/**
 * The curated e2e entrypoint: `bun test/e2e/run.ts`. Exits 1 on any failure so CI gates on it.
 *
 *   --sections a,b|all   only scenarios touching one of these sections (a key of the settings, a multi
 *                        target's settings, the defaults_file, or a merge layer); default all
 *   --scenario <name>    only the scenario with this exact name
 */

import { corpusUnwitnessedExemptEndpoints } from "./apply-idempotence-proof.js";
import { runScenario } from "./runner.js";
import { loadScenarios, type Scenario, scenarioRoots } from "./schema.js";

interface Flags {
  sections?: string[];
  scenario?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sections") {
      const value = argv[++i] ?? "";
      if (value && value !== "all") {
        flags.sections = value.split(",").map((s) => s.trim());
      }
    } else if (arg === "--scenario") {
      flags.scenario = argv[++i];
    }
  }
  return flags;
}

/**
 * A multi scenario declares sections per target and a merge one may declare a section only in a lower
 * layer, so filtering on settings alone would drop both.
 */
function scenarioSections(scenario: Scenario): Set<string> {
  const keys = new Set<string>(Object.keys(scenario.settings ?? {}));
  for (const spec of Object.values(scenario.repos ?? {})) {
    if (spec.settings) {
      for (const key of Object.keys(spec.settings)) {
        keys.add(key);
      }
    }
  }
  for (const doc of [scenario.defaults_file ?? {}, ...(scenario.settings_layers ?? [])]) {
    for (const key of Object.keys(doc)) {
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

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const roots = scenarioRoots();
  const all = loadScenarios(roots);
  const scenarios = selectScenarios(all, flags);

  if (scenarios.length === 0) {
    if (flags.sections || flags.scenario) {
      // A filter that matches nothing is a broken filter (a typo'd name or a
      // section no scenario touches), not a green run.
      const filters = [
        flags.scenario === undefined ? [] : [`--scenario "${flags.scenario}"`],
        flags.sections === undefined ? [] : [`--sections "${flags.sections.join(",")}"`],
      ].flat();
      console.error(
        `none of the ${all.length} scenario(s) under ${roots.join(", ")} match ${filters.join(" / ")}; check the value against the scenario files' name: fields (or their settings keys for --sections)`,
      );
      return 1;
    }
    // An unreadable root already failed in loadScenarios, so an empty corpus here is genuinely empty: exit 0, the line is the signal.
    console.log(`no scenario .yml files found under ${roots.join(", ")}`);
    return 0;
  }

  const table: string[] = [];
  const artifacts: string[] = [];
  let failed = 0;
  for (const scenario of scenarios) {
    const started = Date.now();
    const report = await runScenario(scenario);
    const ms = Date.now() - started;
    if (report.ok) {
      console.log(`  PASS  ${scenario.name} (${ms}ms)`);
      table.push(`  PASS  ${scenario.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${scenario.name} (${ms}ms)`);
      table.push(`  FAIL  ${scenario.name}`);
      for (const failure of report.failures) {
        table.push(`          ${failure.replace(/\n/g, "\n          ")}`);
      }
      if (report.artifactDir) {
        artifacts.push(report.artifactDir);
      }
    }
  }

  // The corpus witness is meaningful over the FULL corpus only: a --sections/--scenario slice can
  // legitimately starve an exempt endpoint. Its own line keeps the tally honest.
  let total = scenarios.length;
  if (!flags.sections && !flags.scenario) {
    total++;
    const unwitnessed = corpusUnwitnessedExemptEndpoints();
    if (unwitnessed.length > 0) {
      failed++;
      table.push("  FAIL  apply-idempotence corpus witness");
      for (const failure of unwitnessed) {
        table.push(`          ${failure}`);
      }
    } else {
      table.push("  PASS  apply-idempotence corpus witness");
    }
  }

  console.log(`\n${table.join("\n")}`);
  console.log(`\n${total - failed}/${total} passed`);
  if (artifacts.length > 0) {
    console.log(`\nartifacts:\n  ${artifacts.join("\n  ")}`);
  }
  return failed > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  // The stack's first line IS the message, so deliberate errors stay readable
  // while an unexpected harness error gains its origin.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}

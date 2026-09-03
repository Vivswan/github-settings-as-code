/**
 * The curated e2e entrypoint: `bun test/e2e/run.ts`. Loads every scenario
 * under the scenario roots (the flat test/e2e/scenarios/ directory plus the
 * per-section src/sections/<key>/scenarios/ directories), optionally filtered
 * by --sections or --scenario, runs each against a fresh mock, prints one
 * line per scenario plus a final table, and exits 1 if any scenario failed so
 * CI gates on it.
 *
 * Flags:
 *   --sections a,b|all   run only scenarios that touch one of these sections
 *                        (a scenario touches a section when it is a top-level
 *                        key of the scenario's settings); default all
 *   --scenario <name>    run only the scenario with this exact name
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
 * Every section a scenario touches: the top-level `settings` keys plus each
 * multi-repo target's `repos.<slug>.settings` keys and the `defaults_file`
 * keys. A multi-repo scenario declares its sections per target, not at the top
 * level, so filtering on `settings` alone would drop it from a --sections run.
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
  for (const key of Object.keys(scenario.defaults_file ?? {})) {
    keys.add(key);
  }
  return keys;
}

/**
 * A scenario "touches" a section when that section appears in its settings, in
 * any multi-repo target's settings, or in its defaults file. --sections keeps
 * scenarios touching any listed section; --scenario matches an exact name.
 */
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
    // Before the corpus phase the scenarios dirs are empty; land green so the
    // script itself is not a failure.
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

  // The corpus-level witness behind the per-run exemptions, meaningful over the FULL corpus only: a
  // --sections/--scenario slice can legitimately starve an exempt endpoint. Its own line item keeps
  // the pass/fail tally honest.
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

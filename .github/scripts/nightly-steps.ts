/**
 * The nightly.yml probes against the latest upstream releases, one subcommand per step of the checks job:
 *
 *   probe-schema   @octokit/openapi and @octokit/graphql-schema at latest, then the lockstep tests
 *   probe-types    @octokit/types at latest, then the typecheck, its failures sorted into tripwires and breakage
 *
 * Each ends the night red instead of leaving a later PR to find the break.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countNoun } from "../../src/text.js";
import { planGraduation } from "./graduate-upstream-gaps.js";
import { dispatch } from "./lib/entry.js";
import { parseDiagnostics } from "./lib/tsc-diagnostics.js";
import { capture, run, status } from "./lib/workflow-step.js";

const SCHEMA_PACKAGES = ["@octokit/openapi", "@octokit/graphql-schema"] as const;
const LOCKSTEP_TESTS = [
  "test/e2e/openapi/validate.test.ts",
  "test/scripts/gen-openapi.test.ts",
  "test/sections/graphql-queries.test.ts",
] as const;

/** The version `bun add` left under the checkout's node_modules, read from the file itself: bun's resolver would
 * auto-install a package it does not find there, and that is exactly the pin this probe must not test. */
function installedVersion(pkg: string): string {
  const manifest = join(process.cwd(), "node_modules", pkg, "package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

function probeSchema(): number | undefined {
  // --no-save leaves package.json and the lockfile untouched; the upgraded node_modules stays ambient for the
  // rest of the job.
  run([
    "bun",
    "add",
    "--no-save",
    "--ignore-scripts",
    ...SCHEMA_PACKAGES.map((pkg) => `${pkg}@latest`),
  ]);
  // A pinned version left in place would make this probe pass green forever without probing anything.
  for (const pkg of SCHEMA_PACKAGES) {
    const installed = installedVersion(pkg);
    const latest = capture(["bun", "info", pkg, "version"]);
    if (installed !== latest) {
      console.log(
        `::error::${pkg}@${installed} is installed but ${latest} is the latest; the probe is testing the pin`,
      );
      return 1;
    }
    console.log(`${pkg}@${installed}`);
  }
  run(["bun", "test", ...LOCKSTEP_TESTS]);
}

/** The typecheck's verdict with its stdout and stderr in arrival order, read back from the one file both went to. */
function typecheck(): { clean: boolean; log: string } {
  const scratch = mkdtempSync(join(tmpdir(), "nightly-typecheck-"));
  try {
    const file = join(scratch, "typecheck.log");
    // --pretty false keeps the one-error-per-line format parseDiagnostics reads, independent of tsc's TTY detection.
    const code = status(["bun", "run", "typecheck", "--pretty", "false"], {
      stdoutFile: file,
      stderrToo: true,
    });
    return { clean: code === 0, log: readFileSync(file, "utf8") };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function probeTypes(): number | undefined {
  run(["bun", "add", "--no-save", "--ignore-scripts", "@octokit/types@latest"]);
  const { clean, log } = typecheck();
  if (clean) {
    console.log("typecheck is clean against @octokit/types@latest");
    return;
  }
  // The graduate script's own reading of the log, so the two agree on which files are tripwires. bun's own lines
  // (`$ bun x tsc ...`, the exit-code line) ride in the merged log and parse as nothing.
  const { gapFiles, foreign } = planGraduation(parseDiagnostics(log).diagnostics);
  const report: string[] = [];
  if (gapFiles.length > 0) {
    report.push(
      "::error::@octokit/types@latest fires upstream-gap tripwires; run bun .github/scripts/graduate-upstream-gaps.ts for these files:",
      ...gapFiles,
    );
  }
  if (foreign.length > 0) {
    const count = countNoun(foreign.length, "diagnostic", "diagnostics");
    report.push(
      `::error::typecheck against @octokit/types@latest failed outside the upstream-gap tripwires (${count}); ` +
        "a types major may have broken the build (see log above)",
    );
  }
  if (report.length === 0) {
    report.push(
      "::error::typecheck against @octokit/types@latest failed without a diagnostic this probe can read (see log above)",
    );
  }
  process.stdout.write(`${log}${report.join("\n")}\n`);
  return 1;
}

if (import.meta.main) {
  await dispatch(
    "nightly-steps",
    { "probe-schema": probeSchema, "probe-types": probeTypes },
    process.argv.slice(2),
  );
}

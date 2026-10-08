/**
 * The nightly.yml steps against the latest upstream releases, one subcommand each:
 *
 *   probe-schema     checks job     @octokit/openapi and @octokit/graphql-schema at latest, then the lockstep tests
 *   probe-types      checks job     @octokit/types and @octokit/openapi-types at latest, then the typecheck, its
 *                                   failures sorted into tripwires and breakage
 *   refresh-openapi  refresh job    a newer @octokit/openapi pinned, the descriptor-derived files regenerated and
 *                                   committed, the whole gate run, and the bump PR opened when it passes
 *
 * The probed packages are the ones that describe GitHub's API; the runtime octokit client packages stay out on
 * purpose. The probes end the night red instead of leaving a later PR to find the break; the refresh opens the PR
 * that turns the night green again.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { countNoun } from "../../src/text.js";
import { GENERATED_OUTPUTS } from "./generated.js";
import { planGraduation } from "./graduate-upstream-gaps.js";
import { dispatch } from "./lib/entry.js";
import { configureBotIdentity, leasePush } from "./lib/pr-branch.js";
import { parseDiagnostics } from "./lib/tsc-diagnostics.js";
import { capture, requireEnv, run, status } from "./lib/workflow-step.js";

const SCHEMA_PACKAGES = ["@octokit/openapi", "@octokit/graphql-schema"] as const;
const TYPES_PACKAGES = ["@octokit/types", "@octokit/openapi-types"] as const;
/** Both named in every typecheck verdict: a diagnostic from either release reads the same in the log. */
const TYPES_LATEST = TYPES_PACKAGES.map((pkg) => `${pkg}@latest`).join(" and ");
const LOCKSTEP_TESTS = [
  "test/e2e/openapi/validate.test.ts",
  "test/e2e/openapi/vocabulary-lockstep.test.ts",
  "test/scripts/gen-openapi.test.ts",
  "test/sections/graphql-queries.test.ts",
] as const;

/** The version `bun add` left under the checkout's node_modules, read from the file itself: bun's resolver would
 * auto-install a package it does not find there, and that is exactly the pin this probe must not test. */
function installedVersion(pkg: string): string {
  const manifest = join(process.cwd(), "node_modules", pkg, "package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

/** --no-save leaves package.json and the lockfile untouched; the upgraded node_modules stays ambient for the rest
 * of the job. */
function installLatest(packages: readonly string[]): number | undefined {
  run(["bun", "add", "--no-save", "--ignore-scripts", ...packages.map((pkg) => `${pkg}@latest`)]);
  // A pinned version left in place would make a probe pass green forever without probing anything.
  for (const pkg of packages) {
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
}

function probeSchema(): number | undefined {
  const failed = installLatest(SCHEMA_PACKAGES);
  if (failed !== undefined) {
    return failed;
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
  const failed = installLatest(TYPES_PACKAGES);
  if (failed !== undefined) {
    return failed;
  }
  const { clean, log } = typecheck();
  if (clean) {
    console.log(`typecheck is clean against ${TYPES_LATEST}`);
    return;
  }
  // The graduate script's own reading of the log, so the two agree on which files are tripwires. bun's own lines
  // (`$ bun x tsc ...`, the exit-code line) ride in the merged log and parse as nothing.
  const { gapFiles, foreign } = planGraduation(parseDiagnostics(log).diagnostics);
  process.stdout.write(log);
  if (gapFiles.length > 0) {
    console.log(
      `::error::${TYPES_LATEST} fire upstream-gap tripwires; run bun .github/scripts/graduate-upstream-gaps.ts for these files:`,
    );
    for (const file of gapFiles) {
      console.log(file);
    }
  }
  if (foreign.length > 0) {
    const count = countNoun(foreign.length, "diagnostic", "diagnostics");
    console.log(
      `::error::typecheck against ${TYPES_LATEST} failed outside the upstream-gap tripwires (${count}); ` +
        "a types major may have broken the build (see log above)",
    );
  }
  if (gapFiles.length === 0 && foreign.length === 0) {
    console.log(
      `::error::typecheck against ${TYPES_LATEST} failed without a diagnostic this probe can read (see log above)`,
    );
  }
  return 1;
}

const OPENAPI = "@octokit/openapi";
const OPENAPI_GENERATOR = "build:openapi";
/** The exact pin in the checkout's package.json (test/config/package-pins.test.ts keeps every pin exact). */
function pinnedVersion(pkg: string): string {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return manifest.devDependencies?.[pkg] ?? "";
}

/** The bump PR's body, in the shape the repository's PRs take; `changed` is git's own stat of the commit. */
function bumpBody(from: string, to: string, changed: string): string {
  return [
    "## What this adds",
    "",
    "```text",
    `before: ${OPENAPI} ${from} pinned, ${to} released`,
    `after:  ${OPENAPI} ${to} pinned -> bun run ${OPENAPI_GENERATOR} -> the descriptor-derived files regenerated`,
    "```",
    "",
    "```text",
    "$ git diff --cached --stat",
    changed,
    "```",
    "",
    "## How",
    "",
    "- **The nightly moved the pin** with `bun add --exact`, regenerated the descriptor-derived files, and rebuilt the schema.",
    "- **The full gate passed on this commit** before it was pushed.",
    "- **Library:** none added; the generator and its tests are the repository's own.",
    "",
    "## Proof",
    "",
    `- **Gates:** \`bun run check\` green against ${to} before the push; this PR's CI judges the merge.`,
    "",
  ].join("\n");
}

function refreshOpenapi(): number | undefined {
  const pinned = pinnedVersion(OPENAPI);
  const latest = capture(["bun", "info", OPENAPI, "version"]);
  if (pinned === latest) {
    console.log(`${OPENAPI}@${pinned} is the latest; nothing to bump`);
    return;
  }
  // A registry tag rolled back behind the pin would otherwise read as a release and open a downgrade PR.
  if (Bun.semver.order(latest, pinned) < 0) {
    console.log(
      `::notice::${OPENAPI}@${pinned} is ahead of the registry's latest ${latest}; nothing to bump`,
    );
    return;
  }
  const branch = `nightly/openapi-${latest}`;
  // The PR is the postcondition, not the branch: a night whose push landed but whose gh call failed leaves the
  // branch alone, and the next night must not read that as done. --head matches a fork's branch of the same name
  // too, so only this repository's PRs count.
  const open = capture([
    "gh",
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "isCrossRepository",
    "--jq",
    "[.[] | select(.isCrossRepository | not)] | length",
  ]);
  if (open !== "0") {
    console.log(`::notice::the bump PR for ${OPENAPI}@${latest} is already open from ${branch}`);
    return;
  }
  // --ignore-scripts: the install under the write token runs no lifecycle script; the checkout is the default
  // branch's, so the manifest it reads is main's own.
  run(["bun", "add", "-d", "--exact", "--ignore-scripts", `${OPENAPI}@${latest}`]);
  run(["bun", "run", OPENAPI_GENERATOR]);
  run(["bun", "run", "build:schema"]);
  const generated = GENERATED_OUTPUTS.filter((output) => output.generator === OPENAPI_GENERATOR);
  run(["git", "add", "--", "package.json", "bun.lock", ...generated.map((output) => output.path)]);
  const changed = capture(["git", "diff", "--cached", "--stat"]);
  configureBotIdentity();
  const subject = `build(deps): bump ${OPENAPI} to ${latest}`;
  run(["git", "commit", "--no-verify", "-m", subject]);
  // The whole gate, on the committed bump (build:check compares the generated files against the index): bump nights
  // are rare and the minutes free, so the PR arrives green and a red night names the command in the log above.
  if (status(["bun", "run", "check"]) !== 0) {
    console.log(
      `::error::bun run check fails against ${OPENAPI}@${latest}; the log above names the failing script, and nothing was pushed`,
    );
    return 1;
  }
  const token = requireEnv("TOKEN");
  const canRetrigger = requireEnv("CAN_RETRIGGER");
  // An empty lease: the branch must not exist, so two runs racing for one night cannot push over each other, and
  // a branch a failed gh call stranded is never rewritten. Which of the two refused is read afresh: ls-remote
  // answers 0 for a present ref and 2 for an absent one.
  if (leasePush(branch, "", token) !== 0) {
    const present = status(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], {
      stdoutFile: devNull,
    });
    console.log(
      present === 0
        ? `::error::${branch} exists on origin with no open PR; open the PR from it or delete the branch, and the next night retries`
        : `::error::the push to ${branch} failed (see above); nothing was opened`,
    );
    return 1;
  }
  run([
    "gh",
    "pr",
    "create",
    "--draft",
    "--head",
    branch,
    "--title",
    subject,
    "--body",
    bumpBody(pinned, latest, changed),
  ]);
  if (canRetrigger === "true") {
    return;
  }
  console.log(
    `::warning::${branch} was pushed with github.token, which starts no workflows; ` +
      "close and reopen the bump PR to run its checks, or register REPO_PLATFORM_TOKEN",
  );
}

if (import.meta.main) {
  await dispatch(
    "nightly-steps",
    {
      "probe-schema": probeSchema,
      "probe-types": probeTypes,
      "refresh-openapi": refreshOpenapi,
    },
    process.argv.slice(2),
  );
}

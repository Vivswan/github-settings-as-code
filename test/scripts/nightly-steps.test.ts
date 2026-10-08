/**
 * nightly.yml's steps with a scripted bun and gh in place of the real ones (an install from the registry or a PR
 * on GitHub has no place in a unit test): what each probe does with the versions it finds and with tsc's output,
 * and what the refresh pushes to a fixture origin, which the workflow text cannot show.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withTempDir } from "../temp-dir.js";
import {
  clone,
  commitAll,
  type Fixture,
  git,
  installReleasePipelineFixture,
  seedFixture,
  write,
} from "./release-pipeline-fixture.js";
import { runStep } from "./step-fixture.js";

setDefaultTimeout(60_000);
installReleasePipelineFixture();

interface Plan {
  /** `bun add` fails with this status instead of installing. */
  addStatus?: number;
  /** What `bun add` installs under node_modules, by package. */
  installed?: Record<string, string>;
  /** What `bun info <pkg> version` prints, by package. */
  latest?: Record<string, string>;
  /** `bun run typecheck`'s stdout, stderr, and status. */
  typecheck?: { stdout: string; stderr?: string; status: number };
  /** `bun run check`'s status; passes when unplanned. */
  checkStatus?: number;
  /** How many open bump PRs `gh pr list` reports; none when unplanned. */
  openPrs?: number;
  /** What `bun run build:openapi` writes into the checkout, by path. */
  generated?: Record<string, string>;
}

/** The scripted bun: every call logged; `add @pkg@latest` writes the planned package.json under node_modules (or
 * fails as planned) and `add -d --exact @pkg@version` moves the checkout's pin and touches bun.lock as bun would;
 * `info` answers the planned latest; `test` exits as planned; `run typecheck` replays the planned typecheck and
 * `run build:openapi` writes the planned generated files. */
const SHIM = `#!/bin/sh
plan="$NIGHTLY_PLAN"
printf '%s\\n' "$*" >> "$plan/calls.log"
case "$1" in
  add)
    if [ -f "$plan/add.status" ]; then exit "$(cat "$plan/add.status")"; fi
    for spec in "$@"; do
      case "$spec" in
        @*@latest)
          name="\${spec%@latest}"
          mkdir -p "node_modules/$name"
          printf '{"name":"%s","version":"%s"}\\n' "$name" "$(cat "$plan/installed/$name")" > "node_modules/$name/package.json" ;;
        @*@*)
          name="\${spec%@*}"
          version="\${spec##*@}"
          printf '{"devDependencies":{"%s":"%s"}}\\n' "$name" "$version" > package.json
          printf 'lockfile for %s\\n' "$spec" > bun.lock ;;
      esac
    done ;;
  info) cat "$plan/latest/$2" ;;
  test) exit 0 ;;
  run)
    case "$2" in
      typecheck)
        cat "$plan/typecheck.stdout"
        cat "$plan/typecheck.stderr" >&2
        exit "$(cat "$plan/typecheck.status")" ;;
      build:openapi)
        if [ -d "$plan/generated" ]; then cp -R "$plan/generated/." . ; fi ;;
      check) if [ -f "$plan/check.status" ]; then exit "$(cat "$plan/check.status")"; fi ;;
    esac ;;
esac
`;

/** The scripted gh: every call logged, `pr list` answers the planned count of open bump PRs, nothing created. */
const GH_SHIM = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$NIGHTLY_PLAN/calls.log"
if [ "$1 $2" = "pr list" ]; then
  if [ -f "$NIGHTLY_PLAN/open-prs" ]; then cat "$NIGHTLY_PLAN/open-prs"; else echo 0; fi
fi
`;

type Subcommand = "probe-schema" | "probe-types" | "refresh-openapi";

function probe(
  dir: string,
  plan: Plan,
  step: Subcommand,
  checkout = join(dir, "checkout"),
  env: Record<string, string> = {},
) {
  const shimDir = join(dir, "shim");
  const planDir = join(dir, "plan");
  for (const sub of [shimDir, planDir, checkout]) {
    mkdirSync(sub, { recursive: true });
  }
  writeFileSync(join(shimDir, "bun"), SHIM, { mode: 0o755 });
  writeFileSync(join(shimDir, "gh"), GH_SHIM, { mode: 0o755 });
  if (plan.checkStatus !== undefined) {
    writeFileSync(join(planDir, "check.status"), `${plan.checkStatus}\n`);
  }
  if (plan.openPrs !== undefined) {
    writeFileSync(join(planDir, "open-prs"), `${plan.openPrs}\n`);
  }
  for (const [path, content] of Object.entries(plan.generated ?? {})) {
    mkdirSync(dirname(join(planDir, "generated", path)), { recursive: true });
    writeFileSync(join(planDir, "generated", path), content);
  }
  if (plan.addStatus !== undefined) {
    writeFileSync(join(planDir, "add.status"), `${plan.addStatus}\n`);
  }
  for (const [kind, versions] of [
    ["installed", plan.installed ?? {}],
    ["latest", plan.latest ?? {}],
  ] as const) {
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(dirname(join(planDir, kind, name)), { recursive: true });
      writeFileSync(join(planDir, kind, name), `${version}\n`);
    }
  }
  if (plan.typecheck !== undefined) {
    writeFileSync(join(planDir, "typecheck.stdout"), plan.typecheck.stdout);
    writeFileSync(join(planDir, "typecheck.stderr"), plan.typecheck.stderr ?? "");
    writeFileSync(join(planDir, "typecheck.status"), `${plan.typecheck.status}\n`);
  }
  const result = runStep(
    "nightly-steps",
    checkout,
    join(dir, "runner-temp"),
    { PATH: `${shimDir}:${process.env.PATH ?? ""}`, NIGHTLY_PLAN: planDir, ...env },
    step,
  );
  const log = join(planDir, "calls.log");
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { ...result, calls };
}

const SCHEMA_ADD =
  "add --no-save --ignore-scripts @octokit/openapi@latest @octokit/graphql-schema@latest";
const LOCKSTEP_TESTS = [
  "test",
  "test/e2e/openapi/validate.test.ts",
  "test/e2e/openapi/vocabulary-lockstep.test.ts",
  "test/scripts/gen-openapi.test.ts",
  "test/sections/graphql-queries.test.ts",
].join(" ");

describe("probe-schema", () => {
  test("both packages at their latest: each is reported and the lockstep tests run", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(
        dir,
        {
          installed: { "@octokit/openapi": "20.1.0", "@octokit/graphql-schema": "15.26.0" },
          latest: { "@octokit/openapi": "20.1.0", "@octokit/graphql-schema": "15.26.0" },
        },
        "probe-schema",
      );
      expect(result).toMatchObject({
        status: 0,
        stdout: "@octokit/openapi@20.1.0\n@octokit/graphql-schema@15.26.0\n",
        calls: [
          SCHEMA_ADD,
          "info @octokit/openapi version",
          "info @octokit/graphql-schema version",
          LOCKSTEP_TESTS,
        ],
      });
    }));

  test("a package the install left behind its latest fails the probe naming both versions, before the tests run", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(
        dir,
        {
          installed: { "@octokit/openapi": "20.1.0", "@octokit/graphql-schema": "15.25.0" },
          latest: { "@octokit/openapi": "20.1.0", "@octokit/graphql-schema": "15.26.0" },
        },
        "probe-schema",
      );
      expect(result).toMatchObject({
        status: 1,
        stdout:
          "@octokit/openapi@20.1.0\n::error::@octokit/graphql-schema@15.25.0 is installed but 15.26.0 is the latest; the probe is testing the pin\n",
        calls: [
          SCHEMA_ADD,
          "info @octokit/openapi version",
          "info @octokit/graphql-schema version",
        ],
      });
    }));

  test("a failing install ends the probe with its status", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(dir, { addStatus: 7 }, "probe-schema");
      expect(result).toMatchObject({ status: 7, stdout: "", calls: [SCHEMA_ADD] });
    }));
});

const TYPES_ADD =
  "add --no-save --ignore-scripts @octokit/types@latest @octokit/openapi-types@latest";
const TYPES_INFO = ["info @octokit/types version", "info @octokit/openapi-types version"];
const TYPES_LATEST = { "@octokit/types": "16.0.0", "@octokit/openapi-types": "29.0.1" };
const TYPES_LINES = "@octokit/types@16.0.0\n@octokit/openapi-types@29.0.1\n";
const TYPECHECK = "run typecheck --pretty false";
const TRIPWIRE_HINT =
  "::error::@octokit/types@latest and @octokit/openapi-types@latest fire upstream-gap tripwires; " +
  "run bun .github/scripts/graduate-upstream-gaps.ts for these files:";
const breakage = (count: string) =>
  `::error::typecheck against @octokit/types@latest and @octokit/openapi-types@latest failed outside the upstream-gap tripwires (${count}); ` +
  "a types major may have broken the build (see log above)";

describe("probe-types", () => {
  test("a clean typecheck passes, saying so", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(
        dir,
        {
          installed: TYPES_LATEST,
          latest: TYPES_LATEST,
          typecheck: { stdout: "", stderr: "$ bun x tsc -p . --pretty false\n", status: 0 },
        },
        "probe-types",
      );
      expect(result).toMatchObject({
        status: 0,
        stdout: `${TYPES_LINES}typecheck is clean against @octokit/types@latest and @octokit/openapi-types@latest\n`,
        calls: [TYPES_ADD, ...TYPES_INFO, TYPECHECK],
      });
    }));

  test("a types package the install left behind its latest fails the probe naming both versions, before the typecheck", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(
        dir,
        {
          installed: { ...TYPES_LATEST, "@octokit/openapi-types": "29.0.0" },
          latest: TYPES_LATEST,
          typecheck: { stdout: "", status: 0 },
        },
        "probe-types",
      );
      expect(result).toMatchObject({
        status: 1,
        stdout:
          "@octokit/types@16.0.0\n::error::@octokit/openapi-types@29.0.0 is installed but 29.0.1 is the latest; the probe is testing the pin\n",
        calls: [TYPES_ADD, ...TYPES_INFO],
      });
    }));

  // The graduate script's own reading of the log: its gap files are the tripwires, and every other diagnostic is
  // breakage it refuses to run over.
  test.each<[label: string, stdout: string[], report: string[]]>([
    [
      "tripped gap files are listed sorted and deduplicated; a TS2344 elsewhere and another code inside a gap file are breakage",
      [
        "src/upstream-gaps/b.ts(12,3): error TS2344: Type 'X' does not satisfy the constraint 'never'.",
        "src/upstream-gaps/a.ts(4,1): error TS2344: Type 'Y' does not satisfy the constraint 'never'.",
        "src/upstream-gaps/a.ts(9,1): error TS2344: Type 'Z' does not satisfy the constraint 'never'.",
        "src/sections/labels/plan.ts(3,3): error TS2344: Type 'W' does not satisfy the constraint 'never'.",
        "src/upstream-gaps/c.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
      [
        TRIPWIRE_HINT,
        "src/upstream-gaps/a.ts",
        "src/upstream-gaps/b.ts",
        breakage("2 diagnostics"),
      ],
    ],
    [
      "a TS2344 in gap.ts is the machinery breaking, not a gap to graduate, and a chained error under node_modules is one diagnostic",
      [
        "src/upstream-gaps/gap.ts(40,5): error TS2344: Type 'string' does not satisfy the constraint 'never'.",
        "node_modules/@octokit/types/dist-types/generated/Endpoints.d.ts(8,3): error TS2322: Type 'A' is not assignable to type 'B'.",
        "  Types of property 'parameters' are incompatible.",
      ],
      [breakage("2 diagnostics")],
    ],
    [
      "a failure outside src/upstream-gaps/ is breakage",
      ["src/main.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'."],
      [breakage("1 diagnostic")],
    ],
    [
      "a failure that prints no located diagnostic is reported as unreadable, not as breakage",
      ["error TS5112: Option 'project' cannot be mixed with source files on a command line."],
      [
        "::error::typecheck against @octokit/types@latest and @octokit/openapi-types@latest failed " +
          "without a diagnostic this probe can read (see log above)",
      ],
    ],
  ])("%s", (_label, stdout, report) =>
    withTempDir("nightly-steps-", (dir) => {
      const log = `${stdout.join("\n")}\n`;
      const stderr = 'error: script "typecheck" exited with code 2\n';
      const result = probe(
        dir,
        {
          installed: TYPES_LATEST,
          latest: TYPES_LATEST,
          typecheck: { stdout: log, stderr, status: 2 },
        },
        "probe-types",
      );
      expect(result).toMatchObject({
        status: 1,
        stdout: `${TYPES_LINES}${log}${stderr}${report.join("\n")}\n`,
        calls: [TYPES_ADD, ...TYPES_INFO, TYPECHECK],
      });
    }),
  );
});

const OPENAPI_PIN = "24.0.0";
const REMOTE_URL = "https://x-access-token:t0ken@github.com/o/r.git";
const PR_LIST =
  "gh pr list --head nightly/openapi-25.0.0 --state open --json isCrossRepository --jq [.[] | select(.isCrossRepository | not)] | length";
/** What the regeneration writes; the checkout starts with each at an older spelling. */
const GENERATED = {
  "src/sections/shared/spec-roles.ts": "export const INVITATION_ROLES = new Set(['read']);\n",
  "src/sections/rulesets/spec-rules.ts": "export const SPEC_RULES = ['creation', 'update'];\n",
};
const OLDER = {
  "src/sections/shared/spec-roles.ts":
    "export const INVITATION_ROLES = new Set(['read', 'write']);\n",
  "src/sections/rulesets/spec-rules.ts": "export const SPEC_RULES = ['creation'];\n",
};

/** The nightly's checkout: main at a package.json pinning @octokit/openapi, with the generated files committed, and
 * the lease push's github.com URL answered by the fixture origin. */
function nightlyCheckout(): { fx: Fixture; checkout: string } {
  const fx = seedFixture();
  const checkout = clone(fx.root, fx.origin, "checkout");
  write(
    checkout,
    "package.json",
    `${JSON.stringify({ devDependencies: { "@octokit/openapi": OPENAPI_PIN } }, null, 2)}\n`,
  );
  write(checkout, "bun.lock", "lockfile for @octokit/openapi@24.0.0\n");
  for (const [path, content] of Object.entries(OLDER)) {
    write(checkout, path, content);
  }
  commitAll(checkout, "chore: pin the descriptor");
  git(checkout, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  git(checkout, "config", `url.${fx.origin}.insteadOf`, REMOTE_URL);
  return { fx, checkout };
}

const REFRESH_ENV = { TOKEN: "t0ken", CAN_RETRIGGER: "true", GITHUB_REPOSITORY: "o/r" };
const refresh = (dir: string, plan: Plan, checkout: string, env: Record<string, string> = {}) =>
  probe(dir, plan, "refresh-openapi", checkout, { ...REFRESH_ENV, ...env });
const BUMP_BRANCH = "refs/heads/nightly/openapi-25.0.0";
const branchTip = (fx: Fixture) => git(fx.origin, "rev-parse", "--verify", "--quiet", BUMP_BRANCH);

describe("refresh-openapi", () => {
  test("a pin already at the latest ends after the version read, pushing nothing", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const result = refresh(dir, { latest: { "@octokit/openapi": OPENAPI_PIN } }, checkout);
      expect(result).toMatchObject({
        status: 0,
        stdout: "@octokit/openapi@24.0.0 is the latest; nothing to bump\n",
        calls: ["info @octokit/openapi version"],
      });
      expect(() => branchTip(fx)).toThrow();
    }));

  test("a registry latest behind the pin (a rolled-back tag) is no release: a notice, no install, no push", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const result = refresh(dir, { latest: { "@octokit/openapi": "23.9.0" } }, checkout);
      expect(result).toMatchObject({
        status: 0,
        stdout:
          "::notice::@octokit/openapi@24.0.0 is ahead of the registry's latest 23.9.0; nothing to bump\n",
        calls: ["info @octokit/openapi version"],
      });
      expect(() => branchTip(fx)).toThrow();
    }));

  test("an open bump PR is yesterday's: a notice, no install, no push", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const earlier = git(checkout, "rev-parse", "HEAD");
      git(checkout, "push", "--quiet", "origin", `HEAD:${BUMP_BRANCH}`);
      const result = refresh(
        dir,
        { latest: { "@octokit/openapi": "25.0.0" }, openPrs: 1 },
        checkout,
      );
      expect(result).toMatchObject({
        status: 0,
        stdout:
          "::notice::the bump PR for @octokit/openapi@25.0.0 is already open from nightly/openapi-25.0.0\n",
        calls: ["info @octokit/openapi version", PR_LIST],
      });
      expect(branchTip(fx)).toBe(earlier);
    }));

  test("a bump branch with no open PR (a night whose gh call failed) is named and left alone, not rewritten or read as done", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const stranded = git(checkout, "rev-parse", "HEAD");
      git(checkout, "push", "--quiet", "origin", `HEAD:${BUMP_BRANCH}`);
      const result = refresh(
        dir,
        { latest: { "@octokit/openapi": "25.0.0" }, generated: GENERATED },
        checkout,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toEndWith(
        "::error::nightly/openapi-25.0.0 exists on origin with no open PR; open the PR from it or delete the branch, and the next night retries\n",
      );
      expect(result.calls.filter((call) => call.startsWith("gh "))).toEqual([PR_LIST]);
      expect(branchTip(fx)).toBe(stranded);
    }));

  test("a release the full gate rejects ends red naming the gate, after the commit and before any push", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const result = refresh(
        dir,
        { latest: { "@octokit/openapi": "25.0.0" }, checkStatus: 1, generated: GENERATED },
        checkout,
      );
      expect(result).toMatchObject({
        status: 1,
        calls: [
          "info @octokit/openapi version",
          PR_LIST,
          "add -d --exact --ignore-scripts @octokit/openapi@25.0.0",
          "run build:openapi",
          "run build:schema",
          "run check",
        ],
      });
      // git's own commit summary precedes the verdict: the bump is committed, so the gate judged the committed
      // files, and the commit stayed local.
      expect(result.stdout).toEndWith(
        "::error::bun run check fails against @octokit/openapi@25.0.0; the log above names the failing script, and nothing was pushed\n",
      );
      expect(git(checkout, "log", "-1", "--format=%s")).toBe(
        "build(deps): bump @octokit/openapi to 25.0.0",
      );
      expect(() => branchTip(fx)).toThrow();
    }));

  test("a release the tests accept lands as one bot commit over the pin, the lockfile, and the regenerated files, and gh opens the draft", () =>
    withTempDir("nightly-steps-", (dir) => {
      const { fx, checkout } = nightlyCheckout();
      const main = git(checkout, "rev-parse", "HEAD");
      const result = refresh(
        dir,
        { latest: { "@octokit/openapi": "25.0.0" }, generated: GENERATED },
        checkout,
        { CAN_RETRIGGER: "false" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toEndWith(
        [
          "::warning::nightly/openapi-25.0.0 was pushed with github.token, which starts no workflows; ",
          "close and reopen the bump PR to run its checks, or register REPO_PLATFORM_TOKEN\n",
        ].join(""),
      );
      const tip = branchTip(fx);
      expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(main);
      expect(git(fx.origin, "log", "-1", "--format=%s%n%an <%ae>", tip)).toBe(
        "build(deps): bump @octokit/openapi to 25.0.0\ngithub-actions[bot] <github-actions[bot]@users.noreply.github.com>",
      );
      expect(git(fx.origin, "diff", "--name-only", main, tip).split("\n").sort()).toEqual([
        "bun.lock",
        "package.json",
        "src/sections/rulesets/spec-rules.ts",
        "src/sections/shared/spec-roles.ts",
      ]);
      expect(git(fx.origin, "show", `${tip}:package.json`)).toBe(
        '{"devDependencies":{"@octokit/openapi":"25.0.0"}}',
      );
      for (const [path, content] of Object.entries(GENERATED)) {
        expect(git(fx.origin, "show", `${tip}:${path}`)).toBe(content.trimEnd());
      }
      // The body rides in the gh call's last argument, newlines and all, so the log reads as one text.
      const log = result.calls.join("\n");
      expect(log).toContain(
        "gh pr create --draft --head nightly/openapi-25.0.0 --title build(deps): bump @octokit/openapi to 25.0.0 --body ## What this adds",
      );
      expect(log).toContain("before: @octokit/openapi 24.0.0 pinned, 25.0.0 released");
      expect(log).toContain("src/sections/rulesets/spec-rules.ts | 2 +-");
    }));
});

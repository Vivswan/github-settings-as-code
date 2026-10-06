/**
 * nightly.yml's probes with a scripted bun in place of the real one (an install from the registry has no place in
 * a unit test): what each probe does with the versions it finds and with tsc's output, which the workflow text
 * cannot show.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withTempDir } from "../temp-dir.js";
import { runStep } from "./step-fixture.js";

setDefaultTimeout(60_000);

interface Plan {
  /** `bun add` fails with this status instead of installing. */
  addStatus?: number;
  /** What `bun add` installs under node_modules, by package. */
  installed?: Record<string, string>;
  /** What `bun info <pkg> version` prints, by package. */
  latest?: Record<string, string>;
  /** `bun run typecheck`'s stdout, stderr, and status. */
  typecheck?: { stdout: string; stderr?: string; status: number };
}

/** The scripted bun: every call logged, `add` writes the planned package.json files (or fails as planned), `info`
 * answers the planned latest, `test` passes, and `run` replays the planned typecheck. */
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
      esac
    done ;;
  info) cat "$plan/latest/$2" ;;
  test) exit 0 ;;
  run)
    cat "$plan/typecheck.stdout"
    cat "$plan/typecheck.stderr" >&2
    exit "$(cat "$plan/typecheck.status")" ;;
esac
`;

function probe(dir: string, plan: Plan, step: "probe-schema" | "probe-types") {
  const shimDir = join(dir, "shim");
  const planDir = join(dir, "plan");
  const checkout = join(dir, "checkout");
  for (const sub of [shimDir, planDir, checkout]) {
    mkdirSync(sub, { recursive: true });
  }
  writeFileSync(join(shimDir, "bun"), SHIM, { mode: 0o755 });
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
    { PATH: `${shimDir}:${process.env.PATH ?? ""}`, NIGHTLY_PLAN: planDir },
    step,
  );
  const log = join(planDir, "calls.log");
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { ...result, calls };
}

const SCHEMA_ADD =
  "add --no-save --ignore-scripts @octokit/openapi@latest @octokit/graphql-schema@latest";
const LOCKSTEP_TESTS =
  "test test/e2e/openapi/validate.test.ts test/sections/graphql-queries.test.ts";

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

const TYPES_ADD = "add --no-save --ignore-scripts @octokit/types@latest";
const TYPECHECK = "run typecheck --pretty false";
const TRIPWIRE_HINT =
  "::error::@octokit/types@latest fires upstream-gap tripwires; run bun .github/scripts/graduate-upstream-gaps.ts for these files:";
const breakage = (count: string) =>
  `::error::typecheck against @octokit/types@latest failed outside the upstream-gap tripwires (${count}); ` +
  "a types major may have broken the build (see log above)";

describe("probe-types", () => {
  test("a clean typecheck passes, saying so", () =>
    withTempDir("nightly-steps-", (dir) => {
      const result = probe(
        dir,
        { typecheck: { stdout: "", stderr: "$ bun x tsc -p . --pretty false\n", status: 0 } },
        "probe-types",
      );
      expect(result).toMatchObject({
        status: 0,
        stdout: "typecheck is clean against @octokit/types@latest\n",
        calls: [TYPES_ADD, TYPECHECK],
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
        "::error::typecheck against @octokit/types@latest failed without a diagnostic this probe can read (see log above)",
      ],
    ],
  ])("%s", (_label, stdout, report) =>
    withTempDir("nightly-steps-", (dir) => {
      const log = `${stdout.join("\n")}\n`;
      const stderr = 'error: script "typecheck" exited with code 2\n';
      const result = probe(dir, { typecheck: { stdout: log, stderr, status: 2 } }, "probe-types");
      expect(result).toMatchObject({
        status: 1,
        stdout: `${log}${stderr}${report.join("\n")}\n`,
        calls: [TYPES_ADD, TYPECHECK],
      });
    }),
  );
});

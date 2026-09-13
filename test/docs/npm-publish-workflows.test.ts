/**
 * The two npm publishers (post-green.yml's publish-next, update-release.yml's publish-npm) share one contract, trusted publishing
 * through the runner's OIDC token and nothing else, and one was copied from the other. The relations here: both are guarded to the
 * repository package.json names; both take one lane; the stable one runs after every other job of its workflow; neither hands npm a
 * token, as the library page promises; the steps they share are the same text; both publish to one registry. The probe, the floor
 * guard, and the publish blocks also run under bash against stubs, since no pin shows what a branch does.
 *
 * The static guards catch ACCIDENTAL drift: a guard, lane, or env edited in plain YAML. Deliberately hiding a token or a second
 * publisher behind other syntax is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { type Job, readWorkflow, type Step, type Workflow } from "./workflow-loader.js";

/** A job that runs steps (the publishers are never reusable-workflow calls). */
type RunJob = Job & { steps: Step[] };

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

function runJob(job: Job | undefined, what: string): RunJob {
  const found = must(job, what);
  return { ...found, steps: must(found.steps, `${what} steps`) };
}

/** A step condition as the runner evaluates it: with or without the `${{ }}` wrapper, whitespace aside. */
const condition = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .trim();

/** Every name and value a job hands the runner beyond its scripts: its env, each step's env, with, and gate. */
function runnerInputs(job: RunJob): string[] {
  return [
    ...Object.entries(job.env ?? {}).flat(),
    ...job.steps.flatMap((step) => [
      ...Object.entries(step.env ?? {}).flat(),
      ...Object.keys(step.with ?? {}),
      ...Object.values(step.with ?? {}).map(String),
      step.if ?? "",
    ]),
  ];
}

const stepNamed = (job: RunJob, name: string): Step =>
  must(
    job.steps.find((step) => step.name === name),
    `step ${name}`,
  );
const setupNode = (job: RunJob): Step =>
  must(
    job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")),
    "setup-node step",
  );

const STABLE_FILE = "update-release.yml";
const STABLE_JOB = "publish-npm";
const publishers = () => ({
  next: runJob(readWorkflow("post-green.yml").jobs["publish-next"], "publish-next job"),
  stableWorkflow: readWorkflow(STABLE_FILE),
});

/** The `owner/name` the manifest's repository URL names: the one repository whose CI is the trusted publisher. */
function manifestSlug(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    repository: { url: string };
  };
  return must(
    pkg.repository.url.match(/^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/)?.[1],
    "owner/name in package.json's repository.url",
  );
}

/**
 * The steps the two publishers share, by name or by action, as [label, next's, stable's]. The checkout is not one: each publisher
 * checks out the source its own workflow resolved.
 */
function sharedSteps(next: RunJob, stable: RunJob): Array<[string, Step, Step]> {
  return next.steps.flatMap((step) => {
    if ((step.uses ?? "").startsWith("actions/checkout@")) return [];
    const twin = stable.steps.find(
      (candidate) =>
        (step.name !== undefined && candidate.name === step.name) ||
        (step.uses !== undefined && candidate.uses === step.uses),
    );
    return twin
      ? [[step.name ?? step.uses ?? "unnamed step", step, twin] as [string, Step, Step]]
      : [];
  });
}

/** A step stripped of what legitimately differs between the two publishers: its gate and its id. */
const body = ({ if: _gate, id: _id, ...rest }: Step): Omit<Step, "if" | "id"> => rest;

/** Every way the two publishers break their shared contract; the assertions and the negative controls read this one list. */
function publisherProblems(next: RunJob, stableWorkflow: Workflow): string[] {
  const stable = runJob(stableWorkflow.jobs[STABLE_JOB], `${STABLE_JOB} job`);
  const problems: string[] = [];
  const guard = `github.repository == '${manifestSlug()}'`;
  for (const [label, job] of [
    ["publish-next", next],
    [STABLE_JOB, stable],
  ] as const) {
    if (condition(job.if) !== guard) problems.push(`${label} is not guarded to ${guard}`);
  }
  if (JSON.stringify(next.concurrency) !== JSON.stringify(stable.concurrency)) {
    problems.push("the publishers take different lanes");
  }
  if (typeof next.concurrency?.group !== "string" || next.concurrency.group.includes("${{")) {
    problems.push("the lane's group is not one literal");
  }
  const others = Object.keys(stableWorkflow.jobs)
    .filter((id) => id !== STABLE_JOB)
    .sort();
  if (JSON.stringify([stable.needs ?? []].flat().sort()) !== JSON.stringify(others)) {
    problems.push(`${STABLE_JOB} does not run after every other job (${others.join(", ")})`);
  }
  for (const value of [...runnerInputs(next), ...runnerInputs(stable)]) {
    if (/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/.test(value))
      problems.push(`a token reaches npm: ${value}`);
  }
  for (const [label, a, b] of sharedSteps(next, stable)) {
    if (JSON.stringify(body(a)) !== JSON.stringify(body(b)))
      problems.push(`"${label}" diverged between the publishers`);
  }
  const registry = setupNode(next).with?.["registry-url"];
  if (typeof registry !== "string" || setupNode(stable).with?.["registry-url"] !== registry) {
    problems.push("the publishers name different registries");
  }
  return problems;
}

describe("the npm publish jobs", () => {
  const { next, stableWorkflow } = publishers();
  const stable = runJob(stableWorkflow.jobs[STABLE_JOB], `${STABLE_JOB} job`);

  test("both are guarded to the manifest's repository, take one lane, hand npm no token, share their steps' text, and name one registry; the stable one runs last", () => {
    // The library page's promise is the second artifact of the token relation.
    const page = readFileSync(join(ROOT, "docs", "reference", "library.md"), "utf8");
    expect(page).toContain("no registry token exists anywhere");
    // Non-vacuity: the setup composite, setup-node, the floor guard, and the library build are shared today, and the stable
    // workflow has jobs for the publish to wait on.
    expect(sharedSteps(next, stable).length).toBeGreaterThan(3);
    expect(Object.keys(stableWorkflow.jobs).length).toBeGreaterThan(2);
    expect(publisherProblems(next, stableWorkflow)).toEqual([]);
  });

  test.each<[string, (next: RunJob, stableWorkflow: Workflow) => void, RegExp]>([
    [
      "a stable publish open to forks",
      (_n, w) => delete must(w.jobs[STABLE_JOB], "stable").if,
      /publish-npm is not guarded/,
    ],
    [
      "a pre-release publish on a lane of its own",
      (n) => {
        n.concurrency = { ...n.concurrency, group: "publish-next" };
      },
      /different lanes/,
    ],
    [
      "a stable publish ahead of the asset verification",
      (_n, w) => {
        must(w.jobs[STABLE_JOB], "stable").needs = ["package-release"];
      },
      /does not run after every other job/,
    ],
    [
      "a token handed to setup-node",
      (n) => {
        setupNode(n).env = { NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}` };
      },
      /a token reaches npm: NODE_AUTH_TOKEN/,
    ],
    [
      "a token in the job's own env under an innocent value",
      (_n, w) => {
        must(w.jobs[STABLE_JOB], "stable").env = { NODE_AUTH_TOKEN: `\${{ github.token }}` };
      },
      /a token reaches npm: NODE_AUTH_TOKEN/,
    ],
    [
      "a floor guard fixed in one job only",
      (n) => {
        const guard = stepNamed(n, "Require an npm that publishes through OIDC");
        guard.run = guard.run?.replace("11.5.1", "11.6.0");
      },
      /"Require an npm that publishes through OIDC" diverged/,
    ],
    [
      "a setup-node without the registry the trusted publisher is configured on",
      (_n, w) => {
        delete setupNode(runJob(w.jobs[STABLE_JOB], "stable")).with?.["registry-url"];
      },
      /different registries|diverged/,
    ],
  ])("%s fails its relation (negative control)", (_case, mutate, message) => {
    const driftedNext = structuredClone(next);
    const driftedWorkflow = structuredClone(stableWorkflow);
    mutate(driftedNext, driftedWorkflow);
    expect(publisherProblems(driftedNext, driftedWorkflow).join("\n")).toMatch(message);
  });
});

/** A `run:` block under `bash -e` (what a Linux runner gives a step) with
 * `bin` first on PATH, the given environment, and GITHUB_OUTPUT captured. */
function runStep(
  run: string,
  env: Record<string, string>,
  bin?: (dir: string) => void,
): { lines: string[]; status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "npm-publish-step-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    bin?.(binDir);
    const output = join(dir, "output");
    writeFileSync(output, "");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["-e", "-c", run], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, PATH: `${binDir}:${process.env.PATH ?? ""}`, GITHUB_OUTPUT: output },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      stdout = String((error as { stdout?: string }).stdout ?? "");
    }
    return {
      lines: stdout.split("\n").filter(Boolean),
      status,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the OIDC probe under bash", () => {
  const { next } = publishers();
  const run = must(must(next.steps[0], "probe step").run, "probe run");

  test("a runner that minted a token URL proceeds silently", () => {
    const probe = runStep(run, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.invalid/oidc" });
    expect(probe).toEqual({ lines: [], status: 0, output: "proceed=true\n" });
  });

  test("a runner without one warns naming the missing grant and skips (control)", () => {
    const probe = runStep(run, {});
    expect(probe.status).toBe(0);
    expect(probe.output).toBe("proceed=false\n");
    expect(probe.lines).toHaveLength(1);
    expect(probe.lines[0]).toMatch(/^::warning::/);
    expect(probe.lines[0]).toContain("id-token: write");
  });
});

describe("the npm floor guard under bash", () => {
  const stable = runJob(readWorkflow(STABLE_FILE).jobs[STABLE_JOB], `${STABLE_JOB} job`);
  const run = must(
    stepNamed(stable, "Require an npm that publishes through OIDC").run,
    "guard run",
  );
  /** Trusted publishing exists from this npm on (npm's changelog for 11.5.1); the script must hold that floor or a newer one. */
  const OIDC_NPM = "11.5.1";
  const floor = must(run.match(/^floor=(\S+)$/m)?.[1], "floor= line in the guard");

  test("the script's floor is not below the npm that introduced trusted publishing", () => {
    const [scriptFloor] = [floor, OIDC_NPM].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    expect(scriptFloor, `floor=${floor} admits an npm that cannot publish through OIDC`).toBe(
      OIDC_NPM,
    );
  });

  /** An npm stub reporting `before` until `npm install -g` runs, then `after`. */
  const stubNpm =
    (before: string, after: string) =>
    (bin: string): void => {
      writeFileSync(join(bin, "version"), before);
      writeFileSync(
        join(bin, "npm"),
        [
          "#!/bin/sh",
          `here="$(dirname "$0")"`,
          'case "$1" in',
          `  --version) cat "$here/version"; echo ;;`,
          `  install) printf '%s' "${after}" > "$here/version"; echo "installed $*" ;;`,
          '  *) echo "unexpected npm $*" >&2; exit 2 ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    };

  const floors: [string, string, string, { lines: string[]; status: number }][] = [
    ["at the floor", floor, floor, { lines: [], status: 0 }],
    ["above it", "99.0.0", "99.0.0", { lines: [], status: 0 }],
    [
      "just below the OIDC floor, upgraded past it",
      "11.4.2",
      "99.0.0",
      { lines: ["installed install -g npm@latest"], status: 0 },
    ],
    [
      "below it and still below after the upgrade",
      "1.0.0",
      "1.0.0",
      {
        lines: [
          "installed install -g npm@latest",
          `::error::npm 1.0.0 cannot publish through OIDC; trusted publishing needs npm ${floor} or newer.`,
        ],
        status: 1,
      },
    ],
  ];
  test.each(floors)("an npm %s", (_name, before, after, expected) => {
    const guard = runStep(run, {}, stubNpm(before, after));
    expect({ lines: guard.lines, status: guard.status }).toEqual(expected);
  });
});

describe("the publish blocks under bash", () => {
  const { next } = publishers();
  const stable = runJob(readWorkflow(STABLE_FILE).jobs[STABLE_JOB], `${STABLE_JOB} job`);
  const nextRun = must(
    stepNamed(next, "Publish the pre-release under the next dist-tag").run,
    "next publish run",
  );
  const stableRun = must(stepNamed(stable, "Publish the release to npm").run, "stable publish run");

  /** A bun that answers the verdict given and an npm that reports every call with the GITHUB_SHA it saw. */
  const stubs =
    (verdict: string) =>
    (bin: string): void => {
      writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "${verdict}"\n`, { mode: 0o755 });
      writeFileSync(join(bin, "npm"), '#!/bin/sh\necho "npm $* (GITHUB_SHA=$GITHUB_SHA)"\n', {
        mode: 0o755,
      });
    };
  const source = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";

  const cases: [string, string, string, { lines: string[]; status: number; output: string }][] = [
    [
      "next: a publish verdict sets the version, publishes under next with the source as GITHUB_SHA, and reports the publish for the confirmation",
      nextRun,
      "publish 2.0.1-main.446.20260913.gb8df084",
      {
        lines: [
          "npm version 2.0.1-main.446.20260913.gb8df084 --no-git-tag-version (GITHUB_SHA=)",
          "npm pkg delete scripts.prepare (GITHUB_SHA=)",
          "npm publish --tag next (GITHUB_SHA=b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a)",
        ],
        status: 0,
        output: "published=true\n",
      },
    ],
    [
      "next: a skip verdict calls npm not at all, reports why, and leaves the confirmation ungated",
      nextRun,
      "skip the registry's next is newer",
      { lines: ["::notice::the registry's next is newer"], status: 0, output: "" },
    ],
    [
      "next: anything else fails the step",
      nextRun,
      "2.0.1-main.446.20260913.gb8df084",
      {
        lines: [
          "unexpected npm-verdict output: 2.0.1-main.446.20260913.gb8df084",
          "::error::npm-verdict printed neither publish nor skip; see the line above.",
        ],
        status: 1,
        output: "",
      },
    ],
    [
      "stable: a publish verdict publishes under the default dist-tag with the source as GITHUB_SHA",
      stableRun,
      "publish 2.1.0",
      {
        lines: [
          "npm pkg delete scripts.prepare (GITHUB_SHA=)",
          "npm publish (GITHUB_SHA=b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a)",
        ],
        status: 0,
        output: "",
      },
    ],
    [
      "stable: a skip verdict calls npm not at all and warns",
      stableRun,
      "skip 2.1.0 is already on the registry",
      { lines: ["::warning::2.1.0 is already on the registry"], status: 0, output: "" },
    ],
  ];
  test.each(cases)("%s", (_name, run, verdict, expected) => {
    expect(runStep(run, { SOURCE_SHA: source, TAG: "v2.1.0" }, stubs(verdict))).toEqual(expected);
  });
});

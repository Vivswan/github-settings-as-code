/**
 * The two npm publish jobs (post-green.yml's publish-next, update-release.yml's
 * publish-npm) share one contract, trusted publishing through the runner's OIDC
 * token and nothing else, and one was copied from the other, so a fix to the
 * shared steps must reach both. The probe, the floor guard, and the publish
 * blocks also run under bash against stubs: the pin alone cannot show what a
 * branch does.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string[];
  concurrency?: { group?: string; queue?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return parseYaml(readFileSync(join(ROOT, ".github", "workflows", file), "utf8")) as Workflow;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** Every string a step hands the runner beyond its script: env values, with values, the gate. */
function stepInputs(step: Step): string[] {
  return [
    ...Object.values(step.env ?? {}),
    ...Object.values(step.with ?? {}).map(String),
    step.if ?? "",
  ];
}

const stepNamed = (job: Job, name: string): Step =>
  must(
    job.steps.find((step) => step.name === name),
    `step ${name}`,
  );
const setupNode = (job: Job): Step =>
  must(
    job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")),
    "setup-node step",
  );

interface Contract {
  /** The stable job's ceiling: read the source, mint the OIDC token, nothing else. */
  stablePermissions: Record<string, string> | undefined;
  /** publish-next declares no ceiling: it inherits the caller's id-token grant (a ceiling of its own would fail the call). */
  nextPermissions: Record<string, string> | undefined;
  /** Both jobs run only in this repository: a fork has no trusted publisher and must not try. */
  repositoryGuards: [string | undefined, string | undefined];
  /** Both jobs take one lane: the registry has no compare-and-set, so a verdict must still hold when its publish lands. */
  lanes: [unknown, unknown];
  stableNeeds: string[];
  /** Steps of publish-next after the probe that are not gated on it. */
  ungatedNextSteps: string[];
  /** Any env, with, or gate value in either job naming a secret or a registry token. */
  tokenInputs: string[];
  /** Whether the two floor guards and the two library builds are the same text. */
  sameFloor: boolean;
  sameBuild: boolean;
  /** Both setup-node steps' registry, and whether either carries an env of its own. */
  registries: unknown[];
  setupNodeEnvs: unknown[];
  /** The npm lines of each publish step: scripts.prepare leaves the manifest, then the one publish, the source sha reaching npm's provenance and the dist-tag the channel's. */
  publishCommands: [string[], string[]];
}

const OIDC_GATE = "steps.oidc.outputs.proceed == 'true'";
const EXPECTED: Contract = {
  stablePermissions: { contents: "read", "id-token": "write" },
  nextPermissions: undefined,
  repositoryGuards: [
    "github.repository == 'Vivswan/github-settings-as-code'",
    "github.repository == 'Vivswan/github-settings-as-code'",
  ],
  lanes: [
    { group: "npm-publish", queue: "max", "cancel-in-progress": false },
    { group: "npm-publish", queue: "max", "cancel-in-progress": false },
  ],
  stableNeeds: ["package-release", "verify-release"],
  ungatedNextSteps: [],
  tokenInputs: [],
  sameFloor: true,
  sameBuild: true,
  registries: ["https://registry.npmjs.org", "https://registry.npmjs.org"],
  setupNodeEnvs: [undefined, undefined],
  publishCommands: [
    ["npm pkg delete scripts.prepare", 'GITHUB_SHA="$SOURCE_SHA" npm publish --tag next ;;'],
    ["npm pkg delete scripts.prepare", 'GITHUB_SHA="$SOURCE_SHA" npm publish ;;'],
  ],
};

function contractOf(next: Job, stable: Job): Contract {
  const probe = next.steps.findIndex((step) => step.id === "oidc");
  if (probe < 0) throw new Error("publish-next has no oidc probe");
  const publishLines = (step: Step): string[] =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\bnpm (?:publish|pkg delete)\b/.test(line));
  return {
    stablePermissions: stable.permissions,
    nextPermissions: next.permissions,
    repositoryGuards: [next.if, stable.if],
    lanes: [next.concurrency, stable.concurrency],
    stableNeeds: [...(stable.needs ?? [])].sort(),
    ungatedNextSteps: next.steps
      .slice(probe + 1)
      .filter((step) => step.if !== OIDC_GATE)
      .map((step) => step.name ?? step.uses ?? "<unnamed step>"),
    tokenInputs: [...next.steps, ...stable.steps]
      .flatMap(stepInputs)
      .filter((value) => /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/.test(value)),
    sameFloor:
      stepNamed(next, "Require an npm that publishes through OIDC").run ===
      stepNamed(stable, "Require an npm that publishes through OIDC").run,
    sameBuild:
      stepNamed(next, "Build the library").run === stepNamed(stable, "Build the library").run,
    registries: [setupNode(next).with?.["registry-url"], setupNode(stable).with?.["registry-url"]],
    setupNodeEnvs: [setupNode(next).env, setupNode(stable).env],
    publishCommands: [
      publishLines(stepNamed(next, "Publish the pre-release under the next dist-tag")),
      publishLines(stepNamed(stable, "Publish the release to npm")),
    ],
  };
}

describe("the npm publish jobs", () => {
  const postGreen = workflow("post-green.yml");
  const updateRelease = workflow("update-release.yml");
  const next = must(postGreen.jobs["publish-next"], "publish-next job");
  const stable = must(updateRelease.jobs["publish-npm"], "publish-npm job");

  test("both publish through OIDC alone, with the same guard and build, and publish-next skips whole without a token", () => {
    expect(contractOf(next, stable)).toEqual(EXPECTED);
  });

  const REGRESSIONS: Array<[string, (next: Job, stable: Job) => void, keyof Contract]> = [
    [
      "a stable publish without the OIDC grant",
      (_next, stable) => (stable.permissions = { contents: "read" }),
      "stablePermissions",
    ],
    [
      "a stable publish with a ceiling beyond its two grants",
      (_next, stable) => (stable.permissions = { ...stable.permissions, contents: "write" }),
      "stablePermissions",
    ],
    [
      "a pre-release publish with a ceiling of its own, which the caller's rejects as a whole",
      (next) => (next.permissions = { contents: "read", "id-token": "write" }),
      "nextPermissions",
    ],
    ["a stable publish open to forks", (_next, stable) => delete stable.if, "repositoryGuards"],
    ["a pre-release publish open to forks", (next) => delete next.if, "repositoryGuards"],
    [
      "a stable publish outside the shared lane, free to overlap a pre-release publish",
      (_next, stable) => delete stable.concurrency,
      "lanes",
    ],
    [
      "a pre-release publish on a lane of its own",
      (next) => (next.concurrency = { ...next.concurrency, group: "publish-next" }),
      "lanes",
    ],
    [
      "a lane that keeps one pending publish and drops the rest",
      (_next, stable) => delete stable.concurrency?.queue,
      "lanes",
    ],
    [
      "a lane pairing queue: max with cancel-in-progress, which GitHub rejects at validation",
      (next) => (next.concurrency = { ...next.concurrency, "cancel-in-progress": true }),
      "lanes",
    ],
    [
      "a stable publish ahead of the ref verification",
      (_next, stable) => (stable.needs = ["package-release"]),
      "stableNeeds",
    ],
    [
      "a pre-release step that runs without the OIDC gate",
      (next) => (must(next.steps.at(-1), "publish step").if = undefined),
      "ungatedNextSteps",
    ],
    [
      "a registry token handed to npm through the environment",
      (_next, stable) =>
        (must(stable.steps.at(-1), "publish step").env = {
          NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}`,
        }),
      "tokenInputs",
    ],
    [
      "a registry token handed to setup-node",
      (next) => (setupNode(next).env = { NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}` }),
      "tokenInputs",
    ],
    [
      "a floor guard fixed in one job only",
      (next) => {
        const guard = stepNamed(next, "Require an npm that publishes through OIDC");
        guard.run = guard.run?.replace("11.5.1", "11.6.0");
      },
      "sameFloor",
    ],
    [
      "a library build that diverged between the jobs",
      (_next, stable) => {
        const build = stepNamed(stable, "Build the library");
        build.run = build.run?.replace("--ignore-scripts", "");
      },
      "sameBuild",
    ],
    [
      "a setup-node without the registry the trusted publisher is configured on",
      (_next, stable) => delete setupNode(stable).with?.["registry-url"],
      "registries",
    ],
    [
      "a pre-release published under the default dist-tag",
      (next) => {
        const step = must(next.steps.at(-1), "publish step");
        step.run = step.run?.replace("npm publish --tag next ;;", "npm publish ;;");
      },
      "publishCommands",
    ],
    [
      "a stable publish that ships scripts.prepare (lefthook is not in the tarball, and npm blocks install scripts)",
      (_next, stable) => {
        const step = must(stable.steps.at(-1), "publish step");
        step.run = step.run?.replace("npm pkg delete scripts.prepare\n", "");
      },
      "publishCommands",
    ],
    [
      "a publish whose provenance names this run's head instead of the source",
      (_next, stable) => {
        const step = must(stable.steps.at(-1), "publish step");
        step.run = step.run?.replace('GITHUB_SHA="$SOURCE_SHA" npm publish ;;', "npm publish ;;");
      },
      "publishCommands",
    ],
  ];
  test.each(REGRESSIONS)("catches %s (negative control)", (_label, mutate, key) => {
    const driftedNext = structuredClone(next);
    const driftedStable = structuredClone(stable);
    mutate(driftedNext, driftedStable);
    expect(contractOf(driftedNext, driftedStable)[key]).not.toEqual(EXPECTED[key]);
    expect(() => expect(contractOf(driftedNext, driftedStable)).toEqual(EXPECTED)).toThrow();
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
  const next = must(workflow("post-green.yml").jobs["publish-next"], "publish-next job");
  const run = must(must(next.steps[0], "probe step").run, "probe run");

  test("a runner that minted a token URL proceeds silently", () => {
    const probe = runStep(run, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.invalid/oidc" });
    expect(probe).toEqual({ lines: [], status: 0, output: "proceed=true\n" });
  });

  test("a runner without one warns naming the caller's missing grant and skips (control)", () => {
    const probe = runStep(run, {});
    expect(probe.status).toBe(0);
    expect(probe.output).toBe("proceed=false\n");
    expect(probe.lines).toEqual([
      "::warning::this run has no OIDC token (the post-green call in the managed ci.yml grants no " +
        "id-token: write); the library pre-release was not published to npm. Add id-token: write " +
        "to that call's permissions in Vivswan/repo-platform to publish every green push to @next.",
    ]);
  });
});

describe("the npm floor guard under bash", () => {
  const stable = must(workflow("update-release.yml").jobs["publish-npm"], "publish-npm job");
  const run = must(
    stepNamed(stable, "Require an npm that publishes through OIDC").run,
    "guard run",
  );

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
    ["at the floor", "11.5.1", "11.5.1", { lines: [], status: 0 }],
    ["above it", "11.9.0", "11.9.0", { lines: [], status: 0 }],
    [
      "below it, upgraded past it",
      "11.4.2",
      "11.9.0",
      { lines: ["installed install -g npm@latest"], status: 0 },
    ],
    [
      "below it and still below after the upgrade",
      "10.9.4",
      "10.9.4",
      {
        lines: [
          "installed install -g npm@latest",
          "::error::npm 10.9.4 cannot publish through OIDC; trusted publishing needs npm 11.5.1 or newer.",
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
  const next = must(workflow("post-green.yml").jobs["publish-next"], "publish-next job");
  const stable = must(workflow("update-release.yml").jobs["publish-npm"], "publish-npm job");
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

  const cases: [string, string, string, { lines: string[]; status: number }][] = [
    [
      "next: a publish verdict sets the version and publishes under next with the source as GITHUB_SHA",
      nextRun,
      "publish 2.0.1-main.412.gb8df084",
      {
        lines: [
          "npm version 2.0.1-main.412.gb8df084 --no-git-tag-version (GITHUB_SHA=)",
          "npm pkg delete scripts.prepare (GITHUB_SHA=)",
          "npm publish --tag next (GITHUB_SHA=b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a)",
        ],
        status: 0,
      },
    ],
    [
      "next: a skip verdict calls npm not at all and reports why",
      nextRun,
      "skip the registry's next is newer",
      { lines: ["::notice::the registry's next is newer"], status: 0 },
    ],
    [
      "next: anything else fails the step",
      nextRun,
      "2.0.1-main.412.gb8df084",
      {
        lines: [
          "unexpected npm-verdict output: 2.0.1-main.412.gb8df084",
          "::error::npm-verdict printed neither publish nor skip; see the line above.",
        ],
        status: 1,
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
      },
    ],
    [
      "stable: a skip verdict calls npm not at all and warns",
      stableRun,
      "skip 2.1.0 is already on the registry",
      { lines: ["::warning::2.1.0 is already on the registry"], status: 0 },
    ],
  ];
  test.each(cases)("%s", (_name, run, verdict, expected) => {
    const step = runStep(run, { SOURCE_SHA: source, TAG: "v2.1.0" }, stubs(verdict));
    expect({ lines: step.lines, status: step.status }).toEqual(expected);
  });
});

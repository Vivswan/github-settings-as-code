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
import { type Job, readWorkflow, type Step } from "./workflow-loader.js";

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

/** Every string a step hands the runner beyond its script: env values, with values, the gate. */
function stepInputs(step: Step): string[] {
  return [
    ...Object.values(step.env ?? {}),
    ...Object.values(step.with ?? {}).map(String),
    step.if ?? "",
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

/** The guard both publishers must carry. */
const forkGuard = () => `github.repository == '${manifestSlug()}'`;

describe("the npm publish jobs", () => {
  const { next, stableWorkflow } = publishers();
  const stable = runJob(stableWorkflow.jobs["publish-npm"], "publish-npm job");

  test("both run only in the repository the manifest names: a fork has no trusted publisher", () => {
    expect(condition(next.if)).toBe(forkGuard());
    expect(condition(stable.if)).toBe(forkGuard());
  });

  test("both take the one lane: the registry has no compare-and-set, so a verdict must still hold when its publish lands", () => {
    expect(next.concurrency).toEqual(stable.concurrency);
    expect(typeof next.concurrency?.group).toBe("string");
    expect(next.concurrency?.group).not.toContain("${{");
  });

  test("the stable publish runs after every other job of its workflow, so nothing reaches the registry before the draft's assets check out", () => {
    const others = Object.keys(stableWorkflow.jobs)
      .filter((id) => id !== "publish-npm")
      .sort();
    expect(others.length).toBeGreaterThan(1);
    expect([stable.needs ?? []].flat().sort()).toEqual(others);
  });

  test("neither hands npm a registry token, as the library page promises", () => {
    const page = readFileSync(join(ROOT, "docs", "reference", "library.md"), "utf8");
    expect(page).toContain("no registry token exists anywhere");
    const tokens = [...next.steps, ...stable.steps]
      .flatMap(stepInputs)
      .filter((value) => /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/.test(value));
    expect(tokens).toEqual([]);
  });

  test("the steps the two publishers share are the same text, so a fix reaches both", () => {
    const shared = sharedSteps(next, stable);
    // The setup composite, setup-node, the floor guard, and the library build are shared today.
    expect(shared.length).toBeGreaterThan(3);
    for (const [label, a, b] of shared) {
      expect(body(a), `"${label}" diverged between the publishers`).toEqual(body(b));
    }
  });

  test("both publish to one registry, the one setup-node writes into .npmrc", () => {
    const registry = setupNode(next).with?.["registry-url"];
    expect(typeof registry).toBe("string");
    expect(setupNode(stable).with?.["registry-url"]).toBe(registry);
  });

  /** Each mutation, then whether the relation it targets still holds; the control passes when it does not. */
  test.each<[string, (next: RunJob, stable: RunJob) => boolean]>([
    [
      "a stable publish open to forks",
      (_n, s) => {
        delete s.if;
        return condition(s.if) === forkGuard();
      },
    ],
    [
      "a pre-release publish on a lane of its own",
      (n, s) => {
        n.concurrency = { ...n.concurrency, group: "publish-next" };
        return JSON.stringify(n.concurrency) === JSON.stringify(s.concurrency);
      },
    ],
    [
      "a token handed to setup-node",
      (n) => {
        setupNode(n).env = { NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}` };
        return n.steps.flatMap(stepInputs).every((value) => !/secrets\./.test(value));
      },
    ],
    [
      "a floor guard fixed in one job only",
      (n, s) => {
        const guard = stepNamed(n, "Require an npm that publishes through OIDC");
        guard.run = guard.run?.replace("11.5.1", "11.6.0");
        return sharedSteps(n, s).every(
          ([, a, b]) => JSON.stringify(body(a)) === JSON.stringify(body(b)),
        );
      },
    ],
  ])("%s fails its relation (negative control)", (_case, mutateAndHolds) => {
    expect(mutateAndHolds(structuredClone(next), structuredClone(stable))).toBe(false);
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
  const stable = runJob(readWorkflow(STABLE_FILE).jobs["publish-npm"], "publish-npm job");
  const run = must(
    stepNamed(stable, "Require an npm that publishes through OIDC").run,
    "guard run",
  );
  const floor = must(run.match(/^floor=(\S+)$/m)?.[1], "floor= line in the guard");

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
      "below it, upgraded past it",
      "1.0.0",
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
  const stable = runJob(readWorkflow(STABLE_FILE).jobs["publish-npm"], "publish-npm job");
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
      "publish 2.0.1-main.446.20260913.gb8df084",
      {
        lines: [
          "npm version 2.0.1-main.446.20260913.gb8df084 --no-git-tag-version (GITHUB_SHA=)",
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
      "2.0.1-main.446.20260913.gb8df084",
      {
        lines: [
          "unexpected npm-verdict output: 2.0.1-main.446.20260913.gb8df084",
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

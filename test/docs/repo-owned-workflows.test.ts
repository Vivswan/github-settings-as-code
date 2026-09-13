/**
 * The invariants of the repo-owned workflows that no single file shows: every job sets bun up through the one
 * composite (or runs no bun), every job is bounded, every action is pinned the same way everywhere, the commit-back
 * push jobs run no PR code under their write token, and lint:yaml is real where a job asks for it. The managed
 * workflows are the platform's and stay out of every pin here.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import {
  isManaged,
  type Job,
  ROOT,
  readAction,
  readWorkflow,
  repoOwnedWorkflowFiles,
  SETUP_USES,
  type Step,
  setupYamllint,
  workflowFiles,
  workflowText,
} from "./workflow-loader.js";

const SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
/** A bun invocation the shell would run: the word `bun` at a command position. */
const RUNS_BUN = /(?:^|[\s;&|(])bun(?=\s|$)/m;
const isSetup = (step: Step) => step.uses === SETUP_USES;
/** A step that needs bun on the runner: a run step invoking it, or a local composite (each of ours runs bun). */
const needsBun = (step: Step) =>
  RUNS_BUN.test(step.run ?? "") || (!isSetup(step) && (step.uses ?? "").startsWith("./"));

/** Why a job's bun setup is wrong, or undefined: one composite step ahead of every bun user, or no bun at all. */
function setupProblem(steps: Step[]): string | undefined {
  const setups = steps.filter(isSetup);
  if (steps.some((step) => (step.uses ?? "").startsWith("oven-sh/setup-bun@")))
    return "setup-bun outside the composite";
  if (setups.length === 0 && !steps.some(needsBun)) return undefined;
  if (setups.length !== 1) return `${setups.length} composite steps for a bun job`;
  const early = steps.slice(0, steps.indexOf(setups[0] as Step)).filter(needsBun);
  return early.length > 0
    ? `bun runs before the composite: ${early.map((s) => s.name ?? s.uses ?? s.run).join("; ")}`
    : undefined;
}

/** `<file>#<job>` and the job, over every repo-owned workflow. */
const repoOwnedJobs = (): Array<[string, Job]> =>
  repoOwnedWorkflowFiles().flatMap((file) =>
    Object.entries(readWorkflow(file).jobs).map(([id, job]): [string, Job] => [
      `${file}#${id}`,
      job,
    ]),
  );
const jobsWhere = (test: (step: Step) => boolean) =>
  repoOwnedJobs().flatMap(([where, job]) => ((job.steps ?? []).some(test) ? [where] : []));

describe("the repo-owned workflows", () => {
  test("the managed set is exactly the files whose header says so", () => {
    expect(workflowFiles().filter((file) => isManaged(workflowText(file)))).toEqual([
      "auto-assign.yml",
      "ci.yml",
      "pr-title.yml",
    ]);
  });

  test("every job sets bun up through the composite once, or runs no bun; every job carries a timeout", () => {
    for (const [where, job] of repoOwnedJobs()) {
      expect(setupProblem(job.steps ?? []), where).toBeUndefined();
      expect(job["timeout-minutes"], `${where} has no timeout-minutes`).toBeGreaterThan(0);
    }
    // Controls: the derivation sees the composite, and each drift class it exists for is a problem.
    expect(jobsWhere(isSetup).length).toBeGreaterThan(15);
    const drifts: Step[][] = [
      [{ uses: SETUP_USES }, { uses: "oven-sh/setup-bun@0000" }],
      [{ uses: "./.github/actions/fetch-test-artifacts" }],
      [{ run: "bun --version" }, { uses: SETUP_USES }],
    ];
    for (const steps of drifts) expect(setupProblem(steps), JSON.stringify(steps)).toBeDefined();
  });
});

/** Every `uses:` value in a YAML file with the comment on its line: block or flow style, an alias resolved. */
function usesIn(text: string): Array<[string, string]> {
  const doc = parseDocument(text);
  const found: Array<[string, string]> = [];
  visit(doc, {
    Pair(_, pair, path) {
      const key = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      const written = pair.value;
      if (!isScalar(key) || key.value !== "uses" || !(isScalar(written) || isAlias(written)))
        return;
      const node = isAlias(written) ? written.resolve(doc) : written;
      // A flow step's comment (`- {uses: x} # v1`) sits on the enclosing map, not on the scalar.
      const parent = path[path.length - 1];
      const comment =
        written.comment ?? (isMap(parent) && parent.flow ? parent.comment : undefined) ?? "";
      if (isScalar(node)) found.push([String(node.value), comment.trim()]);
    },
  });
  return found;
}

const SHA_PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
/** The fleet's own actions ride their stable channel by design; any other ref is a pin problem. */
const FLEET_STABLE = /^Vivswan\/repo-platform\/actions\/[\w-]+@stable$/;

function pinProblem(uses: string, comment: string): string | undefined {
  if (uses.startsWith("./"))
    return comment === "" ? undefined : "a local action carries no version comment";
  if (FLEET_STABLE.test(uses)) return undefined;
  if (!SHA_PIN.test(uses)) return "not a full-sha pin";
  return /^v\d+(?:\.\d+)*$/.test(comment) ? undefined : "no version comment after the sha";
}

describe("action pins across the repo-owned files", () => {
  const files = [
    ...repoOwnedWorkflowFiles().map((file) => `.github/workflows/${file}`),
    ...readdirSync(join(ROOT, ".github/actions")).map(
      (name) => `.github/actions/${name}/action.yml`,
    ),
  ];
  const lines = files.flatMap((file) =>
    usesIn(readFileSync(join(ROOT, file), "utf8")).map(([uses, comment]) => ({
      file,
      uses,
      comment,
    })),
  );

  test("every uses: is a local path, the fleet action at @stable, or a full sha with its version comment; one sha per action", () => {
    expect(lines.length).toBeGreaterThan(30);
    const problems = lines.flatMap(({ file, uses, comment }) => {
      const problem = pinProblem(uses, comment);
      return problem ? [`${file}: ${uses} (${problem})`] : [];
    });
    expect(problems).toEqual([]);
    expect(pinProblem("Vivswan/repo-platform/actions/fuzz-issue@build", "")).toBeDefined();
    const pins = new Map<string, Set<string>>();
    for (const { uses, comment } of lines.filter((line) => SHA_PIN.test(line.uses))) {
      const [action, sha] = uses.split("@") as [string, string];
      pins.set(action, (pins.get(action) ?? new Set()).add(`${sha} ${comment}`));
    }
    expect(pins.size).toBeGreaterThan(3);
    for (const [action, shas] of pins)
      expect([...shas], `${action} is pinned ${shas.size} ways`).toHaveLength(1);
  });
});

/** The commit-back push jobs: [file, push step name, where HEAD_SHA comes from]. */
const PUSH_JOBS: ReadonlyArray<[string, string, string]> = [
  ["auto-fix.yml", "Commit and push the fix", `\${{ github.event.pull_request.head.sha }}`],
  ["auto-format.yml", "Commit and push the formatting", `\${{ needs.format.outputs.head }}`],
];
const HEAD_MOVED_GUARD =
  /^if \[ "\$\(git rev-parse HEAD\)" != "\$HEAD_SHA" \]; then\n {2}echo "::notice::head moved .*"\n {2}exit 0\nfi$/m;
const LEASED_PUSH = /git push --force-with-lease="refs\/heads\/\$\{HEAD_REF\}:\$\{HEAD_SHA\}"/;
/** auto-format's staged-path check between the apply and the commit: an untrusted patch may modify tracked files only. */
const PATH_CHECK =
  /^# The patch was cut on a runner PR code ran on[\s\S]*?^done < <\(git diff --cached --no-renames --name-status -z\)$/m;

describe("the commit-back push jobs", () => {
  test.each(PUSH_JOBS)(
    "%s: no PR code under the write token, skips on a moved head, leases the push",
    (file, name, sha) => {
      const push = readWorkflow(file).jobs.push;
      expect(push?.permissions?.contents).toBe("write");
      expect((push?.steps ?? []).filter(needsBun)).toEqual([]);
      const step = push?.steps?.find((candidate) => candidate.name === name);
      expect(step?.env?.HEAD_SHA).toBe(sha);
      const run = step?.run ?? "";
      expect(run).toMatch(HEAD_MOVED_GUARD);
      expect(run).toMatch(LEASED_PUSH);
      expect(run.search(HEAD_MOVED_GUARD)).toBeLessThan(run.indexOf("git apply"));
    },
  );

  test("auto-format checks the staged paths after the apply and before the commit", () => {
    const push = readWorkflow("auto-format.yml").jobs.push;
    const run =
      push?.steps?.find((step) => step.name === "Commit and push the formatting")?.run ?? "";
    expect(run.search(PATH_CHECK)).toBeGreaterThan(run.indexOf("git apply"));
    expect(run.search(PATH_CHECK)).toBeLessThan(run.indexOf("git commit"));
    expect(run).toContain("M) ;;");
    expect(run).toContain(".github/workflows/*)");
  });
});

/** The setup composite's steps as the runner acts on them: what runs, under which gate, and whether a failure counts. */
const SETUP_SHAPE = [
  {
    uses: expect.stringMatching(/^oven-sh\/setup-bun@[0-9a-f]{40}$/),
    with: { "bun-version-file": ".bun-version" },
  },
  {
    if: "inputs.install != 'false'",
    shell: "bash",
    run: "bun install --frozen-lockfile --ignore-scripts",
  },
  { if: "inputs.yamllint == 'true'", shell: "bash", run: "pipx install yamllint==1.38.0" },
].map((step) => ({
  uses: undefined,
  with: undefined,
  if: undefined,
  shell: undefined,
  run: undefined,
  "continue-on-error": undefined,
  ...step,
}));

describe("the setup composite", () => {
  const shapeOf = (steps: Step[]) =>
    steps.map(({ uses, with: inputs, if: gate, shell, run, "continue-on-error": masked }) => ({
      uses,
      with: inputs,
      if: gate,
      shell,
      run,
      "continue-on-error": masked,
    }));

  test("runs the pinned bun, the gated install, and the gated yamllint, none allowed to fail", () => {
    const steps = readAction(".github/actions/setup").runs.steps ?? [];
    expect(shapeOf(steps)).toEqual(SETUP_SHAPE);
    // Control: a masked install inside the composite, which no caller-side pin can see, fails the shape.
    const masked = steps.map((step) =>
      step.run?.startsWith("bun install") ? { ...step, "continue-on-error": true } : step,
    );
    expect(shapeOf(masked)).not.toEqual(SETUP_SHAPE);
  });
});

describe("lint:yaml", () => {
  test("the composite hands yamllint to exactly the jobs that run it", () => {
    const running = jobsWhere((step) =>
      /\bbun run (?:check|lint:yaml)(?![\w:.-])/.test(step.run ?? ""),
    );
    expect(running).toEqual(["checks.yml#check", "nightly.yml#float-canary"]);
    expect(jobsWhere(setupYamllint)).toEqual(running);
    expect(SCRIPTS.check).toContain("bun run lint:yaml");
  });

  /** The script from the repository root with PATH cut to the system directories plus a stub bin (a yamllint that reports its call, or nothing). */
  function lintYaml(
    env: Record<string, string>,
    stub: boolean,
  ): { status: number; lines: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "lint-yaml-"));
    try {
      mkdirSync(join(dir, "bin"));
      if (stub)
        writeFileSync(join(dir, "bin/yamllint"), '#!/bin/sh\necho "yamllint $1"\n', {
          mode: 0o755,
        });
      const options = {
        cwd: ROOT,
        encoding: "utf8",
        env: { HOME: process.env.HOME ?? "", ...env, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
      } as const;
      try {
        return {
          status: 0,
          lines: execFileSync("bash", ["-c", SCRIPTS["lint:yaml"] ?? ""], options)
            .split("\n")
            .filter(Boolean),
        };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return {
          status: failed.status ?? -1,
          lines: `${failed.stdout ?? ""}${failed.stderr ?? ""}`.split("\n").filter(Boolean),
        };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("with yamllint it lints strictly; without it, CI fails naming the composite input and a local run skips", () => {
    expect(lintYaml({}, true)).toEqual({ status: 0, lines: ["yamllint -s"] });
    expect(lintYaml({ CI: "true" }, false)).toEqual({
      status: 1,
      lines: [
        'lint:yaml: yamllint is missing on this runner; the job needs ./.github/actions/setup with yamllint: "true"',
      ],
    });
    expect(lintYaml({}, false).status).toBe(0);
  });
});

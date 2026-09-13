/**
 * The invariants of the repo-owned workflows that no single file shows: every job sets bun up through the one
 * composite (or runs no bun), every job is bounded, every action is pinned the same way everywhere, the commit-back
 * push jobs run no PR code under their write token, and lint:yaml is real where a job asks for it. The managed
 * workflows are the platform's and stay out of every pin here.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { ROOT } from "../root.js";
import {
  type Job,
  readAction,
  readWorkflow,
  repoOwnedWorkflowFiles,
  SETUP_USES,
  type Step,
  setupYamllint,
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

  test("no step inside the setup composite may mask its failure (a job relies on each one it asks for)", () => {
    const steps = readAction(".github/actions/setup").runs.steps ?? [];
    expect(steps.length).toBeGreaterThan(1);
    for (const step of steps)
      expect(step["continue-on-error"], step.run ?? step.uses).toBeUndefined();
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

describe("the commit-back push jobs", () => {
  test.each([
    ["auto-fix.yml", "Commit and push the fix"],
    ["auto-format.yml", "Commit and push the formatting"],
  ])(
    "%s: no PR code runs under the write token, and the push is leased to the patched head",
    (file, name) => {
      const push = readWorkflow(file).jobs.push;
      expect(push?.permissions?.contents).toBe("write");
      expect((push?.steps ?? []).filter(needsBun)).toEqual([]);
      const step = push?.steps?.find((candidate) => candidate.name === name);
      expect(step?.env?.HEAD_SHA).toBeDefined();
      expect(step?.run).toContain(`--force-with-lease="refs/heads/\${HEAD_REF}:\${HEAD_SHA}"`);
    },
  );
});

describe("lint:yaml", () => {
  test("the composite hands yamllint to exactly the jobs that run it", () => {
    const running = jobsWhere((step) =>
      /\bbun run (?:check|lint:yaml)(?![\w:.-])/.test(step.run ?? ""),
    );
    expect(running.length).toBeGreaterThan(0);
    expect(jobsWhere(setupYamllint)).toEqual(running);
    expect(SCRIPTS.check).toContain("bun run lint:yaml");
  });

  /** The script's exit status from the repository root with PATH cut to the system directories, where yamllint is absent. */
  function lintYamlWithout(env: Record<string, string>): number {
    try {
      execFileSync("bash", ["-c", SCRIPTS["lint:yaml"] ?? ""], {
        cwd: ROOT,
        stdio: "pipe",
        env: { HOME: process.env.HOME ?? "", ...env, PATH: "/usr/bin:/bin" },
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  test("without yamllint a CI run fails and a local run skips", () => {
    expect(lintYamlWithout({ CI: "true" })).toBe(1);
    expect(lintYamlWithout({})).toBe(0);
  });
});

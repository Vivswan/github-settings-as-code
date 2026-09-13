/**
 * Every job of a repo-owned workflow goes through the setup composite (or runs no bun at all) and carries a timeout;
 * every third-party action is one sha with its version comment across the repo-owned files; lint:yaml runs for real
 * where the composite hands the job yamllint. The managed workflows (ci.yml and the fleet's) are the platform's and
 * stay out of every pin here.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlias, isMap, isScalar, LineCounter, parseDocument, visit } from "yaml";
import {
  type CompositeAction,
  installs,
  isManaged,
  type Job,
  ROOT,
  readAction,
  readWorkflow,
  repoOwnedWorkflowFiles,
  SETUP_USES,
  type Step,
  setupInstalls,
  setupYamllint,
  workflowFiles,
  workflowText,
} from "./workflow-loader.js";

const SETUP_DIR = ".github/actions/setup";
const ACTIONS_DIR = ".github/actions";
const YAMLLINT_VERSION = "1.38.0";
/** The composite's header states the rule: 15 minutes unless the job's comment says why it needs more. */
const DEFAULT_TIMEOUT = 15;

const PACKAGE_SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * A job's standing to the composite, or the defect found instead.
 *   install   -> "composite" (the composite's), "own" (a run step's: float-canary re-resolves from scratch), "none"
 *   "no bun"  -> a job no step of which runs bun (a git-only push, a gh-only reporter): nothing to set up
 */
type Setup = { install: string; yamllint: boolean; if: string | undefined } | string;
interface JobPin {
  timeout: number | undefined;
  setup: Setup;
}

const composite = (over: Partial<Exclude<Setup, string>> = {}): Setup => ({
  install: "composite",
  yamllint: false,
  if: undefined,
  ...over,
});

const EXPECTED: Record<string, Record<string, JobPin>> = {
  "auto-fix.yml": {
    build: { timeout: 15, setup: composite() },
    // Downloads the patch and pushes with git alone: no install where the write token is.
    push: { timeout: 10, setup: "no bun" },
  },
  "auto-format.yml": {
    format: { timeout: 15, setup: composite() },
    // Applies the format job's patch and pushes; no PR code runs where the write token is.
    push: { timeout: 10, setup: "no bun" },
  },
  "checks.yml": {
    check: { timeout: 15, setup: composite({ yamllint: true }) },
    "boundary-check": { timeout: 5, setup: composite({ install: "none" }) },
    "anchor-check": { timeout: 5, setup: composite({ install: "none" }) },
    "schema-check": { timeout: 15, setup: composite() },
    "package-smoke": { timeout: 15, setup: composite() },
    "self-check": { timeout: 15, setup: composite() },
    "e2e-smoke": { timeout: 15, setup: composite() },
    "endpoint-coverage": { timeout: 15, setup: composite() },
  },
  "copilot-setup-steps.yml": { "copilot-setup-steps": { timeout: 59, setup: composite() } },
  "e2e-nightly.yml": { nightly: { timeout: 15, setup: composite() } },
  "nightly-fuzz.yml": { fuzz: { timeout: 60, setup: composite() } },
  "nightly.yml": {
    checks: { timeout: 15, setup: composite() },
    "float-canary": { timeout: 15, setup: composite({ install: "own", yamllint: true }) },
    // A few gh calls and the fleet's issue action; no checkout, no bun.
    report: { timeout: 5, setup: "no bun" },
  },
  "post-green.yml": {
    build: { timeout: 10, setup: composite({ if: "steps.token.outputs.proceed == 'true'" }) },
    "publish-next": {
      timeout: 10,
      setup: composite({ if: "steps.oidc.outputs.proceed == 'true'" }),
    },
  },
  "update-release-pr.yml": { anchor: { timeout: 5, setup: composite({ install: "none" }) } },
  "update-release.yml": {
    "package-release": { timeout: 15, setup: composite() },
    "verify-release": { timeout: 5, setup: composite({ install: "none" }) },
    "publish-npm": { timeout: 10, setup: composite() },
  },
};

/** The jobs above the default, each with its reason in the workflow beside the value. */
const LONGER: Record<string, number> = {
  // Copilot's documented ceiling for this job.
  "copilot-setup-steps.yml#copilot-setup-steps": 59,
  // A 50-minute fuzz run bounded below it, so a hang fails instead of cancelling.
  "nightly-fuzz.yml#fuzz": 60,
};

const MANAGED_FILES = ["auto-assign.yml", "ci.yml", "pr-title.yml"];
const SETUP_INPUTS = ["install", "yamllint"];

/** A bun invocation the shell would run: the word `bun` at a command position. */
const RUNS_BUN = /(?:^|[\s;&|(])bun(?=\s|$)/m;
const isSetupBun = (step: Step) => (step.uses ?? "").startsWith("oven-sh/setup-bun@");
const isSetup = (step: Step) => step.uses === SETUP_USES;
/** A step that needs bun on the runner: a run step invoking it, or a local composite (each of ours runs bun). */
const needsBun = (step: Step) =>
  RUNS_BUN.test(step.run ?? "") || (!isSetup(step) && (step.uses ?? "").startsWith("./"));

function setupOf(job: Job): Setup {
  const steps = job.steps ?? [];
  const setups = steps.filter(isSetup);
  const own = steps.some((step) => installs(step.run));
  if (setups.length !== 1) {
    return setups.length === 0 && !steps.some(needsBun) && !steps.some(isSetupBun)
      ? "no bun"
      : `${setups.length} setup steps for a job running bun`;
  }
  if (steps.some(isSetupBun)) {
    return "oven-sh/setup-bun outside the composite";
  }
  const setup = setups[0] as Step;
  const early = steps.slice(0, steps.indexOf(setup)).filter(needsBun);
  if (early.length > 0) {
    return `bun runs before the setup composite: ${early.map((step) => step.name ?? step.uses ?? step.run).join("; ")}`;
  }
  const unknown = Object.keys(setup.with ?? {}).filter((key) => !SETUP_INPUTS.includes(key));
  if (unknown.length > 0) {
    return `unknown setup inputs: ${unknown.join(", ")}`;
  }
  // An expression's value is the runner's to compute; the pin can only read a literal.
  const expressions = SETUP_INPUTS.filter((key) => String(setup.with?.[key] ?? "").includes("${{"));
  if (expressions.length > 0) {
    return `setup inputs given as expressions, not literals: ${expressions.join(", ")}`;
  }
  const install =
    [setupInstalls(setup) ? "composite" : "", own ? "own" : ""].filter(Boolean).join(" and ") ||
    "none";
  return { install, yamllint: setupYamllint(setup), if: setup.if };
}

function pinOf(job: Job): JobPin {
  return { timeout: job["timeout-minutes"], setup: setupOf(job) };
}

function pinsOf(file: string): Record<string, JobPin> {
  return Object.fromEntries(
    Object.entries(readWorkflow(file).jobs).map(([id, job]) => [id, pinOf(job)]),
  );
}

describe("the repo-owned workflows", () => {
  test("the files split into exactly the pinned repo-owned and managed sets", () => {
    expect(repoOwnedWorkflowFiles()).toEqual(Object.keys(EXPECTED).sort());
    expect(workflowFiles().filter((file) => isManaged(workflowText(file)))).toEqual(MANAGED_FILES);
  });

  test("every job goes through the setup composite once (or runs no bun) and carries its pinned timeout", () => {
    expect(
      Object.fromEntries(repoOwnedWorkflowFiles().map((file) => [file, pinsOf(file)])),
    ).toEqual(EXPECTED);
  });

  test(`timeouts above ${DEFAULT_TIMEOUT} minutes are exactly the jobs whose comment says why`, () => {
    const pins = Object.entries(EXPECTED).flatMap(([file, jobs]) =>
      Object.entries(jobs).map(([id, pin]) => [`${file}#${id}`, pin] as const),
    );
    for (const [where, pin] of pins) {
      expect(pin.timeout, `${where} has no timeout`).toBeGreaterThan(0);
    }
    expect(
      Object.fromEntries(
        pins
          .filter(([, pin]) => (pin.timeout ?? 0) > DEFAULT_TIMEOUT)
          .map(([where, pin]) => [where, pin.timeout]),
      ),
    ).toEqual(LONGER);
  });

  const check = () => structuredClone(readWorkflow("checks.yml").jobs.check as Job);
  const setupStep = (job: Job) => (job.steps ?? []).find(isSetup) as Step;

  test.each<[string, (job: Job) => void, JobPin]>([
    [
      "a dropped timeout",
      (job) => delete job["timeout-minutes"],
      { timeout: undefined, setup: composite({ yamllint: true }) },
    ],
    [
      "a job running bun without the composite",
      (job) => (job.steps = job.steps?.filter((step) => !isSetup(step))),
      { timeout: 15, setup: "0 setup steps for a job running bun" },
    ],
    [
      "a duplicated composite",
      (job) => job.steps?.push({ uses: SETUP_USES }),
      { timeout: 15, setup: "2 setup steps for a job running bun" },
    ],
    [
      "the composite moved after the steps that need it",
      (job) => {
        const steps = job.steps ?? [];
        const [setup] = steps.splice(steps.findIndex(isSetup), 1);
        steps.push(setup as Step);
      },
      {
        timeout: 15,
        setup:
          "bun runs before the setup composite: ./.github/actions/fetch-test-artifacts; Lint (biome); Lint (yaml); " +
          "Lint (architecture); Typecheck; Dead code (knip); Compat markers; Test",
      },
    ],
    [
      "one bun step ahead of the composite",
      (job) => job.steps?.splice(1, 0, { run: "bun --version" }),
      { timeout: 15, setup: "bun runs before the setup composite: bun --version" },
    ],
    [
      "setup-bun beside the composite",
      (job) =>
        job.steps?.push({ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" }),
      { timeout: 15, setup: "oven-sh/setup-bun outside the composite" },
    ],
    [
      "setup-bun instead of the composite",
      (job) =>
        (job.steps = job.steps?.map((step) =>
          isSetup(step)
            ? { uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" }
            : step,
        )),
      { timeout: 15, setup: "0 setup steps for a job running bun" },
    ],
    [
      "an inline install beside the composite's",
      (job) => job.steps?.push({ run: "bun install --frozen-lockfile" }),
      { timeout: 15, setup: composite({ install: "composite and own", yamllint: true }) },
    ],
    [
      "a misspelled input",
      (job) => (setupStep(job).with = { yamlint: "true" }),
      { timeout: 15, setup: "unknown setup inputs: yamlint" },
    ],
    [
      "an input given as an expression the runner would evaluate to false",
      (job) => (setupStep(job).with = { install: `\${{ 'false' }}`, yamllint: "true" }),
      { timeout: 15, setup: "setup inputs given as expressions, not literals: install" },
    ],
    [
      "yamllint switched off",
      (job) => (setupStep(job).with = { yamllint: "false" }),
      { timeout: 15, setup: composite() },
    ],
    [
      "the install switched off",
      (job) => (setupStep(job).with = { install: "false", yamllint: "true" }),
      { timeout: 15, setup: composite({ install: "none", yamllint: true }) },
    ],
    // GitHub compares expression strings without regard to letter case, so these spellings switch at runtime too.
    [
      "the install switched off in capitals",
      (job) => (setupStep(job).with = { install: "FALSE", yamllint: "true" }),
      { timeout: 15, setup: composite({ install: "none", yamllint: true }) },
    ],
    [
      "yamllint switched off in capitals",
      (job) => (setupStep(job).with = { yamllint: "False" }),
      { timeout: 15, setup: composite() },
    ],
    [
      "a gated setup",
      (job) => (setupStep(job).if = "github.event_name == 'push'"),
      { timeout: 15, setup: composite({ yamllint: true, if: "github.event_name == 'push'" }) },
    ],
  ])("%s derives away from the pin (negative control)", (_, mutate, derived) => {
    const job = check();
    mutate(job);
    expect(pinOf(job)).toEqual(derived);
    expect(pinOf(job)).not.toEqual(EXPECTED["checks.yml"]?.check as JobPin);
  });

  test("a job with no bun anywhere derives to no bun, and one bun call derives away (negative control)", () => {
    const job: Job = {
      "timeout-minutes": 5,
      steps: [{ run: "gh pr list" }, { uses: "actions/checkout@0" }],
    };
    expect(setupOf(job)).toBe("no bun");
    job.steps?.push({ run: "gh pr list\nbun .github/scripts/release-pipeline.ts verify" });
    expect(setupOf(job)).toBe("0 setup steps for a job running bun");
  });

  test("a local composite (which runs bun) without the setup derives away from no bun (negative control)", () => {
    const job: Job = {
      "timeout-minutes": 5,
      steps: [{ uses: "actions/checkout@0" }, { uses: "./.github/actions/fetch-test-artifacts" }],
    };
    expect(setupOf(job)).toBe("0 setup steps for a job running bun");
  });

  test.each([
    ["a bare command", true, "bun test"],
    ["a command inside a script", true, "echo start\nbun run check"],
    ["a command after a separator", true, "cd lib && bun install"],
    ["a command inside a subshell", true, "out=$(bun --version)"],
    ["the lockfile name", false, "rm bun.lock"],
    ["a word containing it", false, "echo ubuntu bundle"],
    ["a comment naming it", true, "# bun runs here"],
  ])("RUNS_BUN: %s -> %p", (_, expected, run) => {
    expect(RUNS_BUN.test(run)).toBe(expected);
  });
});

/** One `uses:` value and the comment on its line (the text after `#`, trimmed): the version pin lives in that comment. */
interface UsesLine {
  where: string;
  uses: string;
  comment: string;
}

function actionDirs(): string[] {
  return readdirSync(join(ROOT, ACTIONS_DIR))
    .map((name) => `${ACTIONS_DIR}/${name}`)
    .sort();
}

/** Every `uses:` in the YAML syntax tree, block or flow style, an alias resolved, with the comment on its line. */
function usesLinesIn(where: string, text: string): UsesLine[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const lines: UsesLine[] = [];
  visit(doc, {
    Pair(_, pair, path) {
      const written = pair.value;
      const key = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      if (!isScalar(key) || key.value !== "uses") {
        return;
      }
      if (!(isScalar(written) || isAlias(written))) {
        return;
      }
      const node = isAlias(written) ? written.resolve(doc) : written;
      if (!isScalar(node)) {
        return;
      }
      // A flow step's comment (`- {uses: x} # v1`) sits on the enclosing map, not on the scalar.
      const parent = path[path.length - 1];
      const comment =
        written.comment ?? (isMap(parent) && parent.flow ? parent.comment : undefined) ?? "";
      lines.push({
        where: `${where}:${lineCounter.linePos(written.range?.[0] ?? 0).line}`,
        uses: String(node.value),
        comment: comment.trim(),
      });
    },
  });
  return lines;
}

function usesLines(): UsesLine[] {
  return [
    ...repoOwnedWorkflowFiles().flatMap((file) =>
      usesLinesIn(`.github/workflows/${file}`, workflowText(file)),
    ),
    ...actionDirs().flatMap((dir) =>
      usesLinesIn(`${dir}/action.yml`, readFileSync(join(ROOT, dir, "action.yml"), "utf8")),
    ),
  ];
}

const SHA_PIN = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+(?:\.\d+)*$/;
/** The fleet's own actions ride their stable channel by design; any other ref is a pin problem. */
const FLEET_STABLE = /^Vivswan\/repo-platform\/actions\/[\w-]+@stable$/;

/** Why a `uses:` fails the pin policy, or undefined when it passes. */
function pinProblem({ uses, comment }: Pick<UsesLine, "uses" | "comment">): string | undefined {
  if (uses.startsWith("./")) {
    return comment === "" ? undefined : "a local action carries no version comment";
  }
  if (FLEET_STABLE.test(uses)) {
    return undefined;
  }
  if (!SHA_PIN.test(uses)) {
    return "not a full-sha pin";
  }
  if (!VERSION_COMMENT.test(comment)) {
    return "no version comment after the sha";
  }
  return undefined;
}

describe("action pins across the repo-owned files", () => {
  test("every uses: is a local path, the fleet's action on its branch, or a full sha with its version comment", () => {
    const lines = usesLines();
    // Control: the scan reads real lines (a regex drift would pass vacuously).
    expect(lines.length).toBeGreaterThan(30);
    expect(lines.some(({ uses }) => uses === SETUP_USES)).toBe(true);
    expect(
      lines.flatMap((line) => {
        const problem = pinProblem(line);
        return problem ? [`${line.where}: ${line.uses} (${problem})`] : [];
      }),
    ).toEqual([]);
  });

  test("the scan reads block, flow, and aliased steps alike, with the comment and line of each (control)", () => {
    const text = [
      "steps:",
      `  - uses: actions/checkout@${"a".repeat(40)} # v7.0.1`,
      "    with: {ref: main}",
      "  - {uses: actions/checkout@v7}",
      `  - {uses: actions/checkout@${"b".repeat(40)}, with: {ref: main}} # v7.0.2`,
      "  - name: &action actions/checkout@v8",
      "    uses: *action # v8.0.0",
      "  - name: &key uses",
      "    *key : actions/checkout@v9",
      "  # uses: commented/out@v1",
      "  - uses: ./.github/actions/setup",
      "",
    ].join("\n");
    expect(usesLinesIn("x.yml", text)).toEqual([
      { where: "x.yml:2", uses: `actions/checkout@${"a".repeat(40)}`, comment: "v7.0.1" },
      { where: "x.yml:4", uses: "actions/checkout@v7", comment: "" },
      { where: "x.yml:5", uses: `actions/checkout@${"b".repeat(40)}`, comment: "v7.0.2" },
      { where: "x.yml:7", uses: "actions/checkout@v8", comment: "v8.0.0" },
      { where: "x.yml:9", uses: "actions/checkout@v9", comment: "" },
      { where: "x.yml:11", uses: "./.github/actions/setup", comment: "" },
    ]);
  });

  test.each([
    ["a tag ref", "actions/checkout@v7", "", "not a full-sha pin"],
    ["a short sha", "actions/checkout@3d3c42e", "v7.0.1", "not a full-sha pin"],
    [
      "a sha without its comment",
      `actions/checkout@${"a".repeat(40)}`,
      "",
      "no version comment after the sha",
    ],
    [
      "a sha with a prose comment",
      `actions/checkout@${"a".repeat(40)}`,
      "pinned",
      "no version comment after the sha",
    ],
    [
      "the fleet's action at a tag",
      "Vivswan/repo-platform/actions/fuzz-issue@v1",
      "",
      "not a full-sha pin",
    ],
    [
      "the fleet's action on its stable channel",
      "Vivswan/repo-platform/actions/fuzz-issue@stable",
      "",
      undefined,
    ],
    [
      "the fleet's action on the branch it left",
      "Vivswan/repo-platform/actions/fuzz-issue@build",
      "",
      "not a full-sha pin",
    ],
    [
      "the fleet's action at a sha",
      `Vivswan/repo-platform/actions/fuzz-issue@${"b".repeat(40)}`,
      "v1.2.0",
      undefined,
    ],
    ["a local action", "./.github/actions/setup", "", undefined],
    [
      "a local action with a comment",
      "./.github/actions/setup",
      "v1",
      "a local action carries no version comment",
    ],
    ["the action root", "./", "", undefined],
  ])("pinProblem(): %s", (_, uses, comment, problem) => {
    expect(pinProblem({ uses, comment })).toBe(problem);
  });

  test("each third-party action is one sha and one version everywhere it appears", () => {
    const byAction = new Map<string, Set<string>>();
    for (const { uses, comment } of usesLines()) {
      if (!SHA_PIN.test(uses)) {
        continue;
      }
      const [action, sha] = uses.split("@") as [string, string];
      byAction.set(action, (byAction.get(action) ?? new Set()).add(`${sha} ${comment}`));
    }
    expect([...byAction.keys()].sort()).toEqual([
      "actions/cache",
      "actions/checkout",
      "actions/download-artifact",
      "actions/setup-node",
      "actions/upload-artifact",
      "marocchino/sticky-pull-request-comment",
      "oven-sh/setup-bun",
    ]);
    for (const [action, pins] of byAction) {
      expect([...pins], `${action} is pinned ${pins.size} ways`).toHaveLength(1);
    }
  });
});

/** A composite step as the pin reads it: the fields that decide what runs and whether a failure counts. */
interface StepShape {
  uses: string | undefined;
  with: Record<string, unknown> | undefined;
  if: string | undefined;
  shell: string | undefined;
  run: string | undefined;
  "continue-on-error": boolean | undefined;
}

function shapeOf(steps: Step[]): StepShape[] {
  return steps.map((step) => ({
    uses: step.uses,
    with: step.with,
    if: step.if,
    shell: step.shell,
    run: step.run,
    "continue-on-error": step["continue-on-error"],
  }));
}

/** The composite's three steps: none may mask its failure, since a job relies on each one it asks for. */
const SETUP_SHAPE: StepShape[] = [
  {
    uses: expect.stringMatching(/^oven-sh\/setup-bun@[0-9a-f]{40}$/),
    with: { "bun-version-file": ".bun-version" },
    if: undefined,
    shell: undefined,
    run: undefined,
    "continue-on-error": undefined,
  },
  {
    uses: undefined,
    with: undefined,
    if: "inputs.install != 'false'",
    shell: "bash",
    run: "bun install --frozen-lockfile --ignore-scripts",
    "continue-on-error": undefined,
  },
  {
    uses: undefined,
    with: undefined,
    if: "inputs.yamllint == 'true'",
    shell: "bash",
    run: `pipx install yamllint==${YAMLLINT_VERSION}`,
    "continue-on-error": undefined,
  },
];

describe("the setup composite", () => {
  const action = readAction(SETUP_DIR);

  test("declares the two inputs with their defaults and runs bun, the gated install, and the gated yamllint", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toEqual({
      install: { description: expect.any(String), default: "true" },
      yamllint: { description: expect.any(String), default: "false" },
    });
    expect(shapeOf(action.runs.steps ?? [])).toEqual(SETUP_SHAPE);
  });

  test.each<[string, (step: Step) => Step]>([
    ["an install allowed to fail", (step) => ({ ...step, "continue-on-error": true })],
    ["an install with its lockfile unfrozen", (step) => ({ ...step, run: "bun install" })],
    [
      "an install that runs lifecycle scripts",
      (step) => ({ ...step, run: "bun install --frozen-lockfile" }),
    ],
    [
      "an install gated on a different spelling",
      (step) => ({ ...step, if: "inputs.install == 'true'" }),
    ],
  ])("%s inside the composite fails the shape pin (negative control)", (_, mutate) => {
    const steps = (action.runs.steps ?? []).map((step) =>
      step.run?.startsWith("bun install") ? mutate(step) : step,
    );
    expect(() => expect(shapeOf(steps)).toEqual(SETUP_SHAPE)).toThrow();
  });

  test("every run step of every composite names its shell (the runner rejects one without at job start)", () => {
    for (const dir of actionDirs()) {
      for (const step of readAction(dir).runs.steps ?? []) {
        if (step.run !== undefined) {
          expect(step.shell, `${dir}: step ${step.name ?? step.id ?? step.run}`).toBe("bash");
        }
      }
    }
  });

  /** The composites (by directory) whose steps run oven-sh/setup-bun: a second one would replace the pinned bun. */
  const setupBunHosts = (actions: ReadonlyArray<[string, CompositeAction]>) =>
    actions.filter(([, action]) => (action.runs.steps ?? []).some(isSetupBun)).map(([dir]) => dir);

  test("oven-sh/setup-bun runs in the setup composite and nowhere else", () => {
    expect(setupBunHosts(actionDirs().map((dir) => [dir, readAction(dir)]))).toEqual([SETUP_DIR]);
  });

  test("a setup-bun added to another composite is reported by directory (negative control)", () => {
    const fetch = structuredClone(readAction(`${ACTIONS_DIR}/fetch-test-artifacts`));
    fetch.runs.steps?.unshift({
      uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      with: { "bun-version": "latest" },
    });
    expect(
      setupBunHosts([
        [`${ACTIONS_DIR}/fetch-test-artifacts`, fetch],
        [SETUP_DIR, action],
      ]),
    ).toEqual([`${ACTIONS_DIR}/fetch-test-artifacts`, SETUP_DIR]);
  });
});

/** A job's run steps name lint:yaml, directly or through `bun run check`. */
const RUNS_LINT_YAML = /\bbun run (?:check|lint:yaml)(?![\w:.-])/;

/** `<workflow file>#<job id>` for every repo-owned job with a step matching `test`. */
function jobsWhere(test: (step: Step) => boolean): string[] {
  return repoOwnedWorkflowFiles()
    .flatMap((file) =>
      Object.entries(readWorkflow(file).jobs)
        .filter(([, job]) => (job.steps ?? []).some(test))
        .map(([id]) => `${file}#${id}`),
    )
    .sort();
}

interface LintYamlRun {
  status: number;
  stdout: string;
  stderr: string;
  /** The arguments the yamllint stub saw, one per line; undefined when it was never called. */
  calls: string[] | undefined;
}

/**
 * The lint:yaml script under bash from the repository root, PATH cut to the system directories plus a stub bin: with
 * the stub, yamllint records its arguments; without it, `command -v yamllint` fails. The scratch directory is
 * removed on every path.
 */
function runLintYaml(env: Record<string, string>, stub: boolean): LintYamlRun {
  const dir = mkdtempSync(join(tmpdir(), "lint-yaml-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls");
    if (stub) {
      writeFileSync(join(bin, "yamllint"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\n`, {
        mode: 0o755,
      });
    }
    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync("bash", ["-c", PACKAGE_SCRIPTS["lint:yaml"] ?? ""], {
        cwd: ROOT,
        encoding: "utf8",
        env: { HOME: process.env.HOME ?? "", ...env, PATH: `${bin}:/usr/bin:/bin` },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      stdout = String((error as { stdout?: string }).stdout ?? "");
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }
    return {
      status,
      stdout,
      stderr,
      calls: existsSync(calls)
        ? readFileSync(calls, "utf8").split("\n").filter(Boolean)
        : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("lint:yaml", () => {
  test("the composite hands yamllint to exactly the jobs that run it", () => {
    const running = jobsWhere((step) => RUNS_LINT_YAML.test(step.run ?? ""));
    expect(running).toEqual(["checks.yml#check", "nightly.yml#float-canary"]);
    expect(jobsWhere(setupYamllint)).toEqual(running);
    // The check script is what float-canary runs; it must carry lint:yaml for the derivation above to mean anything.
    expect(PACKAGE_SCRIPTS.check).toContain("bun run lint:yaml");
  });

  test.each([
    ["bun run check", true],
    ["bun run lint:yaml", true],
    ["bun run check:compat", false],
    ["bun run lint", false],
    ["bun run build:check", false],
  ])("RUNS_LINT_YAML: %j -> %p", (run, expected) => {
    expect(RUNS_LINT_YAML.test(run)).toBe(expected);
  });

  test("with yamllint on PATH it lints every tracked yaml file in strict mode", () => {
    const run = runLintYaml({}, true);
    expect(run.status).toBe(0);
    expect(run.calls?.[0]).toBe("-s");
    expect(run.calls).toContain(".github/workflows/checks.yml");
    expect(run.calls).toContain("architecture.yml");
    expect(run.calls?.some((arg) => arg.endsWith(".json"))).toBe(false);
  });

  test("without yamllint a CI run fails naming the composite input (control: the skip is local-only)", () => {
    const run = runLintYaml({ CI: "true" }, false);
    expect(run.status).toBe(1);
    expect(run.calls).toBeUndefined();
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toBe(
      'lint:yaml: yamllint is missing on this runner; the job needs ./.github/actions/setup with yamllint: "true"',
    );
  });

  test("without yamllint a local run says it skipped and passes", () => {
    const run = runLintYaml({}, false);
    expect(run.status).toBe(0);
    expect(run.calls).toBeUndefined();
    expect(run.stdout.trim()).toBe(
      "lint:yaml: yamllint not installed, skipping (CI runs it; install with pip install yamllint or brew install yamllint)",
    );
  });
});

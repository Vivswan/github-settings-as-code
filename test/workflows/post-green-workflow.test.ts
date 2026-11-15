/**
 * The hooks ci.yml calls after the all-green gate (post-green.yml, update-release.yml, update-release-pr.yml) push refs, so what
 * they can do follows from where they are reachable and what each job is granted. The relations here: every hook is reachable
 * through workflow_call alone and its ci.yml caller sits downstream of all-green; a job's effective grant covers what its steps
 * consume; a hook job's own condition is the fork guard or nothing; post-green's judged sha reaches every checkout and every step
 * that names a source; no step runs under a condition of its own, every output a step writes is read by a later step, and
 * every read names an output an earlier step writes.
 * The static guards catch ACCIDENTAL drift: a trigger, grant, gate, or step added or dropped in plain YAML. Deliberately hiding
 * one behind other syntax is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP_OUTPUTS as RELEASE_PIPELINE_OUTPUTS } from "../../.github/scripts/release-pipeline/draft.js";
import { COMMANDS as RELEASE_PIPELINE_COMMANDS } from "../../.github/scripts/release-pipeline.js";
import { tableRows } from "../docs/markdown.js";
import { ROOT } from "../root.js";
import { runStep } from "../scripts/step-fixture.js";
import { withTempDir } from "../temp-dir.js";
import { type Job, readWorkflow, type Step, type Workflow } from "./workflow-loader.js";

const CI = readWorkflow("ci.yml");
const CALLER_PREFIX = "./.github/workflows/";

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** A step condition as the runner evaluates it: with or without the `${{ }}` wrapper, whitespace aside. */
const condition = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .trim();

/** A job's `needs`, one or many, as a list. */
const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

/** Every job reachable from `gate` by following `needs` edges away from it, however many hops. */
function downstreamOf(jobs: Record<string, Job>, gate: string): Set<string> {
  const downstream = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, job] of Object.entries(jobs)) {
      if (downstream.has(name)) continue;
      if (needsOf(job).some((dep) => dep === gate || downstream.has(dep))) {
        downstream.add(name);
        grew = true;
      }
    }
  }
  return downstream;
}

interface LocalCall {
  caller: string;
  job: Job;
  file: string;
}

/** ci.yml's calls of this repository's own workflows: the calling job and the callee file. */
const localCalls = (ci: Workflow): LocalCall[] =>
  Object.entries(ci.jobs).flatMap(([caller, job]) =>
    (job.uses ?? "").startsWith(CALLER_PREFIX)
      ? [{ caller, job, file: (job.uses ?? "").slice(CALLER_PREFIX.length) }]
      : [],
  );

/**
 * The hooks: every local call whose caller the gate does not itself judge (the judged call is what all-green needs). Each must sit
 * downstream of the gate; `misplaced` names the ones that do not.
 */
function postGateHooks(ci: Workflow): { hooks: LocalCall[]; misplaced: string[] } {
  const judged = new Set(needsOf(ci.jobs["all-green"]));
  const downstream = downstreamOf(ci.jobs, "all-green");
  const hooks = localCalls(ci).filter(({ caller }) => !judged.has(caller));
  return {
    hooks,
    misplaced: hooks.filter(({ caller }) => !downstream.has(caller)).map(({ caller }) => caller),
  };
}

const { hooks: HOOKS } = postGateHooks(CI);

/** The `owner/name` the manifest's repository URL names: the one repository whose CI is the publisher. */
function manifestSlug(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    repository: { url: string };
  };
  return must(
    pkg.repository.url.match(/^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/)?.[1],
    "owner/name in package.json's repository.url",
  );
}

describe("the hooks ci.yml calls after the gate", () => {
  test("every hook is reachable through workflow_call alone, and its caller sits downstream of all-green", () => {
    const { misplaced } = postGateHooks(CI);
    // Non-vacuity: the packaging hook and the two release hooks are called this way today.
    expect(HOOKS.map((hook) => hook.file)).toContain("post-green.yml");
    expect(HOOKS.length).toBeGreaterThan(2);
    expect(misplaced, "hook callers that all-green does not gate").toEqual([]);
    for (const { file } of HOOKS) {
      expect(
        Object.keys(readWorkflow(file).on),
        `${file} is reachable outside ci.yml's gate`,
      ).toEqual(["workflow_call"]);
    }
    // The judged call (checks.yml) is not a hook: it is what the gate waits for.
    expect(localCalls(CI).map((call) => call.file)).toContain("checks.yml");
    expect(HOOKS.map((hook) => hook.file)).not.toContain("checks.yml");
  });

  test.each(HOOKS.map((hook) => [hook.file, hook.job] as const))(
    "%s: ci.yml passes exactly the inputs it declares",
    (file, job) => {
      const declared = Object.keys(readWorkflow(file).on.workflow_call?.inputs ?? {}).sort();
      expect(Object.keys(job.with ?? {}).sort()).toEqual(declared);
    },
  );

  test.each(HOOKS.map((hook) => [hook.file] as const))(
    "%s: a job's own condition is the fork guard or nothing, so no job skips a green push quietly",
    (file) => {
      const guard = `github.repository == '${manifestSlug()}'`;
      for (const [id, job] of Object.entries(readWorkflow(file).jobs)) {
        if (job.if !== undefined) {
          expect(condition(job.if), `${file}#${id} carries a condition of its own`).toBe(guard);
        }
      }
    },
  );

  test("a hook that grew a dispatch trigger, and a release hook moved ahead of the gate, both fail (negative controls)", () => {
    const dispatchable = structuredClone(readWorkflow("post-green.yml"));
    dispatchable.on.workflow_dispatch = null;
    expect(Object.keys(dispatchable.on)).not.toEqual(["workflow_call"]);
    const ci = structuredClone(CI);
    must(ci.jobs["update-release"], "update-release caller").needs = ["ci"];
    expect(postGateHooks(ci).misplaced).toEqual(["update-release"]);
  });
});

/**
 * The grant a step's commands consume: a push, a release read or write (drafts are visible to a write grant alone), or a pipeline
 * subcommand that pushes needs contents: write; an OIDC-authenticated publish needs id-token: write.
 */
function consumedGrants(step: Step): Array<[scope: string, why: string]> {
  const run = step.run ?? "";
  const label = step.name ?? "unnamed step";
  const grants: Array<[string, string]> = [];
  if (
    /\bgit\s+push\b|\bgh\s+release\s+(?:view|upload|edit|create)\b/.test(run) ||
    /release-pipeline\.ts (?:package|package-commit|retag-major|rename-draft|resolve-source|verify-assets)\b/.test(
      run,
    )
  ) {
    grants.push(["contents", `"${label}" pushes or touches a release`]);
  }
  if (/\bnpm\s+publish\b|ACTIONS_ID_TOKEN_REQUEST_URL/.test(run)) {
    grants.push(["id-token", `"${label}" publishes through OIDC`]);
  }
  return grants;
}

/** A called job's grant: its own permissions block, else its workflow's, else the caller's (GitHub applies the nearest block; a called job with none inherits the caller's). */
const effectiveGrant = (job: Job, workflow: Workflow, caller: Job): Record<string, string> =>
  job.permissions ?? workflow.permissions ?? caller.permissions ?? {};

/** Every hook job whose steps consume a grant its effective permissions do not hold. */
function grantProblems(
  hooks: LocalCall[],
  read: (file: string) => Workflow = readWorkflow,
): string[] {
  return hooks.flatMap(({ file, job: caller }) => {
    const workflow = read(file);
    return Object.entries(workflow.jobs).flatMap(([id, job]) => {
      const granted = effectiveGrant(job, workflow, caller);
      return (job.steps ?? [])
        .flatMap(consumedGrants)
        .filter(([scope]) => granted[scope] !== "write")
        .map(([scope, why]) => `${file}#${id}: ${why}, so it needs ${scope}: write`);
    });
  });
}

describe("the hooks' grants", () => {
  test("every job's effective grant covers what its steps consume", () => {
    const consumers = HOOKS.flatMap(({ file }) =>
      Object.values(readWorkflow(file).jobs).flatMap((job) =>
        (job.steps ?? []).flatMap(consumedGrants),
      ),
    );
    expect(consumers.length).toBeGreaterThan(4);
    expect(grantProblems(HOOKS)).toEqual([]);
  });

  test("a caller ceiling below what the build job pushes with fails the grant relation (negative control)", () => {
    // The build job declares no grant of its own, so the caller's ceiling is what it runs under.
    const hooks = structuredClone(HOOKS).map((hook) =>
      hook.file === "post-green.yml"
        ? { ...hook, job: { ...hook.job, permissions: { contents: "read", "id-token": "write" } } }
        : hook,
    );
    expect(grantProblems(hooks).join("\n")).toMatch(
      /post-green\.yml#build: .* needs contents: write/,
    );
  });

  test.each<[string, string, string, Record<string, string>, RegExp]>([
    [
      "a package job narrowed to read while its source step reads the draft",
      "update-release.yml",
      "package-release",
      { contents: "read" },
      /update-release\.yml#package-release: "Resolve the release's merge commit from the draft" pushes or touches a release/,
    ],
    [
      "a verify job narrowed to read while its asset step reads the draft",
      "update-release.yml",
      "verify-release",
      { contents: "read" },
      /update-release\.yml#verify-release: "Confirm the release carries both packaged assets" pushes or touches a release/,
    ],
  ])("%s fails the grant relation (negative control)", (_case, file, id, permissions, message) => {
    const narrowed = readWorkflow(file);
    must(narrowed.jobs[id], `${id} job`).permissions = permissions;
    const read = (candidate: string) => (candidate === file ? narrowed : readWorkflow(candidate));
    expect(grantProblems(HOOKS, read).join("\n")).toMatch(message);
  });
});

/** What a library-page claim says something runs on. */
type Trigger = "a release cut" | "a release-PR refresh" | "a green push to main";

/** The trigger a library-page claim names: a release cut, a release-PR refresh, else a green push to main. */
function triggerOf(claim: string): Trigger {
  if (/release cut/i.test(claim)) {
    return "a release cut";
  }
  if (/release PR/i.test(claim)) {
    return "a release-PR refresh";
  }
  return "a green push to main";
}

/**
 * Whether a ci.yml job's own condition runs it on the trigger. A green push: the condition names the push event and the main ref
 * beside the gate's success; a release cut: release-please's release_created output; a release-PR refresh: its prs_created output.
 */
function runsOn(job: Job, trigger: Trigger): boolean {
  const on = condition(job.if);
  switch (trigger) {
    case "a release cut":
      return /release_created == 'true'/.test(on);
    case "a release-PR refresh":
      return /prs_created == 'true'/.test(on);
    default:
      return (
        /needs\.all-green\.result == 'success'/.test(on) &&
        /github\.event_name == 'push'/.test(on) &&
        /github\.ref == 'refs\/heads\/main'/.test(on)
      );
  }
}

/** The hook a library-page claim about "every green push" points at, by its ci.yml caller's condition: one caller, or the claim points at nothing. */
function hookFor(claim: string): { file: string; workflow: Workflow } {
  const trigger = triggerOf(claim);
  const matching = HOOKS.filter(({ job }) => runsOn(job, trigger));
  expect(
    matching.map((hook) => hook.file),
    `exactly one hook caller runs on ${trigger}`,
  ).toHaveLength(1);
  const hook = matching[0] as LocalCall;
  return { file: hook.file, workflow: readWorkflow(hook.file) };
}

/** Whether some step of the workflow runs the pipeline subcommand (with its argument, when one is named) on every run its job takes: the step carries no condition. */
const runsSubcommand = (workflow: Workflow, subcommand: string): boolean =>
  Object.values(workflow.jobs).some((job) =>
    (job.steps ?? []).some(
      (step) =>
        new RegExp(`release-pipeline\\.ts ${subcommand}(?![\\w-])`).test(step.run ?? "") &&
        step.if === undefined,
    ),
  );

/** ci.yml's legs that publish a channel to npm: the calls of the platform's npm publish workflow passing that channel. */
const npmLegs = (ci: Workflow, channel: string): Job[] =>
  Object.values(ci.jobs).filter(
    (job) => /\/fleet-npm-publish\.yml@/.test(job.uses ?? "") && job.with?.channel === channel,
  );

/** The library page's claims about what publishes when, against the ci.yml legs that publish and the steps the green-push hook runs. */
function claimProblems(page: string, ci: Workflow = CI): string[] {
  const problems: string[] = [];
  const rows = tableRows(page).filter(([span]) => span === "`next`" || span === "`latest`");
  if (rows.length !== 2)
    problems.push("the dist-tag table no longer has a next row and a latest row");
  for (const [span = "", publishesOn = ""] of rows) {
    const channel = span.slice(1, -1);
    const trigger = triggerOf(publishesOn);
    const legs = npmLegs(ci, channel);
    if (legs.length !== 1 || !legs.every((leg) => runsOn(leg, trigger))) {
      problems.push(
        `the page says ${channel} publishes on "${publishesOn.trim()}", but ci.yml has no one ${channel} leg running on ${trigger}`,
      );
    }
  }
  const build = page.match(/^- Every green push to `main` mints one under the tag `build\//m);
  if (!build) problems.push("the page no longer claims every green push mints a build tag");
  else if (!runsSubcommand(hookFor("green push").workflow, "package-commit")) {
    problems.push(
      "the page says every green push mints a build tag, but the green-push hook runs no package-commit",
    );
  }
  return problems;
}

describe("the library page's publishing claims", () => {
  const page = readFileSync(join(ROOT, "docs", "reference", "library.md"), "utf8");

  test("each channel the page says publishes on a release-PR refresh or a release cut is published by that ci.yml leg", () => {
    expect(claimProblems(page)).toEqual([]);
  });

  test("a green-push caller widened to pull requests matches no claim (negative control)", () => {
    const ci = structuredClone(CI);
    must(ci.jobs["post-green"], "post-green caller").if =
      "needs.all-green.result == 'success' && github.event_name == 'pull_request'";
    const widened = postGateHooks(ci).hooks.filter(({ job }) => {
      const on = condition(job.if);
      return (
        /github\.event_name == 'push'/.test(on) && /github\.ref == 'refs\/heads\/main'/.test(on)
      );
    });
    expect(widened.map((hook) => hook.file)).not.toContain("post-green.yml");
  });

  test("a packaging step gone, a channel's leg gone, or next claimed back on the green push, fails the claim (negative control)", () => {
    const { workflow } = hookFor("green push");
    const build = must(workflow.jobs.build, "build job");
    build.steps = build.steps?.filter((step) => !/package-commit/.test(step.run ?? ""));
    expect(runsSubcommand(workflow, "package-commit")).toBe(false);
    expect(
      claimProblems(
        page.replace(/^\| `next` +\| [^|]+\|/m, "| `next` | Every green push to `main` |"),
      ),
    ).toEqual([
      'the page says next publishes on "Every green push to `main`", but ci.yml has no one next leg running on a green push to main',
    ]);
    // A ci.yml without the release's leg publishes no release, whatever the page says.
    const legless = structuredClone(CI);
    for (const [id, job] of Object.entries(legless.jobs)) {
      if (job.with?.channel === "latest") delete legless.jobs[id];
    }
    expect(claimProblems(page, legless)).toEqual([
      'the page says latest publishes on "Every release cut", but ci.yml has no one latest leg running on a release cut',
    ]);
  });
});

/** A bun invocation of a steps script's subcommand (assignments may sit ahead of bun, arguments after it), capturing the script's name and the subcommand; tokens part by spaces or tabs only, since bash ends a command at a newline. */
const SCRIPT_STEP =
  /^(?:[A-Za-z_]\w*="[^"]*"[ \t]+)*bun[ \t]+\.github\/scripts\/([\w-]+)\.ts[ \t]+([\w-]+)(?:[ \t]+[\w-]+)*$/;

/** Any step whose run hands bun a steps script, however it is spelled (flags, `bun run`, other separators, a line continuation); one SCRIPT_STEP cannot read is a shape to extend it for, never one to pass unjudged. */
const RUNS_SCRIPT = /\bbun\b[\s\S]*\.github\/scripts\//;

/** The steps scripts a hook may run: the subcommands each dispatches and what those write to GITHUB_OUTPUT, declared by the script beside the code that does it; a step naming a script or subcommand outside this is a wiring fault. */
const SCRIPTS = new Map<
  string,
  { commands: Readonly<Record<string, unknown>>; outputs: Record<string, readonly string[]> }
>([
  ["release-pipeline", { commands: RELEASE_PIPELINE_COMMANDS, outputs: RELEASE_PIPELINE_OUTPUTS }],
]);

/** The script and subcommand a step runs, when its run is one SCRIPT_STEP shape. */
const scriptStep = (step: Step): [script: string, command: string] | undefined => {
  const match = (step.run ?? "").trim().match(SCRIPT_STEP);
  return match ? [match[1] ?? "", match[2] ?? ""] : undefined;
};

/** Every `<name>` a step writes to GITHUB_OUTPUT: a shell step's echo lines, or a script subcommand's declared outputs. */
const outputsWritten = (step: Step): string[] => {
  const run = (step.run ?? "").trim();
  const script = scriptStep(step);
  if (script) {
    const outputs = SCRIPTS.get(script[0])?.outputs ?? {};
    return Object.hasOwn(outputs, script[1]) ? [...(outputs[script[1]] ?? [])] : [];
  }
  return [...run.matchAll(/echo "([\w-]+)=[^"]*" >> "\$GITHUB_OUTPUT"/g)].map((m) => m[1] ?? "");
};

/** Every `steps.<id>.outputs.<name>` a step reads, in its condition, env, with, or script. */
const outputsRead = (step: Step): Array<[id: string, name: string]> =>
  [
    step.if ?? "",
    step.run ?? "",
    ...Object.values(step.env ?? {}),
    ...Object.values(step.with ?? {}).map(String),
  ].flatMap((text) =>
    [...text.matchAll(/\bsteps\.([\w-]+)\.outputs\.([\w-]+)/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as [string, string],
    ),
  );

/** The fault in a steps-script step, as the clause after its name: a script this relation does not know, or a subcommand its script does not dispatch; null for any other step. */
function scriptFault(step: Step): string | null {
  const script = scriptStep(step);
  if (!script) return null;
  const [name, command] = script;
  const known = SCRIPTS.get(name);
  if (known === undefined) {
    return `runs .github/scripts/${name}.ts, a script this relation does not know`;
  }
  if (!Object.hasOwn(known.commands, command)) {
    return `runs ${name} ${command}, a subcommand .github/scripts/${name}.ts does not dispatch`;
  }
  return null;
}

/** The outputs the step at `index` reads that no earlier step writes, as `steps.<id>.outputs.<name>`. */
function unwrittenReads(steps: Step[], index: number): string[] {
  return outputsRead(steps[index] as Step).flatMap(([source, name]) => {
    const writer = steps.findIndex((s, at) => at < index && s.id === source);
    const unwritten = writer < 0 || !outputsWritten(steps[writer] as Step).includes(name);
    return unwritten ? [`steps.${source}.outputs.${name}`] : [];
  });
}

/** The outputs the step at `index` writes that no later step reads. */
function unreadWrites(steps: Step[], index: number): string[] {
  const step = steps[index] as Step;
  if (step.id === undefined) return [];
  const later = steps.slice(index + 1);
  return outputsWritten(step).filter(
    (name) =>
      !later.some((other) => outputsRead(other).some(([s, n]) => s === step.id && n === name)),
  );
}

/** The wiring faults of the step at `index`, each as the clause after the step's name. */
function stepWiringFaults(steps: Step[], index: number): string[] {
  const step = steps[index] as Step;
  const faults: string[] = [];
  const script = scriptFault(step);
  if (script !== null) faults.push(script);
  if (step.if !== undefined) {
    // A hook runs on the caller's event, so a step's own condition skips it quietly: retag-major on a release.
    faults.push("runs under a condition of its own");
  }
  for (const read of unwrittenReads(steps, index)) {
    faults.push(`reads ${read}, which no earlier step writes`);
  }
  for (const name of unreadWrites(steps, index)) {
    faults.push(`writes ${name}, which no later step reads`);
  }
  return faults;
}

/**
 * Every wiring fault in a job's steps: a step under a condition of its own (it would skip on the caller's own event), a read of
 * an output no earlier step writes, a written output nobody reads, and a steps-script step naming a script or subcommand
 * nothing dispatches (bun would end it red, but only once the hook runs on main).
 */
function wiringProblems(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const steps = job.steps ?? [];
    const label = (step: Step) => `"${step.name ?? step.uses ?? "unnamed step"}"`;
    const problems: string[] = [];
    steps.forEach((step, index) => {
      for (const fault of stepWiringFaults(steps, index)) {
        problems.push(`${id}: ${label(step)} ${fault}`);
      }
    });
    return problems;
  });
}

/** The post-green hook. */
const POST_GREEN = "post-green.yml";

/** The release hook. */
const RELEASE = "update-release.yml";

describe("the hooks' wiring", () => {
  const workflow = readWorkflow(POST_GREEN);
  const caller = must(
    HOOKS.find((call) => call.file === POST_GREEN),
    "post-green caller",
  ).job;

  test("no step runs under a condition of its own, every read names a written output, every output is read, in every hook", () => {
    // Every step that runs a steps script is one the relation reads: a run shape SCRIPT_STEP misses would pass unjudged.
    const scriptSteps = HOOKS.flatMap(({ file }) =>
      Object.values(readWorkflow(file).jobs).flatMap((job) =>
        (job.steps ?? []).filter((step) => RUNS_SCRIPT.test(step.run ?? "")),
      ),
    );
    expect(scriptSteps.length).toBeGreaterThan(5);
    expect(scriptSteps.filter((step) => scriptStep(step) === undefined)).toEqual([]);
    // The control's own control: a run bash would split at the newline, a bun flag, `bun run`, a line continuation, and
    // a prefix bash reads as a command rather than an assignment are each detected and not read, so a hook step in any
    // of those shapes fails here instead of passing unjudged.
    for (const run of [
      "bun .github/scripts/release-pipeline.ts\npackage",
      "bun --silent .github/scripts/release-pipeline.ts package",
      "bun run .github/scripts/release-pipeline.ts package",
      "bun \\\n  .github/scripts/release-pipeline.ts package",
      '1GITHUB_SHA="$SOURCE_SHA" bun .github/scripts/release-pipeline.ts package',
    ]) {
      expect([RUNS_SCRIPT.test(run), scriptStep({ run })], run).toEqual([true, undefined]);
    }
    for (const { file } of HOOKS) {
      expect(wiringProblems(readWorkflow(file)), file).toEqual([]);
    }
  });

  test.each<[string, string, (w: Workflow) => void, RegExp]>([
    [
      "the source step's readers gone, leaving the resolved sha unread",
      RELEASE,
      (w) => {
        const steps = must(w.jobs["package-release"], "package-release").steps ?? [];
        steps.splice(steps.findIndex((step) => step.id === "source") + 1);
      },
      /writes sha, which no later step reads/,
    ],
    [
      "a checkout under a condition of its own",
      POST_GREEN,
      (w) => {
        must(must(w.jobs.build, "build").steps?.[0], "checkout").if =
          "github.event_name == 'release'";
      },
      /"actions\/checkout@[0-9a-f]+" runs under a condition of its own/,
    ],
    [
      "the resolved sha no longer written",
      RELEASE,
      (w) => {
        const steps = must(w.jobs["package-release"], "package-release").steps ?? [];
        const step = must(
          steps.find((candidate) => candidate.id === "source"),
          "source",
        );
        step.run = step.run?.replace("resolve-source", "verify-assets");
      },
      /reads steps\.source\.outputs\.sha, which no earlier step writes/,
    ],
    [
      "the source step without its id, leaving its readers no writer",
      RELEASE,
      (w) => {
        const steps = must(w.jobs["package-release"], "package-release").steps ?? [];
        delete must(
          steps.find((candidate) => candidate.id === "source"),
          "source",
        ).id;
      },
      /reads steps\.source\.outputs\.sha, which no earlier step writes/,
    ],
    [
      "a step running a script that does not exist, its tokens spaced as the shell allows",
      POST_GREEN,
      (w) => {
        const step = must(must(w.jobs.build, "build").steps?.at(-1), "packaging step");
        step.run = step.run?.replace(
          "bun .github/scripts/release-pipeline.ts",
          "bun  .github/scripts/release-pipe.ts",
        );
      },
      /runs \.github\/scripts\/release-pipe\.ts, a script this relation does not know/,
    ],
    [
      "a step running a script named like a property every object inherits",
      POST_GREEN,
      (w) => {
        const step = must(must(w.jobs.build, "build").steps?.at(-1), "packaging step");
        step.run = step.run?.replace("release-pipeline.ts", "constructor.ts");
      },
      /runs \.github\/scripts\/constructor\.ts, a script this relation does not know/,
    ],
    [
      "a known script with a subcommand it does not dispatch",
      POST_GREEN,
      (w) => {
        const step = must(must(w.jobs.build, "build").steps?.at(-1), "packaging step");
        step.run = step.run?.replace("package-commit", "package-commits");
      },
      /runs release-pipeline package-commits, a subcommand \.github\/scripts\/release-pipeline\.ts does not dispatch/,
    ],
    [
      "a known script with a subcommand named like a property every object inherits",
      RELEASE,
      (w) => {
        const steps = must(w.jobs["package-release"], "package-release").steps ?? [];
        const step = must(
          steps.find((candidate) => /release-pipeline\.ts package$/.test(candidate.run ?? "")),
          "package step",
        );
        step.run = step.run?.replace(/package$/, "constructor");
      },
      /runs release-pipeline constructor, a subcommand \.github\/scripts\/release-pipeline\.ts does not dispatch/,
    ],
  ])("%s fails the wiring relation (negative control)", (_case, file, mutate, message) => {
    const drifted = readWorkflow(file);
    mutate(drifted);
    expect(wiringProblems(drifted).join("\n")).toMatch(message);
  });

  const gateSteps = (w: Workflow, pattern: RegExp, gate: string): void => {
    for (const job of Object.values(w.jobs)) {
      for (const step of job.steps ?? []) {
        if (pattern.test(step.run ?? "")) step.if = gate;
      }
    }
  };

  test.each<[string, (w: Workflow) => void, RegExp]>([
    [
      "a release-hook step under a condition of its own",
      (w) => gateSteps(w, /retag-major/, "github.event_name == 'release'"),
      /"Move the major tag to the packaged commit" runs under a condition of its own/,
    ],
  ])("%s fails the wiring there (negative control)", (_case, mutate, message) => {
    const stable = readWorkflow("update-release.yml");
    mutate(stable);
    expect(wiringProblems(stable).join("\n")).toMatch(message);
  });

  /**
   * The one sha a hook acts on must reach every checkout that names a ref and every step that passes a source to the pipeline
   * (found by the script that reads the variable, not by the env that sets it). A checkout naming no ref takes the caller's
   * event sha.
   */
  function expectSource(
    file: string,
    judged: string,
    atLeast: { checkouts: number; sources: number },
  ) {
    const steps = Object.values(readWorkflow(file).jobs).flatMap((job) => job.steps ?? []);
    const checkouts = steps.filter(
      (step) => (step.uses ?? "").startsWith("actions/checkout@") && step.with?.ref !== undefined,
    );
    const sources = steps.filter((step) => /\$SOURCE_SHA\b/.test(step.run ?? ""));
    expect(checkouts.length).toBeGreaterThanOrEqual(atLeast.checkouts);
    expect(sources.length).toBeGreaterThanOrEqual(atLeast.sources);
    for (const step of checkouts) {
      expect(
        condition(step.with?.ref),
        `${file}: a checkout of something other than ${judged}`,
      ).toBe(judged);
    }
    for (const step of sources) {
      expect(
        condition(step.env?.SOURCE_SHA),
        `${file}: "${step.name}" names a source other than ${judged}`,
      ).toBe(judged);
    }
  }

  test("the judged sha the caller passes post-green is the ref its checkout takes and the source its packaging step names", () => {
    const [input, ...rest] = Object.keys(workflow.on.workflow_call?.inputs ?? {});
    expect(rest, "post-green.yml takes more than the one judged sha").toEqual([]);
    // Compared as expressions, so a sync respelling the managed caller's braces or spacing is not a behavior change here.
    expect(condition(caller.with?.[input ?? ""])).toBe("github.sha");
    expectSource(POST_GREEN, `inputs.${input}`, { checkouts: 1, sources: 1 });
  });
});

describe("the outputs the steps scripts declare", () => {
  /** release-pipeline's draft reads, run as the workflow does with gh stubbed to answer `stdout` or fail with `status`;
   * the branch must have reached gh and ended with `ends`, or an empty output list could stand for a step that never ran. */
  function runDraftRead(
    subcommand: string,
    gh: { stdout?: string; stderr?: string; status?: number },
    ends: number,
  ): Promise<string[]> {
    return withTempDir("release-draft-read-", (dir) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(dir, "answer"), gh.stdout ?? "");
      writeFileSync(join(dir, "answer.err"), gh.stderr ?? "");
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\n: > "${dir}/gh-ran"\ncat "${dir}/answer"\ncat "${dir}/answer.err" >&2\nexit ${gh.status ?? 0}\n`,
        { mode: 0o755 },
      );
      const result = runStep(
        "release-pipeline",
        ROOT,
        join(dir, "runner-temp"),
        { MARKER: "source-v2.1.0", PATH: `${bin}:${process.env.PATH ?? ""}` },
        subcommand,
      );
      expect(
        existsSync(join(dir, "gh-ran")),
        `${subcommand} never reached gh: ${result.stderr}`,
      ).toBe(true);
      expect(result.status, `${subcommand}: ${result.stderr}`).toBe(ends);
      return result.outputs;
    });
  }

  test("the outputs each script declares are exactly the ones its subcommands' branches write, so the wiring relation reads the truth", async () => {
    const sha = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";
    const release = (isDraft: boolean, targetCommitish: string) =>
      JSON.stringify({ isDraft, targetCommitish });
    const assets = (...names: string[]) =>
      JSON.stringify({ assets: names.map((name) => ({ name })) });
    // Every branch of every subcommand a script dispatches from a workflow step, as runs; a declared subcommand this
    // table does not run, or a script the table does not know, fails the pin instead of passing vacuously.
    const branches: Record<string, Record<string, () => Promise<string[]>>> = {
      "release-pipeline": {
        "resolve-source": async () =>
          (
            await Promise.all([
              runDraftRead("resolve-source", { stdout: release(true, sha) }, 0),
              runDraftRead("resolve-source", { stdout: release(false, sha) }, 1),
              runDraftRead("resolve-source", { stdout: release(true, "main") }, 1),
              runDraftRead("resolve-source", { stderr: "release not found\n", status: 1 }, 1),
              runDraftRead("resolve-source", { stderr: "HTTP 502: Bad Gateway\n", status: 4 }, 4),
            ])
          ).flat(),
        "verify-assets": async () =>
          (
            await Promise.all([
              runDraftRead(
                "verify-assets",
                { stdout: assets("index.js", "settings.schema.json") },
                0,
              ),
              runDraftRead("verify-assets", { stdout: assets("index.js") }, 1),
              runDraftRead("verify-assets", { stderr: "release not found\n", status: 4 }, 4),
            ])
          ).flat(),
      },
    };
    expect([...SCRIPTS.keys()].sort()).toEqual(Object.keys(branches).sort());
    for (const [script, runs] of Object.entries(branches)) {
      const { commands, outputs: declared } = must(SCRIPTS.get(script), script);
      for (const subcommand of Object.keys(declared)) {
        expect(
          Object.keys(commands),
          `${script} declares outputs for ${subcommand}, which it does not dispatch`,
        ).toContain(subcommand);
        expect(
          Object.keys(runs),
          `${script} declares ${subcommand}, which no run here exercises`,
        ).toContain(subcommand);
      }
      for (const [subcommand, run] of Object.entries(runs)) {
        const written = new Set((await run()).map((line) => line.split("=")[0] ?? ""));
        expect([...written].sort(), `${script} ${subcommand}`).toEqual(
          [...(declared[subcommand] ?? [])].sort(),
        );
      }
    }
  });
});

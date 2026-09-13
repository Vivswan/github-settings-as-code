/**
 * The hooks ci.yml calls after the all-green gate (post-green.yml, update-release.yml, update-release-pr.yml) push refs and publish
 * packages, so what they can do follows from where they are reachable and what each job is granted. The relations here: every hook is
 * reachable through workflow_call alone and its ci.yml caller sits downstream of all-green; a job's effective grant covers what its
 * steps consume; a hook job's own condition is the fork guard or nothing; post-green's judged sha
 * reaches every checkout and packaging step; every output a step writes is read by a later step, and every gate reads an output an
 * earlier step writes, back to the probe. The push probe also runs under bash against a stubbed git, since no pin shows what a branch
 * does.
 *
 * The static guards catch ACCIDENTAL drift: a trigger, grant, gate, or step added or dropped in plain YAML. Deliberately hiding one
 * behind other syntax is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../root.js";
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
    /\bgit\s+push\b|\bgh\s+release\s+(?:view|upload|edit|create)\b|release-pipeline\.ts (?:package|package-commit|retag-major|anchor)\b/.test(
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

/**
 * A called job's grant: its own permissions block, else its workflow's, else the caller's (GitHub applies the nearest block; a called
 * job with none inherits the caller's).
 */
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
    // A missing grant is quiet here: the push probe warns and skips, the OIDC probe warns and skips, and the job stays green.
    const consumers = HOOKS.flatMap(({ file }) =>
      Object.values(readWorkflow(file).jobs).flatMap((job) =>
        (job.steps ?? []).flatMap(consumedGrants),
      ),
    );
    expect(consumers.length).toBeGreaterThan(4);
    expect(grantProblems(HOOKS)).toEqual([]);
  });

  test.each<[string, (hooks: LocalCall[]) => LocalCall[], RegExp]>([
    [
      "a caller ceiling below what the build job pushes with",
      (hooks) =>
        hooks.map((hook) =>
          hook.file === "post-green.yml"
            ? {
                ...hook,
                job: { ...hook.job, permissions: { contents: "read", "id-token": "write" } },
              }
            : hook,
        ),
      /post-green\.yml#build: .* needs contents: write/,
    ],
    [
      "a caller that grants no OIDC token",
      (hooks) =>
        hooks.map((hook) =>
          hook.file === "post-green.yml"
            ? { ...hook, job: { ...hook.job, permissions: { contents: "write" } } }
            : hook,
        ),
      /post-green\.yml#publish-next: .* needs id-token: write/,
    ],
  ])("%s fails the grant relation (negative control)", (_case, mutate, message) => {
    expect(grantProblems(mutate(structuredClone(HOOKS))).join("\n")).toMatch(message);
  });

  test("an anchor job narrowed to read while its subcommand pushes fails (negative control)", () => {
    const narrowed = readWorkflow("update-release-pr.yml");
    must(narrowed.jobs.anchor, "anchor job").permissions = { contents: "read" };
    const read = (file: string) =>
      file === "update-release-pr.yml" ? narrowed : readWorkflow(file);
    expect(grantProblems(HOOKS, read).join("\n")).toMatch(
      /update-release-pr\.yml#anchor: .* needs contents: write/,
    );
  });
});

/** The hook a library-page claim about "every green push" or "every release cut" points at, by its ci.yml caller's condition. */
function hookFor(claim: string): { file: string; workflow: Workflow } {
  const release = /release cut/i.test(claim);
  // A green push: the caller's own condition names the push event and the main ref beside the gate's success; a release cut: it
  // names release-please's release_created output. One caller each, or the claim points at nothing.
  const runsOn = (job: Job) => {
    const on = condition(job.if);
    return release
      ? /release_created == 'true'/.test(on)
      : /needs\.all-green\.result == 'success'/.test(on) &&
          /github\.event_name == 'push'/.test(on) &&
          /github\.ref == 'refs\/heads\/main'/.test(on);
  };
  const matching = HOOKS.filter(({ job }) => runsOn(job));
  expect(
    matching.map((hook) => hook.file),
    `exactly one hook caller runs on ${release ? "a release cut" : "a green push to main"}`,
  ).toHaveLength(1);
  const hook = matching[0] as LocalCall;
  return { file: hook.file, workflow: readWorkflow(hook.file) };
}

/** A step gate that reads a verdict (`steps.<id>.outputs.<x> == 'true'`); every other condition can skip the step on the caller's own event. */
const VERDICT_GATE = /^steps\.[\w-]+\.outputs\.[\w-]+ == 'true'$/;

/**
 * Whether some step of the workflow runs the pipeline subcommand (with its argument, when one is named) on every run its job takes: the
 * step carries no condition, or a verdict gate the wiring relation ties to a probe.
 */
const runsSubcommand = (workflow: Workflow, subcommand: string): boolean =>
  Object.values(workflow.jobs).some((job) =>
    (job.steps ?? []).some(
      (step) =>
        new RegExp(`release-pipeline\\.ts ${subcommand}(?![\\w-])`).test(step.run ?? "") &&
        (step.if === undefined || VERDICT_GATE.test(condition(step.if))),
    ),
  );

/** The library page's claims about what publishes when, against the steps the hooks run. */
function claimProblems(page: string): string[] {
  const problems: string[] = [];
  const rows = [...page.matchAll(/^\| `(next|latest)` \| ([^|]+) \|/gm)];
  if (rows.length !== 2)
    problems.push("the dist-tag table no longer has a next row and a latest row");
  for (const [, tag = "", publishesOn = ""] of rows) {
    const channel = tag === "latest" ? "stable" : tag;
    const { file, workflow } = hookFor(publishesOn);
    if (!runsSubcommand(workflow, `npm-verdict ${channel}`)) {
      problems.push(
        `the page says ${tag} publishes on "${publishesOn.trim()}", but ${file} runs no npm-verdict ${channel}`,
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

  test("each channel the page says publishes on a green push or a release cut is published by that hook", () => {
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

  test("a packaging step gone, or a channel's verdict gone, fails the claim (negative control)", () => {
    const { workflow } = hookFor("green push");
    const build = must(workflow.jobs.build, "build job");
    build.steps = build.steps?.filter((step) => !/package-commit/.test(step.run ?? ""));
    expect(runsSubcommand(workflow, "package-commit")).toBe(false);
    expect(runsSubcommand(workflow, "npm-verdict next")).toBe(true);
    expect(runsSubcommand(workflow, "npm-verdict stable")).toBe(false);
    // A publish step conditioned on the caller's event skips on the push that calls it, so the channel's claim fails.
    const conditioned = readWorkflow("update-release.yml");
    for (const job of Object.values(conditioned.jobs)) {
      for (const step of job.steps ?? []) {
        if (/npm-verdict stable/.test(step.run ?? "")) step.if = "github.event_name == 'release'";
      }
    }
    expect(runsSubcommand(conditioned, "npm-verdict stable")).toBe(false);
    expect(
      claimProblems(
        page.replace(
          "| `latest` | Every release cut |",
          "| `latest` | Every green push to `main` |",
        ),
      ),
    ).toEqual([
      'the page says latest publishes on "Every green push to `main`", but post-green.yml runs no npm-verdict stable',
    ]);
  });
});

/** Every `<name>` a step writes to GITHUB_OUTPUT. */
const outputsWritten = (step: Step): string[] =>
  [...(step.run ?? "").matchAll(/echo "([\w-]+)=[^"]*" >> "\$GITHUB_OUTPUT"/g)].map(
    (m) => m[1] ?? "",
  );

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

/** The probe steps: each writes a `proceed=` verdict for the steps after it to read. */
const isProbe = (step: Step) => outputsWritten(step).includes("proceed");

/**
 * Whether the step at `index` runs on a verdict: its condition is `steps.<id>.outputs.<name> == 'true'` where an earlier step `<id>`
 * writes `<name>` and is the probe itself or is gated the same way (a chain back to the probe).
 */
function gatedOnProbe(steps: Step[], index: number, probe: number): boolean {
  const match = condition(steps[index]?.if).match(/^steps\.([\w-]+)\.outputs\.([\w-]+) == 'true'$/);
  if (!match) return false;
  const source = steps.findIndex((step, at) => at < index && step.id === match[1]);
  if (source < 0 || !outputsWritten(steps[source] as Step).includes(match[2] ?? "")) return false;
  return source === probe || gatedOnProbe(steps, source, probe);
}

/**
 * Every wiring fault in a job's steps: a step conditioned on anything but a verdict (it would skip on the caller's own event), a step
 * after the probe not gated on it, a read of an output no earlier step writes, a written output nobody reads.
 */
function wiringProblems(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const steps = job.steps ?? [];
    const probe = steps.findIndex(isProbe);
    const label = (step: Step) => `"${step.name ?? step.uses ?? "unnamed step"}"`;
    const problems: string[] = [];
    if (probe >= 0 && steps[probe]?.if !== undefined) {
      // A probe that skips writes no verdict, and every gate on it reads empty: the whole job stands down quietly.
      problems.push(
        `${id}: the probe ${label(steps[probe] as Step)} runs under a condition of its own`,
      );
    }
    steps.forEach((step, index) => {
      if (probe >= 0 && index > probe && !gatedOnProbe(steps, index, probe)) {
        problems.push(`${id}: ${label(step)} runs whatever the probe found`);
      }
      if ((probe < 0 || index < probe) && step.if !== undefined) {
        // A hook runs on the caller's event, so a step's own condition skips it quietly: retag-major on a release, or the checkout
        // the probe judges an empty workspace without.
        problems.push(`${id}: ${label(step)} runs under a condition of its own`);
      }
      for (const [source, name] of outputsRead(step)) {
        const writer = steps.findIndex((s, at) => at < index && s.id === source);
        if (writer < 0 || !outputsWritten(steps[writer] as Step).includes(name)) {
          problems.push(
            `${id}: ${label(step)} reads steps.${source}.outputs.${name}, which no earlier step writes`,
          );
        }
      }
      if (step.id !== undefined) {
        for (const name of outputsWritten(step)) {
          const read = steps
            .slice(index + 1)
            .some((later) => outputsRead(later).some(([s, n]) => s === step.id && n === name));
          if (!read)
            problems.push(`${id}: ${label(step)} writes ${name}, which no later step reads`);
        }
      }
    });
    return problems;
  });
}

describe("post-green.yml", () => {
  const workflow = readWorkflow("post-green.yml");
  const caller = must(
    HOOKS.find((call) => call.file === "post-green.yml"),
    "post-green caller",
  ).job;

  test("every step after a probe runs on its verdict, every read names a written output, every output is read, in every hook", () => {
    const probes = Object.values(workflow.jobs).filter((job) => (job.steps ?? []).some(isProbe));
    // Both post-green jobs open with a probe today; the release hooks have none, and their output reads are judged the same way.
    expect(probes.length).toBe(Object.keys(workflow.jobs).length);
    for (const { file } of HOOKS) {
      expect(wiringProblems(readWorkflow(file)), file).toEqual([]);
    }
  });

  test.each<[string, (w: Workflow) => void, RegExp]>([
    [
      "the packaging step without its gate",
      (w) => delete must(must(w.jobs.build, "build").steps?.at(-1), "step").if,
      /runs whatever the probe found/,
    ],
    [
      "the confirmation gated on a step that is not gated itself",
      (w) => {
        const steps = must(must(w.jobs["publish-next"], "publish-next").steps, "steps");
        must(steps.at(-1), "confirm").if = "steps.oidc-copy.outputs.proceed == 'true'";
        steps.splice(1, 0, { id: "oidc-copy", run: 'echo "proceed=true" >> "$GITHUB_OUTPUT"' });
      },
      /runs whatever the probe found/,
    ],
    [
      "a gate that is not an equality on true",
      (w) => {
        must(must(w.jobs.build, "build").steps?.at(-1), "step").if =
          "always() || steps.token.outputs.proceed == 'true'";
      },
      /runs whatever the probe found/,
    ],
    [
      "a gate on an output the probe never writes",
      (w) => {
        must(must(w.jobs.build, "build").steps?.at(-1), "step").if =
          "steps.token.outputs.published == 'true'";
      },
      /reads steps\.token\.outputs\.published, which no earlier step writes/,
    ],
    [
      "the confirmation step gone, leaving the publish output unread",
      (w) => must(w.jobs["publish-next"], "publish-next").steps?.pop(),
      /writes published, which no later step reads/,
    ],
    [
      "the checkout ahead of the probe under a condition of its own",
      (w) => {
        must(must(w.jobs.build, "build").steps?.[0], "checkout").if =
          "github.event_name == 'release'";
      },
      /"actions\/checkout@[0-9a-f]+" runs under a condition of its own/,
    ],
    [
      "a probe under a condition of its own",
      (w) => {
        must(must(w.jobs.build, "build").steps?.[1], "probe").if = "github.event_name == 'release'";
      },
      /the probe "Check the token can push" runs under a condition of its own/,
    ],
    [
      "the publish output no longer written",
      (w) => {
        const step = must(must(w.jobs["publish-next"], "publish-next").steps?.at(-2), "publish");
        step.run = step.run?.replace(/\n\s*echo "published=true" >> "\$GITHUB_OUTPUT"/, "");
      },
      /reads steps\.publish\.outputs\.published, which no earlier step writes/,
    ],
  ])("%s fails the wiring relation (negative control)", (_case, mutate, message) => {
    const drifted = structuredClone(workflow);
    mutate(drifted);
    expect(wiringProblems(drifted).join("\n")).toMatch(message);
  });

  test("a release-hook step under a condition of its own fails the wiring there (negative control)", () => {
    const stable = readWorkflow("update-release.yml");
    for (const job of Object.values(stable.jobs)) {
      for (const step of job.steps ?? []) {
        if (/retag-major/.test(step.run ?? "")) step.if = "github.event_name == 'release'";
      }
    }
    expect(wiringProblems(stable).join("\n")).toMatch(
      /"Move the major tag to the packaged commit" runs under a condition of its own/,
    );
  });

  test("a verdict gate copied onto a hook without that probe fails the wiring there (negative control)", () => {
    const stable = readWorkflow("update-release.yml");
    for (const job of Object.values(stable.jobs)) {
      for (const step of job.steps ?? []) {
        if (/npm-verdict stable/.test(step.run ?? ""))
          step.if = "steps.oidc.outputs.proceed == 'true'";
      }
    }
    expect(wiringProblems(stable).join("\n")).toMatch(
      /reads steps\.oidc\.outputs\.proceed, which no earlier step writes/,
    );
  });

  test("the judged sha the caller passes is the ref every checkout takes and the source every packaging step names", () => {
    const [input, ...rest] = Object.keys(workflow.on.workflow_call?.inputs ?? {});
    expect(rest, "post-green.yml takes more than the one judged sha").toEqual([]);
    // Compared as expressions, so a sync respelling the managed caller's braces or spacing is not a behavior change here.
    expect(condition(caller.with?.[input ?? ""])).toBe("github.sha");
    const judged = `inputs.${input}`;
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const checkouts = steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    // The steps that pass a source to the pipeline or to npm, found by the script that reads the variable, not by the env that sets it.
    const sources = steps.filter((step) => /\$SOURCE_SHA\b/.test(step.run ?? ""));
    expect(checkouts.length).toBeGreaterThan(1);
    expect(sources.length).toBeGreaterThan(1);
    for (const step of checkouts) {
      expect(condition(step.with?.ref), "a checkout of something other than the judged sha").toBe(
        judged,
      );
    }
    for (const step of sources) {
      expect(
        condition(step.env?.SOURCE_SHA),
        `"${step.name}" packages something other than the judged sha`,
      ).toBe(judged);
    }
  });

  test("the probe tells a rejected PAT from a read ceiling by the same secret the checkout falls back from", () => {
    const steps = must(workflow.jobs.build, "build job").steps ?? [];
    const checkout = must(
      steps.find((step) => (step.uses ?? "").startsWith("actions/checkout@")),
      "checkout",
    );
    const secret = must(
      String(checkout.with?.token).match(
        /^\$\{\{\s*secrets\.(\w+)\s*\|\|\s*github\.token\s*\}\}$/,
      )?.[1],
      "a `secrets.X || github.token` checkout token",
    );
    const probe = must(steps.find(isProbe), "probe step");
    const flag = Object.entries(probe.env ?? {}).find(([, value]) =>
      value.includes(`secrets.${secret}`),
    );
    expect(flag, `the probe's env does not read secrets.${secret}`).toBeDefined();
    expect(condition(flag?.[1])).toBe(`secrets.${secret} != ''`);
    // The script branches on that variable, so the env name and the script agree.
    expect(probe.run).toContain(`"$${flag?.[0]}" = "true"`);
  });
});

/** The probe's stdout as the runner reads it: one entry per line. */
interface ProbeRun {
  lines: string[];
  status: number;
  /** What the step wrote to GITHUB_OUTPUT. */
  output: string;
  probeErrLeft: boolean;
}

/**
 * Run the probe under `bash -e` (what a `run:` step gets on a Linux runner) with git stubbed to write `stderr` and exit `gitStatus`; the
 * scratch directory is removed on every path.
 */
function runProbe(run: string, stderr: string, gitStatus: number, patSet: boolean): ProbeRun {
  const dir = mkdtempSync(join(tmpdir(), "post-green-probe-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s' "$STUB_STDERR" >&2\nexit ${gitStatus}\n`,
      { mode: 0o755 },
    );
    const output = join(dir, "output");
    writeFileSync(output, "");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PAT_SET: patSet ? "true" : "false",
      GITHUB_OUTPUT: output,
      STUB_STDERR: stderr,
    };
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["-e", "-c", run], {
        cwd: dir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      stdout = String((error as { stdout?: string }).stdout ?? "");
    }
    return {
      lines: stdout.split("\n"),
      status,
      output: readFileSync(output, "utf8"),
      probeErrLeft: existsSync(join(dir, "probe.err")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FENCE_OPEN = /^::stop-commands::([0-9a-f]{32})$/;

describe("the push probe under bash", () => {
  const steps = must(readWorkflow("post-green.yml").jobs.build, "build job").steps ?? [];
  const run = must(must(steps.find(isProbe), "probe step").run, "probe run");

  /**
   * The fenced block: git's stderr, indented, between a stop-commands line keyed by a 32-hex token and its own resume line, then one
   * static error. The runner trims, so an indented "::error::forged" still reads as a command outside a fence; the indent only marks
   * the lines as quoted text in the log. Returns the token.
   */
  function expectFenced(lines: string[], inner: string[]): string {
    const [open, header, ...rest] = lines;
    const token = must(open?.match(FENCE_OPEN)?.[1], "a stop-commands line with a 32-hex token");
    expect(header).toBe("probe stderr:");
    expect(rest.slice(0, inner.length)).toEqual(inner);
    expect(rest[inner.length]).toBe(`::${token}::`);
    const after = rest.slice(inner.length + 1).filter(Boolean);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^::error::/);
    for (const line of inner) {
      expect(line.startsWith("  ")).toBe(true);
      // The error after the fence is static text: none of git's words reach a line the runner reads as a command.
      expect(after[0]).not.toContain(line.trim());
    }
    return token;
  }

  test("a stderr that does not end in a newline still closes the fence on a line of its own, under a token fresh per run", () => {
    const probe = runProbe(run, "refused", 1, true);
    expect(probe.status).toBe(1);
    const token = expectFenced(probe.lines, ["  refused"]);
    expect(probe.probeErrLeft).toBe(false);
    expect(probe.output).toBe("");
    // A fixed token is one remote text could name to resume command processing.
    expect(expectFenced(runProbe(run, "refused", 1, true).lines, ["  refused"])).not.toBe(token);
  });

  test("a stderr carrying workflow-command text is confined to indented lines inside the fence", () => {
    const hostile = "::stop-commands::probe-marker\nremote: %25 done\r\n::error::forged\n";
    const probe = runProbe(run, hostile, 1, true);
    expect(probe.status).toBe(1);
    expectFenced(probe.lines, [
      "  ::stop-commands::probe-marker",
      "  remote: %25 done\r",
      "  ::error::forged",
    ]);
    expect(probe.probeErrLeft).toBe(false);
  });

  test("an empty stderr opens and closes the fence around nothing", () => {
    const probe = runProbe(run, "", 1, true);
    expect(probe.status).toBe(1);
    expectFenced(probe.lines, []);
    expect(probe.probeErrLeft).toBe(false);
  });

  test("without a PAT a refused probe warns naming both remedies, skips, and prints no stderr (control)", () => {
    const probe = runProbe(run, "refused\n", 1, false);
    expect(probe.status).toBe(0);
    const commands = probe.lines.filter((line) => line.startsWith("::"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^::warning::/);
    // The two ways to let the hook push: a wider caller ceiling, or the PAT the checkout falls back from.
    expect(commands[0]).toContain("contents: write");
    expect(commands[0]).toContain("REPO_PLATFORM_TOKEN");
    expect(probe.lines).not.toContain("  refused");
    expect(probe.output).toBe("proceed=false\n");
    expect(probe.probeErrLeft).toBe(false);
  });

  test("a probe the token passes proceeds and prints nothing (control)", () => {
    const probe = runProbe(run, "", 0, true);
    expect(probe.status).toBe(0);
    expect(probe.lines).toEqual([""]);
    expect(probe.output).toBe("proceed=true\n");
    expect(probe.probeErrLeft).toBe(false);
  });
});

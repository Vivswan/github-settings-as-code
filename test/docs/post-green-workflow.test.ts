/**
 * The hooks ci.yml calls after the all-green gate (post-green.yml, update-release.yml, update-release-pr.yml) push refs and publish
 * packages, so what they can do follows from where they are reachable and what each job is granted. The relations here: a hook is
 * reachable through workflow_call alone and every ci.yml job that calls one sits downstream of all-green; a job's effective grant covers
 * what its steps consume; post-green's judged sha reaches every checkout and packaging step; every step after a probe runs on a verdict
 * an earlier step wrote. The push probe also runs under bash against a stubbed git, since no pin shows what a branch does.
 *
 * The static guards catch ACCIDENTAL drift: a trigger, grant, or gate added or dropped in plain YAML. Deliberately hiding one behind
 * other syntax is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** ci.yml's calls of this repository's own workflows: the calling job and the callee file. */
const localCalls = (ci: Workflow): Array<{ caller: string; job: Job; file: string }> =>
  Object.entries(ci.jobs).flatMap(([caller, job]) =>
    (job.uses ?? "").startsWith(CALLER_PREFIX)
      ? [{ caller, job, file: (job.uses ?? "").slice(CALLER_PREFIX.length) }]
      : [],
  );

/** The hooks: callees of ci.yml jobs downstream of all-green, with the caller that reaches each. */
const postGateHooks = (ci: Workflow) => {
  const gated = downstreamOf(ci.jobs, "all-green");
  return localCalls(ci).filter(({ caller }) => gated.has(caller));
};

describe("the hooks ci.yml calls after the gate", () => {
  const hooks = postGateHooks(CI);

  test("every post-gate hook is reachable through workflow_call alone, and its caller sits downstream of all-green", () => {
    // Non-vacuity: the packaging and release hooks are called this way today.
    expect(hooks.map((hook) => hook.file).sort()).toContain("post-green.yml");
    expect(hooks.length).toBeGreaterThan(1);
    for (const { file } of hooks) {
      expect(
        Object.keys(readWorkflow(file).on),
        `${file} is reachable outside ci.yml's gate`,
      ).toEqual(["workflow_call"]);
    }
    // The pre-gate call (checks.yml) is not a hook: it is what the gate judges.
    expect(localCalls(CI).map((call) => call.file)).toContain("checks.yml");
    expect(hooks.map((hook) => hook.file)).not.toContain("checks.yml");
  });

  test.each(hooks.map((hook) => [hook.file, hook.job] as const))(
    "%s: ci.yml passes exactly the inputs it declares",
    (file, job) => {
      const declared = Object.keys(readWorkflow(file).on.workflow_call?.inputs ?? {}).sort();
      expect(Object.keys(job.with ?? {}).sort()).toEqual(declared);
    },
  );

  test("a hook that grew a dispatch trigger fails, and a caller moved ahead of the gate stops counting as a hook (negative controls)", () => {
    const dispatchable = structuredClone(readWorkflow("post-green.yml"));
    dispatchable.on.workflow_dispatch = null;
    expect(Object.keys(dispatchable.on)).not.toEqual(["workflow_call"]);
    const ci = structuredClone(CI);
    must(ci.jobs["post-green"], "post-green caller").needs = ["ci"];
    expect(postGateHooks(ci).map((hook) => hook.file)).not.toContain("post-green.yml");
  });
});

/** The grant a step's commands consume: a push or a release write needs contents: write, an OIDC-authenticated publish id-token: write. */
function consumedGrants(step: Step): Array<[scope: string, why: string]> {
  const run = step.run ?? "";
  const label = step.name ?? "unnamed step";
  const grants: Array<[string, string]> = [];
  if (/\bgit\s+push\b|\bgh\s+release\s+(?:upload|edit|create)\b/.test(run)) {
    grants.push(["contents", `"${label}" pushes or writes a release`]);
  }
  if (/\bnpm\s+publish\b|ACTIONS_ID_TOKEN_REQUEST_URL/.test(run)) {
    grants.push(["id-token", `"${label}" publishes through OIDC`]);
  }
  return grants;
}

/** A called job's grant: its own permissions block, else the caller's (GitHub inherits the caller's when the job declares none). */
const effectiveGrant = (job: Job, caller: Job): Record<string, string> =>
  job.permissions ?? caller.permissions ?? {};

describe("the hooks' grants", () => {
  test("every job's effective grant covers what its steps consume", () => {
    // A missing grant is quiet here: the push probe warns and skips, the OIDC probe warns and skips, and the job stays green.
    const consumers = postGateHooks(CI).flatMap(({ file, job: caller }) =>
      Object.entries(readWorkflow(file).jobs).flatMap(([id, job]) =>
        (job.steps ?? []).flatMap((step) =>
          consumedGrants(step).map(([scope, why]) => ({
            where: `${file}#${id}`,
            granted: effectiveGrant(job, caller)[scope],
            scope,
            why,
          })),
        ),
      ),
    );
    // The packaging job pushes and both publishers mint OIDC tokens today.
    expect(consumers.length).toBeGreaterThan(2);
    for (const { where, granted, scope, why } of consumers) {
      expect(granted, `${where}: ${why}, so it needs ${scope}: write`).toBe("write");
    }
  });

  test("a publisher whose own ceiling drops the OIDC grant fails, whatever the caller grants (negative control)", () => {
    const caller: Job = { permissions: { contents: "write", "id-token": "write" } };
    const job: Job = { permissions: { contents: "read" } };
    expect(effectiveGrant(job, caller)["id-token"]).toBeUndefined();
    expect(consumedGrants({ run: "npm publish --tag next" })).toEqual([
      ["id-token", '"unnamed step" publishes through OIDC'],
    ]);
  });
});

/** The probe steps: each writes a `proceed=` verdict to GITHUB_OUTPUT for the steps after it to read. */
const isProbe = (step: Step) =>
  /echo "proceed=(?:true|false)" >> "\$GITHUB_OUTPUT"/.test(step.run ?? "");

/**
 * Whether the step at `index` runs on a verdict: its condition is `steps.<id>.outputs.<name> == 'true'` where `<id>` names an
 * earlier step that is the probe itself or is gated the same way (a chain back to the probe).
 */
function gatedOnProbe(steps: Step[], index: number, probe: number): boolean {
  const match = condition(steps[index]?.if).match(/^steps\.([\w-]+)\.outputs\.[\w-]+ == 'true'$/);
  if (!match) return false;
  const source = steps.findIndex((step, at) => at < index && step.id === match[1]);
  if (source < 0) return false;
  return source === probe || gatedOnProbe(steps, source, probe);
}

/** The job ids whose steps after a probe are not gated on it, with the offending step names. */
function ungatedAfterProbe(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const steps = job.steps ?? [];
    const probe = steps.findIndex(isProbe);
    if (probe < 0) return [];
    return steps.flatMap((step, index) =>
      index > probe && !gatedOnProbe(steps, index, probe)
        ? [`${id}: "${step.name ?? step.uses ?? "unnamed step"}" runs whatever the probe found`]
        : [],
    );
  });
}

describe("post-green.yml", () => {
  const workflow = readWorkflow("post-green.yml");
  const caller = must(
    localCalls(CI).find((call) => call.file === "post-green.yml"),
    "post-green caller",
  ).job;

  test("every step after a probe runs on the probe's verdict", () => {
    const probes = Object.values(workflow.jobs).filter((job) => (job.steps ?? []).some(isProbe));
    // Both jobs open with a probe today; a job without one is not judged here.
    expect(probes.length).toBe(Object.keys(workflow.jobs).length);
    expect(ungatedAfterProbe(workflow)).toEqual([]);
  });

  test.each<[string, (w: Workflow) => void]>([
    [
      "the packaging step without its gate",
      (w) => delete must(must(w.jobs.build, "build").steps?.at(-1), "step").if,
    ],
    [
      "the confirmation gated on a step that is not gated itself",
      (w) => {
        const steps = must(must(w.jobs["publish-next"], "publish-next").steps, "steps");
        must(steps.at(-1), "confirm").if = "steps.oidc-copy.outputs.proceed == 'true'";
        steps.splice(1, 0, { id: "oidc-copy", run: "echo" });
      },
    ],
    [
      "a gate that is not an equality on true",
      (w) => {
        must(must(w.jobs.build, "build").steps?.at(-1), "step").if =
          "always() || steps.token.outputs.proceed == 'true'";
      },
    ],
  ])("%s fails the gate relation (negative control)", (_case, mutate) => {
    const drifted = structuredClone(workflow);
    mutate(drifted);
    expect(ungatedAfterProbe(drifted)).not.toEqual([]);
  });

  test("the judged sha the caller passes is the ref every checkout takes and the source every packaging step names", () => {
    const [input, ...rest] = Object.keys(workflow.on.workflow_call?.inputs ?? {});
    expect(rest, "post-green.yml takes more than the one judged sha").toEqual([]);
    expect(caller.with?.[input ?? ""]).toBe(`\${{ github.sha }}`);
    const judged = `\${{ inputs.${input} }}`;
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const checkouts = steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    const sources = steps.filter((step) => step.env?.SOURCE_SHA !== undefined);
    expect(checkouts.length).toBeGreaterThan(1);
    expect(sources.length).toBeGreaterThan(1);
    for (const step of checkouts) {
      expect(step.with?.ref, "a checkout of something other than the judged sha").toBe(judged);
    }
    for (const step of sources) {
      expect(
        step.env?.SOURCE_SHA,
        `"${step.name}" packages something other than the judged sha`,
      ).toBe(judged);
    }
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
   * The fenced block: git's stderr, indented, between a stop-commands line keyed by a fresh 32-hex token and its own resume line, then one
   * static error. The runner trims, so an indented "::error::forged" still reads as a command outside a fence; the indent only marks the
   * lines as quoted text in the log.
   */
  function expectFenced(lines: string[], inner: string[]): void {
    const [open, header, ...rest] = lines;
    const token = open?.match(FENCE_OPEN)?.[1];
    expect(token).toBeDefined();
    expect(header).toBe("probe stderr:");
    expect(rest.slice(0, inner.length)).toEqual(inner);
    expect(rest[inner.length]).toBe(`::${token}::`);
    const after = rest.slice(inner.length + 1).filter(Boolean);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/^::error::/);
    for (const line of inner) {
      expect(line.startsWith("  ")).toBe(true);
    }
  }

  test("a stderr that does not end in a newline still closes the fence on a line of its own", () => {
    const probe = runProbe(run, "refused", 1, true);
    expect(probe.status).toBe(1);
    expectFenced(probe.lines, ["  refused"]);
    expect(probe.probeErrLeft).toBe(false);
    expect(probe.output).toBe("");
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

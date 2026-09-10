/**
 * apply-settings.yml is this repository's settings writer and post-green.yml is
 * how ci.yml's post-green slot reaches it: the call is the only write trigger,
 * so a repository setting is never written from a commit the all-green gate has
 * not judged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
interface Input {
  required?: boolean;
  type?: string;
  default?: unknown;
}
interface Trigger {
  inputs?: Record<string, Input>;
}
interface Job {
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, Trigger | null>;
  jobs: Record<string, Job>;
}

interface Contract {
  jobs: string[];
  triggers: string[];
  shaInput: { required: boolean; type: string | undefined; hasDefault: boolean } | undefined;
  dispatchInputs: string[];
  mode: string | undefined;
  /** Every checkout step: the workspace root is the tree `uses: ./` runs from. */
  checkouts: Array<{ repository: unknown; path: unknown; ref: unknown }>;
  writers: Array<{
    afterFreshness: boolean;
    if: string | undefined;
    mode: unknown;
    env: Record<string, string> | undefined;
  }>;
  ungatedBeforeWriter: string[];
}

const FRESHNESS_GATE = "steps.freshness.outputs.moved == 'false'";
const EXPECTED: Contract = {
  jobs: ["apply"],
  triggers: ["workflow_call", "workflow_dispatch"],
  shaInput: { required: true, type: "string", hasDefault: false },
  dispatchInputs: [],
  mode: `\${{ github.event_name == 'workflow_dispatch' && 'check' || 'apply' }}`,
  checkouts: [
    {
      repository: undefined,
      path: undefined,
      ref: `\${{ github.event_name == 'workflow_dispatch' && github.event.repository.default_branch || inputs.sha }}`,
    },
    {
      repository: "Vivswan/repo-platform",
      path: "platform",
      ref: `\${{ steps.scripts.outputs.ref }}`,
    },
  ],
  writers: [{ afterFreshness: true, if: FRESHNESS_GATE, mode: `\${{ env.MODE }}`, env: undefined }],
  ungatedBeforeWriter: [],
};

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`apply-settings.yml has no ${what}`);
  return value;
}

const isCheckout = (s: Step): boolean => s.uses?.startsWith("actions/checkout@") === true;
const isWriter = (s: Step): boolean => s.uses === "./";

function contractOf(wf: Workflow): Contract {
  const job = must(wf.jobs.apply, "apply job");
  const sha = wf.on.workflow_call?.inputs?.sha;
  const freshness = job.steps.findIndex((s) => s.id === "freshness");
  if (freshness < 0) throw new Error("apply-settings.yml has no freshness step");
  const writerIndexes = job.steps.flatMap((s, i) => (isWriter(s) ? [i] : []));
  const lastWriter = writerIndexes[writerIndexes.length - 1] ?? freshness;
  return {
    jobs: Object.keys(wf.jobs),
    triggers: Object.keys(wf.on).sort(),
    shaInput: sha && {
      required: sha.required === true,
      type: sha.type,
      hasDefault: "default" in sha,
    },
    dispatchInputs: Object.keys(wf.on.workflow_dispatch?.inputs ?? {}),
    mode: job.env?.MODE,
    checkouts: job.steps
      .filter(isCheckout)
      .map((s) => ({ repository: s.with?.repository, path: s.with?.path, ref: s.with?.ref })),
    writers: writerIndexes.map((i) => {
      const step = must(job.steps[i], "writer step");
      return { afterFreshness: i > freshness, if: step.if, mode: step.with?.mode, env: step.env };
    }),
    ungatedBeforeWriter: job.steps
      .slice(freshness + 1, lastWriter)
      .filter((s) => s.if !== FRESHNESS_GATE)
      .map((s) => s.name ?? s.uses ?? "<unnamed step>"),
  };
}

function expectContract(wf: Workflow): void {
  expect(contractOf(wf)).toEqual(EXPECTED);
}

describe("apply-settings.yml post-green write path", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "apply-settings.yml"), "utf8"),
  ) as Workflow;

  test("the hook is call-only for writes, checks out the judged sha once, and gates its one writer on freshness", () => {
    expectContract(wf);
  });

  const REGRESSIONS: Array<[string, (w: Workflow, job: Job) => void, keyof Contract]> = [
    [
      "a second job with its own checkout and writer",
      (w) => {
        w.jobs.shadow = {
          steps: [{ uses: "actions/checkout@v7" }, { uses: "./", with: { mode: "apply" } }],
        };
      },
      "jobs",
    ],
    [
      "a push trigger of its own",
      (w) => (w.on.push = { branches: ["main"] } as Trigger),
      "triggers",
    ],
    [
      "a schedule of its own",
      (w) => (w.on.schedule = [{ cron: "0 0 * * 1" }] as unknown as Trigger),
      "triggers",
    ],
    [
      "a dispatch input, the schema a mode toggle would grow from",
      (w) => (w.on.workflow_dispatch = { inputs: { check_only: { required: false } } }),
      "dispatchInputs",
    ],
    [
      "an optional judged sha",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").required = false),
      "shaInput",
    ],
    [
      "a judged sha with a fallback default",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").default = ""),
      "shaInput",
    ],
    [
      "a judged sha that is not a string",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").type = "boolean"),
      "shaInput",
    ],
    [
      "a mode that lets a dispatch write",
      (_w, job) => (must(job.env, "job env").MODE = "apply"),
      "mode",
    ],
    [
      "a call that checks out the live default branch",
      (_w, job) => {
        const checkout = must(job.steps.find(isCheckout), "checkout step");
        checkout.with = { ...checkout.with, ref: `\${{ github.event.repository.default_branch }}` };
      },
      "checkouts",
    ],
    [
      "a second checkout that swaps the judged tree for the default branch",
      (_w, job) => {
        const writer = job.steps.findIndex(isWriter);
        job.steps.splice(writer, 0, {
          uses: "actions/checkout@v7",
          if: FRESHNESS_GATE,
          with: { ref: `\${{ github.event.repository.default_branch }}` },
        });
      },
      "checkouts",
    ],
    [
      "a second root checkout that names this repository explicitly",
      (_w, job) => {
        const writer = job.steps.findIndex(isWriter);
        job.steps.splice(writer, 0, {
          uses: "actions/checkout@v7",
          if: FRESHNESS_GATE,
          with: { repository: `\${{ github.repository }}`, path: "./" },
        });
      },
      "checkouts",
    ],
    [
      "a negative freshness test on the writer",
      (_w, job) =>
        (must(job.steps.find(isWriter), "writer step").if =
          "steps.freshness.outputs.moved != 'true'"),
      "writers",
    ],
    [
      "a writer whose mode ignores the dispatch pin",
      (_w, job) => {
        const writer = must(job.steps.find(isWriter), "writer step");
        writer.with = { ...writer.with, mode: "apply" };
      },
      "writers",
    ],
    [
      "a writer whose own env shadows the job's MODE",
      (_w, job) => (must(job.steps.find(isWriter), "writer step").env = { MODE: "apply" }),
      "writers",
    ],
    [
      "a second writer ahead of the freshness check",
      (_w, job) => job.steps.splice(1, 0, { uses: "./", with: { mode: "apply" } }),
      "writers",
    ],
    [
      "an ungated bundle build between the freshness check and the writer",
      (_w, job) => {
        const build = must(
          job.steps.find((s) => s.name === "Build the action bundle"),
          "bundle build step",
        );
        build.if = undefined;
      },
      "ungatedBeforeWriter",
    ],
  ];
  test.each(REGRESSIONS)("catches %s (negative control)", (_label, mutate, key) => {
    const drifted = structuredClone(wf);
    mutate(drifted, must(drifted.jobs.apply, "apply job"));
    expect(contractOf(drifted)[key]).not.toEqual(EXPECTED[key]);
    expect(() => expectContract(drifted)).toThrow();
  });
});

interface CallerJob {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: Record<string, string>;
  steps?: Step[];
  [key: string]: unknown;
}

/** The step contract of a self-contained job: what each step is (the action
 * it uses or the command it runs), its gate, and its name. */
interface PinnedStep {
  name: string | undefined;
  id: string | undefined;
  uses: string | undefined;
  if: string | undefined;
  run: string | undefined;
  env: Record<string, string> | undefined;
  with: Record<string, unknown> | undefined;
}
interface CallTrigger extends Trigger {
  secrets?: Record<string, { required?: boolean }>;
}
interface Caller {
  on: Record<string, Trigger | null> & { workflow_call?: CallTrigger | null };
  jobs: Record<string, CallerJob>;
  [key: string]: unknown;
}

interface CallerContract {
  /** The workflow's top-level keys: no lane, permissions, or env above the one job. */
  topLevel: string[];
  triggers: string[];
  /** The whole workflow_call interface ci.yml must satisfy. */
  inputs: Record<string, { required: boolean; type: string | undefined; hasDefault: boolean }>;
  secrets: string[];
  /** Every job, with its exact key set: nothing may gate, lane, or extend the call,
   * and the only job beside it is the build-branch publisher (self-contained steps
   * pinned by name, gate, and command; no ceiling of its own, so it inherits the
   * caller's grant; no call of its own). */
  jobs: Array<{
    id: string;
    keys: string[];
    uses: unknown;
    with: unknown;
    secrets: unknown;
    permissions: unknown;
    steps: PinnedStep[] | undefined;
  }>;
}

/** The build job's gate: every step after the push probe runs only when the token can push. */
const PROCEED = "steps.token.outputs.proceed == 'true'";
/** The push probe: a dry-run push over the real channel; a PAT that cannot push
 * fails the job, a default token that cannot warns naming BOTH remedies. */
const PUSH_PROBE = [
  "if git push --dry-run --quiet origin HEAD:refs/dry-run/token-probe 2>probe.err; then",
  '  echo "proceed=true" >> "$GITHUB_OUTPUT"',
  'elif [ "$PAT_SET" = "true" ]; then',
  "  echo \"::error::REPO_PLATFORM_TOKEN cannot push to this repository: $(tr '\\n' ' ' <probe.err)\"",
  "  exit 1",
  "else",
  '  echo "::warning::this run\'s token cannot push (the caller grants contents: read); the build branch and the latest tag were not advanced here (the release hook advances them on each release)." \\',
  '    "Raise the caller\'s ceiling to contents: write, or add a REPO_PLATFORM_TOKEN PAT secret with Contents (read and write) on this repository, to publish every green push to @latest."',
  '  echo "proceed=false" >> "$GITHUB_OUTPUT"',
  "fi",
  "rm -f probe.err",
  "",
].join("\n");

const CALLER_EXPECTED: CallerContract = {
  topLevel: ["jobs", "name", "on"],
  triggers: ["workflow_call"],
  inputs: { sha: { required: true, type: "string", hasDefault: false } },
  secrets: [],
  jobs: [
    {
      id: "apply-settings",
      keys: ["secrets", "uses", "with"],
      uses: "./.github/workflows/apply-settings.yml",
      with: { sha: `\${{ inputs.sha }}` },
      secrets: "inherit",
      permissions: undefined,
      steps: undefined,
    },
    {
      id: "build",
      keys: ["runs-on", "steps", "timeout-minutes"],
      uses: undefined,
      with: undefined,
      secrets: undefined,
      permissions: undefined,
      steps: [
        {
          name: undefined,
          id: undefined,
          uses: "actions/checkout@v7",
          if: undefined,
          run: undefined,
          env: undefined,
          with: {
            ref: `\${{ inputs.sha }}`,
            "fetch-depth": 0,
            token: `\${{ secrets.REPO_PLATFORM_TOKEN || github.token }}`,
          },
        },
        {
          name: "Check the token can push to build",
          id: "token",
          uses: undefined,
          if: undefined,
          run: PUSH_PROBE,
          env: { PAT_SET: `\${{ secrets.REPO_PLATFORM_TOKEN != '' }}` },
          with: undefined,
        },
        {
          name: undefined,
          id: undefined,
          uses: "oven-sh/setup-bun@v2",
          if: PROCEED,
          run: undefined,
          env: undefined,
          with: { "bun-version-file": ".bun-version" },
        },
        {
          name: "Build the bundle",
          id: undefined,
          uses: undefined,
          if: PROCEED,
          run: "bun install --frozen-lockfile --ignore-scripts\nbun run build:bundle\n",
          env: undefined,
          with: undefined,
        },
        {
          name: "Append this commit's packaged child to build and move latest to the tip",
          id: undefined,
          uses: undefined,
          if: PROCEED,
          run: 'GITHUB_SHA="$SOURCE_SHA" bun .github/scripts/release-pipeline.ts advance-build',
          env: {
            SOURCE_SHA: `\${{ inputs.sha }}`,
            RUN_URL: `\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}`,
          },
          with: undefined,
        },
      ],
    },
  ],
};

function callerContractOf(wf: Caller): CallerContract {
  const call = wf.on.workflow_call;
  return {
    topLevel: Object.keys(wf).sort(),
    triggers: Object.keys(wf.on).sort(),
    inputs: Object.fromEntries(
      Object.entries(call?.inputs ?? {}).map(([name, input]) => [
        name,
        { required: input.required === true, type: input.type, hasDefault: "default" in input },
      ]),
    ),
    secrets: Object.keys(call?.secrets ?? {}).sort(),
    jobs: Object.entries(wf.jobs).map(([id, job]) => ({
      id,
      keys: Object.keys(job).sort(),
      uses: job.uses,
      with: job.with,
      secrets: job.secrets,
      permissions: job.permissions,
      steps: job.steps?.map((step) => ({
        name: step.name,
        id: step.id,
        uses: step.uses,
        if: step.if,
        run: step.run,
        env: step.env,
        with: step.with,
      })),
    })),
  };
}

function expectCallerContract(wf: Caller): void {
  expect(callerContractOf(wf)).toEqual(CALLER_EXPECTED);
}

describe("post-green.yml reaches the hook", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "post-green.yml"), "utf8"),
  ) as Caller;

  test("one job calls apply-settings.yml with the judged sha and inherited secrets", () => {
    expectCallerContract(wf);
  });

  const REGRESSIONS: Array<[string, (w: Caller) => void, keyof CallerContract]> = [
    [
      "the starter's no-op job back in place of the call",
      (w) => {
        delete w.jobs["apply-settings"];
        w.jobs.noop = {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 5,
          steps: [{ env: { SHA: `\${{ inputs.sha }}` }, run: "echo post-green hook for $SHA" }],
        };
      },
      "jobs",
    ],
    [
      "a judged sha that is not forwarded",
      (w) => (must(w.jobs["apply-settings"], "apply-settings job").with = {}),
      "jobs",
    ],
    [
      "secrets that are not inherited, so the PAT never reaches the apply",
      (w) => delete must(w.jobs["apply-settings"], "apply-settings job").secrets,
      "jobs",
    ],
    [
      "an undeclared job beside the call",
      (w) => (w.jobs.extra = { "runs-on": "ubuntu-latest", steps: [{ run: "echo" }] }),
      "jobs",
    ],
    [
      "a build step that runs the append without the token gate",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.at(-1);
        must(step, "append step").if = undefined;
      },
      "jobs",
    ],
    [
      "a build job whose append runs another subcommand",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.at(-1);
        must(step, "append step").run =
          'GITHUB_SHA="$SOURCE_SHA" bun .github/scripts/release-pipeline.ts package';
      },
      "jobs",
    ],
    [
      "a build job with a ceiling of its own instead of the caller's grant",
      (w) => (must(w.jobs.build, "build job").permissions = { contents: "read" }),
      "jobs",
    ],
    [
      "a push probe whose warning names only one of the two remedies",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        must(step, "probe step").run = PUSH_PROBE.replace(
          "Raise the caller's ceiling to contents: write, or add",
          "Add",
        );
      },
      "jobs",
    ],
    [
      "a probe whose output the gates cannot read (its id gone)",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        delete must(step, "probe step").id;
      },
      "jobs",
    ],
    [
      "a probe that cannot tell a rejected PAT from a read ceiling (PAT_SET gone)",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        delete must(step, "probe step").env;
      },
      "jobs",
    ],
    [
      "a shallow checkout, which advance-build refuses (fetch-depth gone)",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[0];
        delete must(must(step, "checkout step").with, "checkout with")["fetch-depth"];
      },
      "jobs",
    ],
    [
      "a checkout that never tries the caller's token",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[0];
        must(must(step, "checkout step").with, "checkout with").token =
          `\${{ secrets.REPO_PLATFORM_TOKEN }}`;
      },
      "jobs",
    ],
    [
      "a call that reaches a different workflow",
      (w) =>
        (must(w.jobs["apply-settings"], "apply-settings job").uses =
          "./.github/workflows/checks.yml"),
      "jobs",
    ],
    [
      "a condition that can skip the call",
      (w) =>
        (must(w.jobs["apply-settings"], "apply-settings job").if =
          "github.ref != 'refs/heads/main'"),
      "jobs",
    ],
    [
      "steps beside the call",
      (w) => (must(w.jobs["apply-settings"], "apply-settings job").steps = [{ run: "echo" }]),
      "jobs",
    ],
    [
      "a caller holding the lane the called workflow takes",
      (w) =>
        (must(w.jobs["apply-settings"], "apply-settings job").concurrency = {
          group: `apply-settings-\${{ github.repository }}`,
        }),
      "jobs",
    ],
    [
      "a workflow-level lane the called workflow also takes",
      (w) => (w.concurrency = { group: `apply-settings-\${{ github.repository }}` }),
      "topLevel",
    ],
    [
      "an optional judged sha",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").required = false),
      "inputs",
    ],
    [
      "a judged sha with a fallback default",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").default = ""),
      "inputs",
    ],
    [
      "a judged sha that is not a string",
      (w) => (must(w.on.workflow_call?.inputs?.sha, "sha input").type = "boolean"),
      "inputs",
    ],
    [
      "a second required input ci.yml does not pass",
      (w) =>
        (must(must(w.on.workflow_call ?? undefined, "workflow_call").inputs, "inputs").mode = {
          required: true,
          type: "string",
        }),
      "inputs",
    ],
    [
      "a declared secret ci.yml does not pass by name",
      (w) =>
        (must(w.on.workflow_call ?? undefined, "workflow_call").secrets = {
          APPLY_SETTING_TOKEN: { required: true },
        }),
      "secrets",
    ],
    [
      "a push trigger of its own",
      (w) => (w.on.push = { branches: ["main"] } as Trigger),
      "triggers",
    ],
    [
      "a dispatch that could reach the apply outside the gate",
      (w) => (w.on.workflow_dispatch = null),
      "triggers",
    ],
  ];
  test.each(REGRESSIONS)("catches %s (negative control)", (_label, mutate, key) => {
    const drifted = structuredClone(wf);
    mutate(drifted);
    expect(callerContractOf(drifted)[key]).not.toEqual(CALLER_EXPECTED[key]);
    expect(() => expectCallerContract(drifted)).toThrow();
  });
});

/** post-green.yml runs only from ci.yml's post-green slot, so neither the build branch nor npm is written from a commit the all-green gate has not judged. */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
interface Input {
  required?: boolean;
  type?: string;
  default?: unknown;
}
interface Trigger {
  inputs?: Record<string, Input>;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`post-green.yml has no ${what}`);
  return value;
}

interface CallerJob {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: Record<string, string>;
  steps?: Step[];
  [key: string]: unknown;
}

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
  /** The workflow's top-level keys: no lane, permissions, or env above the jobs. */
  topLevel: string[];
  triggers: string[];
  /** The whole workflow_call interface ci.yml must satisfy. */
  inputs: Record<string, { required: boolean; type: string | undefined; hasDefault: boolean }>;
  secrets: string[];
  /** Pinned to the exact key set so nothing gates or extends the two jobs; no permissions ceiling of their own, so they inherit the caller's grant. */
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
/**
 * git's stderr prints inside a stop-commands fence keyed by a token minted for the run, so remote-supplied text can neither forge a workflow command
 * nor swallow the static error that follows.
 *   % and encoded line breaks in a message  -> the runner decodes them, so one line can carry a second command
 *   a line whose first non-blank text is "::" -> the runner acts on it, wherever it came from
 *   the fence's own token                     -> the only resume; awk terminates probe.err's last line, so the closing fence is a line of its own
 */
const FENCED_STDERR = [
  "  fence=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')",
  '  echo "::stop-commands::$fence"',
  '  echo "probe stderr:"',
  "  awk '{ print \"  \" $0 }' probe.err",
  '  echo "::$fence::"',
].join("\n");
const PUSH_PROBE = [
  "if git push --dry-run --quiet origin HEAD:refs/dry-run/token-probe 2>probe.err; then",
  '  echo "proceed=true" >> "$GITHUB_OUTPUT"',
  'elif [ "$PAT_SET" = "true" ]; then',
  FENCED_STDERR,
  '  echo "::error::REPO_PLATFORM_TOKEN cannot push to this repository; git\'s refusal is in the probe stderr lines above."',
  "  rm -f probe.err",
  "  exit 1",
  "else",
  '  echo "::warning::this run\'s token cannot push (the caller grants contents: read); the build branch and the latest tag were not advanced here (the release hook advances them on each release)." \\',
  '    "Raise the caller\'s ceiling to contents: write, or add a REPO_PLATFORM_TOKEN PAT secret with Contents (read and write) on this repository, to publish every green push to @latest."',
  '  echo "proceed=false" >> "$GITHUB_OUTPUT"',
  "fi",
  "rm -f probe.err",
  "",
].join("\n");

/** The publish job's gate: every step after the OIDC probe runs only when the runner minted a token URL. */
const OIDC_PROCEED = "steps.oidc.outputs.proceed == 'true'";
/** The OIDC probe: the runner sets ACTIONS_ID_TOKEN_REQUEST_URL only under an
 * id-token: write grant (the managed caller gives post-green one; a fork or a
 * ceiling change may not); without it the job warns, naming the caller's
 * ceiling, and skips. */
const OIDC_PROBE = [
  'if [ -n "$ACTIONS_ID_TOKEN_REQUEST_URL" ]; then',
  '  echo "proceed=true" >> "$GITHUB_OUTPUT"',
  "else",
  '  echo "::warning::this run has no OIDC token (the post-green call in the managed ci.yml grants no id-token: write); the library pre-release was not published to npm." \\',
  '    "Add id-token: write to that call\'s permissions in Vivswan/repo-platform to publish every green push to @next."',
  '  echo "proceed=false" >> "$GITHUB_OUTPUT"',
  "fi",
  "",
].join("\n");
/** The npm floor: trusted publishing needs 11.5.1; an older npm is upgraded once, then held to it. */
const NPM_FLOOR = [
  "floor=11.5.1",
  'below_floor() { [ "$(printf \'%s\\n\' "$floor" "$(npm --version)" | sort -V | head -n1)" != "$floor" ]; }',
  "if below_floor; then",
  "  npm install -g npm@latest",
  "fi",
  "if below_floor; then",
  '  echo "::error::npm $(npm --version) cannot publish through OIDC; trusted publishing needs npm $floor or newer."',
  "  exit 1",
  "fi",
  "",
].join("\n");
/** The publish: the pipeline's verdict names the version or the reason to skip; the source sha reaches npm's provenance; no token is passed. */
const PUBLISH_NEXT = [
  `verdict="$(GITHUB_SHA="$SOURCE_SHA" bun .github/scripts/release-pipeline.ts npm-verdict next)"`,
  'case "$verdict" in',
  "  publish\\ *)",
  `    npm version "\${verdict#publish }" --no-git-tag-version`,
  "    npm pkg delete scripts.prepare",
  `    GITHUB_SHA="$SOURCE_SHA" npm publish --tag next ;;`,
  `  skip\\ *) echo "::notice::\${verdict#skip }" ;;`,
  "  *)",
  '    echo "unexpected npm-verdict output: $verdict"',
  '    echo "::error::npm-verdict printed neither publish nor skip; see the line above."',
  "    exit 1 ;;",
  "esac",
  "",
].join("\n");

const CALLER_EXPECTED: CallerContract = {
  topLevel: ["jobs", "name", "on"],
  triggers: ["workflow_call"],
  inputs: { sha: { required: true, type: "string", hasDefault: false } },
  secrets: [],
  jobs: [
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
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
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
          uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
          if: PROCEED,
          run: undefined,
          env: undefined,
          with: { "bun-version-file": ".bun-version" },
        },
        {
          name: "Build the bundle and the library",
          id: undefined,
          uses: undefined,
          if: PROCEED,
          run: "bun install --frozen-lockfile --ignore-scripts\nbun run build:bundle\nbun run build:lib\n",
          env: undefined,
          with: undefined,
        },
        {
          name: "Append this commit's packaged commit to build and point latest at the newest main source",
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
    {
      id: "publish-next",
      keys: ["concurrency", "if", "runs-on", "steps", "timeout-minutes"],
      uses: undefined,
      with: undefined,
      secrets: undefined,
      permissions: undefined,
      steps: [
        {
          name: "Check the caller grants an OIDC token",
          id: "oidc",
          uses: undefined,
          if: undefined,
          run: OIDC_PROBE,
          env: undefined,
          with: undefined,
        },
        {
          name: undefined,
          id: undefined,
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          if: OIDC_PROCEED,
          run: undefined,
          env: undefined,
          with: { ref: `\${{ inputs.sha }}`, "persist-credentials": false },
        },
        {
          name: undefined,
          id: undefined,
          uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
          if: OIDC_PROCEED,
          run: undefined,
          env: undefined,
          with: { "bun-version-file": ".bun-version" },
        },
        {
          name: undefined,
          id: undefined,
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          if: OIDC_PROCEED,
          run: undefined,
          env: undefined,
          with: { "node-version": 24, "registry-url": "https://registry.npmjs.org" },
        },
        {
          name: "Require an npm that publishes through OIDC",
          id: undefined,
          uses: undefined,
          if: OIDC_PROCEED,
          run: NPM_FLOOR,
          env: undefined,
          with: undefined,
        },
        {
          name: "Build the library",
          id: undefined,
          uses: undefined,
          if: OIDC_PROCEED,
          run: "bun install --frozen-lockfile --ignore-scripts\nbun run build:lib\n",
          env: undefined,
          with: undefined,
        },
        {
          name: "Publish the pre-release under the next dist-tag",
          id: undefined,
          uses: undefined,
          if: OIDC_PROCEED,
          run: PUBLISH_NEXT,
          env: { SOURCE_SHA: `\${{ inputs.sha }}` },
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

describe("post-green.yml publishes the build branch", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "post-green.yml"), "utf8"),
  ) as Caller;

  test("two self-contained jobs, each gated on its probe, with the judged sha as the only input", () => {
    expectCallerContract(wf);
  });

  const REGRESSIONS: Array<[string, (w: Caller) => void, keyof CallerContract]> = [
    [
      "an undeclared job beside the publisher",
      (w) => (w.jobs.extra = { "runs-on": "ubuntu-latest", steps: [{ run: "echo" }] }),
      "jobs",
    ],
    [
      "a job that calls another workflow with inherited secrets",
      (w) => {
        w.jobs.call = {
          uses: "./.github/workflows/checks.yml",
          with: { sha: `\${{ inputs.sha }}` },
          secrets: "inherit",
        };
      },
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
      "a publish job with a ceiling of its own, which the managed caller's rejects as a whole",
      (w) =>
        (must(w.jobs["publish-next"], "publish-next job").permissions = {
          contents: "read",
          "id-token": "write",
        }),
      "jobs",
    ],
    [
      "a publish step that runs without the OIDC gate",
      (w) => {
        const step = must(w.jobs["publish-next"], "publish-next job").steps?.at(-1);
        must(step, "publish step").if = undefined;
      },
      "jobs",
    ],
    [
      "a publish job that hands npm a registry token",
      (w) => {
        const step = must(w.jobs["publish-next"], "publish-next job").steps?.at(-1);
        must(step, "publish step").env = {
          ...must(step, "publish step").env,
          NODE_AUTH_TOKEN: `\${{ secrets.NPM_TOKEN }}`,
        };
      },
      "jobs",
    ],
    [
      "a publish job that publishes under the default dist-tag",
      (w) => {
        const step = must(w.jobs["publish-next"], "publish-next job").steps?.at(-1);
        must(step, "publish step").run = PUBLISH_NEXT.replace(
          "npm publish --tag next",
          "npm publish",
        );
      },
      "jobs",
    ],
    [
      "a publish job open to forks",
      (w) => delete must(w.jobs["publish-next"], "publish-next job").if,
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
      "a push probe that interpolates git's stderr into the workflow command",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        must(step, "probe step").run = PUSH_PROBE.replace(
          `${FENCED_STDERR}\n  echo "::error::REPO_PLATFORM_TOKEN cannot push to this repository; git's refusal is in the probe stderr lines above."`,
          "  echo \"::error::REPO_PLATFORM_TOKEN cannot push to this repository: $(tr '\\n' ' ' <probe.err)\"",
        );
      },
      "jobs",
    ],
    [
      "a push probe that prints git's stderr outside the stop-commands fence",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        must(step, "probe step").run = PUSH_PROBE.replace(
          FENCED_STDERR,
          '  echo "probe stderr:"\n  awk \'{ print "  " $0 }\' probe.err',
        );
      },
      "jobs",
    ],
    [
      "a push probe whose fence token is fixed, so remote text could name it and resume commands",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[1];
        must(step, "probe step").run = PUSH_PROBE.replace(
          "  fence=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')",
          "  fence=probe-marker",
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
      "a checkout of the live default branch instead of the judged sha",
      (w) => {
        const step = must(w.jobs.build, "build job").steps?.[0];
        must(must(step, "checkout step").with, "checkout with").ref =
          `\${{ github.event.repository.default_branch }}`;
      },
      "jobs",
    ],
    [
      "a workflow-level lane above the jobs",
      (w) => (w.concurrency = { group: `post-green-\${{ github.repository }}` }),
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
          REPO_PLATFORM_TOKEN: { required: true },
        }),
      "secrets",
    ],
    [
      "a push trigger of its own",
      (w) => (w.on.push = { branches: ["main"] } as Trigger),
      "triggers",
    ],
    [
      "a dispatch that could reach the publisher outside the gate",
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

/** The probe's stdout as the runner reads it: one entry per line. */
interface ProbeRun {
  lines: string[];
  status: number;
  /** What the step wrote to GITHUB_OUTPUT. */
  output: string;
  probeErrLeft: boolean;
}

/**
 * Run the pinned probe under `bash -e` (what a `run:` step gets on a Linux runner) with git stubbed to write `stderr` and exit `gitStatus`; the
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

const STATIC_ERROR =
  "::error::REPO_PLATFORM_TOKEN cannot push to this repository; git's refusal is in the probe stderr lines above.";
const FENCE_OPEN = /^::stop-commands::([0-9a-f]{32})$/;

describe("the push probe under bash", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "post-green.yml"), "utf8"),
  ) as Caller;
  const run = must(must(must(wf.jobs.build, "build job").steps?.[1], "probe step").run, "run");

  function expectFenced(lines: string[], inner: string[]): void {
    const [open, header, ...rest] = lines;
    const token = open?.match(FENCE_OPEN)?.[1];
    expect(token).toBeDefined();
    expect(header).toBe("probe stderr:");
    expect(rest).toEqual([...inner, `::${token}::`, STATIC_ERROR, ""]);
    // The runner trims, so an indented "::error::forged" still reads as a command outside a fence; the indent only marks the lines as quoted text in
    // the log.
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

  test("without a PAT a refused probe warns, skips, and prints no stderr (control)", () => {
    const probe = runProbe(run, "refused\n", 1, false);
    expect(probe.status).toBe(0);
    expect(probe.lines.filter((line) => line.startsWith("::"))).toEqual([
      "::warning::this run's token cannot push (the caller grants contents: read); the build branch " +
        "and the latest tag were not advanced here (the release hook advances them on each release). " +
        "Raise the caller's ceiling to contents: write, or add a REPO_PLATFORM_TOKEN PAT secret with " +
        "Contents (read and write) on this repository, to publish every green push to @latest.",
    ]);
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

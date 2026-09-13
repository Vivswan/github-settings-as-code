/**
 * The command tree end to end: each subcommand through main() against a
 * stub client, holding the exit codes and outputs to the action's, the two
 * file-only commands to their verdicts, and the token to never appearing in
 * what the CLI prints.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CliHost } from "../../src/cli/commands.js";
import { CLI_COMMANDS, main } from "../../src/cli/program.js";
import { type ConfigEnv, type GithubClient, sectionGrant, sectionModule } from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { memoryStream, runCli } from "./streams.js";

const ROOT = join(import.meta.dir, "..", "..");
const SINGLE = join(ROOT, "test", "fixtures", "single.yml");
const LAYERS = join(ROOT, "test", "fixtures", "layers");
const TOKEN = "ghp_cli_test_token";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsac-cli-"));
  scratch.push(dir);
  return dir;
}

const cli = runCli;

describe("check and apply", () => {
  const target = ["--repository", "o/r", "--settings-file", SINGLE, "--token", TOKEN];

  test("a host written as a method keeps its receiver through the executor", async () => {
    class MethodHost implements CliHost {
      readonly env = {};
      constructor(private readonly api: GithubClient) {}
      createClient(): GithubClient {
        return this.api;
      }
    }
    const stdout = memoryStream();
    const stderr = memoryStream();
    const code = await main(["node", "gsac", "check", ...target], {
      host: new MethodHost(
        new MockApi({ "GET /repos/o/r": { data: { has_wiki: false, private: false } } }),
      ),
      streams: { stdout: stdout.stream, stderr: stderr.stream },
      colors: false,
    });
    expect({ code, stdout: stdout.text(), stderr: stderr.text() }).toEqual({
      code: 0,
      stdout: "result: clean\nresult=clean\nskipped-sections=\nrepos-result={}\n",
      stderr: "",
    });
  });

  test("check: clean exits 0 with result=clean, drift exits 1 with result=drift", async () => {
    // `private: false` proves the target public, so its lines print in the clear
    // under the action's default redaction; a terminal has no GITHUB_REPOSITORY to exempt.
    const clean = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false, private: false } } }),
    );
    expect(clean).toEqual({
      code: 0,
      stdout: "result: clean\nresult=clean\nskipped-sections=\nrepos-result={}\n",
      stderr: "",
    });
    const drifted = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: true, private: false } } }),
    );
    expect(drifted.code).toBe(1);
    // Drift lines are log lines: stdout, with the outputs closing the run.
    expect(drifted.stdout).toContain("has_wiki");
    expect(drifted.stdout).toEndWith(
      "result: drift\nresult=drift\nskipped-sections=\nrepos-result={}\n",
    );
    expect(drifted.stderr).toBe("");
  });

  test("a target the probe cannot prove public is redacted, as the action redacts it", async () => {
    const result = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(
      "warning: private repository #1: drift - repository. details hidden",
    );
    expect(result.stderr).not.toContain("has_wiki");
  });

  test("apply patches the declared keys, exits 0, and reports applied", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    const applied = await cli(["apply", ...target], api);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toEndWith("result=applied\nskipped-sections=\nrepos-result={}\n");
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
  });

  test("--json prints the outputs as one object and nothing else on stdout", async () => {
    const result = await cli(
      ["check", ...target, "--json"],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } }),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("result: clean\n");
    expect(JSON.parse(result.stdout)).toEqual({
      result: "clean",
      "skipped-sections": [],
      "repos-result": {},
    });
  });

  test("the token comes from GITHUB_TOKEN when no flag names it", async () => {
    const result = await cli(
      ["check", "--repository", "o/r", "--settings-file", SINGLE],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } }),
      { GITHUB_TOKEN: TOKEN },
    );
    expect(result.code).toBe(0);
  });

  test("a config problem fails before any API call, the action's line on stderr", async () => {
    const api = new MockApi({});
    const result = await cli(["check", "--repository", "not-a-slug", "--token", TOKEN], api);
    expect(result.code).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(result.stderr).toBe(
      'error: cannot target a repository: "not-a-slug" is not an owner/name slug. Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)\n',
    );
    expect(result.stdout).toBe(
      "result: failed\nresult=failed\nskipped-sections=\nrepos-result={}\n",
    );
  });

  test.each<[string, string[], string]>([
    [
      "no token",
      ["check", "--repository", "o/r"],
      "cannot call the GitHub API: no token was provided. Pass --token, or export GITHUB_TOKEN",
    ],
    [
      "no repository outside Actions",
      ["check", "--token", TOKEN],
      'cannot target a repository: "" is not an owner/name slug. Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)',
    ],
    [
      "the artifact channel",
      ["check", ...target, "--private-report", "artifact"],
      'the "private-report" input is "artifact", which is not a supported private-report channel from the command line (the artifact upload needs the Actions runner). Set it to "none" (default), "issue", "issue-on-failure"',
    ],
  ])("%s fails with a remedy a terminal can follow", async (_case, args, message) => {
    const api = new MockApi({});
    const result = await cli(args, api);
    expect(api.calls).toHaveLength(0);
    expect(result).toEqual({
      code: 1,
      stdout: "result: failed\nresult=failed\nskipped-sections=\nrepos-result={}\n",
      stderr: `error: ${message}\n`,
    });
  });

  test("the token never appears in what the CLI prints, even echoed by the API", async () => {
    const api = new MockApi({
      "GET /repos/o/r": { error: { status: 500, message: `bad token ${TOKEN}`, body: "" } },
    });
    const result = await cli(["check", ...target, "--private-repos", "show"], api);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(result.stderr).toContain("bad token ***");
  });

  test.each<[string, string[], ConfigEnv]>([
    ["the parser's unknown-option message", ["check", `--tokn=${TOKEN}`], { GITHUB_TOKEN: TOKEN }],
    ["a file-only command's argument, plain", ["validate", TOKEN], { GITHUB_TOKEN: TOKEN }],
    [
      "a file-only command's argument, --json",
      ["validate", TOKEN, "--json"],
      { GITHUB_TOKEN: TOKEN },
    ],
    [
      "a config error echoing a padded --token",
      ["check", "--token", ` ${TOKEN} `, "--repository", TOKEN],
      {},
    ],
    ["a config error echoing --token=", ["check", `--token=${TOKEN}`, "--repository", TOKEN], {}],
  ])("the token is masked in %s", async (_where, args, env) => {
    // Every writer goes through one boundary registered before the parse, so
    // a message no code of ours words (the parser's, a path echo) is masked too.
    const result = await cli(args, new MockApi({}), env);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(result.stdout + result.stderr).toContain("***");
  });

  test.each([false, true])(
    "a failure after the parse is reported through the mask boundary, exit 1 (verbose: %p)",
    async (verbose) => {
      // The summary file's directory does not exist, so the write throws inside
      // the run; the path carries the token, and the report must not. Without
      // --verbose the remedy asks for it; with it the stack is the report.
      const summary = join(tempDir(), "missing", `${TOKEN}.md`);
      const masked = summary.replaceAll(TOKEN, "***");
      const result = await cli(
        ["check", ...target, "--summary", summary, ...(verbose ? ["--verbose"] : [])],
        new MockApi({ "GET /repos/o/r": { data: { has_wiki: false, private: false } } }),
      );
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      const message = `Error: ENOENT: no such file or directory, open '${masked}'`;
      if (!verbose) {
        expect(result.stderr).toBe(
          `error: github-settings-as-code stopped unexpectedly: ${message}. Re-run with --verbose for the stack; if it recurs, file a bug with that output attached\n`,
        );
        return;
      }
      // The stack's frames carry this machine's paths, so the line is pinned around them.
      expect(result.stderr).toStartWith(
        `error: github-settings-as-code stopped unexpectedly: ${message}\n    at `,
      );
      expect(result.stderr).toEndWith(
        ". The stack above is the report: if it recurs, file a bug with it attached\n",
      );
      expect(result.stderr).not.toContain("Re-run with --verbose");
    },
  );

  test("--summary appends the run's markdown to the named file", async () => {
    const summary = join(tempDir(), "summary.md");
    const result = await cli(
      ["check", ...target, "--summary", summary],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } }),
    );
    expect(result.code).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("clean");
  });
});

describe("merge", () => {
  test("folds the layers into the merged file, exits 0, and reports merged", async () => {
    const out = join(tempDir(), "merged.yml");
    const result = await cli([
      "merge",
      "--settings-file",
      join(LAYERS, "fleet.yml"),
      "--settings-file",
      join(LAYERS, "team.yml"),
      "--merged-file",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toEndWith(
      "result: merged\nresult=merged\nskipped-sections=\nrepos-result={}\n",
    );
    // The whole document only the fold produces: team.yml's label and rule join
    // fleet.yml's under explicit policy wrappers, its `has_projects: null` removes
    // fleet.yml's key, and pages passes through untouched.
    expect(parseYaml(readFileSync(out, "utf8"))).toEqual({
      repository: { has_wiki: false },
      labels: {
        _undeclared: "delete",
        entries: [
          { name: "bug", color: "d73a4a" },
          { name: "docs", color: "0075ca" },
          { name: "team", color: "00ff00" },
        ],
      },
      rulesets: {
        _undeclared: "keep",
        entries: [
          {
            name: "main",
            target: "branch",
            enforcement: "active",
            rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
          },
        ],
      },
      pages: { build_type: "workflow", source: { branch: "main", path: "/" } },
    });
  });

  test("a merge without merged-file fails with the action's line", async () => {
    const result = await cli(["merge", "--settings-file", join(LAYERS, "fleet.yml")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith('error: mode: merge needs a "merged-file" input');
    expect(result.stdout).toBe(
      "result: failed\nresult=failed\nskipped-sections=\nrepos-result={}\n",
    );
  });
});

describe("snapshot", () => {
  const LABEL = { name: "bug", color: "d73a4a", description: "Something is broken" };

  test("writes the live settings to the snapshot file, exits 0, and reports snapshot", async () => {
    const out = join(tempDir(), "out", "snapshot.yml");
    const api = new MockApi({
      "GET /repos/o/r": { data: { private: false } },
      "GET /repos/o/r/labels?per_page=100&page=1": { data: [LABEL] },
    });
    const result = await cli(
      [
        "snapshot",
        "--token",
        TOKEN,
        "--repository",
        "o/r",
        "--snapshot-file",
        out,
        "--sections",
        "labels",
      ],
      api,
    );
    expect(result).toEqual({
      code: 0,
      stdout: `snapshot written to ${out}\nresult: snapshot\nresult=snapshot\nskipped-sections=\nrepos-result={}\n`,
      stderr: "",
    });
    expect(api.mutations()).toEqual([]);
    expect(parseYaml(readFileSync(out, "utf8"))).toEqual({
      labels: { _undeclared: "delete", entries: [LABEL] },
    });
  });

  test("a snapshot without a destination fails before any API call, the action's line on stderr", async () => {
    const api = new MockApi({});
    const result = await cli(["snapshot", "--token", TOKEN, "--repository", "o/r"], api);
    expect(api.calls).toHaveLength(0);
    expect(result).toEqual({
      code: 1,
      stdout: "result: failed\nresult=failed\nskipped-sections=\nrepos-result={}\n",
      stderr:
        'error: mode: snapshot needs exactly one of the "snapshot-file" input (one repository\'s settings written to that file) or the "snapshot-dir" input (one <owner>/<name>.yml per repos or repos-dir target under that directory). Set one of them\n',
    });
  });
});

describe("validate and permissions", () => {
  test("validate: a valid file exits 0 naming its sections; --json gives the verdict as an object", async () => {
    const plain = await cli(["validate", SINGLE]);
    expect(plain).toEqual({
      code: 0,
      stdout: `${SINGLE} is valid: 1 section(s) declared (repository)\n`,
      stderr: "",
    });
    const json = await cli(["validate", SINGLE, "--json"]);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      result: "valid",
      file: SINGLE,
      sections: ["repository"],
    });
  });

  test("validate: an invalid file exits 1 with the validator's line", async () => {
    const file = join(tempDir(), "bad.yml");
    writeFileSync(file, "labels:\n  - color: d73a4a\n");
    const result = await cli(["validate", file]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith(`error: ${file} has malformed section entries:`);
    // The same message, once on stderr and once as the object's problem.
    const problem = result.stderr.slice("error: ".length, -1);
    const json = await cli(["validate", file, "--json"]);
    expect(json.code).toBe(1);
    expect(json.stderr).toBe(result.stderr);
    expect(JSON.parse(json.stdout)).toEqual({ result: "failed", file, problem });
  });

  test("validate: an unreadable file exits 1 naming the path", async () => {
    const result = await cli(["validate", join(tempDir(), "missing.yml")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("error: cannot read settings from ");
  });

  test("permissions prints one grant per declared section, from the section declarations", async () => {
    const file = join(tempDir(), "settings.yml");
    writeFileSync(
      file,
      "labels:\n  - name: bug\n    color: d73a4a\nrepository:\n  has_wiki: false\n",
    );
    const result = await cli(["permissions", file]);
    expect(result).toEqual({
      code: 0,
      stdout: `repository: ${sectionGrant(sectionModule("repository"))}\nlabels: ${sectionGrant(sectionModule("labels"))}\n`,
      stderr: "",
    });
    const json = await cli(["permissions", file, "--json"]);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      result: "valid",
      file,
      grant: {
        repository: sectionGrant(sectionModule("repository")),
        labels: sectionGrant(sectionModule("labels")),
      },
    });
  });
});

describe("the --json failure envelope", () => {
  test.each<[string, string[]]>([
    [
      "a config problem in a mode command",
      [
        "check",
        "--token",
        TOKEN,
        "--repository",
        "not-a-slug",
        "--settings-file",
        SINGLE,
        "--json",
      ],
    ],
    ["a missing required input", ["merge", "--settings-file", SINGLE, "--json"]],
    ["a parser error", ["validate", "--json"]],
    // The duplicate is refused at the second --token, before the parser reaches --json.
    [
      "a parser error raised before the flag",
      ["check", "--token", "ghp_first", "--token", "ghp_second", "--json"],
    ],
  ])(
    "%s: stdout is one failed envelope carrying the stderr line as its problem, exit 1",
    async (_case, argv) => {
      const result = await cli(argv);
      expect(result.code).toBe(1);
      const lines = result.stdout.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(1);
      const problem = result.stderr.match(/^error: (.*)$/m)?.[1];
      expect(problem).toBeDefined();
      const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      expect(envelope.result).toBe("failed");
      expect(envelope.problem).toBe(problem);
    },
  );

  test.each<[string, string[], boolean]>([
    [
      "a --json after the -- terminator is an argument",
      ["validate", "--", "--json", "extra"],
      false,
    ],
    [
      "a --json the parser took as --summary's value still reads as the flag",
      ["validate", "--summary", "--json"],
      true,
    ],
    [
      "a --json after --summary took -- as its value is the flag",
      ["validate", "--summary", "--", "--json"],
      true,
    ],
  ])("what counts as --json on a parser error: %s", async (_case, argv, envelope) => {
    const result = await cli(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("error: ");
    expect(result.stdout).toBe(
      envelope
        ? `${JSON.stringify({ result: "failed", problem: "missing required argument 'file'" })}\n`
        : "",
    );
  });

  test("--help under --json is the one exception: the usage on stdout, no envelope, exit 0", async () => {
    const result = await cli(["--json", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toStartWith("Usage: github-settings-as-code");
    expect(result.stdout).not.toContain('"result"');
  });

  test("no subcommand under --json: the usage on stderr, an envelope naming the missing subcommand, exit 1", async () => {
    const result = await cli(["--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("Usage: github-settings-as-code");
    expect(JSON.parse(result.stdout)).toEqual({
      result: "failed",
      problem: "no subcommand was given; the usage above lists them",
    });
  });

  test("a mode command's failed envelope still carries the three outputs", async () => {
    const result = await cli(["merge", "--settings-file", SINGLE, "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      result: "failed",
      "skipped-sections": [],
      "repos-result": {},
      problem:
        'mode: merge needs a "merged-file" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file',
    });
  });
});

describe("commander's own exits", () => {
  test("--help exits 0, prints the bin name, and names every subcommand", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("Usage: github-settings-as-code [options] [command]");
    expect(result.stdout).toContain("gsac");
    for (const command of CLI_COMMANDS) {
      expect(result.stdout).toContain(`  ${command}`);
    }
  });

  test("a repeated single-value flag exits 1 naming the flag; a repeated list flag accumulates", async () => {
    const repeated = await cli(
      ["check", "--token", TOKEN, "--repository", "a/b", "--repository", "c/d"],
      new MockApi({}),
    );
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toBe(
      "error: option '--repository <value>' argument 'c/d' is invalid. --repository takes one value and was given more than once\n",
    );
    // Both unknown names must be reported: a last-wins parser would name only the second.
    const list = await cli([
      "check",
      "--token",
      TOKEN,
      "--repository",
      "o/r",
      "--sections",
      "nope",
      "--sections",
      "also",
    ]);
    expect(list.code).toBe(1);
    expect(list.stderr).toStartWith(
      'error: unknown sections "nope", "also" in the "sections" input',
    );
    // Both token values were registered before the parse, so the echo is masked.
    const token = await cli(["check", "--token", "first", "--token", "second"]);
    expect(token.code).toBe(1);
    expect(token.stderr).toBe(
      "error: option '--token <value>' argument '***' is invalid. --token takes one value and was given more than once\n",
    );
  });

  test("an unknown flag exits 1 with commander's line on stderr", async () => {
    const result = await cli(["check", "--tokn", "x"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: unknown option '--tokn'");
  });

  test("a missing file argument exits 1", async () => {
    const result = await cli(["validate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: missing required argument 'file'");
  });
});

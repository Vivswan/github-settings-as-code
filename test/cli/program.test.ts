/**
 * The command tree through main(): what only the program decides, beside the
 * equivalence pins (test/cli/execution.test.ts runs every arm on both faces,
 * test/cli/inputs.test.ts holds argv -> config to env -> config). Here: the
 * host's receiver, the --json envelope on every exit, the crash path, the
 * file-only commands' verdicts, and the token never appearing in what the
 * CLI prints.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliHost } from "../../src/cli/commands.js";
import { main } from "../../src/cli/program.js";
import { type ConfigEnv, type GitHubClient, sectionGrant, sectionModule } from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import { memoryStream, runCli } from "./streams.js";

const SINGLE = join(ROOT, "test", "fixtures", "single.yml");
const TOKEN = "ghp_cli_test_token";

const cli = runCli;

describe("check and apply", () => {
  const target = ["--repository", "o/r", "--settings-file", SINGLE, "--token", TOKEN];

  test("a host written as a method keeps its receiver through the executor", async () => {
    class MethodHost implements CliHost {
      readonly env = {};
      constructor(private readonly api: GitHubClient) {}
      createClient(): GitHubClient {
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

  test("a config problem fails before any API call, the action's line on stderr", async () => {
    const api = new MockApi({});
    const result = await cli(["check", "--repository", "not-a-slug", "--token", TOKEN], api);
    expect(result.code).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(result.stderr).toBe(
      'error: cannot target a repository: "not-a-slug" is not an owner/name slug. Set the "repository" input (--repository on the command line) to a value like "octocat/hello-world"; inside GitHub Actions, GITHUB_REPOSITORY supplies it\n',
    );
    expect(result.stdout).toBe(
      "result: failed\nresult=failed\nskipped-sections=\nrepos-result={}\n",
    );
  });

  test.each<[string, string[], ConfigEnv]>([
    ["the parser's unknown-option message", ["check", `--tokn=${TOKEN}`], { GITHUB_TOKEN: TOKEN }],
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
    (verbose) =>
      withTempDir("gsac-cli-", async (dir) => {
        // The summary file's directory does not exist, so the write throws inside
        // the run; the path carries the token, and the report must not. Without
        // --verbose the remedy asks for it; with it the stack is the report.
        const summary = join(dir, "missing", `${TOKEN}.md`);
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
      }),
  );

  test("--summary appends the run's markdown to the named file", () =>
    withTempDir("gsac-cli-", async (dir) => {
      const summary = join(dir, "summary.md");
      const result = await cli(
        ["check", ...target, "--summary", summary],
        new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } }),
      );
      expect(result.code).toBe(0);
      expect(readFileSync(summary, "utf8")).toContain("clean");
    }));
});

describe("validate and permissions", () => {
  test("validate: a valid file exits 0 naming its sections; --json gives the verdict as an object", async () => {
    const plain = await cli(["validate", SINGLE]);
    expect(plain).toEqual({
      code: 0,
      stdout: `${SINGLE} is valid: 1 section declared (repository)\n`,
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

  test("validate: an invalid file exits 1 with the validator's line", () =>
    withTempDir("gsac-cli-", async (dir) => {
      const file = join(dir, "bad.yml");
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
    }));

  test("permissions prints one grant per declared section, from the section declarations", () =>
    withTempDir("gsac-cli-", async (dir) => {
      const file = join(dir, "settings.yml");
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
    }));
});

describe("the --json failure envelope", () => {
  test("a missing required input: stdout is one failed envelope carrying the stderr line as its problem, exit 1", async () => {
    const result = await cli(["merge", "--settings-file", SINGLE, "--json"]);
    expect(result.code).toBe(1);
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const problem = result.stderr.match(/^error: (.*)$/m)?.[1];
    expect(problem).toBeDefined();
    const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(envelope.result).toBe("failed");
    expect(envelope.problem).toBe(problem);
  });

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

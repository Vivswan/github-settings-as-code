/**
 * The command tree through main(): what only the program decides, beside the
 * equivalence pins (test/cli/execution.test.ts runs every arm on both faces,
 * test/cli/inputs.test.ts holds argv -> config to env -> config). Here: the
 * host's receiver, the --json envelope on every exit, the crash path, the
 * file-only commands' verdicts, and the token never appearing in what the
 * CLI prints.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    async (verbose) => {
      // The client factory throws inside the run, its message carrying the token, and the report must not.
      // Without --verbose the remedy asks for it; with it the stack is the report.
      const stdout = memoryStream();
      const stderr = memoryStream();
      const host: CliHost = {
        env: {},
        createClient: () => {
          throw new Error(`no client for ${TOKEN}`);
        },
      };
      const code = await main(
        ["node", "gsac", "check", ...target, ...(verbose ? ["--verbose"] : [])],
        { host, streams: { stdout: stdout.stream, stderr: stderr.stream }, colors: false },
      );
      expect(code).toBe(1);
      expect(stdout.text() + stderr.text()).not.toContain(TOKEN);
      const message = "Error: no client for ***";
      if (!verbose) {
        expect(stderr.text()).toBe(
          `error: github-settings-as-code stopped unexpectedly: ${message}. Re-run with --verbose for the stack; if it recurs, file a bug with that output attached\n`,
        );
        return;
      }
      // The stack's frames carry this machine's paths, so the line is pinned around them.
      expect(stderr.text()).toStartWith(
        `error: github-settings-as-code stopped unexpectedly: ${message}\n    at `,
      );
      expect(stderr.text()).toEndWith(
        ". The stack above is the report: if it recurs, file a bug with it attached\n",
      );
      expect(stderr.text()).not.toContain("Re-run with --verbose");
    },
  );

  // Opened only when the summary was appended, a path that could not be was found out after the run's requests had landed.
  test.each<[string, (dir: string) => string, string]>([
    ["under a directory that does not exist", (dir) => join(dir, "no-such-dir", "summary.md"), ""],
    [
      "at a file that already holds a block",
      (dir) => {
        const file = join(dir, "summary.md");
        writeFileSync(file, "## earlier\n");
        return file;
      },
      "## earlier\n",
    ],
  ])(
    "--summary %s is opened before the run, and the run's summary is appended to what the file held",
    (_where, arrange, held) =>
      withTempDir("gsac-cli-", async (dir) => {
        const summary = arrange(dir);
        const api = new MockApi({
          "GET /repos/o/r": { data: { has_wiki: true, private: false } },
        }).allowMutations("PATCH /repos/o/r");
        const result = await cli(["apply", ...target, "--summary", summary, "--json"], api);
        expect({ code: result.code, stdout: JSON.parse(result.stdout) }).toEqual({
          code: 0,
          stdout: { result: "applied", "skipped-sections": [], "repos-result": {} },
        });
        expect(api.mutations().map((call) => `${call.method} ${call.path}`)).toEqual([
          "PATCH /repos/o/r",
        ]);
        const written = readFileSync(summary, "utf8");
        expect(written).toStartWith(`${held}## github-settings-as-code (apply)\n`);
        expect(written).toContain("| repository | :white_check_mark: applied |");
      }),
  );

  test.each<[string, (dir: string) => string, string]>([
    ["a directory", (dir) => dir, "EISDIR: illegal operation on a directory"],
    [
      "a link into a directory that does not exist",
      (dir) => {
        const link = join(dir, "summary.md");
        symlinkSync(join(dir, "missing", "summary.md"), link);
        return link;
      },
      "ENOENT: no such file or directory",
    ],
  ])(
    "a --summary path that is %s cannot be opened, so it is refused before any request, naming --summary",
    (_what, arrange, reason) =>
      withTempDir("gsac-cli-", async (dir) => {
        const summary = arrange(dir);
        const api = new MockApi({});
        const problem = `cannot write the summary to ${summary}: Error: ${reason}, open '${summary}'. Check that --summary names a writable path`;
        const result = await cli(["apply", ...target, "--summary", summary, "--json"], api);
        expect(api.calls).toEqual([]);
        expect({ ...result, stdout: JSON.parse(result.stdout) }).toEqual({
          code: 1,
          stdout: { result: "failed", problem },
          stderr: `error: ${problem}\n`,
        });
      }),
  );
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
    const result = await cli(["render", "--settings-file", SINGLE, "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      result: "failed",
      "skipped-sections": [],
      "repos-result": {},
      problem:
        'mode: render needs a "rendered-file" input: the path the rendered settings document is written to. Set it (for example .github/settings.rendered.yml) and feed that path to a later apply or check step as its settings-file',
    });
  });
});

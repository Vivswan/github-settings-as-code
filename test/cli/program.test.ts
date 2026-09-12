/**
 * The command tree end to end: each subcommand through main() against a
 * stub client, holding the exit codes and outputs to the action's, the two
 * file-only commands to their verdicts, the unavailable commands to their one
 * line, and the token to never appearing in what the CLI prints.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_COMMANDS, main } from "../../src/cli/program.js";
import { type ConfigEnv, type GithubClient, sectionGrant, sectionModule } from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { memoryStream } from "./streams.js";

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

async function cli(
  args: readonly string[],
  api: GithubClient = new MockApi({}),
  env: ConfigEnv = {},
) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await main(["node", "gsac", ...args], {
    host: { env, createClient: () => api },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: false,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("check and apply", () => {
  const target = ["--repository", "o/r", "--settings-file", SINGLE, "--token", TOKEN];

  test("check: clean exits 0 with result=clean, drift exits 1 with result=drift", async () => {
    // `private: false` proves the target public, so its lines print in the clear
    // under the action's default redaction; a terminal has no GITHUB_REPOSITORY to exempt.
    const clean = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false, private: false } } }),
    );
    expect(clean).toEqual({
      code: 0,
      stdout: "result: clean\nskipped-sections=\nresult=clean\n",
      stderr: "",
    });
    const drifted = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: true, private: false } } }),
    );
    expect(drifted.code).toBe(1);
    // Drift lines are log lines: stdout, with the outputs closing the run.
    expect(drifted.stdout).toContain("has_wiki");
    expect(drifted.stdout).toEndWith("result: drift\nskipped-sections=\nresult=drift\n");
    expect(drifted.stderr).toBe("");
  });

  test("a target the probe cannot prove public is redacted, as the action redacts it", async () => {
    const result = await cli(
      ["check", ...target],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(
      "warning: private repository: drift - repository. details hidden",
    );
    expect(result.stderr).not.toContain("has_wiki");
  });

  test("apply patches the declared keys, exits 0, and reports applied", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    const applied = await cli(["apply", ...target], api);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toEndWith("result=applied\n");
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
    expect(JSON.parse(result.stdout)).toEqual({ "skipped-sections": "", result: "clean" });
    expect(result.stderr).toBe("result: clean\n");
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
      'error: cannot target a repository: "not-a-slug" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"\n',
    );
    expect(result.stdout).toBe("result: failed\nskipped-sections=\nresult=failed\n");
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

  test("a failure after the parse is reported through the mask boundary, exit 1", async () => {
    // The summary file's directory does not exist, so the write throws inside
    // the run; the path carries the token, and the report must not.
    const summary = join(tempDir(), "missing", `${TOKEN}.md`);
    const result = await cli(
      ["check", ...target, "--summary", summary],
      new MockApi({ "GET /repos/o/r": { data: { has_wiki: false, private: false } } }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("error: github-settings-as-code stopped unexpectedly: ");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(result.stderr).toContain("***");
  });

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
    expect(result.stdout).toEndWith("result: merged\nskipped-sections=\nresult=merged\n");
    expect(readFileSync(out, "utf8")).toContain("name: team");
  });

  test("a merge without merged-file fails with the action's line", async () => {
    const result = await cli(["merge", "--settings-file", join(LAYERS, "fleet.yml")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith('error: mode: merge needs a "merged-file" input');
    expect(result.stdout).toBe("result: failed\nskipped-sections=\nresult=failed\n");
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
    expect(JSON.parse(json.stdout)).toEqual({
      file: SINGLE,
      valid: true,
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
    const json = await cli(["validate", file, "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ file, valid: false });
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
    expect(JSON.parse(json.stdout)).toEqual({
      repository: sectionGrant(sectionModule("repository")),
      labels: sectionGrant(sectionModule("labels")),
    });
  });
});

describe("the commands this build cannot run", () => {
  test.each(["snapshot", "init"])("%s exits 1 naming the missing mode", async (command) => {
    const result = await cli([command]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `error: ${command} needs mode: snapshot, which this build of github-settings-as-code does not include. Upgrade to a release whose inputs reference lists snapshot among the modes\n`,
    );
  });
});

describe("commander's own exits", () => {
  test("--help exits 0 and names every subcommand", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    for (const command of CLI_COMMANDS) {
      expect(result.stdout).toContain(`  ${command}`);
    }
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

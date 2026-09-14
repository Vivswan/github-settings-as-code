/** `init` end to end through main() against a stub client, the argv port and the written file alike. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InitConfig } from "../../src/cli/init.js";
import { main } from "../../src/cli/program.js";
import {
  type ConfigEnv,
  DEFAULT_API_VERSION,
  parseRepoSlug,
  SectionSelection,
  sectionGrant,
  sectionModule,
  validateSettings,
} from "../../src/index.js";
import { DEFAULT_SETTINGS_FILE, SNAPSHOT_SCHEMA_URL } from "../../src/internal.js";
import { MockApi } from "../mock-api.js";
import { withTempDir } from "../temp-dir.js";
import { memoryStream, runCli } from "./streams.js";

const TOKEN = "ghp_cli_init_token";
const BUG = { name: "bug", color: "d73a4a", description: "Something is broken" };
const LABELS_ROUTE = { "GET /repos/o/r/labels?per_page=100&page=1": { data: [BUG] } };
const LABELS_DOC = { labels: { _undeclared: "delete", entries: [BUG] } };
const LABELS_GRANT = sectionGrant(sectionModule("labels"));

const cli = runCli;

/** Drive init on `argv` and capture what its argv port parsed, or what it printed. */
async function parsed(argv: readonly string[], env: ConfigEnv = {}) {
  let cfg: InitConfig | undefined;
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await main(["node", "gsac", "init", ...argv], {
    host: { env, createClient: () => new MockApi({}) },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: false,
    executeInit: async (config) => {
      cfg = config;
      return { code: 0, lines: [], json: { result: "snapshot" } };
    },
  });
  return { cfg, code, stderr: stderr.text() };
}

describe("init: argv -> config", () => {
  test("the defaults: the settings file apply and check read, every section, the fail policy, no --force", async () => {
    const result = await parsed(["--repository", "o/r"], { GITHUB_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect(result.cfg).toEqual({
      kind: "init",
      token: TOKEN,
      apiVersion: DEFAULT_API_VERSION,
      repo: parseRepoSlug("o/r")._unsafeUnwrap(),
      settingsFile: DEFAULT_SETTINGS_FILE,
      sections: SectionSelection.ALL,
      onMissingPermission: "fail",
      force: false,
    });
  });

  test("every flag set, --force included", async () => {
    const result = await parsed([
      "--token",
      TOKEN,
      "--repository",
      "o/r",
      "--settings-file",
      "conf/settings.yml",
      "--sections",
      "labels,milestones",
      "--on-missing-permission",
      "warn",
      "--api-version",
      "2030-01-01",
      "--force",
    ]);
    expect(result.cfg).toEqual({
      kind: "init",
      token: TOKEN,
      apiVersion: "2030-01-01",
      repo: parseRepoSlug("o/r")._unsafeUnwrap(),
      settingsFile: "conf/settings.yml",
      sections: SectionSelection.of({ only: ["labels", "milestones"] })._unsafeUnwrap(),
      onMissingPermission: "warn",
      force: true,
    });
  });

  test.each<[string, string[], ConfigEnv, string]>([
    [
      "no token",
      ["--repository", "o/r"],
      {},
      'cannot call the GitHub API: no token was provided. Set the "token" input (--token on the command line), or export GITHUB_TOKEN',
    ],
    [
      "a settings file spelled as a list",
      ["--repository", "o/r", "--settings-file", "a.yml,b.yml"],
      { GITHUB_TOKEN: TOKEN },
      'the "settings-file" input is "a.yml,b.yml", which contains a list separator: init writes exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file',
    ],
    [
      "a repeated settings file",
      ["--repository", "o/r", "--settings-file", "a.yml", "--settings-file", "b.yml"],
      { GITHUB_TOKEN: TOKEN },
      'the "settings-file" input is "a.yml\nb.yml", which contains a list separator: init writes exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file',
    ],
  ])(
    "%s is refused before any config exists, with a remedy a terminal can follow",
    async (_case, argv, env, message) => {
      const result = await parsed(argv, env);
      expect(result).toEqual({ cfg: undefined, code: 1, stderr: `error: ${message}\n` });
    },
  );

  test("a snapshot destination flag is unknown to init: the settings file is the destination", async () => {
    const result = await parsed(["--repository", "o/r", "--snapshot-file", "x.yml"], {
      GITHUB_TOKEN: TOKEN,
    });
    expect(result.cfg).toBeUndefined();
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith("error: unknown option '--snapshot-file'");
  });
});

describe("init: the written file and the printed grant", () => {
  test("writes the snapshot under the schema hint, prints the grant for its sections, exits 0", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, ".github", "settings.yml");
      const api = new MockApi(LABELS_ROUTE);
      const result = await cli(
        [
          "init",
          "--token",
          TOKEN,
          "--repository",
          "o/r",
          "--settings-file",
          file,
          "--sections",
          "labels",
        ],
        api,
      );
      expect(result).toEqual({
        code: 0,
        stdout: [
          `${file} written from o/r: 1 section declared (labels)`,
          "Token permissions the file needs:",
          `  labels: ${LABELS_GRANT}`,
          "",
        ].join("\n"),
        stderr: "",
      });
      expect(api.mutations()).toEqual([]);
      const written = readFileSync(file, "utf8");
      // The first line is the editor's schema hint, the same URL the README's quick start pins.
      expect(written.split("\n")[0]).toBe(`# yaml-language-server: $schema=${SNAPSHOT_SCHEMA_URL}`);
      // No line dates the file: the document follows the pin, so a re-run over the same repository rewrites the same bytes.
      expect(written.split("\n")[1]).toBe("labels:");
      const doc = parseYaml(written);
      expect(doc).toEqual(LABELS_DOC);
      expect(validateSettings(doc).isOk()).toBe(true);
    }));

  test("the grant is the section declarations' for exactly the sections the file declares", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      const api = new MockApi({
        ...LABELS_ROUTE,
        "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: [] },
      });
      const result = await cli(
        [
          "init",
          "--token",
          TOKEN,
          "--repository",
          "o/r",
          "--settings-file",
          file,
          "--sections",
          "labels,milestones",
          "--json",
        ],
        api,
      );
      expect(result.code).toBe(0);
      // Milestones: nothing live, so the section is omitted and earns no grant line.
      const declared = Object.keys(parseYaml(readFileSync(file, "utf8")));
      expect(declared).toEqual(["labels"]);
      expect(JSON.parse(result.stdout)).toEqual({
        result: "snapshot",
        file,
        repository: "o/r",
        "skipped-sections": [],
        grant: Object.fromEntries(
          declared.map((key) => [key, sectionGrant(sectionModule(key as "labels"))]),
        ),
      });
    }));

  test("a denied section under warn is skipped: partial, the file omits it, the line says so, exit 0", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      // No variables route: the read answers 404, the fine-grained denial.
      const result = await cli(
        [
          "init",
          "--token",
          TOKEN,
          "--repository",
          "o/r",
          "--settings-file",
          file,
          "--sections",
          "labels,actions_variables,check_suite_preferences",
          "--on-missing-permission",
          "warn",
        ],
        new MockApi(LABELS_ROUTE),
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(
        /^warning: actions_variables: skipped - the token was denied GET/,
      );
      expect(result.stdout).toBe(
        [
          `${file} written from o/r: 1 section declared (labels)`,
          "not read back: check_suite_preferences (the file's header says why; declare them by hand to manage them)",
          "skipped: actions_variables (the file omits them; the warnings above say why)",
          "Token permissions the file needs:",
          `  labels: ${LABELS_GRANT}`,
          "",
        ].join("\n"),
      );
      expect(parseYaml(readFileSync(file, "utf8"))).toEqual(LABELS_DOC);
      // The same run under --json: the envelope carries the partial result and the skipped section by name.
      const json = await cli(
        [
          "init",
          "--token",
          TOKEN,
          "--repository",
          "o/r",
          "--settings-file",
          join(dir, "again.yml"),
          "--sections",
          "labels,actions_variables",
          "--on-missing-permission",
          "warn",
          "--json",
        ],
        new MockApi(LABELS_ROUTE),
      );
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        result: "partial",
        file: join(dir, "again.yml"),
        repository: "o/r",
        "skipped-sections": ["actions_variables"],
        grant: { labels: LABELS_GRANT },
      });
    }));
});

describe("init: an existing settings file", () => {
  const target = (file: string) => [
    "init",
    "--token",
    TOKEN,
    "--repository",
    "o/r",
    "--settings-file",
    file,
    "--sections",
    "labels",
  ];

  test("is refused naming --force, before any API call, and left as it was", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      writeFileSync(file, "repository:\n  has_wiki: false\n");
      const api = new MockApi(LABELS_ROUTE);
      const result = await cli(target(file), api);
      expect(api.calls).toHaveLength(0);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `error: ${file} already exists: init writes the starting settings file and does not replace the one you author. Pass --force to replace it, or --settings-file <path> to write elsewhere\n`,
      });
      expect(readFileSync(file, "utf8")).toBe("repository:\n  has_wiki: false\n");
      const json = await cli([...target(file), "--json"], api);
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({
        result: "failed",
        file,
        problem: result.stderr.slice("error: ".length, -1),
      });
    }));

  test("is left byte for byte as it was when --force gets past the check and a denied section fails the snapshot under the default policy", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      const original = "repository:\n  has_wiki: false\n";
      writeFileSync(file, original);
      // No variables route: the read answers 404, the fine-grained denial, which fails the snapshot unless warn was asked for.
      const api = new MockApi(LABELS_ROUTE);
      const args = [...target(file).slice(0, -1), "labels,actions_variables", "--force"];
      const result = await cli(args, api);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /^error: actions_variables: not snapshotted - the token was denied GET/,
      );
      const problem = `the snapshot of o/r failed, so ${file} was not written; the errors above name the section and the fix`;
      expect(result.stderr).toEndWith(`error: ${problem}\n`);
      expect(readFileSync(file, "utf8")).toBe(original);
      const json = await cli([...args, "--json"], api);
      expect(json.code).toBe(1);
      expect(json.stderr).toBe(result.stderr);
      expect(JSON.parse(json.stdout)).toEqual({ result: "failed", file, problem });
      expect(readFileSync(file, "utf8")).toBe(original);
    }));

  test("a problem in the flags names the settings file in the envelope when the command was told one", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      const result = await cli(
        ["init", "--repository", "o/r", "--settings-file", file, "--json"],
        new MockApi({}),
      );
      const problem =
        'cannot call the GitHub API: no token was provided. Set the "token" input (--token on the command line), or export GITHUB_TOKEN';
      expect(result).toEqual({
        code: 1,
        stdout: `${JSON.stringify({ result: "failed", file, problem })}\n`,
        stderr: `error: ${problem}\n`,
      });
    }));

  const NO_MILESTONES = { "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: [] } };
  test.each<[string, string[], Record<string, unknown>, string, number | undefined]>([
    [
      "no selected section can be read back",
      ["--sections", "check_suite_preferences"],
      {},
      "cannot be read back: check_suite_preferences",
      0,
    ],
    // No variables route: the read answers 404, the fine-grained denial, and warn skips the section.
    [
      "the only selected section is skipped under warn",
      ["--sections", "actions_variables", "--on-missing-permission", "warn"],
      {},
      "skipped: actions_variables",
      undefined,
    ],
    [
      "nothing exists for the selected sections",
      ["--sections", "milestones"],
      NO_MILESTONES,
      "nothing exists on the repository: milestones",
      undefined,
    ],
  ])(
    "never writes an empty document, --force or not: %s, exit 1",
    (_case, flags, routes, why, apiCalls) =>
      withTempDir("gsac-init-", async (dir) => {
        const file = join(dir, "settings.yml");
        writeFileSync(file, "repository:\n  has_wiki: false\n");
        const api = new MockApi(routes as ConstructorParameters<typeof MockApi>[0]);
        const result = await cli([...target(file).slice(0, -2), ...flags, "--force"], api);
        if (apiCalls !== undefined) {
          expect(api.calls).toHaveLength(apiCalls);
        }
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toEndWith(
          `error: the snapshot of o/r declares no section (${why}), so ${file} was not written. Choose sections init can read back, or drop --sections to read every section\n`,
        );
        expect(readFileSync(file, "utf8")).toBe("repository:\n  has_wiki: false\n");
        // Without --force, into a path that does not exist yet: still refused, and nothing is created.
        const fresh = join(dir, "fresh.yml");
        const plain = await cli(
          [...target(fresh).slice(0, -2), ...flags],
          new MockApi(routes as ConstructorParameters<typeof MockApi>[0]),
        );
        expect(plain.code).toBe(1);
        expect(plain.stderr).toEndWith(
          `so ${fresh} was not written. Choose sections init can read back, or drop --sections to read every section\n`,
        );
        expect(existsSync(fresh)).toBe(false);
      }),
  );

  test("is replaced under --force", () =>
    withTempDir("gsac-init-", async (dir) => {
      const file = join(dir, "settings.yml");
      writeFileSync(file, "repository:\n  has_wiki: false\n");
      const result = await cli([...target(file), "--force"], new MockApi(LABELS_ROUTE));
      expect(result.code).toBe(0);
      expect(parseYaml(readFileSync(file, "utf8"))).toEqual(LABELS_DOC);
    }));

  test("an unwritable destination fails naming --settings-file", () =>
    withTempDir("gsac-init-", async (dir) => {
      // A directory at the path: --force gets past the existence check, the write itself fails.
      const file = join(dir, "settings.yml");
      mkdirSync(file);
      const result = await cli([...target(file), "--force"], new MockApi(LABELS_ROUTE));
      expect(result.code).toBe(1);
      expect(result.stderr).toStartWith(`error: cannot write the settings file ${file}: `);
      expect(result.stderr).toEndWith(". Check that --settings-file names a writable path\n");
    }));
});

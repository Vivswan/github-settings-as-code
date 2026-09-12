/**
 * The argv port is the action's env port under another spelling: for a table
 * of input sets covering every RunConfig arm, parseConfig over the CLI's
 * parsed flags equals parseConfig over a record shaped like the runner's
 * inputs, on the ok and the error path alike. The per-mode flag split is
 * proven against parseConfig's own acceptance, and the help text is pinned
 * to INPUT_DECLS so every input is reachable from exactly the commands whose
 * mode reads it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { exposedInputs, inputsForMode, LIST_INPUTS } from "../../src/cli/inputs.js";
import { maskedStreams } from "../../src/cli/io.js";
import { buildProgram, CLI_COMMANDS, main } from "../../src/cli/program.js";
import {
  type ConfigEnv,
  describeProblem,
  INPUT_DECLS,
  type InputName,
  MODES,
  type Mode,
  parseConfig,
  parseReposInput,
  type RunConfig,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { memoryStream } from "./streams.js";

type Inputs = Partial<Record<InputName, string>>;

/** The action's port: the runner hands back the set input or an empty string. */
const recordReader = (inputs: Inputs) => (name: InputName) => inputs[name] ?? "";

let recipient = "";
beforeAll(async () => {
  recipient = await identityToRecipient(await generateX25519Identity());
});

interface Case {
  readonly name: string;
  /** The argv after the program name: the subcommand and its flags. */
  readonly argv: readonly string[];
  /** The same inputs as the runner would present them. */
  readonly inputs: Inputs;
  readonly env?: ConfigEnv;
  /**
   * A flag the subcommand does not expose: commander refuses it before
   * parseConfig runs, where the action's path refuses the same input by name.
   */
  readonly unknownFlag?: InputName;
}

/** One case per RunConfig arm and per path a flag can take, plus the rejections. */
function cases(): Case[] {
  return [
    {
      name: "check, one repository, token from the environment",
      argv: ["check", "--repository", "o/r", "--settings-file", "s.yml"],
      inputs: { mode: "check", repository: "o/r", "settings-file": "s.yml" },
      env: { GITHUB_TOKEN: "ghp_env" },
    },
    {
      name: "check, the workflow's own repository from GITHUB_REPOSITORY",
      argv: ["check", "--token", "ghp_flag"],
      inputs: { mode: "check", token: "ghp_flag" },
      env: {
        GITHUB_REPOSITORY: "o/self",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "7",
      },
    },
    {
      name: "apply, discovery with every filter and a repeated flag",
      argv: [
        "apply",
        "--token",
        "ghp_flag",
        "--repos",
        "*",
        "--visibility",
        "public",
        "--archived",
        "include",
        "--forks",
        "exclude",
        "--exclude",
        "x/*",
        "--exclude",
        "tmp-*",
        "--topics",
        "a,b",
        "--affiliation",
        "owner,collaborator",
        "--on-missing-permission",
        "warn",
        "--required-sections",
        "labels",
        "--sections",
        "labels,milestones",
        "--api-version",
        "2030-01-01",
        "--private-repos",
        "redact",
        "--private-report",
        "issue-on-failure",
        "--defaults-file",
        "d.yml",
      ],
      inputs: {
        mode: "apply",
        token: "ghp_flag",
        repos: "*",
        visibility: "public",
        archived: "include",
        forks: "exclude",
        exclude: "x/*\ntmp-*",
        topics: "a,b",
        affiliation: "owner,collaborator",
        "on-missing-permission": "warn",
        "required-sections": "labels",
        sections: "labels,milestones",
        "api-version": "2030-01-01",
        "private-repos": "redact",
        "private-report": "issue-on-failure",
        "defaults-file": "d.yml",
      },
      env: { GITHUB_REPOSITORY: "o/admin" },
    },
    {
      name: "check, central repos-dir with the artifact channel and its key",
      argv: [
        "check",
        "--token",
        "ghp_flag",
        "--repos-dir",
        "repos",
        "--private-report",
        "artifact",
        "--report-public-key",
        recipient,
      ],
      inputs: {
        mode: "check",
        token: "ghp_flag",
        "repos-dir": "repos",
        "private-report": "artifact",
        "report-public-key": recipient,
      },
      env: { GITHUB_REPOSITORY: "o/admin" },
    },
    {
      name: "merge, layers as repeated flags",
      argv: [
        "merge",
        "--settings-file",
        "a.yml",
        "--settings-file",
        "b.yml",
        "--merged-file",
        "out.yml",
        "--layering",
        "replace",
      ],
      inputs: {
        mode: "merge",
        "settings-file": "a.yml\nb.yml",
        "merged-file": "out.yml",
        layering: "replace",
      },
    },
    {
      name: "merge, layers as one comma list, a token tolerated",
      argv: [
        "merge",
        "--token",
        "ghp_flag",
        "--settings-file",
        "a.yml,b.yml",
        "--merged-file",
        "o.yml",
      ],
      inputs: {
        mode: "merge",
        token: "ghp_flag",
        "settings-file": "a.yml,b.yml",
        "merged-file": "o.yml",
      },
    },
    {
      name: "rejected: a merge-only flag on check",
      argv: ["check", "--token", "ghp_flag", "--merged-file", "out.yml"],
      inputs: { mode: "check", token: "ghp_flag", "merged-file": "out.yml" },
      unknownFlag: "merged-file",
    },
    {
      name: "rejected: an engine flag on merge",
      argv: ["merge", "--repository", "o/r", "--merged-file", "out.yml"],
      inputs: { mode: "merge", repository: "o/r", "merged-file": "out.yml" },
      unknownFlag: "repository",
    },
    {
      name: "rejected: no token anywhere",
      argv: ["check", "--repository", "o/r"],
      inputs: { mode: "check", repository: "o/r" },
    },
    {
      name: "rejected: a filter without discovery",
      argv: ["apply", "--token", "ghp_flag", "--repository", "o/r", "--visibility", "public"],
      inputs: { mode: "apply", token: "ghp_flag", repository: "o/r", visibility: "public" },
    },
    {
      name: "rejected: an unsupported enum value",
      argv: ["check", "--token", "ghp_flag", "--on-missing-permission", "ignore"],
      inputs: { mode: "check", token: "ghp_flag", "on-missing-permission": "ignore" },
      env: { GITHUB_REPOSITORY: "o/self" },
    },
  ];
}

/** Drive the CLI on `argv` and capture what its argv port parsed, or what it printed. */
async function throughArgv(argv: readonly string[], env: ConfigEnv) {
  let parsed: RunConfig | undefined;
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await main(["node", "gsac", ...argv], {
    host: { env, createClient: () => new MockApi({}) },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: false,
    execute: async (cfg) => {
      parsed = cfg;
      return 0;
    },
  });
  return { parsed, code, stderr: stderr.text() };
}

describe("argv -> config equals env -> config", () => {
  test("for every RunConfig arm and every rejection", async () => {
    for (const { name, argv, inputs, env = {}, unknownFlag } of cases()) {
      const expected = parseConfig(recordReader(inputs), env);
      const actual = await throughArgv(argv, env);
      if (expected.isOk()) {
        expect(actual.parsed, name).toEqual(expected.value);
        expect(actual.code, name).toBe(0);
        continue;
      }
      expect(actual.parsed, name).toBeUndefined();
      expect(actual.code, name).toBe(1);
      if (unknownFlag === undefined) {
        expect(actual.stderr, name).toBe(`error: ${describeProblem(expected.error)}\n`);
      } else {
        expect(actual.stderr, name).toStartWith(`error: unknown option '--${unknownFlag}'`);
      }
    }
  });

  test("the table reaches every arm, both paths of the token, and the rejections", () => {
    // The pin above is only as wide as its table; hold the table to the arms.
    const kinds = new Set<string>();
    let envToken = 0;
    let rejected = 0;
    for (const { argv, inputs, env = {} } of cases()) {
      const result = parseConfig(recordReader(inputs), env);
      if (result.isErr()) {
        rejected++;
        continue;
      }
      kinds.add(result.value.kind);
      if (result.value.kind !== "merge" && !argv.includes("--token")) {
        envToken++;
      }
    }
    expect([...kinds].sort()).toEqual(["merge", "multi", "single"]);
    expect(envToken).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThanOrEqual(5);
  });
});

/** A value each input accepts, so a flag can be exercised alone. */
const VALID: Record<Exclude<InputName, "mode" | "token">, string> = {
  repository: "o/r",
  "settings-file": "s.yml",
  "merged-file": "out.yml",
  "on-missing-permission": "warn",
  "required-sections": "labels",
  sections: "labels",
  "api-version": "2030-01-01",
  repos: "*",
  "repos-dir": "repos",
  "defaults-file": "d.yml",
  layering: "replace",
  "private-repos": "show",
  "private-report": "issue",
  "report-public-key": "",
  visibility: "public",
  archived: "only",
  forks: "only",
  exclude: "x/*",
  topics: "a",
  affiliation: "collaborator",
};

/** The inputs one flag needs beside it to be accepted at all. */
const COMPANIONS: Partial<Record<InputName, Inputs>> = {
  "defaults-file": { repos: "*" },
  visibility: { repos: "*" },
  archived: { repos: "*" },
  forks: { repos: "*" },
  exclude: { repos: "*" },
  topics: { repos: "*" },
  affiliation: { repos: "*" },
  "report-public-key": { "private-report": "artifact" },
};

/** The smallest input set each mode accepts. */
function base(mode: Mode): Inputs {
  return mode === "merge" ? { mode, "merged-file": "out.yml" } : { mode, token: "ghp" };
}

describe("the per-mode flag split", () => {
  test("every flag a subcommand exposes is one its mode accepts, and every hidden one is rejected", () => {
    const env: ConfigEnv = { GITHUB_REPOSITORY: "o/self" };
    for (const mode of MODES) {
      const exposed = new Set(inputsForMode(mode));
      for (const name of Object.keys(VALID) as (keyof typeof VALID)[]) {
        const value = name === "report-public-key" ? recipient : VALID[name];
        if (exposed.has(name)) {
          const result = parseConfig(
            recordReader({ ...base(mode), ...COMPANIONS[name], [name]: value }),
            env,
          );
          expect(
            result.isOk(),
            `${mode} --${name}: ${result.match(() => "", describeProblem)}`,
          ).toBe(true);
        } else {
          const result = parseConfig(recordReader({ ...base(mode), [name]: value }), env);
          expect(result.isErr(), `${mode} --${name} should be rejected by parseConfig`).toBe(true);
          expect(
            result.match(
              () => "",
              (problem) => problem.code,
            ),
            `${mode} --${name}`,
          ).toMatch(/^input-(merge-only|rejected-in-merge)$/);
        }
      }
    }
  });

  test("every LIST_INPUTS entry is one parseConfig splits: a newline-joined pair is accepted whole", () => {
    // Two entries per list input, each valid alone; the pair must come out of the
    // parse as those two values, which only the library's own splitting can prove
    // (repos is split downstream by parseReposInput, so that is what reads it).
    const engine: Inputs = { mode: "check", token: "ghp" };
    const discovery: Inputs = { ...engine, repos: "*" };
    const cases: Record<
      (typeof LIST_INPUTS)[number],
      [Inputs, [string, string], (cfg: RunConfig) => readonly string[]]
    > = {
      "settings-file": [
        { mode: "merge", "merged-file": "out.yml" },
        ["a.yml", "b.yml"],
        (cfg) => (cfg.kind === "merge" ? cfg.settingsFiles : []),
      ],
      "required-sections": [
        engine,
        ["labels", "milestones"],
        (cfg) => (cfg.kind === "merge" ? [] : [...cfg.sections.required]),
      ],
      sections: [
        engine,
        ["labels", "milestones"],
        (cfg) => (cfg.kind === "merge" ? [] : [...cfg.sections.only]),
      ],
      repos: [
        engine,
        ["o/a", "o/b"],
        (cfg) =>
          cfg.kind === "multi"
            ? parseReposInput(cfg.reposInput)
                .map((r) => r.slugs)
                .unwrapOr([])
            : [],
      ],
      exclude: [
        discovery,
        ["x/*", "tmp-*"],
        (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.exclude : []),
      ],
      topics: [
        discovery,
        ["a", "b"],
        (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.topics : []),
      ],
      affiliation: [
        discovery,
        ["owner", "collaborator"],
        (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.affiliation : []),
      ],
    };
    const env: ConfigEnv = { GITHUB_REPOSITORY: "o/self" };
    for (const name of LIST_INPUTS) {
      const [companions, pair, kept] = cases[name];
      const result = parseConfig(recordReader({ ...companions, [name]: pair.join("\n") }), env);
      expect(result.isOk(), `${name}: ${result.match(() => "", describeProblem)}`).toBe(true);
      expect(result.map(kept).unwrapOr([]), name).toEqual(pair);
    }
  });

  test("every declared input is the mode, the global token, or a flag of some subcommand", () => {
    expect(new Set([...exposedInputs(), "mode"])).toEqual(new Set(Object.keys(INPUT_DECLS)));
  });
});

describe("the help text", () => {
  const { program } = buildProgram({
    host: { env: {}, createClient: () => new MockApi({}) },
    streams: maskedStreams({ stdout: memoryStream().stream, stderr: memoryStream().stream }),
    colors: false,
  });

  test("lists every subcommand and the global token flag", () => {
    const help = program.helpInformation();
    for (const command of CLI_COMMANDS) {
      expect(help, command).toMatch(new RegExp(`^  ${command}\\b`, "m"));
    }
    expect(help).toContain("--token <value>");
    expect(help).toContain("--json");
    expect(help).toContain("--summary <file>");
  });

  test("each mode's subcommand lists exactly its INPUT_DECLS flags, described by the declaration", () => {
    for (const mode of MODES) {
      const command = program.commands.find((candidate) => candidate.name() === mode);
      if (command === undefined) {
        throw new Error(`no ${mode} subcommand`);
      }
      const help = command.helpInformation();
      for (const name of Object.keys(INPUT_DECLS) as InputName[]) {
        const listed = help.includes(`--${name} <value>`);
        expect(listed, `${mode} --${name}`).toBe(inputsForMode(mode).includes(name));
        if (listed) {
          // The description wraps to the help width; its first words are the declaration's.
          const opening = INPUT_DECLS[name].description.split(" ").slice(0, 3).join(" ");
          expect(help, `${mode} --${name} description`).toContain(opening);
        }
      }
    }
  });
});

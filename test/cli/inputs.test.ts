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
import { ARTIFACT_REFUSED, describeCliProblem } from "../../src/cli/commands.js";
import {
  CLI_UNSUPPORTED_INPUTS,
  exposedInputs,
  inputDescription,
  inputsForMode,
  isList,
} from "../../src/cli/inputs.js";
import { maskedStreams } from "../../src/cli/io.js";
import { buildProgram, CLI_COMMANDS, main } from "../../src/cli/program.js";
import {
  type ConfigEnv,
  describeProblem,
  INPUT_DECLS,
  type InputDecl,
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
  /** A value the action accepts and only the CLI refuses, with the line it prints. */
  readonly cliRefuses?: string;
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
      name: "check, central repos-dir with the issue channel",
      argv: ["check", "--token", "ghp_flag", "--repos-dir", "repos", "--private-report", "issue"],
      inputs: { mode: "check", token: "ghp_flag", "repos-dir": "repos", "private-report": "issue" },
      env: { GITHUB_REPOSITORY: "o/admin" },
    },
    {
      name: "refused by the CLI alone: the artifact channel",
      argv: [
        "check",
        "--token",
        "ghp_flag",
        "--repos-dir",
        "repos",
        "--private-report",
        "artifact",
      ],
      inputs: {
        mode: "check",
        token: "ghp_flag",
        "repos-dir": "repos",
        "private-report": "artifact",
      },
      env: { GITHUB_REPOSITORY: "o/admin" },
      cliRefuses: describeCliProblem(ARTIFACT_REFUSED),
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
    for (const { name, argv, inputs, env = {}, unknownFlag, cliRefuses } of cases()) {
      const expected = parseConfig(recordReader(inputs), env);
      const actual = await throughArgv(argv, env);
      if (cliRefuses !== undefined) {
        // The action would ask for the channel's key next; the CLI refuses the channel itself.
        expect(actual, name).toEqual({
          parsed: undefined,
          code: 1,
          stderr: `error: ${cliRefuses}\n`,
        });
        continue;
      }
      if (expected.isOk()) {
        expect(actual.parsed, name).toEqual(expected.value);
        expect(actual.code, name).toBe(0);
        continue;
      }
      expect(actual.parsed, name).toBeUndefined();
      expect(actual.code, name).toBe(1);
      if (unknownFlag === undefined) {
        expect(actual.stderr, name).toBe(`error: ${describeCliProblem(expected.error)}\n`);
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
    for (const { argv, inputs, env = {}, cliRefuses } of cases()) {
      const result = parseConfig(recordReader(inputs), env);
      if (result.isErr() || cliRefuses !== undefined) {
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
          ).toMatch(/^input-(merge-only|rejected-in-merge|report-key-unused)$/);
        }
      }
    }
  });

  /**
   * One repeated-argv case per input, keyed over every InputName so a new
   * input must say whether it repeats: a list input names the subcommand and
   * companions, the pair a repeated flag carries, and the library's own
   * reading of the parsed config (repos is split by parseReposInput); a
   * single-value input is "single" and its repeat must be refused.
   */
  interface Repeated {
    readonly argv: readonly string[];
    readonly pair: readonly [string, string];
    readonly kept: (cfg: RunConfig) => readonly string[];
    readonly env?: ConfigEnv;
  }
  const check = ["check", "--token", "ghp", "--repository", "o/r"];
  const discovery = ["check", "--token", "ghp", "--repos", "*"];
  const REPEATED: Record<InputName, Repeated | "single"> = {
    token: "single",
    repository: "single",
    "settings-file": {
      argv: ["merge", "--merged-file", "out.yml"],
      pair: ["a.yml", "b.yml"],
      kept: (cfg) => (cfg.kind === "merge" ? cfg.settingsFiles : []),
    },
    mode: "single",
    "merged-file": "single",
    "on-missing-permission": "single",
    "required-sections": {
      argv: check,
      pair: ["labels", "milestones"],
      kept: (cfg) => (cfg.kind === "merge" ? [] : [...cfg.sections.required]),
    },
    sections: {
      argv: check,
      pair: ["labels", "milestones"],
      kept: (cfg) => (cfg.kind === "merge" ? [] : [...cfg.sections.only]),
    },
    "api-version": "single",
    repos: {
      argv: ["check", "--token", "ghp"],
      pair: ["o/a", "o/b"],
      kept: (cfg) =>
        cfg.kind === "multi"
          ? parseReposInput(cfg.reposInput)
              .map((r) => r.slugs)
              .unwrapOr([])
          : [],
      env: { GITHUB_REPOSITORY: "o/admin" },
    },
    "repos-dir": "single",
    "defaults-file": "single",
    layering: "single",
    "private-repos": "single",
    "private-report": "single",
    "report-public-key": "single",
    visibility: "single",
    archived: "single",
    forks: "single",
    exclude: {
      argv: discovery,
      pair: ["x/*", "tmp-*"],
      kept: (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.exclude : []),
    },
    topics: {
      argv: discovery,
      pair: ["a", "b"],
      kept: (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.topics : []),
    },
    affiliation: {
      argv: discovery,
      pair: ["owner", "collaborator"],
      kept: (cfg) => (cfg.kind === "multi" ? cfg.discoveryFilters.affiliation : []),
    },
  };

  test("a repeated flag accumulates exactly for the inputs declared list, and is refused for the rest", async () => {
    const exposed = new Set(exposedInputs());
    for (const name of Object.keys(REPEATED) as InputName[]) {
      const repeated = REPEATED[name];
      const decl: InputDecl = INPUT_DECLS[name];
      // The record and the declaration agree on which inputs are lists.
      expect(repeated !== "single", `${name} declares list: ${decl.list}`).toBe(decl.list === true);
      expect(isList(name), name).toBe(decl.list === true);
      if (repeated === "single") {
        if (!exposed.has(name)) {
          continue; // the mode is the subcommand; an unsupported input has no flag
        }
        // The base argv minus this flag, so the two repeats below are its only occurrences.
        const base = inputsForMode("check").includes(name) || name === "token" ? check : ["merge"];
        const flag = base.filter((argument, index) => {
          const value = index > 0 && base[index - 1] === `--${name}`;
          return argument !== `--${name}` && !value;
        });
        // Long values: a token value is masked, and a one-letter mask would eat the message.
        const actual = await throughArgv(
          [...flag, `--${name}`, "first-value", `--${name}`, "second-value"],
          {},
        );
        // The token's echoed value is masked (registered before the parse); the rest print as given.
        const echoed = name === "token" ? "***" : "second-value";
        expect(actual.code, name).toBe(1);
        expect(actual.stderr, name).toBe(
          `error: option '--${name} <value>' argument '${echoed}' is invalid. --${name} takes one value and was given more than once\n`,
        );
        continue;
      }
      const [first, second] = repeated.pair;
      const actual = await throughArgv(
        [...repeated.argv, `--${name}`, first, `--${name}`, second],
        repeated.env ?? {},
      );
      expect(actual.stderr, name).toBe("");
      expect(actual.parsed, name).toBeDefined();
      expect(actual.parsed === undefined ? [] : repeated.kept(actual.parsed), name).toEqual([
        first,
        second,
      ]);
    }
  });

  test("every declared input is the mode, the global token, a flag of some subcommand, or named unsupported", () => {
    expect(new Set([...exposedInputs(), "mode", ...CLI_UNSUPPORTED_INPUTS])).toEqual(
      new Set(Object.keys(INPUT_DECLS)),
    );
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

  test("each mode's subcommand carries exactly its INPUT_DECLS flags, each with its full description", () => {
    for (const mode of MODES) {
      const command = program.commands.find((candidate) => candidate.name() === mode);
      if (command === undefined) {
        throw new Error(`no ${mode} subcommand`);
      }
      const options = command.options.filter((option) => option.long !== "--help");
      expect(options.map((option) => option.long).sort(), mode).toEqual(
        inputsForMode(mode)
          .map((name) => `--${name}`)
          .sort(),
      );
      for (const option of options) {
        const name = option.long?.slice(2) as InputName;
        expect(option.flags, `${mode} ${name}`).toBe(`--${name} <value>`);
        expect(option.description, `${mode} ${name}`).toBe(inputDescription(name));
      }
    }
  });

  test("the repository flag's help names the terminal's requirement, not the runner's default", () => {
    const description = inputDescription("repository");
    expect(description).toContain("Required unless repos or repos-dir is set");
    expect(description).not.toContain("Defaults to the current repository");
    expect(description).toStartWith(INPUT_DECLS.repository.description.split(".")[0] ?? "");
  });
});

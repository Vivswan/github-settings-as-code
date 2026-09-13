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
import {
  CLI_UNSUPPORTED_INPUTS,
  declared,
  exposedInputs,
  INIT_SUBCOMMAND,
  inputDescription,
  inputsForMode,
  isList,
  modeSubcommand,
} from "../../src/cli/inputs.js";
import { maskedStreams } from "../../src/cli/io.js";
import { buildProgram, CLI_COMMANDS, main } from "../../src/cli/program.js";
import {
  type ConfigEnv,
  describeProblem,
  parseConfig,
  parseReposInput,
  type RunConfig,
} from "../../src/index.js";
import {
  FILTER_INPUTS,
  INPUT_DECLS,
  type InputDecl,
  type InputName,
  MODES,
  type Mode,
  PRIVATE_REPORT_CHANNELS,
} from "../../src/internal.js";
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
      name: "snapshot, one repository to a file with an allowlist",
      argv: [
        "snapshot",
        "--token",
        "ghp_flag",
        "--repository",
        "o/r",
        "--snapshot-file",
        "snap.yml",
        "--sections",
        "labels",
        "--on-missing-permission",
        "warn",
      ],
      inputs: {
        mode: "snapshot",
        token: "ghp_flag",
        repository: "o/r",
        "snapshot-file": "snap.yml",
        sections: "labels",
        "on-missing-permission": "warn",
      },
    },
    {
      name: "snapshot, the fleet to a directory with a discovery filter",
      argv: [
        "snapshot",
        "--token",
        "ghp_flag",
        "--repos",
        "*",
        "--snapshot-dir",
        "snaps",
        "--forks",
        "exclude",
      ],
      inputs: {
        mode: "snapshot",
        token: "ghp_flag",
        repos: "*",
        "snapshot-dir": "snaps",
        forks: "exclude",
      },
      env: { GITHUB_REPOSITORY: "o/admin" },
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
      cliRefuses: describeProblem({ code: "input-artifact-unsupported" }),
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
      return { exitCode: 0 };
    },
  });
  return { parsed, code, stderr: stderr.text() };
}

/** The action's face: it hands the run an artifact uploader, so parseConfig admits the artifact channel. */
const ACTION = { artifactUpload: true } as const;

describe("argv -> config equals env -> config", () => {
  test("for every RunConfig arm and every rejection", async () => {
    for (const { name, argv, inputs, env = {}, unknownFlag, cliRefuses } of cases()) {
      const expected = parseConfig(recordReader(inputs), env, ACTION);
      const actual = await throughArgv(argv, env);
      if (cliRefuses !== undefined) {
        // The action would ask for the channel's key next; the CLI's face has no artifact upload, so parseConfig refuses the channel for it.
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
        expect(actual.stderr, name).toBe(`error: ${describeProblem(expected.error)}\n`);
      } else {
        expect(actual.stderr, name).toStartWith(`error: unknown option '--${unknownFlag}'`);
      }
    }
  });

  test("the table reaches every arm, both paths of the token, and every kind of rejection", () => {
    // The pin above is only as wide as its table; hold the table to the arms.
    const kinds = new Set<string>();
    const rejections = new Set<string>();
    let envToken = 0;
    for (const { argv, inputs, env = {}, cliRefuses, unknownFlag } of cases()) {
      const result = parseConfig(recordReader(inputs), env, ACTION);
      if (cliRefuses !== undefined) {
        rejections.add("refused by the CLI alone");
        continue;
      }
      if (unknownFlag !== undefined) {
        rejections.add("a flag the subcommand lacks");
        continue;
      }
      if (result.isErr()) {
        rejections.add("rejected by parseConfig");
        continue;
      }
      kinds.add(result.value.kind);
      if (result.value.kind !== "merge" && !argv.includes("--token")) {
        envToken++;
      }
    }
    expect([...kinds].sort()).toEqual(["merge", "multi", "single", "snapshot"]);
    expect(envToken).toBeGreaterThan(0);
    expect([...rejections].sort()).toEqual([
      "a flag the subcommand lacks",
      "refused by the CLI alone",
      "rejected by parseConfig",
    ]);
  });
});

/** A value each input accepts, so a flag can be exercised alone. */
const VALID: Record<Exclude<InputName, "mode" | "token">, string> = {
  repository: "o/r",
  "settings-file": "s.yml",
  "merged-file": "out.yml",
  "snapshot-file": "snap.yml",
  "snapshot-dir": "snaps",
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
  switch (mode) {
    case "merge":
      return { mode, "merged-file": "out.yml" };
    case "snapshot":
      return { mode, token: "ghp", "snapshot-file": "snap.yml" };
    default:
      return { mode, token: "ghp" };
  }
}

/**
 * The snapshot's fleet inputs need the directory form: they unset the base's
 * snapshot-file (an empty value reads as unset) and name a snapshot-dir.
 */
const SNAPSHOT_FLEET: Inputs = { "snapshot-file": "", "snapshot-dir": "snaps", repos: "*" };
const SNAPSHOT_FLEET_INPUTS = new Set<InputName>([
  "snapshot-dir",
  "repos",
  "repos-dir",
  ...FILTER_INPUTS,
]);

/** The inputs a flag needs beside it under `mode`, on top of that mode's base. */
function companions(mode: Mode, name: InputName): Inputs {
  if (mode === "snapshot" && SNAPSHOT_FLEET_INPUTS.has(name)) {
    return name === "repos-dir" ? { ...SNAPSHOT_FLEET, repos: "" } : SNAPSHOT_FLEET;
  }
  return COMPANIONS[name] ?? {};
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
            recordReader({ ...base(mode), ...companions(mode, name), [name]: value }),
            env,
            ACTION,
          );
          expect(
            result.isOk(),
            `${mode} --${name}: ${result.match(() => "", describeProblem)}`,
          ).toBe(true);
        } else {
          const result = parseConfig(recordReader({ ...base(mode), [name]: value }), env, ACTION);
          expect(result.isErr(), `${mode} --${name} should be rejected by parseConfig`).toBe(true);
          expect(
            result.match(
              () => "",
              (problem) => problem.code,
            ),
            `${mode} --${name}`,
          ).toMatch(
            /^input-(merge-only|snapshot-only|rejected-in-merge|rejected-in-snapshot|report-key-unused)$/,
          );
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
    "snapshot-file": "single",
    "snapshot-dir": "single",
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
        // The base argv of the first subcommand exposing the flag, minus this flag, so the two
        // repeats below are its only occurrences.
        const base =
          inputsForMode("check").includes(name) || name === "token"
            ? check
            : inputsForMode("merge").includes(name)
              ? ["merge"]
              : ["snapshot", "--token", "ghp"];
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
      expect(help, command).toMatch(new RegExp(`^  ${command} `, "m"));
    }
    expect(help).toContain("--token <value>");
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
        expect(option.description, `${mode} ${name}`).toBe(
          inputDescription(name, modeSubcommand(mode)),
        );
      }
    }
  });

  /**
   * A flag mention in prose: `--name` anywhere, or the bare name where the
   * prose cannot mean the noun: a hyphenated name, or one followed by a colon
   * and its value (`repos: "*"`). The single-word names (sections, repository,
   * topics) double as the prose's own nouns, so bare they do not count.
   */
  function mentions(name: string, text: string): boolean {
    const bare = name.includes("-") ? `${name}(?![\\w-])` : `${name}:`;
    return new RegExp(`(?<![\\w-])(--${name}(?![\\w-])|${bare})`).test(text);
  }

  test("every command's help names only the flags it accepts, and restricts itself to no other subcommand", () => {
    const subcommands = program.commands.map((command) => command.name());
    const restriction = new RegExp(
      `\\b((?:${subcommands.join("|")})(?:, |,? and )?)+ only\\b`,
      "g",
    );
    // The mode is the subcommand, never a flag; every other input is some command's flag.
    const inputs = Object.keys(INPUT_DECLS).filter((name) => name !== "mode");
    const findings: string[] = [];
    for (const command of program.commands) {
      // Commander folds the text to width; the prose is scanned unfolded.
      const help = command.helpInformation().replace(/\s+/g, " ");
      const accepted = new Set(
        [...command.options, ...program.options].map((option) => option.long?.slice(2)),
      );
      for (const name of inputs.filter((name) => !accepted.has(name) && mentions(name, help))) {
        findings.push(`${command.name()} --help names --${name}, which it does not accept`);
      }
      for (const [clause] of help.matchAll(restriction)) {
        if (!new RegExp(`\\b${command.name()}\\b`).test(clause)) {
          findings.push(`${command.name()} --help restricts "${clause}" away from itself`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  test("the repository flag's help names the terminal's requirement, not the runner's default", () => {
    const runnerDefault = "Defaults to the current repository";
    const escapeClause = "unless repos or repos-dir is set";
    for (const subcommand of [modeSubcommand("check"), INIT_SUBCOMMAND]) {
      const description = inputDescription("repository", subcommand);
      expect(description).toStartWith(INPUT_DECLS.repository.description.split(".")[0] ?? "");
      expect(description).not.toContain(runnerDefault);
      expect(description).toContain("Required");
      expect(description).toContain("GITHUB_REPOSITORY supplies it");
      // The escape clause holds only where the multi-repo flags exist: init has none.
      expect(description.includes(escapeClause)).toBe(subcommand.flags.has("repos"));
    }
  });

  test("init's sections flag keeps the declaration's first sentence and drops the mode restriction", () => {
    const declared = INPUT_DECLS.sections.description;
    // The declaration's first sentence is the allowlist itself; the clause after it names the modes init never runs.
    expect(inputDescription("sections", INIT_SUBCOMMAND)).toBe(
      declared.slice(0, declared.indexOf(". ") + 1),
    );
    expect(inputDescription("sections", modeSubcommand("check"))).toBe(declared);
  });

  test("the private-report flag's help offers exactly the channels the CLI accepts", () => {
    // parseConfig refuses the artifact channel for a face without an upload, so its value leaves the list and the other channels stay.
    const accepted = PRIVATE_REPORT_CHANNELS.filter((channel) => channel !== "artifact");
    const check = inputDescription("private-report", modeSubcommand("check"));
    const opening = check.slice(0, check.indexOf(". ") + 1);
    // Every word of the opening sentence besides its connectives is a channel name, so a stray channel cannot hide in it.
    const named = opening
      .replace(/[.,()]/g, " ")
      .split(/\s+/)
      .filter((word) => word !== "" && word !== "or" && word !== "default");
    expect(named).toEqual([...accepted]);
    expect(check).not.toContain("artifact");
    // With the key flag present the declaration stands whole, so the removal is the clause's alone.
    const withKey = { ...modeSubcommand("check"), flags: new Set(exposedInputs()) };
    withKey.flags.add("report-public-key");
    expect(inputDescription("private-report", withKey)).toBe(
      INPUT_DECLS["private-report"].description,
    );
  });

  test("declared() refuses a clause the declaration no longer carries", () => {
    // The negative control for the load-time pin: a stale clause must throw, not pass through.
    expect(() => declared("repository", "a sentence the declaration never had")).toThrow(
      /^BUG: the repository input's description no longer says "a sentence the declaration never had"/,
    );
    expect(declared("repository", "Target repository (owner/name).")).toBe(
      "Target repository (owner/name).",
    );
  });
});

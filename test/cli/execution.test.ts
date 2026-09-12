/**
 * The action's env port and the CLI's argv port run the same RunConfig arms to the same exit code, outputs, log
 * lines, and annotations: one executor behind both faces. The table is the runner's input sets; the argv is the
 * same set spelled as flags, an equality test/cli/inputs.test.ts pins on its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/action/run.js";
import {
  type ConfigEnv,
  collectingIo,
  INPUT_DECLS,
  type InputName,
  type OutputName,
  parseConfig,
} from "../../src/index.js";
import { MockApi, type Route } from "../mock-api.js";
import { runCli } from "./streams.js";

type Inputs = Partial<Record<InputName, string>>;

interface Case {
  readonly name: string;
  /** The runner's inputs; `dir` is the side's own scratch directory for the files the arm writes or misses. */
  readonly inputs: (dir: string) => Inputs;
  readonly routes: Record<string, Route>;
  /** The writes the arm may perform; anything else is an unrouted mutation and throws. */
  readonly mutations?: readonly string[];
  readonly env: ConfigEnv;
  /** Where the arm ends on both faces; without it, two faces failing alike would pass as equal. */
  readonly ends: { readonly code: number; readonly result: string };
}

const ROOT = join(import.meta.dir, "..", "..");
const SINGLE = join(ROOT, "test", "fixtures", "single.yml");
const LAYERS = join(ROOT, "test", "fixtures", "layers");
const TOKEN = "ghp_equivalence_token";
const BUG = { name: "bug", color: "d73a4a", description: "Something is broken" };
const DOCS = { name: "docs", color: "0075ca", description: "Documentation" };
const FLEET_ENV: ConfigEnv = { GITHUB_REPOSITORY: "admin/fleet" };

/** The settings.yml of a remote target, as the contents endpoint hands it back through getRepoFile. */
const remoteSettings = (slug: string, hasWiki: boolean): Record<string, Route> => ({
  [`GET /repos/${slug}`]: { data: { has_wiki: hasWiki, private: false } },
  [`GET /repos/${slug}/contents/.github/settings.yml`]: {
    data: `repository:\n  has_wiki: false\n`,
  },
});

const labels = (slug: string, entries: unknown[]): Record<string, Route> => ({
  [`GET /repos/${slug}`]: { data: { private: false } },
  [`GET /repos/${slug}/labels?per_page=100&page=1`]: { data: entries },
});

const cases: Case[] = [
  {
    name: "check, one repository, clean",
    ends: { code: 0, result: "clean" },
    inputs: () => ({ mode: "check", token: TOKEN, repository: "o/r", "settings-file": SINGLE }),
    routes: { "GET /repos/o/r": { data: { has_wiki: false, private: false } } },
    env: {},
  },
  {
    name: "check, one repository, drift",
    ends: { code: 1, result: "drift" },
    inputs: () => ({ mode: "check", token: TOKEN, repository: "o/r", "settings-file": SINGLE }),
    routes: { "GET /repos/o/r": { data: { has_wiki: true, private: false } } },
    env: {},
  },
  {
    name: "apply, one repository",
    ends: { code: 0, result: "applied" },
    inputs: () => ({ mode: "apply", token: TOKEN, repository: "o/r", "settings-file": SINGLE }),
    routes: { "GET /repos/o/r": { data: { has_wiki: true, private: false } } },
    mutations: ["PATCH /repos/o/r"],
    env: {},
  },
  {
    name: "check, one repository, a settings file that cannot be read",
    ends: { code: 1, result: "failed" },
    inputs: (dir) => ({
      mode: "check",
      token: TOKEN,
      repository: "o/r",
      "settings-file": join(dir, "missing.yml"),
    }),
    routes: {},
    env: {},
  },
  {
    name: "check, two repositories from a list, one drifting",
    ends: { code: 1, result: "drift" },
    inputs: () => ({ mode: "check", token: TOKEN, repos: "o/a,o/b" }),
    routes: { ...remoteSettings("o/a", false), ...remoteSettings("o/b", true) },
    env: FLEET_ENV,
  },
  {
    name: "merge, two layers",
    ends: { code: 0, result: "merged" },
    inputs: (dir) => ({
      mode: "merge",
      "settings-file": `${join(LAYERS, "fleet.yml")},${join(LAYERS, "team.yml")}`,
      "merged-file": join(dir, "merged.yml"),
    }),
    routes: {},
    env: {},
  },
  {
    name: "snapshot, one repository to a file",
    ends: { code: 0, result: "snapshot" },
    inputs: (dir) => ({
      mode: "snapshot",
      token: TOKEN,
      repository: "o/r",
      "snapshot-file": join(dir, "snapshot.yml"),
      sections: "labels",
    }),
    routes: labels("o/r", [BUG]),
    env: {},
  },
  {
    name: "snapshot, two repositories to a directory",
    ends: { code: 0, result: "snapshot" },
    inputs: (dir) => ({
      mode: "snapshot",
      token: TOKEN,
      repos: "o/a,o/b",
      "snapshot-dir": join(dir, "snaps"),
      sections: "labels",
    }),
    routes: { ...labels("o/a", [BUG]), ...labels("o/b", [DOCS]) },
    env: FLEET_ENV,
  },
];

/** What both faces are held to, with each side's scratch directory folded to one spelling. */
interface Observed {
  readonly code: number;
  readonly outputs: Partial<Record<OutputName, string>>;
  readonly logs: readonly string[];
  readonly annotations: readonly string[];
}

const OUTPUT_NAMES: readonly OutputName[] = ["result", "skipped-sections", "repos-result"];
const OUTPUT_LINE = new RegExp(`^(${OUTPUT_NAMES.join("|")})=(.*)$`);

/** The environment keys the action's parse reads beside the inputs, held to the case's env on both faces. */
const CONTEXT_KEYS = ["GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITHUB_RUN_ID", "GITHUB_TOKEN"];
const INPUT_KEYS = Object.keys(INPUT_DECLS).map((name) => `INPUT_${name.toUpperCase()}`);

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsac-equivalence-"));
  scratch.push(dir);
  return dir;
}

function api(c: Case): MockApi {
  return new MockApi({ ...c.routes }).allowMutations(...(c.mutations ?? []));
}

const fold = (dir: string) => (line: string) => line.replaceAll(dir, "<dir>");

/** The action's face: the inputs as the runner's INPUT_* variables, the run over a collecting Io. */
async function throughEnv(c: Case): Promise<Observed> {
  const dir = tempDir();
  const inputs = c.inputs(dir);
  const keys = [...INPUT_KEYS, ...CONTEXT_KEYS];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
  for (const [key, value] of Object.entries(c.env)) {
    process.env[key] = value;
  }
  const collected = collectingIo();
  let code: number;
  try {
    code = await run({ api: api(c), io: collected.io });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  const at = fold(dir);
  return {
    code,
    outputs: Object.fromEntries(
      Object.entries(collected.outputs).map(([name, value]) => [name, at(value)]),
    ),
    logs: collected.lines.filter((l) => l.level === undefined).map((l) => at(l.line)),
    annotations: collected.lines
      .filter((l) => l.level !== undefined)
      .map((l) => at(`${l.level}: ${l.line}`)),
  };
}

/** The CLI's face: the same inputs as the subcommand's flags, the run over the program's streams. */
async function throughArgv(c: Case): Promise<Observed> {
  const dir = tempDir();
  const { mode, ...flags } = c.inputs(dir);
  const argv = [
    mode ?? "",
    ...Object.entries(flags).flatMap(([name, value]) => [`--${name}`, value ?? ""]),
  ];
  const result = await runCli(argv, api(c), c.env);
  const at = fold(dir);
  const outputs: Partial<Record<OutputName, string>> = {};
  const logs: string[] = [];
  for (const line of result.stdout.split("\n").filter((l) => l !== "")) {
    const output = OUTPUT_LINE.exec(line);
    if (output === null) {
      logs.push(at(line));
    } else {
      outputs[output[1] as OutputName] = at(output[2] ?? "");
    }
  }
  return {
    code: result.code,
    outputs,
    logs,
    annotations: result.stderr
      .split("\n")
      .filter((l) => l !== "")
      .map(at),
  };
}

describe("the action and the CLI run one arm to one result", () => {
  test.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const action = await throughEnv(c);
    const cli = await throughArgv(c);
    expect(cli).toEqual(action);
    expect({ code: action.code, result: action.outputs.result }).toEqual(c.ends);
  });

  test("the table reaches every arm, both snapshot forms, and both exit codes", () => {
    const arms = new Set<string>();
    for (const c of cases) {
      const parsed = parseConfig((name) => c.inputs("<dir>")[name] ?? "", c.env)._unsafeUnwrap();
      arms.add(parsed.kind === "snapshot" ? `snapshot:${parsed.form}` : parsed.kind);
    }
    expect([...arms].sort()).toEqual(["merge", "multi", "single", "snapshot:dir", "snapshot:file"]);
    expect([...new Set(cases.map((c) => c.ends.code))].sort()).toEqual([0, 1]);
  });
});

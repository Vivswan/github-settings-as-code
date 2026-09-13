/**
 * The executor's own seams: what a face hands in through RunDeps reaches the flows, and the arms end at the flows'
 * conclusions. The two faces running the same arms to the same result is pinned in test/cli/execution.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import {
  type ArtifactUploader,
  collectingIo,
  describeProblem,
  executeRun,
  parseRepoSlug,
  type RunConfig,
  type RunDeps,
  SectionSelection,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { ROOT } from "../root.js";
import { tempDirTest } from "../temp-dir.js";

const LAYERS = join(ROOT, "test", "fixtures", "layers");

type SingleConfig = Extract<RunConfig, { kind: "single" }>;

const single = (overrides: Partial<SingleConfig> = {}): SingleConfig => ({
  kind: "single",
  token: "ghp_executor_test",
  apiVersion: "2022-11-28",
  mode: "check",
  repo: parseRepoSlug("o/r")._unsafeUnwrap(),
  settingsFile: join(ROOT, "test", "fixtures", "single.yml"),
  onMissingPermission: "fail",
  sections: SectionSelection.ALL,
  privateRepos: "show",
  privateReport: "none",
  reportPublicKey: "",
  selfSlug: "o/r",
  runUrl: "",
  ...overrides,
});

const tempTest = tempDirTest("gsac-execute-");

/** Deps over a collecting Io and one stub client; `createClient` records whether the run asked for it. */
function deps(api: MockApi, overrides: Partial<RunDeps> = {}) {
  const collected = collectingIo();
  let opened = 0;
  const run: RunDeps = {
    io: collected.io,
    createClient: () => {
      opened++;
      return api;
    },
    ...overrides,
  };
  return { run, collected, opened: () => opened };
}

describe("executeRun", () => {
  tempTest("a merge opens no client and ends at the merge conclusion", async (dir) => {
    const mergedFile = join(dir, "merged.yml");
    const api = new MockApi({});
    const d = deps(api);
    const code = await executeRun(
      {
        kind: "merge",
        settingsFiles: [join(LAYERS, "fleet.yml"), join(LAYERS, "team.yml")],
        mergedFile,
        layering: "merge",
      },
      d.run,
    );
    expect(code).toBe(0);
    expect(d.opened()).toBe(0);
    expect(api.calls).toEqual([]);
    expect(d.collected.outputs).toEqual({
      result: "merged",
      "skipped-sections": "",
      "repos-result": "{}",
    });
    expect(d.collected.lines.slice(-2)).toEqual([
      { line: `merged 2 layer(s) into ${mergedFile}` },
      { line: "result: merged" },
    ]);
  });

  tempTest(
    "a fatal problem raised after the parse is worded by the face's describe",
    async (dir) => {
      const settingsFile = join(dir, "missing.yml");
      const api = new MockApi({});
      const d = deps(api, { describe: (problem) => `worded: ${problem.code}` });
      expect(await executeRun(single({ settingsFile }), d.run)).toBe(1);
      expect(d.opened()).toBe(1);
      expect(api.calls).toEqual([]);
      expect(d.collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(d.collected.lines).toEqual([
        { level: "error", line: "worded: settings-file-unreadable" },
        { line: "result: failed" },
      ]);
    },
  );

  test("the artifact channel is the uploader dep's: absent it fails before any API call, present the run reaches the API", async () => {
    const reportPublicKey = await identityToRecipient(await generateX25519Identity());
    const cfg = single({ privateRepos: "redact", privateReport: "artifact", reportPublicKey });
    const routes = { "GET /repos/o/r": { data: { has_wiki: false, private: false } } };

    const refused = new MockApi(routes);
    const without = deps(refused);
    expect(await executeRun(cfg, without.run)).toBe(1);
    expect(refused.calls).toEqual([]);
    expect(without.collected.outputs).toEqual({
      result: "failed",
      "skipped-sections": "",
      "repos-result": "{}",
    });
    expect(without.collected.lines).toEqual([
      { level: "error", line: describeProblem({ code: "artifact-uploader-missing" }) },
      { line: "result: failed" },
    ]);

    const uploads: string[] = [];
    const uploader: ArtifactUploader = {
      async upload(name) {
        uploads.push(name);
      },
    };
    const reached = new MockApi(routes);
    const with_ = deps(reached, { uploader });
    expect(await executeRun(cfg, with_.run)).toBe(0);
    expect(reached.calls.map((c) => `${c.method} ${c.path}`)).toContain("GET /repos/o/r");
    expect(with_.collected.outputs).toEqual({
      result: "clean",
      "skipped-sections": "",
      "repos-result": "{}",
    });
    // A target proven public gets no private report, so nothing was uploaded.
    expect(uploads).toEqual([]);
  });
});

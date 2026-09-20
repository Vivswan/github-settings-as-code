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
  executeRun,
  parseRepoSlug,
  type RunConfig,
  type RunDeps,
  SectionSelection,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

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
  test("a render opens no client and ends at the render conclusion", () =>
    withTempDir("gsac-execute-", async (dir) => {
      const renderedFile = join(dir, "merged.yml");
      const api = new MockApi({});
      const d = deps(api);
      const code = await executeRun(
        {
          kind: "render",
          settingsFiles: [join(LAYERS, "fleet.yml"), join(LAYERS, "team.yml")],
          renderedFile,
          layering: "deep",
        },
        d.run,
      );
      expect(code).toEqual({ exitCode: 0 });
      expect(d.opened()).toBe(0);
      expect(api.calls).toEqual([]);
      expect(d.collected.outputs).toEqual({
        result: "rendered",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(d.collected.lines.slice(-2)).toEqual([
        { line: `rendered 2 layers into ${renderedFile}` },
        { line: "result: rendered" },
      ]);
    }));

  test("a fatal problem raised after the parse comes back beside the exit code, worded once on the Io", () =>
    withTempDir("gsac-execute-", async (dir) => {
      const settingsFile = join(dir, "missing.yml");
      const api = new MockApi({});
      const d = deps(api);
      expect(await executeRun(single({ settingsFile }), d.run)).toEqual({
        exitCode: 1,
        fatal: {
          code: "settings-file-unreadable",
          role: "settings-file",
          path: settingsFile,
          reason: expect.stringContaining("ENOENT"),
        },
      });
      expect(d.opened()).toBe(1);
      expect(api.calls).toEqual([]);
      expect(d.collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(d.collected.lines).toEqual([
        { level: "error", line: expect.stringMatching(/^cannot read settings from /) },
        { line: "result: failed" },
      ]);
    }));

  test("the artifact channel uploads through the uploader dep, and a target proven public gets no report", async () => {
    const reportPublicKey = await identityToRecipient(await generateX25519Identity());
    const cfg = single({ privateRepos: "redact", privateReport: "artifact", reportPublicKey });
    const routes = { "GET /repos/o/r": { data: { has_wiki: false, private: false } } };
    const uploads: string[] = [];
    const uploader: ArtifactUploader = {
      async upload(name) {
        uploads.push(name);
      },
    };
    const reached = new MockApi(routes);
    const with_ = deps(reached, { uploader });
    expect(await executeRun(cfg, with_.run)).toEqual({ exitCode: 0 });
    expect(reached.calls.map((c) => `${c.method} ${c.path}`)).toContain("GET /repos/o/r");
    expect(with_.collected.outputs).toEqual({
      result: "clean",
      "skipped-sections": "",
      "repos-result": "{}",
    });
    expect(uploads).toEqual([]);
  });
});

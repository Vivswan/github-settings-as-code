import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import {
  collectingIo,
  parseRepoSlug,
  runMulti,
  runSingle,
  SectionSelection,
  type SingleConfig,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

const cfg = (overrides: Partial<SingleConfig> = {}): SingleConfig => ({
  repo,
  settingsFile: "test/fixtures/single.yml",
  mode: "check",
  onMissingPermission: "fail",
  sections: SectionSelection.ALL,
  privateRepos: "show",
  privateReport: "none",
  reportPublicKey: "",
  selfSlug: "o/r",
  runUrl: "",
  ...overrides,
});

describe("runSingle", () => {
  test("a clean check returns the one target's outcome and prints nothing", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } });
    const collected = collectingIo();
    expect(await runSingle(api, cfg(), collected.io)).toEqual(
      ok({
        result: "clean",
        display: "o/r",
        detail: {
          slug: "o/r",
          outcomes: [{ key: "repository", status: "clean", detail: [] }],
          note: undefined,
        },
      }),
    );
    expect(collected.lines).toEqual([]);
  });

  test("the artifact channel without an uploader is fatal before any API call", async () => {
    const api = new MockApi({});
    const fatal = err({ code: "artifact-uploader-missing" as const });
    expect(
      await runSingle(
        api,
        cfg({ privateRepos: "redact", privateReport: "artifact", reportPublicKey: "age1x" }),
        collectingIo().io,
      ),
    ).toEqual(fatal);
    expect(
      await runMulti(
        api,
        {
          ...cfg({ privateRepos: "redact", privateReport: "artifact", reportPublicKey: "age1x" }),
          reposDir: "",
          reposInput: "o/a",
          defaultsFile: "",
          adminOwner: "o",
          discoveryFilters: {
            visibility: "all",
            archived: "skip",
            forks: "include",
            affiliation: ["owner"],
            topics: [],
            exclude: [],
          },
          discoveryFiltersSet: [],
        },
        collectingIo().io,
      ),
    ).toEqual(fatal);
    expect(api.calls).toEqual([]);
  });

  test("an unreadable settings file is fatal, carrying the path under the settings-file role", async () => {
    const api = new MockApi({});
    const result = await runSingle(api, cfg({ settingsFile: "missing.yml" }), collectingIo().io);
    expect(result).toEqual(
      err({
        code: "settings-file-unreadable",
        role: "settings-file",
        path: "missing.yml",
        reason: expect.stringContaining("ENOENT"),
      }),
    );
    expect(api.calls).toEqual([]);
  });
});

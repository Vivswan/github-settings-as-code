import { describe, expect, test } from "bun:test";
import {
  collectingIo,
  parseRepoSlug,
  runMulti,
  runSingle,
  type SingleConfig,
} from "../../src/index.js";
import { ARTIFACT_NEEDS_UPLOADER } from "../../src/report/delivery.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r") as NonNullable<ReturnType<typeof parseRepoSlug>>;

const cfg = (overrides: Partial<SingleConfig> = {}): SingleConfig => ({
  repo,
  settingsFile: "test/fixtures/single.yml",
  mode: "check",
  onMissingPermission: "fail",
  requiredSections: new Set(),
  onlySections: new Set(),
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
    expect(await runSingle(api, cfg(), collected.io)).toEqual({
      target: {
        result: "clean",
        display: "o/r",
        detail: {
          slug: "o/r",
          outcomes: [{ key: "repository", status: "clean", detail: [] }],
          note: undefined,
        },
      },
    });
    expect(collected.lines).toEqual([]);
  });

  test("the artifact channel without an uploader is fatal before any API call", async () => {
    const api = new MockApi({});
    const fatal = { fatal: ARTIFACT_NEEDS_UPLOADER };
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
    ).toEqual({ ...fatal, targets: [] });
    expect(api.calls).toEqual([]);
  });

  test("an unreadable settings file is fatal, naming the path and the input", async () => {
    const api = new MockApi({});
    const result = await runSingle(api, cfg({ settingsFile: "missing.yml" }), collectingIo().io);
    expect(result).toEqual({
      fatal: expect.stringMatching(
        /^cannot read settings from missing\.yml: .*ENOENT.*\. Check that the file exists at that path \(set the "settings-file" input if it lives elsewhere\) and is valid YAML$/,
      ),
    });
    expect(api.calls).toEqual([]);
  });
});

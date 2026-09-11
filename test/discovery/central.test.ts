import { describe, expect, test } from "bun:test";
import { resolveCentralTargets } from "../../src/discovery/central.js";

describe("resolveCentralTargets", () => {
  test("reads owner-shorthand and owner/name files, warns on strays", () => {
    // The walk sorts directory entries, so the target and warning order is
    // fixed: top-level files first, then each owner directory.
    expect(resolveCentralTargets("test/fixtures/repos", "viv")).toEqual({
      targets: [
        {
          slug: "viv/api",
          source: "central",
          origin: "test/fixtures/repos/api.yml",
          filePath: "test/fixtures/repos/api.yml",
        },
        {
          slug: "octo/web",
          source: "central",
          origin: "test/fixtures/repos/octo/web.yml",
          filePath: "test/fixtures/repos/octo/web.yml",
        },
      ],
      warnings: [
        "ignoring test/fixtures/repos/README.md: not a .yml/.yaml file, so it defines no target repository",
        "ignoring test/fixtures/repos/octo/deep: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory",
      ],
    });
  });

  test("shorthand without a known admin owner is an error", () => {
    expect(resolveCentralTargets("test/fixtures/repos", "")).toEqual({
      error:
        'repos-dir "test/fixtures/repos" has 1 invalid settings file(s):\n' +
        "- cannot resolve test/fixtures/repos/api.yml: top-level repos-dir files use the current " +
        "repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml " +
        "layout instead",
    });
  });

  test("the same repo defined twice is an error", () => {
    expect(resolveCentralTargets("test/fixtures/repos-dup", "viv")).toEqual({
      error:
        'repos-dir "test/fixtures/repos-dup" has 1 invalid settings file(s):\n' +
        "- duplicate target viv/x: defined by both test/fixtures/repos-dup/viv/x.yml and " +
        "test/fixtures/repos-dup/x.yml. Keep exactly one settings file per repository",
    });
  });

  test("missing dir errors with a checkout hint", () => {
    expect(resolveCentralTargets("test/fixtures/nope", "viv")).toEqual({
      error:
        'repos-dir "test/fixtures/nope" does not exist in the workspace, so there are no central ' +
        "settings files to read. Add an actions/checkout step before this action, or fix the " +
        "repos-dir path",
    });
  });
});

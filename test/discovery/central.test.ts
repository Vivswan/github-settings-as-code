import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { resolveCentralTargets } from "../../src/discovery/central.js";
import { describeProblem } from "../../src/problem.js";
import { withTempDir } from "../temp-dir.js";

describe("resolveCentralTargets", () => {
  test("reads owner-shorthand and owner/name files, warns on strays", () => {
    // The walk sorts directory entries, so the order is fixed: top-level files first, then each owner directory.
    expect(resolveCentralTargets("test/fixtures/repos", "example-org")).toEqual(
      ok({
        targets: [
          {
            repo: { owner: "example-org", name: "api", slug: "example-org/api" },
            source: "central",
            origin: "test/fixtures/repos/api.yml",
            filePath: "test/fixtures/repos/api.yml",
          },
          {
            repo: { owner: "octo", name: "web", slug: "octo/web" },
            source: "central",
            origin: "test/fixtures/repos/octo/web.yml",
            filePath: "test/fixtures/repos/octo/web.yml",
          },
        ],
        warnings: [
          "ignoring test/fixtures/repos/README.md: not a .yml/.yaml file, so it defines no target repository",
          "ignoring test/fixtures/repos/octo/deep: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory",
        ],
      }),
    );
  });

  test("shorthand without a known admin owner is refused, naming the ownerless files", () => {
    expect(resolveCentralTargets("test/fixtures/repos", "")).toEqual(
      err({
        code: "repos-dir-invalid-files",
        reposDir: "test/fixtures/repos",
        files: [{ kind: "ownerless", files: ["test/fixtures/repos/api.yml"] }],
      }),
    );
  });

  test("two ownerless files fold into one entry, and the message counts both files", () =>
    withTempDir("central-ownerless-", (dir) => {
      writeFileSync(join(dir, "a.yml"), "");
      writeFileSync(join(dir, "b.yml"), "");
      const problem = resolveCentralTargets(dir, "")._unsafeUnwrapErr();
      expect(describeProblem(problem)).toStartWith(
        `repos-dir "${dir}" has 2 invalid settings files:\n- cannot resolve ${join(dir, "a.yml")}, ${join(dir, "b.yml")}: `,
      );
    }));

  test("the same repo defined twice is refused, naming both files", () => {
    expect(resolveCentralTargets("test/fixtures/repos-dup", "example-org")).toEqual(
      err({
        code: "repos-dir-invalid-files",
        reposDir: "test/fixtures/repos-dup",
        files: [
          {
            kind: "duplicate",
            slug: "example-org/x",
            first: "test/fixtures/repos-dup/example-org/x.yml",
            second: "test/fixtures/repos-dup/x.yml",
          },
        ],
      }),
    );
  });

  test("a symbolic link is followed, and one whose target is gone is ignored with a warning: a stale link left by a rename would otherwise end the whole run as an unreadable repos-dir", () =>
    withTempDir("central-links-", (dir) => {
      mkdirSync(join(dir, "octo"));
      writeFileSync(join(dir, "octo", "web.yml"), "");
      symlinkSync("gone.yml", join(dir, "old.yml"));
      symlinkSync("gone", join(dir, "octo", "stale.yml"));
      symlinkSync(join("octo", "web.yml"), join(dir, "site.yml"));
      symlinkSync("octo", join(dir, "team"));
      const target = (owner: string, name: string, filePath: string) => ({
        repo: { owner, name, slug: `${owner}/${name}` },
        source: "central" as const,
        origin: filePath,
        filePath,
      });
      const broken = (path: string) =>
        `ignoring ${path}: a symbolic link whose target cannot be read, so it defines no target repository. Repair the link or remove it`;

      expect(resolveCentralTargets(dir, "example-org")).toEqual(
        ok({
          targets: [
            target("octo", "web", join(dir, "octo", "web.yml")),
            target("example-org", "site", join(dir, "site.yml")),
            target("team", "web", join(dir, "team", "web.yml")),
          ],
          warnings: [
            broken(join(dir, "octo", "stale.yml")),
            broken(join(dir, "old.yml")),
            broken(join(dir, "team", "stale.yml")),
          ],
        }),
      );
    }));

  test("a missing dir is its own problem", () => {
    expect(resolveCentralTargets("test/fixtures/nope", "example-org")).toEqual(
      err({ code: "repos-dir-missing", reposDir: "test/fixtures/nope" }),
    );
  });
});

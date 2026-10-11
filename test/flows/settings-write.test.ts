import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath } from "../../src/flows/settings-write.js";
import { withTempDir } from "../temp-dir.js";

describe("canonicalPath", () => {
  // bun's realpath collapses "link/.." lexically before following the link and names the sibling of `link`; the
  // rename the snapshot guards compare against follows the link first. Expectations are realpaths of EXISTING paths,
  // never of the shape under test, so they hold on every runtime and temp layout.
  test.each<[string, (base: string) => string, (base: string) => string]>([
    [
      "an existing file reached through a link and ..",
      (base) => `${base}/link/../x`,
      (base) => realpathSync.native(join(base, "elsewhere", "x")),
    ],
    [
      "a leaf that does not exist yet under a link",
      (base) => join(base, "link", "nope.yml"),
      (base) => join(realpathSync.native(join(base, "link")), "nope.yml"),
    ],
    [
      "a parent that does not exist yet",
      (base) => join(base, "missing", "deeper", "nope.yml"),
      (base) => join(realpathSync.native(base), "missing", "deeper", "nope.yml"),
    ],
    [
      "a spelling through a directory link, named as the filesystem names it",
      (base) => join(base, "alias", "x"),
      (base) => realpathSync.native(join(base, "elsewhere", "x")),
    ],
    [
      ".. after a segment that does not exist, back onto a link: the dir form's join collapses it the same way",
      (base) => `${base}/missing/../link`,
      (base) => realpathSync.native(join(base, "link")),
    ],
  ])("%s", (_case, input, expected) =>
    withTempDir("canonical-path-", (base) => {
      mkdirSync(join(base, "elsewhere", "inner"), { recursive: true });
      writeFileSync(join(base, "elsewhere", "x"), "");
      writeFileSync(join(base, "x"), "");
      symlinkSync(join("elsewhere", "inner"), join(base, "link"));
      symlinkSync("elsewhere", join(base, "alias"));
      expect(canonicalPath(input(base))).toBe(expected(base));
    }),
  );
});

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { collectingIo, concludeMerge, type MergeConfig, runMerge } from "../../src/index.js";
import { withTempDir } from "../temp-dir.js";

const FLEET = "repository:\n  has_wiki: false\n";
const REPO = "repository:\n  has_issues: true\n";

describe("runMerge", () => {
  /** The two layers written into `dir`, and the config folding them into `mergedFile`. */
  const cfg = (dir: string, mergedFile: string): MergeConfig => {
    writeFileSync(join(dir, "fleet.yml"), FLEET);
    writeFileSync(join(dir, "repo.yml"), REPO);
    return {
      settingsFiles: [join(dir, "fleet.yml"), join(dir, "repo.yml")],
      mergedFile,
      layering: "merge",
    };
  };

  test("folds the layers into merged-file, and the finished merge concludes merged", () =>
    withTempDir("run-merge-", (dir) => {
      const collected = collectingIo();
      const mergedFile = join(dir, "out", "merged.yml");
      const config = cfg(dir, mergedFile);
      const merged = runMerge(config, collected.io);
      expect(merged).toEqual(ok({ layers: config.settingsFiles, mergedFile }));
      expect(readFileSync(mergedFile, "utf8")).toBe(
        "repository:\n  has_issues: true\n  has_wiki: false\n",
      );
      expect(concludeMerge(collected.io, merged._unsafeUnwrap())).toBe(0);
      expect(collected.outputs).toEqual({
        result: "merged",
        "skipped-sections": "",
        "repos-result": "{}",
      });
    }));

  test.each<[string, (dir: string) => string, number, string]>([
    ["a layer's own path", (d) => join(d, "repo.yml"), 1, "repo.yml"],
    ["a ./ spelling of a layer, compared resolved", (d) => `${d}/./fleet.yml`, 0, "fleet.yml"],
  ])(
    "a merged-file naming %s fails before any write, naming the layer's position",
    (_case, mergedFile, index, layer) =>
      withTempDir("run-merge-", (dir) => {
        const collected = collectingIo();
        const target = mergedFile(dir);
        expect(runMerge(cfg(dir, target), collected.io)).toEqual(
          err({
            code: "merged-file-is-layer" as const,
            mergedFile: target,
            index,
            layer: join(dir, layer),
          }),
        );
        expect(collected.lines).toEqual([]);
        expect(readFileSync(join(dir, "fleet.yml"), "utf8")).toBe(FLEET);
        expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
      }),
  );

  test("a sibling file beside the merged file is never touched, whether a layer or the user's own", () =>
    withTempDir("run-merge-", (dir) => {
      // The write stages under a name unique to the run, so a `<merged-file>.tmp` the user owns, or one that IS a
      // layer, survives the write untouched.
      writeFileSync(join(dir, "fleet.yml"), FLEET);
      const owned = join(dir, "merged.yml.tmp");
      writeFileSync(owned, REPO);
      const mergedFile = join(dir, "merged.yml");
      const collected = collectingIo();
      const merged = runMerge(
        { settingsFiles: [join(dir, "fleet.yml"), owned], mergedFile, layering: "merge" },
        collected.io,
      );
      expect(merged).toEqual(ok({ layers: [join(dir, "fleet.yml"), owned], mergedFile }));
      expect(readFileSync(owned, "utf8")).toBe(REPO);
      expect(readFileSync(mergedFile, "utf8")).toBe(
        "repository:\n  has_issues: true\n  has_wiki: false\n",
      );
      expect(readdirSync(dir).sort()).toEqual(["fleet.yml", "merged.yml", "merged.yml.tmp"]);
    }));
});

describe("runMerge writes through the shared writer", () => {
  const twoLayers = (dir: string): string[] => {
    writeFileSync(join(dir, "fleet.yml"), FLEET);
    writeFileSync(join(dir, "repo.yml"), REPO);
    return [join(dir, "fleet.yml"), join(dir, "repo.yml")];
  };
  const MERGED = "repository:\n  has_issues: true\n  has_wiki: false\n";
  const merge = (layers: string[], mergedFile: string) =>
    runMerge({ settingsFiles: layers, mergedFile, layering: "merge" }, collectingIo().io);

  test("a merged-file that is a link to a layer is admitted: the rename replaces the link and the layer stands", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const mergedFile = join(dir, "out.yml");
      symlinkSync("repo.yml", mergedFile);
      expect(merge(layers, mergedFile)).toEqual(ok({ layers, mergedFile }));
      expect(lstatSync(mergedFile).isSymbolicLink()).toBe(false);
      expect(readFileSync(mergedFile, "utf8")).toBe(MERGED);
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }));

  test("a layer read through a link to the destination is refused: the write would change what the next run reads", () =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const alias = join(dir, "alias.yml");
      symlinkSync("repo.yml", alias);
      const layers = [join(dir, "fleet.yml"), alias];
      const mergedFile = join(dir, "repo.yml");
      expect(merge(layers, mergedFile)).toEqual(
        err({ code: "merged-file-is-layer" as const, mergedFile, index: 1, layer: alias }),
      );
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }));

  test.each<[string, (dir: string) => { layer: string; mergedFile: string }]>([
    [
      "a chain: the destination is a link in the middle of the layer's read",
      (d) => {
        symlinkSync("repo.yml", join(d, "out.yml"));
        symlinkSync("out.yml", join(d, "alias.yml"));
        return { layer: join(d, "alias.yml"), mergedFile: join(d, "out.yml") };
      },
    ],
    [
      "a directory link the layer is read through",
      (d) => {
        symlinkSync(".", join(d, "folder"));
        return { layer: join(d, "folder", "repo.yml"), mergedFile: join(d, "folder") };
      },
    ],
  ])("%s is refused: the write would change what the next run reads", (_case, shape) =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const { layer, mergedFile } = shape(dir);
      const layers = [join(dir, "fleet.yml"), layer];
      expect(merge(layers, mergedFile)).toEqual(
        err({ code: "merged-file-is-layer" as const, mergedFile, index: 1, layer }),
      );
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }),
  );

  test("a merged-file that spells a layer's link in another case is refused on a case-insensitive filesystem", () =>
    withTempDir("run-merge-", (dir) => {
      writeFileSync(join(dir, "Probe"), "");
      const caseInsensitive = existsSync(join(dir, "probe"));
      twoLayers(dir);
      const alias = join(dir, "alias.yml");
      symlinkSync("repo.yml", alias);
      const layers = [join(dir, "fleet.yml"), alias];
      const mergedFile = join(dir, "ALIAS.YML");
      const merged = merge(layers, mergedFile);
      if (caseInsensitive) {
        expect(merged).toEqual(
          err({ code: "merged-file-is-layer" as const, mergedFile, index: 1, layer: alias }),
        );
        expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      } else {
        expect(merged).toEqual(ok({ layers, mergedFile }));
      }
    }));

  test("a layer that IS the link at the destination is refused: the rename would replace the layer's own entry", () =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const link = join(dir, "out.yml");
      symlinkSync("repo.yml", link);
      const layers = [join(dir, "fleet.yml"), link];
      expect(merge(layers, link)).toEqual(
        err({ code: "merged-file-is-layer" as const, mergedFile: link, index: 1, layer: link }),
      );
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }));

  test("an existing merged file keeps its permission bits through the replace", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const mergedFile = join(dir, "merged.yml");
      writeFileSync(mergedFile, "stale\n");
      chmodSync(mergedFile, 0o600);
      // A permissive umask, so a writer that forgot the mode would land at 0644 and fail the pin.
      const previous = process.umask(0o022);
      try {
        expect(merge(layers, mergedFile)).toEqual(ok({ layers, mergedFile }));
      } finally {
        process.umask(previous);
      }
      expect(readFileSync(mergedFile, "utf8")).toBe(MERGED);
      expect(statSync(mergedFile).mode & 0o777).toBe(0o600);
    }));

  test("a merged-file spelled through a link and .. stages beside the destination the OS resolves, not beside cwd", () =>
    withTempDir("run-merge-", (dir) => {
      // `link/../out.yml`: the OS follows the link and steps up, so the file lands beside `inner`; a staging name
      // built with join() would collapse `link/..` lexically and stage under `dir`. `dir` is made read-only for the
      // write, so a staging file placed there fails the run instead of quietly renaming across.
      mkdirSync(join(dir, "elsewhere", "inner"), { recursive: true });
      symlinkSync(join("elsewhere", "inner"), join(dir, "link"));
      const layers = twoLayers(dir);
      const mergedFile = `${dir}/link/../out.yml`;
      chmodSync(dir, 0o555);
      try {
        expect(merge(layers, mergedFile)).toEqual(ok({ layers, mergedFile }));
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readFileSync(join(dir, "elsewhere", "out.yml"), "utf8")).toBe(MERGED);
      expect(readdirSync(join(dir, "elsewhere")).sort()).toEqual(["inner", "out.yml"]);
      expect(readdirSync(dir).filter((name) => name.startsWith(".gsac-"))).toEqual([]);
    }));

  test("a merged-file that spells an existing layer in another case is refused on a case-insensitive filesystem", () =>
    withTempDir("run-merge-", (dir) => {
      writeFileSync(join(dir, "Probe"), "");
      const caseInsensitive = existsSync(join(dir, "probe"));
      const layers = twoLayers(dir);
      const mergedFile = join(dir, "REPO.YML");
      const merged = merge(layers, mergedFile);
      if (caseInsensitive) {
        expect(merged).toEqual(
          err({
            code: "merged-file-is-layer" as const,
            mergedFile,
            index: 1,
            layer: join(dir, "repo.yml"),
          }),
        );
        expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
      } else {
        expect(merged).toEqual(ok({ layers, mergedFile }));
        expect(readFileSync(mergedFile, "utf8")).toBe(MERGED);
      }
    }));

  test("a merged-file with a trailing slash fails on the rename, staged under the directory's own hidden name", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const mergedFile = `${dir}/out.yml/`;
      // The rename cannot land on `out.yml/`; the staging name in the OS's line is the one observable of where the write staged.
      expect(merge(layers, mergedFile)).toEqual(
        err({
          code: "merged-file-unwritable" as const,
          path: mergedFile,
          reason: expect.stringContaining(`rename '${dir}/.gsac-`),
        }),
      );
      expect(readdirSync(dir).sort()).toEqual(["fleet.yml", "repo.yml"]);
    }));

  test("a merged-file leaf at the filesystem's name limit is written: the staging name is short and its own", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const mergedFile = join(dir, `${"m".repeat(251)}.yml`);
      expect(merge(layers, mergedFile)).toEqual(ok({ layers, mergedFile }));
      expect(readFileSync(mergedFile, "utf8")).toBe(MERGED);
      expect(readdirSync(dir).filter((name) => name.startsWith(".gsac-"))).toEqual([]);
    }));
});

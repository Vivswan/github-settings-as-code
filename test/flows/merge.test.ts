import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
        "repository:\n  has_wiki: false\n  has_issues: true\n",
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
            staging: false,
          }),
        );
        expect(collected.lines).toEqual([]);
        expect(readFileSync(join(dir, "fleet.yml"), "utf8")).toBe(FLEET);
        expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
      }),
  );

  test.each<[string, (dir: string) => { layer: string; mergedFile: string }]>([
    [
      "as spelled",
      (d) => ({ layer: join(d, "merged.yml.tmp"), mergedFile: join(d, "merged.yml") }),
    ],
    // The same directory under two names: a lexical comparison sees two paths, the filesystem one.
    [
      "through a symlinked directory",
      (d) => ({
        layer: join(d, "real", "merged.yml.tmp"),
        mergedFile: join(d, "link", "merged.yml"),
      }),
    ],
  ])(
    "a layer sitting on the merged file's staging sibling (%s) is refused before the write unlinks it",
    (_case, paths) =>
      withTempDir("run-merge-", (dir) => {
        // The write stages at <merged-file>.tmp and unlinks whatever is there first; a layer at that path would be gone
        // before the fold's result landed.
        writeFileSync(join(dir, "fleet.yml"), FLEET);
        mkdirSync(join(dir, "real"));
        symlinkSync(join(dir, "real"), join(dir, "link"));
        const { layer: staged, mergedFile } = paths(dir);
        writeFileSync(staged, REPO);
        const collected = collectingIo();
        expect(
          runMerge(
            { settingsFiles: [join(dir, "fleet.yml"), staged], mergedFile, layering: "merge" },
            collected.io,
          ),
        ).toEqual(
          err({
            code: "merged-file-is-layer" as const,
            mergedFile,
            index: 1,
            layer: staged,
            staging: true,
          }),
        );
        expect(collected.lines).toEqual([]);
        expect(readFileSync(staged, "utf8")).toBe(REPO);
        expect(existsSync(mergedFile)).toBe(false);
      }),
  );
});

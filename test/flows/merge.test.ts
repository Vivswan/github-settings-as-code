import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { collectingIo, concludeMerge, type MergeConfig, runMerge } from "../../src/index.js";

const FLEET = "repository:\n  has_wiki: false\n";
const REPO = "repository:\n  has_issues: true\n";

describe("runMerge", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-merge-"));
    writeFileSync(join(dir, "fleet.yml"), FLEET);
    writeFileSync(join(dir, "repo.yml"), REPO);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cfg = (mergedFile: string): MergeConfig => ({
    settingsFiles: [join(dir, "fleet.yml"), join(dir, "repo.yml")],
    mergedFile,
    layering: "merge",
  });

  test("folds the layers into merged-file, and the finished merge concludes merged", () => {
    const collected = collectingIo();
    const mergedFile = join(dir, "out", "merged.yml");
    const merged = runMerge(cfg(mergedFile), collected.io);
    expect(merged).toEqual(ok({ layers: cfg(mergedFile).settingsFiles, mergedFile }));
    expect(readFileSync(mergedFile, "utf8")).toBe(
      "repository:\n  has_wiki: false\n  has_issues: true\n",
    );
    expect(concludeMerge(collected.io, merged._unsafeUnwrap())).toBe(0);
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "merged" });
  });

  test.each<[string, (dir: string) => string, number, string]>([
    ["a layer's own path", (d) => join(d, "repo.yml"), 1, "repo.yml"],
    ["a ./ spelling of a layer, compared resolved", (d) => `${d}/./fleet.yml`, 0, "fleet.yml"],
  ])(
    "a merged-file naming %s fails before any write, naming the layer's position",
    (_case, mergedFile, index, layer) => {
      const collected = collectingIo();
      const target = mergedFile(dir);
      expect(runMerge(cfg(target), collected.io)).toEqual(
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
    },
  );
});

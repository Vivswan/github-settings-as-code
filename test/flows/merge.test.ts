import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectingIo, type MergeConfig, runMerge } from "../../src/index.js";

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

  test("folds the layers into merged-file and concludes merged", () => {
    const collected = collectingIo();
    expect(runMerge(cfg(join(dir, "out", "merged.yml")), collected.io)).toBe(0);
    expect(readFileSync(join(dir, "out", "merged.yml"), "utf8")).toBe(
      "repository:\n  has_wiki: false\n  has_issues: true\n",
    );
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "merged" });
  });

  test.each<[string, (dir: string) => string, number, string]>([
    ["a layer's own path", (d) => join(d, "repo.yml"), 2, "repo.yml"],
    ["a ./ spelling of a layer, compared resolved", (d) => `${d}/./fleet.yml`, 1, "fleet.yml"],
  ])(
    "a merged-file naming %s fails before any write, naming the layer's position",
    (_case, mergedFile, position, layer) => {
      const collected = collectingIo();
      const target = mergedFile(dir);
      expect(runMerge(cfg(target), collected.io)).toBe(1);
      expect(collected.lines).toEqual([
        {
          level: "error",
          line:
            `the "merged-file" input "${target}" is layer ${position} of the ` +
            `"settings-file" list ("${join(dir, layer)}"): the merge would overwrite that ` +
            `layer with the folded document, and the next run would fold the merged document as a ` +
            `layer. Write the merged document to a path outside the layer list`,
        },
        { line: "result: failed" },
      ]);
      expect(readFileSync(join(dir, "fleet.yml"), "utf8")).toBe(FLEET);
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    },
  );
});

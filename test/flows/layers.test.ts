import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { foldLayers, readLayerFiles } from "../../src/flows/layers.js";
import * as settingsRead from "../../src/flows/settings-read.js";
import { silentIo } from "../../src/io.js";
import { withTempDir } from "../temp-dir.js";

describe("readLayerFiles", () => {
  /** Two readable layers and one with broken YAML, written into `dir`. */
  function writeLayers(dir: string): void {
    writeFileSync(join(dir, "fleet.yml"), "repository:\n  has_wiki: false\n");
    writeFileSync(join(dir, "repo.yml"), "repository:\n  has_issues: true\n");
    writeFileSync(join(dir, "broken.yml"), "labels: [oops, unclosed\n");
  }

  test("reads every layer in path order, each named by its path", () =>
    withTempDir("read-layers-", (dir) => {
      writeLayers(dir);
      const fleet = join(dir, "fleet.yml");
      const repo = join(dir, "repo.yml");
      expect(readLayerFiles([repo, fleet])).toEqual(
        ok([
          { name: repo, doc: { repository: { has_issues: true } } },
          { name: fleet, doc: { repository: { has_wiki: false } } },
        ]),
      );
    }));

  test("the first unreadable layer is the problem, and the layers after it are never read", () =>
    withTempDir("read-layers-", (dir) => {
      writeLayers(dir);
      const read = spyOn(settingsRead, "readSettingsFile");
      try {
        const missing = join(dir, "missing.yml");
        expect(readLayerFiles([missing, join(dir, "broken.yml")])).toEqual(
          err({
            code: "settings-file-unreadable" as const,
            role: "layer" as const,
            path: missing,
            reason: expect.stringContaining("ENOENT"),
          }),
        );
        // The broken layer's own syntax error never becomes a candidate: one read, the failed one.
        expect(read.mock.calls).toEqual([[missing, "layer"]]);
      } finally {
        read.mockRestore();
      }
    }));
});

describe("foldLayers", () => {
  test("a wrapper's malformed _layering is the fold's refusal, not the layer's own shape problem", () => {
    // The standalone view hides the directive from the per-layer parse, so the fold, which owns it, is what names the fix;
    // a well-formed one folds. Without the strip the parse would report a bare enum mismatch first.
    const fold = (directive: string) =>
      foldLayers(
        [
          {
            name: "repo.yml",
            doc: { labels: { _layering: directive, entries: [{ name: "mine" }] } },
          },
        ],
        "merged",
        "merge",
        silentIo(),
      );
    expect(fold("union")).toEqual(
      err({
        layer: "repo.yml",
        site: "labels._layering",
        code: "layer-bad-directive",
        actual: "union",
      }),
    );
    expect(fold("merge").isOk()).toBe(true);
  });
});

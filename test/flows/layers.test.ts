import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import type { Layering } from "../../src/engine/layers.js";
import { foldLayers, readLayerFiles } from "../../src/flows/layers.js";
import * as settingsRead from "../../src/flows/settings-read.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
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
  test.each<[string, Record<string, unknown>, Layering]>([
    ["the run directive", { labels: [{ name: "bug", description: null }] }, "shallow"],
    [
      "the file directive",
      { _layering: "replace", labels: [{ name: "bug", description: null }] },
      "deep",
    ],
    [
      "the wrapper directive",
      { labels: { _layering: "shallow", entries: [{ name: "bug", description: null }] } },
      "deep",
    ],
  ])(
    "a null inside an entry reaches the per-layer validation when %s says the entry is copied as written; under deep the same null is a marker the fold consumes",
    (_case, repo, run) => {
      // Under shallow and replace the fold never opens the entry, so the null is data the validator must judge and name;
      // under deep it deletes the lower description with a notice, and the layer validates.
      const fleet = { name: "fleet.yml", doc: { labels: [{ name: "bug", description: "fleet" }] } };
      const fold = (doc: Record<string, unknown>, layering: Layering) =>
        foldLayers([fleet, { name: "repo.yml", doc }], "merged", layering, silentIo());
      expect(fold(repo, run).match(() => null, describeProblem)).toMatch(
        /^repo\.yml has malformed section entries: labels(\.entries)?\[0\]\.description/,
      );
      const deep = fold({ labels: [{ name: "bug", description: null }] }, "deep");
      expect(deep.map((folded): unknown[] => [folded.notices, folded.settings])).toEqual(
        ok([
          [{ layer: "repo.yml", path: "labels[0].description" }],
          { labels: { _undeclared: "delete", entries: [{ name: "bug" }] } },
        ]),
      );
    },
  );

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
        "deep",
        silentIo(),
      );
    expect(fold("merge")).toEqual(
      err({
        layer: "repo.yml",
        site: "labels._layering",
        code: "layer-bad-directive",
        actual: "merge",
        allowed: ["replace", "shallow", "deep"],
      }),
    );
    expect(fold("shallow").isOk()).toBe(true);
  });
});

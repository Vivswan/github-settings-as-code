import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { readLayerFiles } from "../../src/flows/layers.js";
import * as settingsRead from "../../src/flows/settings-read.js";
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

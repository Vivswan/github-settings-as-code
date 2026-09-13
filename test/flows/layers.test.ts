import { describe, expect, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { readLayerFiles } from "../../src/flows/layers.js";
import * as settingsRead from "../../src/flows/settings-read.js";
import { tempDirTest } from "../temp-dir.js";

describe("readLayerFiles", () => {
  const tempTest = tempDirTest("read-layers-");

  /** Two readable layers and one with broken YAML, written into `dir`. */
  function writeLayers(dir: string): void {
    writeFileSync(join(dir, "fleet.yml"), "repository:\n  has_wiki: false\n");
    writeFileSync(join(dir, "repo.yml"), "repository:\n  has_issues: true\n");
    writeFileSync(join(dir, "broken.yml"), "labels: [oops, unclosed\n");
  }

  tempTest("reads every layer in path order, each named by its path", (dir) => {
    writeLayers(dir);
    const fleet = join(dir, "fleet.yml");
    const repo = join(dir, "repo.yml");
    expect(readLayerFiles([repo, fleet])).toEqual(
      ok([
        { name: repo, doc: { repository: { has_issues: true } } },
        { name: fleet, doc: { repository: { has_wiki: false } } },
      ]),
    );
  });

  tempTest(
    "the first unreadable layer is the problem, and the layers after it are never read",
    (dir) => {
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
    },
  );
});

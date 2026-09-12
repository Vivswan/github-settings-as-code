import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { readLayerFiles } from "../../src/flows/layers.js";
import * as settingsRead from "../../src/flows/settings-read.js";

describe("readLayerFiles", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "read-layers-"));
    writeFileSync(join(dir, "fleet.yml"), "repository:\n  has_wiki: false\n");
    writeFileSync(join(dir, "repo.yml"), "repository:\n  has_issues: true\n");
    writeFileSync(join(dir, "broken.yml"), "labels: [oops, unclosed\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads every layer in path order, each named by its path", () => {
    const fleet = join(dir, "fleet.yml");
    const repo = join(dir, "repo.yml");
    expect(readLayerFiles([repo, fleet])).toEqual(
      ok([
        { name: repo, doc: { repository: { has_issues: true } } },
        { name: fleet, doc: { repository: { has_wiki: false } } },
      ]),
    );
  });

  test("the first unreadable layer is the problem, and the layers after it are never read", () => {
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
  });
});

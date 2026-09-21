import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import type { Layering } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
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
  const fleet = { name: "fleet.yml", doc: { labels: [{ name: "bug", description: "fleet" }] } };
  const fold = (doc: Record<string, unknown>, layering: Layering) =>
    foldLayers([fleet, { name: "repo.yml", doc }], "merged", { layering }, silentIo());

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
    ["deep, where the pair merges", { labels: [{ name: "bug", description: null }] }, "deep"],
  ])(
    "a null a key does not admit is the layer's own error under %s: the fold reads no null as a marker",
    (_case, repo, run) => {
      expect(fold(repo, run).match(() => null, describeProblem)).toMatch(
        /^repo\.yml has malformed section entries: labels(\.entries)?\[0\]\.description has no empty state; write a string\./,
      );
    },
  );

  test("a removal entry validates alone (the standalone view drops it) and the fold drops the lower entry with a notice", () => {
    const folded = fold({ labels: [{ name: "Bug", _remove: true }, { name: "docs" }] }, "deep");
    expect(folded.map((out): unknown[] => [out.notices, out.settings])).toEqual(
      ok([
        [{ layer: "repo.yml", path: "labels[0]" }],
        { labels: { _undeclared: "delete", entries: [{ name: "docs" }] } },
      ]),
    );
  });

  test("the removal a single document refuses folds as a higher layer: per-layer validation sees the standalone view, and the fold consumes the marker", () => {
    const higher = { labels: [{ name: "bug", _remove: true }] };
    expect(
      validateSettingsDoc(higher, "repo.yml", SectionSelection.ALL, silentIo()).match(
        () => null,
        describeProblem,
      ),
    ).toMatch(
      /^repo\.yml has malformed section entries: labels\[0\]\._remove: a single document has no lower layer/,
    );
    expect(fold(higher, "shallow").map((out): unknown[] => [out.notices, out.settings])).toEqual(
      ok([
        [{ layer: "repo.yml", path: "labels[0]" }],
        { labels: { _undeclared: "delete", entries: [] } },
      ]),
    );
  });
  test.each<[string, Record<string, unknown>, string]>([
    [
      "a plain list",
      {
        labels: [
          { name: "bug", _remove: true },
          { name: "new", color: null },
        ],
      },
      "labels[1].color",
    ],
    [
      "an {_layering, entries} wrapper",
      {
        labels: {
          _layering: "deep",
          entries: [
            { name: "bug", _remove: true },
            { name: "new", color: null },
          ],
        },
      },
      "labels.entries[1].color",
    ],
    [
      "a nested list",
      {
        environments: [
          {
            name: "prod",
            variables: [
              { name: "REGION", _remove: true },
              { name: "ZONE", value: null },
            ],
          },
        ],
      },
      "environments[0].variables[1].value",
    ],
  ])(
    "a layer's own issue names the entry by its index in the file as written, removal entries counted, in %s",
    (_case, doc, path) => {
      const fleet = {
        name: "fleet.yml",
        doc: {
          labels: [{ name: "bug", color: "111111" }],
          environments: [{ name: "prod", variables: [{ name: "REGION", value: "eu" }] }],
        },
      };
      expect(
        foldLayers(
          [fleet, { name: "repo.yml", doc }],
          "merged",
          { layering: "deep" },
          silentIo(),
        ).match(() => null, describeProblem),
      ).toStartWith(
        `repo.yml has malformed section entries: ${path} has no empty state; write a string.`,
      );
    },
  );

  test("a malformed marker inside a closed entry schema is the fold's refusal, not the layer's own unknown-key problem", () => {
    // Per-layer validation runs before the fold, and an environment secret's schema is closed: were the marker left in
    // the standalone view, the layer would fail on `Unrecognized key: "_remove"` and never hear that it takes only true.
    expect(
      fold(
        { environments: [{ name: "prod", secrets: [{ name: "TOKEN", _remove: "yes" }] }] },
        "deep",
      ),
    ).toEqual(
      err({
        layer: "repo.yml",
        site: "environments[0].secrets[0]._remove",
        code: "layer-remove-not-true",
        actual: "yes",
      }),
    );
  });

  test("a whole-section null is refused by the layer's own validation, naming the two fixes", () => {
    expect(fold({ labels: null }, "deep").match(() => null, describeProblem)).toMatch(
      /^repo\.yml has malformed section entries: labels: null has no meaning; remove the section or declare its entries\./,
    );
  });

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
        { layering: "deep" },
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

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  type Layering,
  mergeSettings,
  readLayerFiles,
  runRender,
  silentIo,
} from "../../src/index.js";
import { layerFile, RUNNER_ROOT_FILES } from "../e2e/constants.js";
import { loadScenarios, scenarioRoots, settingsYamlFor } from "../e2e/schema.js";
import { withTempDir } from "../temp-dir.js";

/** Every layer file's text, lowest first, as the e2e runner writes a scenario's stack. */
type Stack = readonly string[];

/**
 * A stack in no schema order: `labels` before `repository` (SECTION_KEYS lists them the other way),
 * `enable_vulnerability_alerts` before `has_wiki` (the schema declares the PATCH fields first), a wrapper opening
 * with its entries, and a higher layer opening with the section the schema lists last. The bytes pinned here are the
 * canonical rendering of the fold; no layer's order survives into them.
 */
const UNORDERED: Stack = [
  stringifyYaml({
    labels: {
      entries: [
        { name: "docs", color: "0075ca" },
        { name: "bug", color: "d73a4a" },
      ],
      _undeclared: "keep",
    },
    repository: { has_issues: true, enable_vulnerability_alerts: true, has_wiki: false },
  }),
  stringifyYaml({
    secret_scanning_custom_patterns: [{ pattern: "tok_[a-z]+", name: "token" }],
    repository: { has_issues: false },
    labels: [{ color: "0075ca", name: "docs" }],
  }),
];

const UNORDERED_MERGED = [
  "repository:",
  "  has_issues: false",
  "  has_wiki: false",
  "  enable_vulnerability_alerts: true",
  "labels:",
  "  _undeclared: keep",
  "  entries:",
  "    - name: bug",
  "      color: d73a4a",
  "    - name: docs",
  "      color: 0075ca",
  "secret_scanning_custom_patterns:",
  "  _undeclared: keep",
  "  entries:",
  "    - name: token",
  "      pattern: tok_[a-z]+",
  "",
].join("\n");

/** Every e2e scenario mode: render runs, as the runner lays it out: the layers below, the scenario's settings on top. */
const SCENARIO_STACKS: [string, Stack, Layering][] = loadScenarios(scenarioRoots())
  .filter((scenario) => scenario.inputs?.mode === "render")
  .map((scenario) => [
    scenario.name,
    [
      ...(scenario.settings_layers ?? []).map((layer) => stringifyYaml(layer)),
      settingsYamlFor(scenario),
    ],
    scenario.inputs?.layering ?? "deep",
  ]);

/** The bytes mode: render writes for the stack, and the layers it read, so the library verb starts from the same documents. */
function actionMerge(
  dir: string,
  stack: Stack,
  layering: Layering,
): { written: string; layers: ReturnType<typeof readLayerFiles> } {
  const paths = stack.map((text, index) => {
    const path = join(
      dir,
      index === stack.length - 1 ? RUNNER_ROOT_FILES.settings : layerFile(index),
    );
    writeFileSync(path, text);
    return path;
  });
  const renderedFile = join(dir, RUNNER_ROOT_FILES.rendered);
  const merged = runRender({ settingsFiles: paths, renderedFile, layering }, silentIo());
  if (merged.isErr()) {
    throw new Error(`mode: render refused the stack: ${JSON.stringify(merged.error)}`);
  }
  return { written: readFileSync(renderedFile, "utf8"), layers: readLayerFiles(paths) };
}

describe("mergeSettings writes the bytes mode: render writes", () => {
  test.each<[string, Stack, Layering]>([
    ...SCENARIO_STACKS,
    ["a stack in no schema order", UNORDERED, "deep"],
  ])("%s", (_name, stack, layering) =>
    withTempDir("merge-parity-", (dir) => {
      const { written, layers } = actionMerge(dir, stack, layering);
      const report = mergeSettings(layers._unsafeUnwrap(), { layering })._unsafeUnwrap();
      expect(report.yaml).toBe(written);
    }),
  );

  test("the e2e corpus contributes at least the three curated merge scenarios", () => {
    expect(SCENARIO_STACKS.length).toBeGreaterThanOrEqual(3);
  });

  test("the written file is the fold in the canonical order: sections by SECTION_KEYS, entries by name, the knob leading its wrapper", () =>
    withTempDir("merge-parity-", (dir) => {
      expect(actionMerge(dir, UNORDERED, "deep").written).toBe(UNORDERED_MERGED);
    }));
});

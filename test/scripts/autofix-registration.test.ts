/**
 * The commit-back registration (`autofix` in .repo-platform.yml) and its hook (.github/actions/autofix) against the
 * generated-output table. The platform's push job enforces the lists and nothing ties them to the generators, so
 * without these a new generator would regenerate nothing on a pull request, or turn every fix run red:
 *
 *   an output missing from push.paths  -> the platform refuses the whole fix
 *   an input missing from push.on      -> no fix run starts, and the pull request fails on the drift test
 *   a generator missing from the hook  -> its output is never regenerated
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import {
  generatedPaths,
  generatorEntryPoint,
  generatorScripts,
} from "../../.github/scripts/generated.js";
import { SCHEMA_DESCRIPTIONS } from "../../src/sections/docs-registry.js";
import { ROOT } from "../root.js";

const HOOK = ".github/actions/autofix/action.yml";
const GAPS_DIR = "src/upstream-gaps/";

const { push } = (
  parse(readFileSync(join(ROOT, ".repo-platform.yml"), "utf8")) as {
    autofix: { push: { on: string[]; paths: string[] } };
  }
).autofix;
const hook = parse(readFileSync(join(ROOT, HOOK), "utf8")) as {
  runs: { steps: { run?: string }[] };
};
const packageScripts = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The platform's list grammar: a glob, or a directory spelled with a closing slash. */
const listed = (list: readonly string[], path: string): boolean =>
  list.some((entry) => new Bun.Glob(entry.endsWith("/") ? `${entry}**` : entry).match(path));

const generatorFiles = generatorScripts().map((name) =>
  generatorEntryPoint(packageScripts[name] ?? ""),
);

describe("the autofix registration tracks the generated-output table", () => {
  test("push.paths is the generated outputs by name plus the gaps directory, and none is a path the platform never carries", () => {
    const paths = generatedPaths();
    expect([...push.paths].sort()).toEqual([...paths, GAPS_DIR].sort());
    expect(
      paths.filter((path) => path.startsWith(".github/") || path === ".repo-platform.yml"),
    ).toEqual([]);
  });

  test("the hook runs every generator, in table order", () => {
    const commands = hook.runs.steps.flatMap((step) =>
      [...(step.run ?? "").matchAll(/^\s*bun run (build:\S+)\s*$/gm)].map((match) => match[1]),
    );
    expect(commands).toEqual(generatorScripts());
  });

  test("a hand edit to a generated output, a generator, or the hook starts a fix run", () => {
    for (const file of generatorFiles) {
      expect(file).not.toBeNull();
    }
    for (const path of [...generatedPaths(), ...generatorFiles.map((file) => file ?? ""), HOOK]) {
      expect(listed(push.on, path), `push.on: ${path}`).toBe(true);
    }
  });

  test("an edit to a module a generator runs or to a docs file the registry loads starts a fix run", async () => {
    // The bundler names the modules whose code reaches a generator.
    const bundle = await Bun.build({
      entrypoints: generatorFiles.map((file) => join(ROOT, file ?? "")),
      root: ROOT,
      target: "bun",
      packages: "external",
      metafile: true,
    });
    const modules = Object.keys(bundle.metafile?.inputs ?? {}).map((path) =>
      relative(ROOT, resolve(path)),
    );
    const docs = [...new Set(SCHEMA_DESCRIPTIONS.map((entry) => entry.source))];
    // Controls: a census that came back empty or partial would pass with nothing checked.
    expect(modules).toContain("src/sections/labels/index.ts");
    expect(docs).toContain("docs/sections/labels.docs.yml");
    expect([...modules, ...docs].filter((path) => !listed(push.on, path))).toEqual([]);
  });
});

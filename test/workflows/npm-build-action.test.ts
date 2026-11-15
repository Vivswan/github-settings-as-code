/**
 * The npm-build hook the platform's npm module runs before `npm publish`. Without these, a hook that stops building
 * a path package.json's `files` ships, keeps `scripts.prepare` in the published manifest, or writes what the module
 * refuses after the hook (a version, a dist-tag, a registry) fails only on main, in the publish job.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT } from "../root.js";
import type { Step } from "./workflow-loader.js";

const HOOK = parseYaml(
  readFileSync(join(ROOT, ".github", "actions", "npm-build", "action.yml"), "utf8"),
) as { runs: { steps: Step[] } };
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  files: string[];
  scripts: Record<string, string>;
};
const RUNS = HOOK.runs.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

const scriptsRun = RUNS.flatMap((run) => [...run.matchAll(/\bbun run ([\w:-]+)/g)]).map(
  (match) => match[1] ?? "",
);

test("the hook builds every built path package.json's files list ships, with scripts package.json has", () => {
  const built = { "lib/pkg/": "build:lib", "lib/settings.schema.json": "build:schema" };
  // Non-vacuity: every lib/ entry of `files` is one this table knows how to build.
  expect(PKG.files.filter((file) => file.startsWith("lib/")).sort()).toEqual(
    Object.keys(built).sort(),
  );
  expect(scriptsRun).toEqual(expect.arrayContaining(Object.values(built)));
  expect(scriptsRun.filter((name) => !Object.hasOwn(PKG.scripts, name))).toEqual([]);
});

test("the hook drops scripts.prepare before anything packs the package", () => {
  // The script exists on main, so the removal removes something; `npm publish` and attw's pack would both run it.
  expect(PKG.scripts.prepare).toBeDefined();
  const removal = RUNS.findIndex((run) => /\bnpm pkg delete scripts\.prepare\b/.test(run));
  const packs = RUNS.findIndex((run) => /\bbun run lint:package\b/.test(run));
  expect(removal).toBeGreaterThanOrEqual(0);
  expect(packs).toBeGreaterThan(removal);
});

test.each<[what: string, pattern: RegExp]>([
  ["a version", /\bnpm (?:version|pkg set version)\b|\bbun pm version\b/],
  ["a dist-tag", /\bpublishConfig\.tag\b|\bnpm (?:pkg set tag|config set tag|dist-tag)\b|--tag\b/],
  ["a registry", /registry|\.npmrc|NPM_CONFIG_/i],
  ["a publish of its own", /\b(?:npm|bun) publish\b/],
])("the hook writes nothing the module refuses or owns: %s", (_what, pattern) => {
  const written = HOOK.runs.steps.flatMap((step) => [
    step.run ?? "",
    ...Object.keys(step.env ?? {}),
  ]);
  expect(written.filter((text) => pattern.test(text))).toEqual([]);
});

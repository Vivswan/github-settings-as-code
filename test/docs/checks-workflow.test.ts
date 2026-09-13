/**
 * checks.yml and the fetch-test-artifacts composite against the code they run: a cache key that hashes every input its artifact depends on
 * (a stale restore would test against yesterday's spec with no failure anywhere), and head_ref conditions that spell the release PR
 * branch prefix the pipeline script owns (a drifted spelling skips the anchor-check on every release PR instead of failing there).
 *
 * The cache-key test catches ACCIDENTAL omissions: an input the trim script imports that no hashFiles argument names. Deliberately
 * hiding an input behind expression syntax is out of scope.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { RELEASE_PR_BRANCH_PREFIX } from "../../.github/scripts/release-pipeline.js";
import { ROOT } from "../root.js";
import { headRefPrefixes, headRefPrefixesIn } from "./head-ref.js";
import { readAction, type Step, type Workflow, workflowText } from "./workflow-loader.js";

const COMPOSITE_DIR = ".github/actions/fetch-test-artifacts";
const PATHS_TS = "test/e2e/openapi/paths.ts";
const TRIM_TS = ".github/scripts/trim-openapi.ts";
const FETCH_GRAPHQL_TS = ".github/scripts/fetch-graphql-schema.ts";

/** A fetched, gitignored test artifact the composite restores from its cache. */
interface FetchedArtifact {
  label: string;
  path: string;
  /** Every source the fetched output depends on; the cache key must hash each. */
  hashInputs: () => string[];
}
const FETCHED_ARTIFACTS: readonly FetchedArtifact[] = [
  {
    label: "trimmed OpenAPI spec",
    path: "test/e2e/openapi/github-openapi.trimmed.json",
    // Every import of the scripts: the paths and the API version trimmed, and the fetch helper the bytes come through.
    hashInputs: () => [
      TRIM_TS,
      PATHS_TS,
      ...relativeImportsOf(TRIM_TS),
      ...relativeImportsOf(PATHS_TS),
    ],
  },
  {
    label: "GraphQL schema",
    path: "test/e2e/graphql/schema.docs.graphql",
    hashInputs: () => [FETCH_GRAPHQL_TS, ...relativeImportsOf(FETCH_GRAPHQL_TS)],
  },
];
const [OPENAPI, GRAPHQL] = FETCHED_ARTIFACTS as [FetchedArtifact, FetchedArtifact];

/** The composite's one actions/cache step restoring exactly `path`; zero or several is a broken composite, never a skip. */
function cacheStepFor(path: string): Step {
  const steps = readAction(COMPOSITE_DIR).runs.steps ?? [];
  const found = steps.filter(
    (step) => (step.uses ?? "").startsWith("actions/cache@") && step.with?.path === path,
  );
  expect(
    found.length,
    `${COMPOSITE_DIR} must cache ${path} in exactly one step, found ${found.length}`,
  ).toBe(1);
  return found[0] as Step;
}

/** The key of an artifact cache step; anything but a string key is a broken cache, never a skip. */
function cacheKeyOf(step: Step, path: string): string {
  const key = step.with?.key;
  expect(
    typeof key,
    `the cache step for ${path} has a non-string key: ${JSON.stringify(key)}`,
  ).toBe("string");
  return key as string;
}

/** Every path pattern any hashFiles(...) call in the key names, in order; a key with no call is a constant and fails here. */
function hashFilesPatterns(key: string): string[] {
  const calls = [...key.matchAll(/hashFiles\(([^)]*)\)/g)];
  expect(calls.length, `cache key has no hashFiles call: ${key}`).toBeGreaterThan(0);
  return calls.flatMap((call) =>
    (call[1] ?? "")
      .split(",")
      .map((arg) => arg.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
}

/**
 * The repository .ts files `file` imports. Single-line static imports and literal `import()`/`require()` calls are recognized; any other
 * import-ish line fails, so an unsupported form extends this parser instead of being skipped.
 */
function relativeImportsOf(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    const openers = [...line.matchAll(/\b(?:import|require)\s*\(/g)].length;
    if (openers === 0 && !/^\s*import[\s{"]/.test(line)) {
      continue;
    }
    // Every call on the line is read and must close on it with a quoted literal; a call left open (a multiline argument) or a
    // non-literal argument is the unsupported form.
    const calls = [...line.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)];
    const found =
      openers > 0
        ? calls.length === openers
          ? calls.map((call) => (call[1] ?? "").trim().match(/^(["'])([^"']+)\1$/)?.[2] ?? null)
          : [null]
        : [line.match(/^import [^"]*from "([^"]+)";$/)?.[1] ?? null];
    expect(
      found.every((spec) => spec !== null),
      `unrecognized import form in ${file}: "${line.trim()}" - teach relativeImportsOf() to parse it`,
    ).toBe(true);
    specifiers.push(...found.map((spec) => spec ?? ""));
  }
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) =>
      relative(ROOT, resolve(ROOT, file, "..", spec))
        .split("\\")
        .join("/")
        .replace(/\.js$/, ".ts"),
    );
}

/** True when a file is named by the pattern list, directly or via a ** glob. */
function covered(patterns: string[], file: string): boolean {
  if (patterns.includes(file)) {
    return true;
  }
  return patterns.some(
    (pattern) => pattern.endsWith("/**") && file.startsWith(pattern.slice(0, -2)),
  );
}

/** The key's hashFiles list names at least one pattern and covers every input the artifact depends on. */
function expectKeyHashesInputs(key: string, artifact: FetchedArtifact): void {
  const patterns = hashFilesPatterns(key);
  expect(patterns.length, `the ${artifact.label} cache key hashes nothing: ${key}`).toBeGreaterThan(
    0,
  );
  for (const file of artifact.hashInputs()) {
    expect(
      covered(patterns, file),
      `${file} changes the ${artifact.label} but its cache key does not hash it`,
    ).toBe(true);
  }
}

describe("the fetch-test-artifacts cache keys", () => {
  const keyOf = (artifact: FetchedArtifact) =>
    cacheKeyOf(cacheStepFor(artifact.path), artifact.path);

  test("each key hashes every input its artifact depends on", () => {
    // The import walk found the scripts' own imports, so the coverage below is not vacuous.
    expect(OPENAPI.hashInputs().length).toBeGreaterThan(2);
    expect(OPENAPI.hashInputs()).toEqual(
      expect.arrayContaining(["src/github/api.ts", ".github/scripts/lib/fetch-retry.ts"]),
    );
    expect(GRAPHQL.hashInputs()).toContain(".github/scripts/lib/fetch-retry.ts");
    // Every call in the key contributes, wherever the expression puts it.
    expect(
      hashFilesPatterns(
        `k-\${{ format('{0}', hashFiles('a.ts', 'b/**')) }}-\${{ hashFiles('c.ts') }}`,
      ),
    ).toEqual(["a.ts", "b/**", "c.ts"]);
    for (const artifact of FETCHED_ARTIFACTS) {
      expectKeyHashesInputs(keyOf(artifact), artifact);
    }
  });

  /** A GraphQL schema key whose expression is `call`. */
  const keyed = (call: string) => `graphql-schema-\${{ ${call} }}`;

  test.each<[string, string, RegExp]>([
    ["a key hashing nothing", keyed("hashFiles()"), /GraphQL schema cache key hashes nothing/],
    [
      "a key hashing an unrelated file",
      keyed("hashFiles('package.json')"),
      /fetch-graphql-schema\.ts changes the GraphQL schema but its cache key does not hash it/,
    ],
    ["a key without hashFiles", "graphql-schema-v1", /cache key has no hashFiles call/],
  ])("%s fails the guard (negative control)", (_, key, message) => {
    expect(() => expectKeyHashesInputs(key, GRAPHQL)).toThrow(message);
  });

  test("every hashFiles pattern of every key matches at least one file on disk", () => {
    // hashFiles() silently skips a pattern that matches nothing (a moved input), so the key would stop changing with it while the coverage test still
    // sees the stale pattern string.
    for (const artifact of FETCHED_ARTIFACTS) {
      for (const pattern of hashFilesPatterns(keyOf(artifact))) {
        // dot: true because the scripts live under .github/, which the glob scanner skips by default (hashFiles itself does not).
        const matches = [...new Bun.Glob(pattern).scanSync({ cwd: ROOT, dot: true })];
        expect(
          matches.length,
          `hashFiles pattern '${pattern}' matches no file on disk, so it contributes nothing to the cache key`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

/** The guard: one anchor-check step, its job gated on the constant, and no job or step condition spelling it otherwise. */
function expectReleasePrefixes(wf: Workflow): void {
  const anchorStepJobs = Object.values(wf.jobs).flatMap((job) =>
    (job.steps ?? [])
      .filter((step) => (step.run ?? "").includes("release-pipeline.ts anchor-check"))
      .map(() => job),
  );
  expect(anchorStepJobs.length, "checks.yml must run anchor-check in exactly one step").toBe(1);
  expect(headRefPrefixesIn(anchorStepJobs[0]?.if)).toEqual([RELEASE_PR_BRANCH_PREFIX]);
  for (const literal of headRefPrefixes(wf)) {
    expect(literal).toBe(RELEASE_PR_BRANCH_PREFIX);
  }
}

describe("checks.yml release PR branch spelling", () => {
  const text = workflowText("checks.yml");

  // Workflows cannot import the constant, so the head_ref conditions spell it by hand; a drifted spelling skips the anchor-check on every release PR
  // instead of failing there.
  test("the anchor-check step is gated on RELEASE_PR_BRANCH_PREFIX and nothing spells it otherwise", () => {
    expectReleasePrefixes(parseYaml(text) as Workflow);
  });

  test("a drifted spelling fails the guard (negative control)", () => {
    const drifted = text.replaceAll(`'${RELEASE_PR_BRANCH_PREFIX}'`, "'release-pls--'");
    expect(() => expectReleasePrefixes(parseYaml(drifted) as Workflow)).toThrow();
  });

  test("a missing anchor-check step fails the guard (negative control)", () => {
    const wf = parseYaml(text) as Workflow;
    for (const job of Object.values(wf.jobs)) {
      job.steps = job.steps?.filter((step) => !(step.run ?? "").includes("anchor-check"));
    }
    expect(() => expectReleasePrefixes(wf)).toThrow();
  });
});

describe("headRefPrefixes", () => {
  test("collects job- and step-level literals in order and none where no condition tests head_ref", () => {
    const wf = {
      jobs: {
        gate: {
          if: "github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
          steps: [
            { if: 'startsWith(github.head_ref, "feature/")' },
            { if: "startsWith ( github . head_ref ,\n  'hotfix/' )" },
            { if: "github.actor != 'dependabot[bot]'" },
            {},
          ],
        },
        plain: { steps: [{}] },
        bare: {},
      },
    };
    expect(headRefPrefixes(wf)).toEqual(["release-please--", "feature/", "hotfix/"]);
    expect(headRefPrefixes({ jobs: {} })).toEqual([]);
  });
});

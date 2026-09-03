/**
 * Workflow contract for the fetched, gitignored test artifacts: one cache key per artifact
 * across every workflow, hashing every input, and restored plus fetched before any unit-suite run.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { RELEASE_PR_BRANCH_PREFIX } from "../../.github/scripts/release-pipeline.js";
import { headRefPrefixes, headRefPrefixesIn } from "./head-ref.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const PATHS_TS = "test/e2e/openapi/paths.ts";

interface FetchedArtifact {
  label: string;
  path: string;
  fetchScript: string;
}
const FETCHED_ARTIFACTS: readonly FetchedArtifact[] = [
  {
    label: "trimmed OpenAPI spec",
    path: "test/e2e/openapi/github-openapi.trimmed.json",
    fetchScript: ".github/scripts/trim-openapi.ts",
  },
  {
    label: "GraphQL schema",
    path: "test/e2e/graphql/schema.docs.graphql",
    fetchScript: ".github/scripts/fetch-graphql-schema.ts",
  },
];
const [OPENAPI, GRAPHQL] = FETCHED_ARTIFACTS as [FetchedArtifact, FetchedArtifact];

const PACKAGE_SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** Ends a `bun ...` token: the e2e runner (`bun test/e2e/run.ts`) and `test:e2e` continue past it. */
const TOKEN_END = "(?![\\w/:.-])";
/** The runner itself, anywhere in the step; a file filter after it still loads what it names. */
const BUN_TEST = new RegExp(`\\bbun test${TOKEN_END}`);
/** Never matches: the alternative for an empty script set. */
const NOTHING = /(?!)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runsScript(names: readonly string[]): RegExp {
  if (names.length === 0) {
    return NOTHING;
  }
  return new RegExp(`\\bbun run (?:${names.map(escapeRegExp).join("|")})${TOKEN_END}`);
}

/** The whole run scalar is the plain fetch command; anything wrapping, quoting, or commenting it is not a fetch. */
function isFetchCommand(run: string | undefined, fetchScript: string): boolean {
  return (run ?? "").trim() === `bun ${fetchScript}`;
}

/** package.json scripts running `bun test`, directly or via `bun run <such script>`; a new alias needs no edit here. */
function suiteScripts(): string[] {
  const names: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, command] of Object.entries(PACKAGE_SCRIPTS)) {
      if (names.includes(name)) {
        continue;
      }
      if (BUN_TEST.test(command) || runsScript(names).test(command)) {
        names.push(name);
        grew = true;
      }
    }
  }
  return names;
}

/** A run step that executes the unit suite, directly or through a package script. */
const SUITE_RUN = new RegExp(`${BUN_TEST.source}|${runsScript(suiteScripts()).source}`);

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { if?: string; steps?: Step[] }>;
}

/** An actions/cache step whose `path` (one path per line) lists the artifact; found by path, so a renamed key stays visible. */
function cachesArtifact(step: Step, path: string): boolean {
  const paths = String(step.with?.path ?? "")
    .split("\n")
    .map((line) => line.trim());
  return (step.uses ?? "").startsWith("actions/cache") && paths.includes(path);
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

/** Every actions/cache key in the workflow for the artifact path. */
function cacheKeys(wf: Workflow, path: string): string[] {
  return Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => cachesArtifact(step, path))
    .map((step) => cacheKeyOf(step, path));
}

function readWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, file), "utf8")) as Workflow;
}

/** The quoted file patterns inside the key's hashFiles(...) call. */
function hashFilesPatterns(key: string): string[] {
  const match = key.match(/hashFiles\(([^)]*)\)/);
  expect(match, `cache key has no hashFiles call: ${key}`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((arg) => arg.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

/**
 * The repo-relative .ts files paths.ts imports route data from (its relative
 * imports, with the compiled .js specifiers mapped back to source). Only
 * single-line static `import ... from "..."` statements are recognized; any
 * other import-ish line (dynamic import(), require, a reformatted multi-line
 * import) fails the assertion below, so an unsupported form extends this
 * parser instead of being silently skipped.
 */
function routeDataImports(): string[] {
  const source = readFileSync(join(ROOT, PATHS_TS), "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    if (!/\bimport\b|\brequire\(/.test(line)) {
      continue;
    }
    const match = line.match(/^import [^"]*from "([^"]+)";$/);
    expect(
      match,
      `unrecognized import form in ${PATHS_TS}: "${line.trim()}" - teach routeDataImports() to parse it`,
    ).not.toBeNull();
    specifiers.push(match?.[1] ?? "");
  }
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) =>
      relative(ROOT, resolve(ROOT, PATHS_TS, "..", spec))
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

describe("checks.yml openapi-trimmed cache keys", () => {
  const wf = readWorkflow("checks.yml");
  const keys = cacheKeys(wf, OPENAPI.path);

  test("all consuming jobs cache the spec under byte-identical keys", () => {
    // The count is pinned on purpose: a new job consuming the spec is a
    // conscious edit here, and a removed cache step cannot go unnoticed.
    expect(
      keys.length,
      `checks.yml carries ${keys.length} openapi-trimmed cache keys, expected 3 (check, e2e-smoke, endpoint-coverage); update this pin when a consuming job is added or removed`,
    ).toBe(3);
    for (const key of keys) {
      expect(key, "the openapi-trimmed cache keys in checks.yml diverged").toBe(keys[0] as string);
    }
  });

  test("the hashFiles list covers every route-data input of the spec", () => {
    const patterns = hashFilesPatterns(keys[0] ?? "");
    const inputs = [".github/scripts/trim-openapi.ts", PATHS_TS, ...routeDataImports()];
    expect(inputs).toContain("src/report/issue-report.ts");
    expect(patterns).toContain("src/sections/**");
    for (const file of inputs) {
      expect(
        covered(patterns, file),
        `${file} feeds USED_PATHS but the cache key does not hash it`,
      ).toBe(true);
    }
  });

  test("every hashFiles pattern matches at least one file on disk", () => {
    // hashFiles() silently skips a pattern that matches nothing (a moved or
    // renamed input), so the key would stop changing with that input while
    // the coverage test above still sees the stale pattern string.
    for (const pattern of hashFilesPatterns(keys[0] ?? "")) {
      // dot: true because the trim script lives under .github/, which the
      // glob scanner skips by default (hashFiles itself does not).
      const matches = [...new Bun.Glob(pattern).scanSync({ cwd: ROOT, dot: true })];
      expect(
        matches.length,
        `hashFiles pattern '${pattern}' matches no file on disk, so it contributes nothing to the cache key`,
      ).toBeGreaterThan(0);
    }
  });
});

/** `<workflow file>#<job id>` for every job whose steps run the unit suite. */
function suiteRunningJobs(file: string, wf: Workflow): string[] {
  return Object.entries(wf.jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => SUITE_RUN.test(step.run ?? "")))
    .map(([id]) => `${file}#${id}`);
}

/** Per artifact: cache of its path under checks.yml's key, then its fetch gated on that cache's miss, then the suite. */
function expectArtifactsBeforeSuite(
  where: string,
  steps: Step[],
  referenceKeys: ReadonlyMap<string, string>,
): void {
  const suiteIdx = steps.findIndex((step) => SUITE_RUN.test(step.run ?? ""));
  for (const { label, path, fetchScript } of FETCHED_ARTIFACTS) {
    const cacheIdx = steps.findIndex((step) => cachesArtifact(step, path));
    const fetchIdx = steps.findIndex((step) => isFetchCommand(step.run, fetchScript));
    expect(
      cacheIdx,
      `${where} runs the test suite without an actions/cache step for the ${label} (path ${path})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      fetchIdx,
      `${where} runs the test suite without a plain, failure-propagating fetch of the ${label} first (bun ${fetchScript})`,
    ).toBeGreaterThanOrEqual(0);
    expect(fetchIdx, `${where}: the ${label} fetch must follow its cache restore`).toBeGreaterThan(
      cacheIdx,
    );
    expect(suiteIdx, `${where}: the ${label} fetch must precede the test suite`).toBeGreaterThan(
      fetchIdx,
    );
    const cache = steps[cacheIdx] as Step;
    const reference = referenceKeys.get(path);
    expect(reference, `no reference key for ${path}`).toBeDefined();
    expect(
      cacheKeyOf(cache, path),
      `${where}: the ${label} cache key diverged from checks.yml's`,
    ).toBe(reference as string);
    expect(
      steps[fetchIdx]?.if,
      `${where}: the ${label} fetch must run exactly on a miss of its cache step`,
    ).toBe(`steps.${cache.id}.outputs.cache-hit != 'true'`);
    expect(
      steps[fetchIdx]?.["continue-on-error"],
      `${where}: a failed ${label} fetch must fail the job`,
    ).toBeUndefined();
  }
}

describe("fetched test artifacts across workflows", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  const workflows = files.map((file) => ({ file, wf: readWorkflow(file) }));
  // checks.yml's check job is the reference spelling of both keys.
  const checks = readWorkflow("checks.yml");
  const referenceKeys = new Map(
    FETCHED_ARTIFACTS.map(({ path }) => {
      const key = cacheKeys(checks, path)[0];
      expect(key, `checks.yml no longer caches ${path}`).toBeDefined();
      return [path, key as string];
    }),
  );

  test("the suite scripts are test and check", () => {
    expect(suiteScripts().sort()).toEqual(["check", "test"]);
  });

  test.each([
    ["bun test", true],
    ["bun run test", true],
    ["bun run check", true],
    ["bun test test/docs/checks-workflow.test.ts", true],
    ["bun test/e2e/run.ts", false],
    ["bun run test:e2e", false],
    ["bun run typecheck --pretty false", false],
    ["bun run build:check", false],
    ["timeout 50m bun test/e2e/fuzz.ts --seed 1", false],
  ])("SUITE_RUN on %j is %p", (command, matches) => {
    expect(SUITE_RUN.test(command)).toBe(matches);
  });

  test("exactly the pinned jobs run the unit suite", () => {
    // Pinned: a pattern that silently stops matching would pass the guard vacuously.
    const found = workflows.flatMap(({ file, wf }) => suiteRunningJobs(file, wf));
    expect(found.sort()).toEqual(["checks.yml#check", "nightly.yml#float-canary"]);
  });

  test("every suite-running job caches and fetches both artifacts first, under checks.yml's keys", () => {
    for (const { file, wf } of workflows) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        if ((job.steps ?? []).some((step) => SUITE_RUN.test(step.run ?? ""))) {
          expectArtifactsBeforeSuite(`${file}#${id}`, job.steps ?? [], referenceKeys);
        }
      }
    }
  });

  test("every cache of an artifact path, in any workflow, spells checks.yml's key", () => {
    // The e2e jobs cache the spec without running the suite; a second spelling is a second cache.
    for (const { file, wf } of workflows) {
      for (const { path } of FETCHED_ARTIFACTS) {
        for (const key of cacheKeys(wf, path)) {
          expect(key, `${file}: the cache key for ${path} diverged from checks.yml's`).toBe(
            referenceKeys.get(path) as string,
          );
        }
      }
    }
  });

  const canary = () => readWorkflow("nightly.yml").jobs["float-canary"]?.steps ?? [];
  const fetches = (step: Step, { fetchScript }: FetchedArtifact) =>
    isFetchCommand(step.run, fetchScript);
  const onCache = (steps: Step[], { path }: FetchedArtifact, patch: (step: Step) => Step) =>
    steps.map((step) => (cachesArtifact(step, path) ? patch(step) : step));
  const onFetch = (steps: Step[], artifact: FetchedArtifact, patch: (step: Step) => Step) =>
    steps.map((step) => (fetches(step, artifact) ? patch(step) : step));
  /** Rewrites of a fetch step's run text that keep the command but stop it running or mask its failure. */
  const INVALID_FETCH_RUNS: Array<[string, (run: string) => string]> = [
    ["a fetch commented out", (run) => `# ${run}`],
    ["a fetch short-circuited behind a separator", (run) => `true || ${run}`],
    ["a fetch quoted in an echo", (run) => `echo "; ${run}"`],
    ["a fetch inside a heredoc body", (run) => `cat <<'EOF'\n${run}\nEOF`],
    ["a fetch with its failure masked", (run) => `${run} || true`],
  ];

  test("a multiline path list naming the artifact is still its cache step (positive control)", () => {
    const steps = onCache(canary(), OPENAPI, (step) => ({
      ...step,
      with: { ...step.with, path: `other/file.json\n${OPENAPI.path}\n` },
    }));
    expect(() =>
      expectArtifactsBeforeSuite("nightly.yml#float-canary", steps, referenceKeys),
    ).not.toThrow();
  });

  test.each<[string, (steps: Step[]) => Step[], RegExp]>([
    [
      "a dropped fetch step",
      (steps) => steps.filter((step) => !fetches(step, GRAPHQL)),
      /nightly\.yml#float-canary runs the test suite without a plain, failure-propagating fetch of the GraphQL schema/,
    ],
    [
      "a dropped cache step",
      (steps) => steps.filter((step) => !cachesArtifact(step, OPENAPI.path)),
      /without an actions\/cache step for the trimmed OpenAPI spec/,
    ],
    [
      "a cache of the wrong path",
      (steps) =>
        onCache(steps, OPENAPI, (step) => ({
          ...step,
          with: { ...step.with, path: "test/e2e/openapi/other.json" },
        })),
      /without an actions\/cache step for the trimmed OpenAPI spec/,
    ],
    [
      "a fetch moved after the suite",
      (steps) => {
        const [fetch] = steps.splice(
          steps.findIndex((step) => fetches(step, OPENAPI)),
          1,
        );
        return [...steps, fetch as Step];
      },
      /fetch must precede the test suite/,
    ],
    [
      "a drifted key",
      (steps) =>
        onCache(steps, GRAPHQL, (step) => ({
          ...step,
          with: { ...step.with, key: `${step.with?.key}-v2` },
        })),
      /GraphQL schema cache key diverged/,
    ],
    [
      "a non-string key under the right path",
      (steps) => onCache(steps, GRAPHQL, (step) => ({ ...step, with: { ...step.with, key: 42 } })),
      /cache step for test\/e2e\/graphql\/schema\.docs\.graphql has a non-string key: 42/,
    ],
    [
      "a renamed key under the right path",
      (steps) =>
        onCache(steps, OPENAPI, (step) => ({
          ...step,
          with: {
            ...step.with,
            key: String(step.with?.key).replace("openapi-trimmed-", "openapi-spec-"),
          },
        })),
      /trimmed OpenAPI spec cache key diverged/,
    ],
    ...INVALID_FETCH_RUNS.map(([name, rewrite]): [string, (steps: Step[]) => Step[], RegExp] => [
      name,
      (steps) => onFetch(steps, OPENAPI, (step) => ({ ...step, run: rewrite(step.run ?? "") })),
      /without a plain, failure-propagating fetch of the trimmed OpenAPI spec first/,
    ]),
    [
      "a fetch switched off",
      (steps) => onFetch(steps, OPENAPI, (step) => ({ ...step, if: "false" })),
      /fetch must run exactly on a miss of its cache step/,
    ],
    [
      "a fetch allowed to fail",
      (steps) => onFetch(steps, GRAPHQL, (step) => ({ ...step, "continue-on-error": true })),
      /a failed GraphQL schema fetch must fail the job/,
    ],
  ])("%s fails the guard naming the job (negative control)", (_, mutate, message) => {
    expect(() =>
      expectArtifactsBeforeSuite("nightly.yml#float-canary", mutate(canary()), referenceKeys),
    ).toThrow(message);
  });
});

/** The guard: one anchor-check step gated on the constant, and no job or step condition spelling it otherwise. */
function expectReleasePrefixes(wf: Workflow): void {
  const anchorSteps = Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.run ?? "").includes("release-pipeline.ts anchor-check"));
  expect(anchorSteps.length, "checks.yml lost its anchor-check step").toBe(1);
  expect(headRefPrefixesIn(anchorSteps[0]?.if)).toEqual([RELEASE_PR_BRANCH_PREFIX]);
  for (const literal of headRefPrefixes(wf)) {
    expect(literal).toBe(RELEASE_PR_BRANCH_PREFIX);
  }
}

describe("checks.yml release PR branch spelling", () => {
  const text = readFileSync(join(WORKFLOWS_DIR, "checks.yml"), "utf8");

  // Workflows cannot import the constant, so the head_ref conditions spell
  // it by hand; a drifted spelling skips the anchor-check on every release
  // PR instead of failing there.
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

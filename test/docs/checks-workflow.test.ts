/**
 * checks.yml and the fetch-test-artifacts composite against the code they run: a cache key that hashes every input its artifact depends on
 * (a stale restore would test against yesterday's spec with no failure anywhere), and head_ref conditions that spell the release PR
 * branch prefix the pipeline script owns (a drifted spelling skips the anchor-check on every release PR instead of failing there).
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
    // The imports under src/ and test/ decide which paths and which API version are trimmed; the script's own lib/ helpers only carry the fetch.
    hashInputs: () => [
      TRIM_TS,
      PATHS_TS,
      ...[...relativeImportsOf(TRIM_TS), ...relativeImportsOf(PATHS_TS)].filter((file) =>
        /^(?:src|test)\//.test(file),
      ),
    ],
  },
  {
    // The fetch script carries the pinned UPSTREAM_REF, the sole input that changes the output.
    label: "GraphQL schema",
    path: "test/e2e/graphql/schema.docs.graphql",
    hashInputs: () => [".github/scripts/fetch-graphql-schema.ts"],
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

/** The bodies of the key's `${{ }}` expressions, read as GitHub's lexer does: a `}}` inside a single-quoted string closes nothing. */
function expressionsOf(key: string): string[] {
  const bodies: string[] = [];
  for (let at = key.indexOf("${{"); at !== -1; at = key.indexOf("${{", at)) {
    let end = at + 3;
    let quoted = false;
    for (; end < key.length; end++) {
      if (key[end] === "'") {
        quoted = !quoted; // a doubled quote inside a string toggles twice and stays quoted
      } else if (!quoted && key.startsWith("}}", end)) {
        break;
      }
    }
    expect(end < key.length, `unterminated expression in cache key: ${key}`).toBe(true);
    bodies.push(key.slice(at + 3, end));
    at = end + 2;
  }
  return bodies;
}

/**
 * The quoted file patterns of the key's hashFiles(...) call. The call must BE the `${{ }}` expression, bare or as the one argument of a
 * literal format(): any other expression around it (`false && hashFiles(...) || 'v1'`) can leave the key constant while the call still
 * reads as present, and outside `${{ }}` the call is literal text.
 */
function hashFilesPatterns(key: string): string[] {
  const HASH_CALL = String.raw`hashFiles\(([^)]*)\)`;
  const WHOLE = new RegExp(
    String.raw`^\s*(?:${HASH_CALL}|format\(\s*'[^']*\{0\}[^']*'\s*,\s*${HASH_CALL}\s*\))\s*$`,
  );
  const match =
    expressionsOf(key)
      .map((body) => body.match(WHOLE))
      .map((m) => (m ? [m[0], m[1] ?? m[2] ?? ""] : null))
      .find((m) => m) ?? null;
  expect(match, `cache key has no expression that is a hashFiles call: ${key}`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((arg) => arg.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

/**
 * The repository .ts files `file` imports. Single-line static imports and literal `import()`/`require()` calls are recognized; any other
 * import-ish line fails, so an unsupported form extends this parser instead of being skipped.
 */
function relativeImportsOf(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    const call = /\b(?:import|require)\s*\(/.test(line);
    if (!call && !/^\s*import[\s{"]/.test(line)) {
      continue;
    }
    const match = call
      ? (line.match(/\b(?:import|require)\s*\(\s*(["'])([^"']+)\1\s*\)/)?.slice(1) ?? null)
      : line.match(/^import [^"]*from "([^"]+)";$/);
    expect(
      match,
      `unrecognized import form in ${file}: "${line.trim()}" - teach relativeImportsOf() to parse it`,
    ).not.toBeNull();
    specifiers.push(match?.[1] ?? "");
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
    expect(OPENAPI.hashInputs()).toContain("src/github/api.ts");
    // The call is read wherever the expression puts it, a format() wrapper included.
    expect(hashFilesPatterns(`k-\${{ format('{0}', hashFiles('a.ts', 'b/**')) }}`)).toEqual([
      "a.ts",
      "b/**",
    ]);
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
    ["a key without hashFiles", "graphql-schema-v1", /no expression that is a hashFiles call/],
    [
      "a hashFiles call outside the expression delimiters",
      "graphql-schema-hashFiles('.github/scripts/fetch-graphql-schema.ts')",
      /no expression that is a hashFiles call/,
    ],
    [
      "a hashFiles call short-circuited inside the expression",
      keyed("false && hashFiles('.github/scripts/fetch-graphql-schema.ts') || 'v1'"),
      /no expression that is a hashFiles call/,
    ],
    [
      "a hashFiles call spelled inside a string literal with its own fake delimiters",
      keyed(`'}}\${{ hashFiles('.github/scripts/fetch-graphql-schema.ts') }}'`),
      /no expression that is a hashFiles call/,
    ],
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

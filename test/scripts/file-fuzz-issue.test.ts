import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBody,
  capChars,
  failureDirs,
  fileIssue,
  type GhRunner,
  head,
  issueNumberFromUrl,
  runUrl,
} from "../../.github/scripts/file-fuzz-issue.js";
import {
  genDiscoveryScenario,
  genMergeScenario,
  genMultiScenario,
  genScenario,
} from "../e2e/generators.js";
import { Rng } from "../e2e/prng.js";
import { insertReplay } from "../e2e/runner.js";

describe("head", () => {
  test("returns the text unchanged when under the limit", () => {
    expect(head("a\nb\nc", 5)).toBe("a\nb\nc");
  });

  test("truncates and names how many lines were cut", () => {
    expect(head(["1", "2", "3", "4", "5"].join("\n"), 2)).toBe("1\n2\n... (3 more lines)");
  });

  test("trims trailing whitespace when under the limit", () => {
    expect(head("a\n\n", 5)).toBe("a");
  });

  test("a single trailing newline is not counted as an extra line", () => {
    // Exactly `limit` lines plus a trailing newline must not report "1 more lines" for the empty trailing split element.
    const text = `${["1", "2", "3"].join("\n")}\n`;
    expect(head(text, 3)).toBe("1\n2\n3");
  });
});

describe("capChars", () => {
  test("returns the text unchanged when within the cap", () => {
    expect(capChars("short", 100)).toBe("short");
  });

  test("truncates a long single line to at most `max` characters", () => {
    const out = capChars("x".repeat(1000), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("... (truncated)")).toBe(true);
  });
});

describe("runUrl", () => {
  test("builds the Actions run URL from the standard env vars", () => {
    expect(
      runUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "12345",
      } as NodeJS.ProcessEnv),
    ).toBe("https://github.com/o/r/actions/runs/12345");
  });

  test("returns empty when any component is missing", () => {
    expect(runUrl({ GITHUB_SERVER_URL: "https://github.com" } as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("buildBody", () => {
  let root: string;
  const env = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "42",
  } as NodeJS.ProcessEnv;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artifacts-"));
    const corpus = join(root, "labels-drift-100-0");
    mkdirSync(corpus, { recursive: true });
    writeFileSync(
      join(corpus, "report.md"),
      "# labels-drift\n\n## Failures\n\n- exit code 1 != 0\n",
    );
    writeFileSync(join(corpus, "scenario.yml"), "name: labels-drift\nsettings:\n  labels: []\n");
    const fuzz = join(root, "fuzz-314159-0");
    mkdirSync(fuzz, { recursive: true });
    writeFileSync(join(fuzz, "report.md"), "# fuzz-314159\n\niter 7 FAIL\n");
    writeFileSync(join(fuzz, "scenario.yml"), "name: fuzz-314159\nsettings: {}\n");
    insertReplay(fuzz, "bun test/e2e/fuzz.ts --seed 314159 --iterations 1");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a corpus failure gets a run.ts replay, not an empty-seed fuzz command", () => {
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("## labels-drift");
    expect(body).toContain("bun test/e2e/run.ts --scenario labels-drift");
    expect(body).not.toContain("--seed undefined");
    expect(body).not.toContain("--seed \n");
  });

  test("every fuzz family replays with the command its run wrote, never one derived from the name", () => {
    const seed = 314159;
    const master = 271828;
    const iteration = (name: string, sections?: string): [string, string] => [
      name,
      `bun test/e2e/fuzz.ts --seed ${seed} --iterations 1${sections ? ` --sections ${sections}` : ""}`,
    ];
    // Only the standard and merge modes draw from --sections, so only their replays carry it (fuzz.ts main()).
    const cases: Array<[name: string, replay: string]> = [
      iteration(genScenario(new Rng(seed)).scenario.name, "labels,actions"),
      iteration(genMultiScenario(new Rng(seed)).scenario.name),
      iteration(genDiscoveryScenario(new Rng(seed)).scenario.name),
      iteration(genMergeScenario(new Rng(seed)).scenario.name, "rulesets"),
      // A battery entry replays the whole battery under the master seed; the seed in its name is never a replay.
      [
        `fuzz-witness-labels-drift-apply-${seed}`,
        `bun test/e2e/fuzz.ts --seed ${master} --iterations 0`,
      ],
    ];
    const familyRoot = mkdtempSync(join(tmpdir(), "families-"));
    try {
      for (const [name, replay] of cases) {
        const dir = join(familyRoot, `${name}-0`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.md"), `# ${name}\n\n## Failures\n\n- exit code 1 != 0\n`);
        writeFileSync(join(dir, "scenario.yml"), `name: ${name}\nsettings: {}\n`);
        insertReplay(dir, replay);
      }
      const body = buildBody(failureDirs(familyRoot), env);
      const commands = body.split("\n").filter((line) => line.startsWith("bun test/e2e/"));
      expect(commands.sort()).toEqual(cases.map(([, replay]) => replay).sort());
      for (const [name] of cases) {
        expect(body).toContain(`## ${name}`);
      }
    } finally {
      rmSync(familyRoot, { recursive: true, force: true });
    }
  });

  test("a replay block past the report head window still lands, once, right under the title", () => {
    const deepRoot = mkdtempSync(join(tmpdir(), "deep-"));
    try {
      const dir = join(deepRoot, "fuzz-chaos-single-7-0");
      mkdirSync(dir, { recursive: true });
      const failures = Array.from({ length: 70 }, (_, i) => `- failure ${i}`);
      const report = [
        "# fuzz-chaos-single-7",
        "",
        "## Failures",
        "",
        ...failures,
        "",
        "## Replay",
        "",
        "```sh",
        "bun test/e2e/fuzz.ts --seed 7 --iterations 1",
        "```",
        "",
        "Exit code: 1",
        "",
      ];
      writeFileSync(join(dir, "report.md"), report.join("\n"));
      const body = buildBody(failureDirs(deepRoot), env);
      const lines = body.split("\n");
      const title = lines.indexOf("## fuzz-chaos-single-7");
      expect(lines.slice(title, title + 8)).toEqual([
        "## fuzz-chaos-single-7",
        "",
        "## Replay",
        "",
        "```sh",
        "bun test/e2e/fuzz.ts --seed 7 --iterations 1",
        "```",
        "",
      ]);
      expect(body.split("## Replay")).toHaveLength(2);
      expect(body).toContain("- failure 0");
      expect(body).not.toContain("Exit code: 1");
    } finally {
      rmSync(deepRoot, { recursive: true, force: true });
    }
  });

  test("a replay heading with no one-command sh block under it fails the filing loudly", () => {
    const badRoot = mkdtempSync(join(tmpdir(), "bad-"));
    try {
      const dir = join(badRoot, "fuzz-9-0");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "report.md"),
        "# fuzz-9\n\n## Replay\n\n```bash\nbun test/e2e/fuzz.ts --seed 9\n```\n",
      );
      expect(() => buildBody(failureDirs(badRoot), env)).toThrow(
        /"## Replay" heading but no ```sh block/,
      );
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });

  test("includes the report, scenario, run link, and artifacts note", () => {
    const body = buildBody(failureDirs(root), env);
    expect(body).toContain("2 failure artifact(s)");
    expect(body).not.toContain("failing scenario(s)");
    expect(body).toContain("- exit code 1 != 0");
    expect(body).toContain("```yaml");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
    expect(body).toContain("e2e-artifacts");
  });

  test("caps the body under the GitHub limit and says how many were omitted", () => {
    const bigRoot = mkdtempSync(join(tmpdir(), "big-"));
    const filler = "x".repeat(5000);
    for (let i = 0; i < 40; i++) {
      const dir = join(bigRoot, `scenario-${i}-0`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.md"), `# scenario-${i}\n\n${filler}\n`);
      writeFileSync(join(dir, "scenario.yml"), `name: scenario-${i}\nbody: ${filler}\n`);
    }
    const body = buildBody(failureDirs(bigRoot), env);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("omitted to stay under the GitHub body limit");
    rmSync(bigRoot, { recursive: true, force: true });
  });

  test("a single giant single-line artifact still produces a body under the limit", () => {
    // One artifact whose report and scenario are each a single 70,000-char line, which line truncation cannot shorten.
    const giantRoot = mkdtempSync(join(tmpdir(), "giant-"));
    const dir = join(giantRoot, "labels-drift-9-0");
    mkdirSync(dir, { recursive: true });
    const giant = "x".repeat(70_000);
    writeFileSync(join(dir, "report.md"), `# labels-drift\n${giant}`);
    writeFileSync(join(dir, "scenario.yml"), `name: labels-drift\nbody: ${giant}`);
    const body = buildBody(failureDirs(giantRoot), env);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("## labels-drift");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
    rmSync(giantRoot, { recursive: true, force: true });
  });

  test("files a bare notice when there are no failing-scenario dirs", () => {
    const body = buildBody([], env);
    expect(body).toContain("no failing-scenario artifact");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
  });
});

describe("fileIssue", () => {
  /** A recording gh runner; `openNumber` set opens the comment path, undefined the create path. */
  function fakeGh(openNumber?: number): { run: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify(openNumber === undefined ? [] : [{ number: openNumber }]);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/o/r/issues/7\n";
      }
      return "";
    };
    return { run, calls };
  }

  const ensureLabel = [
    "label",
    "create",
    "e2e-fuzz",
    "--force",
    "--color",
    "B60205",
    "--description",
    "e2e fuzz failure",
  ];
  const findOpen = [
    "issue",
    "list",
    "--label",
    "e2e-fuzz",
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number",
  ];

  // Assignment policy lives in the auto-assign workflow the nightly dispatches after filing, so neither argv sequence touches assignees.
  test("create path ensures the label, finds no open issue, and opens a labeled issue with the body", async () => {
    const { run, calls } = fakeGh(undefined);
    await fileIssue(run, "body");
    expect(calls).toEqual([
      ensureLabel,
      findOpen,
      [
        "issue",
        "create",
        "--label",
        "e2e-fuzz",
        "--title",
        "e2e fuzz failures (nightly)",
        "--body",
        "body",
      ],
    ]);
  });

  test("comment path ensures the label, then comments on the existing issue without creating one", async () => {
    const { run, calls } = fakeGh(3);
    await fileIssue(run, "body");
    expect(calls).toEqual([ensureLabel, findOpen, ["issue", "comment", "3", "--body", "body"]]);
  });

  test("returns the created issue number (parsed from gh's create URL)", async () => {
    const { run } = fakeGh(undefined);
    expect(await fileIssue(run, "body")).toBe(7);
  });

  test("returns the existing issue number on the comment path", async () => {
    const { run } = fakeGh(3);
    expect(await fileIssue(run, "body")).toBe(3);
  });
});

describe("issueNumberFromUrl", () => {
  test("parses the trailing number from a gh issue URL", () => {
    expect(issueNumberFromUrl("https://github.com/o/r/issues/42\n")).toBe(42);
  });

  test("returns undefined when the URL has no trailing number", () => {
    expect(issueNumberFromUrl("not a url")).toBeUndefined();
  });
});

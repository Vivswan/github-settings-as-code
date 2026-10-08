/**
 * auto-fix.yml's two steps against local fixture repositories: the fix-owned paths pinned to the generated-output
 * table (a security boundary the script keeps literal, so a newly registered output would otherwise slip past it),
 * and the branches each step takes that the workflow text cannot show: what the patch holds, which commit subject
 * a push gets, and which push is refused, skipped, or warned about.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FIX_OWNED_PATHS,
  fixOwned,
  GAPS_DIR,
  GENERATORS,
} from "../../.github/scripts/auto-fix-steps.js";
import {
  generatedPaths,
  generatorEntryPoint,
  generatorScripts,
} from "../../.github/scripts/generated.js";
import { ROOT } from "../root.js";
import {
  clone,
  commitAll,
  type Fixture,
  git,
  installReleasePipelineFixture,
  seedFixture,
  withPushPlans,
  write,
} from "./release-pipeline-fixture.js";
import { runStep } from "./step-fixture.js";

setDefaultTimeout(60_000);
installReleasePipelineFixture();

const workflow = parse(readFileSync(join(ROOT, ".github/workflows/auto-fix.yml"), "utf8")) as {
  on: { pull_request: { paths: string[] } };
};
const packageScripts = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("the fix-owned paths and generators track the generated-output table", () => {
  test("every generated output is fix-owned, every fix-owned entry covers a generated output, and the generators run in table order", () => {
    const paths = generatedPaths();
    for (const path of paths) {
      expect(fixOwned(path), path).toBe(true);
    }
    // The gaps directory is owned for the graduation's deletions, which the generated-output table cannot list.
    for (const entry of FIX_OWNED_PATHS.filter((entry) => entry !== GAPS_DIR)) {
      expect(
        paths.some((path) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)),
        entry,
      ).toBe(true);
    }
    expect(generatorScripts()).toEqual([...GENERATORS]);
  });

  test("a hand edit to a generated output or its generator triggers the fix", () => {
    const files = generatorScripts().map((name) => generatorEntryPoint(packageScripts[name] ?? ""));
    for (const file of files) {
      expect(file).not.toBeNull();
    }
    for (const path of [...generatedPaths(), ...files.map((file) => file ?? "")]) {
      expect(
        workflow.on.pull_request.paths.some((pattern) => new Bun.Glob(pattern).match(path)),
        `on.paths: ${path}`,
      ).toBe(true);
    }
  });
});

const GENERATOR_ENV: Record<(typeof GENERATORS)[number], string> = {
  "build:openapi": "GEN_OPENAPI",
  "build:gaps-index": "GEN_GAPS_INDEX",
  "build:docs": "GEN_DOCS",
  "build:action-docs": "GEN_ACTION_DOCS",
  "build:inputs-table": "GEN_INPUTS_TABLE",
};
const GAP_FILE = "src/upstream-gaps/one.ts";
const GAPS_INDEX = "src/generated/upstream-gaps.ts";
const REMOTE_URL = "https://x-access-token:t0ken@github.com/o/r.git";

/** A same-repo PR branch as both jobs check it out: every fix-owned path tracked, one gap file beside the index,
 * and a package.json whose generator scripts run whatever the matching GEN_* variable says. */
function prFixture(): { fx: Fixture; pr: string; headSha: string; temp: string } {
  const fx = seedFixture();
  const pr = clone(fx.root, fx.origin, "pr");
  for (const path of FIX_OWNED_PATHS) {
    if (!path.endsWith("/")) {
      write(pr, path, `${path}\n`);
    }
  }
  write(pr, GAP_FILE, "export const one = 1;\n");
  write(pr, GAPS_INDEX, "export * from './one.js';\n");
  write(
    pr,
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture",
        version: "0.0.0",
        scripts: Object.fromEntries(
          GENERATORS.map((name) => [name, `sh -c "$${GENERATOR_ENV[name]}"`]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  const headSha = commitAll(pr, "feat: a pull request");
  git(pr, "push", "--quiet", "origin", "HEAD:refs/heads/pr");
  git(pr, "checkout", "--quiet", "-b", "pr");
  // The lease push names github.com; the fixture origin answers in its place.
  git(pr, "config", `url.${fx.origin}.insteadOf`, REMOTE_URL);
  return { fx, pr, headSha, temp: join(fx.root, "runner-temp") };
}

const rebuild = (pr: string, temp: string, env: Record<string, string>) =>
  runStep("auto-fix-steps", pr, temp, env, "rebuild");

function patchPaths(temp: string): string[] {
  return [...readFileSync(join(temp, "autofix.patch"), "utf8").matchAll(/^diff --git a\/(\S+)/gm)]
    .map((match) => match[1] ?? "")
    .sort();
}

describe("rebuild", () => {
  test("generators that change nothing leave an empty patch and changed=false, and an index entry the earlier steps left staged is not the fix", () => {
    const { pr, temp } = prFixture();
    write(pr, "package.json", `${readFileSync(join(pr, "package.json"), "utf8")}\n`);
    git(pr, "add", "package.json");
    const result = rebuild(pr, temp, {});
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("docs and upstream gaps already fresh\n");
    expect(result.outputs).toEqual(["changed=false", "pruned=false"]);
    expect(readFileSync(join(temp, "autofix.patch"), "utf8")).toBe("");
    expect(git(pr, "diff", "--cached", "--name-only")).toBe("");
  });

  test("the generators run in table order and only the fix-owned paths enter the patch; a docs change alone is not a prune", () => {
    const { pr, temp } = prFixture();
    const result = rebuild(
      pr,
      temp,
      Object.fromEntries(
        GENERATORS.map((name) => [
          GENERATOR_ENV[name],
          `echo ${name} >> README.md && echo ${name} >> package.json`,
        ]),
      ),
    );
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual(["changed=true", "pruned=false"]);
    expect(result.stdout).toContain("1 file changed, 5 insertions(+)");
    expect(patchPaths(temp)).toEqual(["README.md"]);
    expect(
      git(pr, "diff", "--cached", "README.md")
        .split("\n")
        .filter((line) => /^\+[^+]/.test(line)),
    ).toEqual(GENERATORS.map((name) => `+${name}`));
  });

  test("a graduated gap file (a deletion under src/upstream-gaps/) is a prune; the index alone regenerated is not", () => {
    const { pr, temp } = prFixture();
    const graduated = rebuild(pr, temp, {
      GEN_GAPS_INDEX: `rm ${GAP_FILE} && echo 'export {};' > ${GAPS_INDEX}`,
    });
    expect(graduated.status).toBe(0);
    expect(graduated.outputs).toEqual(["changed=true", "pruned=true"]);
    expect(patchPaths(temp)).toEqual([GAPS_INDEX, GAP_FILE].sort());
    git(pr, "reset", "--hard", "--quiet");
    const regenerated = rebuild(pr, temp, {
      GEN_GAPS_INDEX: `echo '// regenerated' >> ${GAPS_INDEX}`,
    });
    expect(regenerated.status).toBe(0);
    expect(regenerated.outputs).toEqual(["changed=true", "pruned=false"]);
    expect(patchPaths(temp)).toEqual([GAPS_INDEX]);
  });

  test("a failing generator ends the step with its status before the later generators run or any output is written", () => {
    const { pr, temp } = prFixture();
    const result = rebuild(pr, temp, {
      GEN_DOCS: "exit 3",
      GEN_ACTION_DOCS: "echo ran >> README.md",
    });
    expect(result.status).toBe(3);
    expect(result.outputs).toEqual([]);
    expect(readFileSync(join(pr, "README.md"), "utf8")).toBe("README.md\n");
  });
});

/** The patch the build job would upload for `mutate`'s changes to the PR branch's tree, at the path the push job
 * downloads it to. */
function cutPatch(pr: string, temp: string, mutate: () => void): void {
  mutate();
  git(pr, "add", "-A");
  // Untrimmed: the fixture's git() drops the final newline, which corrupts a patch.
  write(
    join(temp, "autofix"),
    "autofix.patch",
    execFileSync("git", ["diff", "--cached", "--binary"], { cwd: pr, encoding: "utf8" }),
  );
  git(pr, "reset", "--hard", "--quiet");
}

const PUSH_ENV = {
  TOKEN: "t0ken",
  CAN_RETRIGGER: "true",
  HEAD_REF: "pr",
  PRUNED: "false",
  GITHUB_REPOSITORY: "o/r",
};

/** Run from outside the PR clone, as the push job runs it from the trusted checkout. */
const push = (pr: string, temp: string, env: Record<string, string>) =>
  runStep("auto-fix-steps", temp, temp, { ...PUSH_ENV, PR_CHECKOUT: pr, ...env }, "push");

const originTip = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/heads/pr");
const messageOf = (fx: Fixture, sha: string): string =>
  git(fx.origin, "log", "-1", "--format=%B", sha);
const authorOf = (fx: Fixture, sha: string): string =>
  git(fx.origin, "log", "-1", "--format=%an <%ae>", sha);

describe("push", () => {
  test("a checkout that is not the build's head pushes nothing, with a notice", () => {
    const { fx, pr, headSha, temp } = prFixture();
    cutPatch(pr, temp, () => write(pr, "README.md", "fresh\n"));
    const result = push(pr, temp, { HEAD_SHA: fx.mergeSha });
    expect(result).toMatchObject({
      status: 0,
      stdout: "::notice::head moved since the build; skipping the stale fix push\n",
      outputs: [],
    });
    expect(originTip(fx)).toBe(headSha);
    expect(git(pr, "status", "--porcelain")).toBe("");
  });

  test.each([
    [
      "a file outside the fix-owned paths",
      (pr: string) => write(pr, "package.json", "{}\n"),
      "package.json",
    ],
    [
      "a rename out of a protected path behind an allowed destination",
      // Rename detection would list the destination alone, inside src/upstream-gaps/; --no-renames shows the
      // deleted half.
      (pr: string) => git(pr, "mv", "src/marker.ts", "src/upstream-gaps/marker.ts"),
      "src/marker.ts",
    ],
  ])(
    "a patch staging %s is refused naming it, and nothing is committed or pushed",
    (_, mutate, named) => {
      const { fx, pr, headSha, temp } = prFixture();
      cutPatch(pr, temp, () => mutate(pr));
      const result = push(pr, temp, { HEAD_SHA: headSha });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe(
        [
          `::error::the fix patch staged '${named}', outside the generated docs (README.md, action.yml,`,
          "docs/reference/coverage.md, docs/reference/undeclared-policy.md, docs/reference/permissions.md,",
          "docs/operate/check-mode.md, docs/reference/sections.md, docs/reference/inputs.md,",
          "docs/reference/architecture.md, docs/start/getting-started.md, src/generated/spec-enums.ts,",
          "src/generated/spec-roles.ts, src/generated/spec-rules.ts, src/generated/upstream-gaps.ts), and",
          "src/upstream-gaps/; refusing to push\n",
        ].join(" "),
      );
      expect(originTip(fx)).toBe(headSha);
      expect(git(pr, "rev-parse", "HEAD")).toBe(headSha);
    },
  );

  test.each([
    [
      "docs alone",
      () => ({ "docs/reference/inputs.md": "fresh\n" }),
      "false",
      "docs: regenerate generated docs",
    ],
    [
      "the gaps index",
      () => ({ [GAPS_INDEX]: "export {};\n" }),
      "false",
      "build: regenerate generated files",
    ],
    [
      "a graduated gap file",
      () => ({ [GAPS_INDEX]: "export {};\n", [GAP_FILE]: null }),
      "true",
      "fix: graduate upstream gaps octokit now ships",
    ],
  ])(
    "a patch over %s lands on the PR branch as the bot under the matching subject with the Dependabot trailer",
    (_, changes, pruned, subject) => {
      const { fx, pr, headSha, temp } = prFixture();
      cutPatch(pr, temp, () => {
        for (const [path, content] of Object.entries(changes())) {
          if (content === null) {
            git(pr, "rm", "--quiet", path);
          } else {
            write(pr, path, content);
          }
        }
      });
      const result = push(pr, temp, { HEAD_SHA: headSha, PRUNED: pruned });
      expect(result).toMatchObject({ status: 0, outputs: [] });
      expect(result.stdout).not.toContain("::");
      const tip = originTip(fx);
      expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(headSha);
      expect(messageOf(fx, tip)).toBe(`${subject}\n\n[dependabot skip]`);
      expect(authorOf(fx, tip)).toBe(
        "github-actions[bot] <github-actions[bot]@users.noreply.github.com>",
      );
      expect(git(fx.origin, "diff", "--name-only", headSha, tip).split("\n").sort()).toEqual(
        Object.keys(changes()).sort(),
      );
    },
  );

  test("a push with the default token lands and sets notify=true with a warning, since it starts no workflows", () => {
    const { fx, pr, headSha, temp } = prFixture();
    cutPatch(pr, temp, () => write(pr, "README.md", "fresh\n"));
    const result = push(pr, temp, { HEAD_SHA: headSha, CAN_RETRIGGER: "false" });
    expect(result).toMatchObject({ status: 0, outputs: ["notify=true"] });
    expect(result.stdout).toEndWith(
      "::warning::auto-fix pushed without REPO_PLATFORM_TOKEN - checks will not re-run on the new head; close/reopen the PR or register the token\n",
    );
    expect(git(fx.origin, "rev-parse", `${originTip(fx)}^`)).toBe(headSha);
  });

  test("a lease the branch outgrew during the push is a skipped stale fix when the head moved, and a failure when it did not", () => {
    const moved = prFixture();
    cutPatch(moved.pr, moved.temp, () => write(moved.pr, "README.md", "fresh\n"));
    const rival = clone(moved.fx.root, moved.fx.origin, "rival");
    git(rival, "checkout", "--quiet", "pr");
    write(rival, "src/marker.ts", "export const marker = 'rival';\n");
    const rivalSha = commitAll(rival, "feat: the rival push");
    git(rival, "push", "--quiet", "origin", "HEAD:refs/heads/pr");
    const skipped = push(moved.pr, moved.temp, { HEAD_SHA: moved.headSha });
    expect(skipped).toMatchObject({ status: 0, outputs: [] });
    expect(skipped.stdout).toEndWith(
      "::notice::head moved during the push; skipping the stale fix push\n",
    );
    expect(originTip(moved.fx)).toBe(rivalSha);

    const unmoved = prFixture();
    cutPatch(unmoved.pr, unmoved.temp, () => write(unmoved.pr, "README.md", "fresh\n"));
    let failed = { status: -1, stdout: "", outputs: [""] };
    const pushes = withPushPlans(
      unmoved.fx,
      [{ fail: { stderr: "remote: Write access to repository not granted.\n", status: 128 } }],
      () => {
        failed = push(unmoved.pr, unmoved.temp, { HEAD_SHA: unmoved.headSha });
      },
    );
    expect(pushes).toHaveLength(1);
    expect(failed).toMatchObject({ status: 1, outputs: [] });
    expect(failed.stdout).not.toContain("::");
    expect(originTip(unmoved.fx)).toBe(unmoved.headSha);
  });
});

import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";
import { ARTIFACTS_DIR } from "../e2e/constants.js";
import { ROOT } from "../root.js";
import { readWorkflow, type Step, type Workflow, workflowFiles } from "./workflow-loader.js";

const FUZZ_ISSUE_ACTION = "Vivswan/repo-platform/actions/fuzz-issue@stable";

/** The nightlies whose one job runs the checks and files the issue; nightly.yml's report job is judged on its own below. */
const NIGHTLIES: ReadonlyArray<[file: string, job: string]> = [["nightly-fuzz.yml", "fuzz"]];

const filerIn = (steps: Step[], mode: string) =>
  steps.find((s) => s.uses === FUZZ_ISSUE_ACTION && s.with?.mode === mode);

/** A step condition as the runner evaluates it: with or without the `${{ }}` wrapper, whitespace aside. */
const condition = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .trim();

describe.each(NIGHTLIES)("%s failure path", (file, job) => {
  const workflow = readWorkflow(file);
  const steps = workflow.jobs[job]?.steps ?? [];
  const report = filerIn(steps, "report");
  const resolve = filerIn(steps, "resolve");

  test("on failure, the filed issue names the artifact the run uploads, from the directory the runner writes", () => {
    const upload = steps.find((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(report, "no reporting fuzz-issue step").toBeDefined();
    expect(upload, "no upload-artifact step").toBeDefined();
    // A step without a condition runs on success() only, so a dropped `if:` files nothing on the night that fails.
    expect(condition(report?.if)).toBe("failure()");
    expect(condition(upload?.if)).toBe(condition(report?.if));
    // upload-artifact refuses a duplicate name, so a re-run attempt uploads under its own: the name carries the attempt number.
    const name = upload?.with?.name;
    expect(
      typeof name === "string" && /\$\{\{[^}]*\bgithub\.run_attempt\b[^}]*\}\}/.test(name),
      `the upload name ${JSON.stringify(name)} does not vary by run attempt`,
    ).toBe(true);
    expect(report?.with?.["artifact-name"]).toBe(name);
    const dir = String(upload?.with?.path).replace(/\/$/, "");
    expect(report?.with?.["artifacts-dir"]).toBe(dir);
    expect(join(ROOT, dir)).toBe(ARTIFACTS_DIR);
  });

  test("on success, the resolve step closes the label the report step files under", () => {
    expect(resolve, "no resolving fuzz-issue step").toBeDefined();
    expect(condition(resolve?.if)).toBe("success()");
    expect(String(resolve?.with?.label)).toBe(String(report?.with?.label));
  });

  test("the job holds the grant each fuzz-issue step consumes", () => {
    // A missing grant is not loud: the report step runs on an already-red night, so its 403 adds a line to a red job and files no issue.
    const grants = workflow.jobs[job]?.permissions ?? workflow.permissions ?? {};
    const filers = steps.filter((s) => s.uses === FUZZ_ISSUE_ACTION);
    expect(filers.length).toBeGreaterThan(1);
    for (const s of filers) {
      expect(
        grants.issues,
        `${file}#${job}: the ${s.with?.mode} fuzz-issue step needs issues: write`,
      ).toBe("write");
    }
  });
});

/**
 * A job condition over `needs.<job>.result` evaluated the way the runner does, with each job's result substituted; the remaining text is
 * checked to be nothing but string literals and the ==, !=, &&, ||, ! and parenthesis operators before it runs.
 */
function evaluate(raw: unknown, results: Record<string, string>): boolean {
  const expression = condition(raw).replace(/\bneeds\.([\w-]+)\.result\b/g, (_, job: string) => {
    const result = results[job];
    if (result === undefined)
      throw new Error(`the condition reads needs.${job}, which is not in needs`);
    return JSON.stringify(result);
  });
  if (!/^(?:"[a-z]*"|'[a-z]*'|==|!=|&&|\|\||!|[()\s])+$/.test(expression)) {
    throw new Error(`the condition uses more than the evaluator knows: ${expression}`);
  }
  return Boolean(new Function(`return (${expression});`)());
}

describe("nightly.yml report job", () => {
  const workflow = readWorkflow("nightly.yml");
  const report = workflow.jobs.report;
  const steps = report?.steps ?? [];
  const siblings = Object.keys(workflow.jobs).filter((job) => job !== "report");
  const red = filerIn(steps, "report")?.if;
  const green = filerIn(steps, "resolve")?.if;
  const night = (job: string, result: string) =>
    Object.fromEntries(siblings.map((sibling) => [sibling, sibling === job ? result : "success"]));

  test("every sibling job is in its needs, and a sibling that is not green files the issue and does not close it", () => {
    // GitHub enforces neither (docs/nightly.md in the platform repository): a sibling outside `needs` never reaches the report, and a
    // result the conditions do not fold in is a red night the green branch closes, or one that matches neither side and files nothing.
    const needs = report?.needs;
    expect(Array.isArray(needs) ? [...needs].sort() : needs).toEqual([...siblings].sort());
    const verdicts = siblings.flatMap((job) =>
      ["failure", "cancelled", "skipped"].map((result) => ({
        night: `${job} ${result}`,
        files: evaluate(red, night(job, result)),
        closes: evaluate(green, night(job, result)),
      })),
    );
    expect(verdicts).toEqual(
      verdicts.map(({ night: name }) => ({ night: name, files: true, closes: false })),
    );
    expect(evaluate(red, night("", ""))).toBe(false);
    expect(evaluate(green, night("", ""))).toBe(true);
  });
});

test("the nightlies file under distinct labels, so one's green night cannot close the other's issue", () => {
  const labels = [
    ...NIGHTLIES.map(
      ([file, job]) => filerIn(readWorkflow(file).jobs[job]?.steps ?? [], "report")?.with?.label,
    ),
    filerIn(readWorkflow("nightly.yml").jobs.report?.steps ?? [], "report")?.with?.label,
  ];
  // GitHub compares label names without regard to case.
  expect(new Set(labels.map((label) => String(label).toLowerCase())).size).toBe(labels.length);
});

type Workflows = ReadonlyArray<[file: string, workflow: Workflow]>;

const uploadSteps = (workflows: Workflows) =>
  workflows.flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([job, spec]) =>
      (spec.steps ?? [])
        .filter((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"))
        .map((step) => ({ where: `${file}#${job}`, step })),
    ),
  );

/**
 * A path block is one pattern per line, read in its normalized spelling: the guards match on prefixes, so ./test/e2e/x
 * would slip past test/e2e/ otherwise.
 */
const patternsOf = (path: unknown) =>
  String(path ?? "")
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "")
    .map((pattern) => normalize(pattern).replace(/\/$/, ""));

/** upload-artifact skips every item whose basename starts with a dot, the search root included. */
const hasHiddenSegment = (path: unknown) =>
  patternsOf(path)
    .flatMap((pattern) => pattern.split("/"))
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");

/** The uploads that would upload nothing: a hidden path without include-hidden-files: true. */
const emptyHiddenUploads = (workflows: Workflows) =>
  uploadSteps(workflows)
    .filter(
      ({ step }) =>
        hasHiddenSegment(step.with?.path) && String(step.with?.["include-hidden-files"]) !== "true",
    )
    .map(({ where }) => where);

const e2ePatterns = (step: Step) =>
  patternsOf(step.with?.path).filter((pattern) => pattern.startsWith("test/e2e/"));

const driftedE2eUploads = (workflows: Workflows) =>
  uploadSteps(workflows)
    .filter(({ step }) =>
      e2ePatterns(step).some((pattern) => join(ROOT, pattern) !== ARTIFACTS_DIR),
    )
    .map(({ where }) => where);

describe("upload-artifact steps", () => {
  const workflows: Workflows = workflowFiles().map((file) => [file, readWorkflow(file)]);

  // The failure is silent: with if-no-files-found: ignore the step goes green on an empty upload, and the e2e nightlies shipped that
  // way for as long as they existed.
  test("every pattern under test/e2e is the artifacts directory, and every upload of a hidden path includes hidden files", () => {
    const underE2e = uploadSteps(workflows).filter(({ step }) => e2ePatterns(step).length > 0);
    expect(underE2e.length, "no workflow uploads the e2e artifacts directory").toBeGreaterThan(0);
    expect(driftedE2eUploads(workflows)).toEqual([]);
    expect(emptyHiddenUploads(workflows)).toEqual([]);
  });

  test.each<[string, (step: Step) => boolean, (workflows: Workflows) => string[]]>([
    [
      "include-hidden-files omitted",
      (step) => {
        delete step.with?.["include-hidden-files"];
        return hasHiddenSegment(step.with?.path);
      },
      emptyHiddenUploads,
    ],
    [
      "include-hidden-files false",
      (step) => {
        if (step.with) step.with["include-hidden-files"] = false;
        return hasHiddenSegment(step.with?.path);
      },
      emptyHiddenUploads,
    ],
    [
      "a multiline path whose second pattern drifts under test/e2e",
      (step) => {
        if (step.with) step.with.path = "dist/\ntest/e2e/wrong/";
        return true;
      },
      driftedE2eUploads,
    ],
    [
      "a drifted path spelled with a leading ./",
      (step) => {
        if (step.with) step.with.path = "./test/e2e/wrong/";
        return true;
      },
      driftedE2eUploads,
    ],
  ])("%s on every upload fails the guard (negative control)", (_case, mutate, guard) => {
    const mutated: Workflows = workflows.map(([file, workflow]) => [
      file,
      structuredClone(workflow),
    ]);
    const violating = uploadSteps(mutated)
      .filter(({ step }) => mutate(step))
      .map(({ where }) => where);
    expect(violating.length).toBeGreaterThan(0);
    expect(guard(mutated)).toEqual(violating);
  });
});

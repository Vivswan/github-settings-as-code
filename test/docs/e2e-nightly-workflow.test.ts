/**
 * Both nightlies file a failure issue through the fleet's fuzz-issue action, pointing at the artifact the run uploaded, resolve it on the
 * next green night, and dispatch auto-assign.yml with the issue number. The links a rename on one side breaks with no other check noticing:
 * the directory the runner writes, the artifact the issue cites, the conditions the steps run under, the step ids the expressions read, the
 * label the report and the resolve share, and the input names the dispatch passes to a workflow the platform syncs.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ARTIFACTS_DIR } from "../e2e/constants.js";
import { ROOT } from "../root.js";
import { readWorkflow, type Step } from "./workflow-loader.js";

const FUZZ_ISSUE_ACTION = "Vivswan/repo-platform/actions/fuzz-issue@stable";

const NIGHTLIES: ReadonlyArray<[file: string, job: string]> = [
  ["e2e-nightly.yml", "nightly"],
  ["nightly-fuzz.yml", "fuzz"],
];

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

  test("every steps.<id> a step reads names a step that precedes it", () => {
    // An output read from a later step is empty, not an error: a gate on it is quietly false.
    const reads = steps.flatMap((s, index) =>
      [
        s.if ?? "",
        s.run ?? "",
        ...Object.values(s.env ?? {}),
        ...Object.values(s.with ?? {}).map(String),
      ].flatMap((text) =>
        [...text.matchAll(/\bsteps\.([\w-]+)\./g)].map((m) => ({ index, id: m[1] ?? "" })),
      ),
    );
    // The dispatch is gated on the filer's output, so a zero here means the walk went blind, not that the job reads nothing.
    expect(reads.length).toBeGreaterThan(0);
    const unresolved = reads.filter(
      ({ index, id }) => !steps.slice(0, index).some((earlier) => earlier.id === id),
    );
    expect(
      unresolved.map(
        ({ index, id }) => `step ${index + 1} reads steps.${id}, which no earlier step defines`,
      ),
      `${file}#${job}`,
    ).toEqual([]);
  });

  test("the job holds the grant each step consumes", () => {
    // A missing grant is not loud: the fuzz-issue action files nothing, and the dispatch's 403 is swallowed by its `|| echo ::warning`.
    const grants = workflow.jobs[job]?.permissions ?? workflow.permissions ?? {};
    const consumers = steps.flatMap((s) => [
      ...(s.uses === FUZZ_ISSUE_ACTION ? [["issues", `the ${s.with?.mode} fuzz-issue step`]] : []),
      ...(/\bgh workflow run\b/.test(s.run ?? "")
        ? [["actions", "the gh workflow run dispatch"]]
        : []),
    ]);
    expect(consumers.length).toBeGreaterThan(1);
    for (const [scope, why] of consumers) {
      expect(grants[scope as string], `${file}#${job}: ${why} needs ${scope}: write`).toBe("write");
    }
  });

  test("the dispatched issue is the one the report step filed, and only when it filed one", () => {
    const dispatch = steps.find((s) => /\bgh workflow run\b/.test(s.run ?? ""));
    expect(dispatch, "no dispatch step").toBeDefined();
    expect(report?.id, "the report step has no id to read an output from").toBeDefined();
    const output = `steps.${report?.id}.outputs.issue-number`;
    // The field's value is a shell variable the step's env fills from the report step's output.
    const variable =
      (dispatch?.run ?? "").match(/["']?issue=\$\{?([A-Za-z_][\w]*)\}?(?![\w])/)?.[1] ?? "";
    expect(variable, "the issue field is not filled from a $VARIABLE").not.toBe("");
    expect(dispatch?.env?.[variable]).toBe(`\${{ ${output} }}`);
    // Gated on a non-empty number, so the dispatch never expands to a bare `issue=`.
    expect(condition(dispatch?.if)).toBe(`failure() && ${output} != ''`);
  });

  test("every workflow it dispatches declares every input it passes", () => {
    // The dispatch command runs to the next shell separator (continuations joined), so every field on it is read, wherever the other options sit.
    const dispatches = steps.flatMap((s) => [
      ...(s.run ?? "").replace(/\\\n/g, " ").matchAll(/gh workflow run (\S+\.yml)([^;&|\n]*)/g),
    ]);
    expect(dispatches.length, "no gh workflow run dispatch").toBeGreaterThan(0);
    for (const [, target = "", rest = ""] of dispatches) {
      const passed = [
        ...rest.matchAll(/(?:^|\s)(?:-f|--raw-field|-F|--field)[\s=]+["']?([\w-]+)=/g),
      ].map((m) => m[1] ?? "");
      expect(passed.length, `the ${target} dispatch passes no input`).toBeGreaterThan(0);
      const declared = Object.keys(readWorkflow(target).on.workflow_dispatch?.inputs ?? {});
      expect(
        passed.filter((input) => !declared.includes(input)),
        `${target} declares no workflow_dispatch input for these`,
      ).toEqual([]);
    }
  });
});

test("the nightlies file under distinct labels, so one's green night cannot close the other's issue", () => {
  const labels = NIGHTLIES.map(
    ([file, job]) => filerIn(readWorkflow(file).jobs[job]?.steps ?? [], "report")?.with?.label,
  );
  // GitHub compares label names without regard to case.
  expect(new Set(labels.map((label) => String(label).toLowerCase())).size).toBe(labels.length);
});

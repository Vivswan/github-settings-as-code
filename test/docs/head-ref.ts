/**
 * Workflows cannot import RELEASE_PR_BRANCH_PREFIX, so their if: conditions spell
 * it by hand. This pulls every literal a workflow's job- and step-level conditions
 * test github.head_ref against, so each workflow contract test can pin them.
 */

/** The parts of a parsed workflow the head_ref walk reads. */
export interface HeadRefWorkflow {
  jobs: Record<string, { if?: string; steps?: Array<{ if?: string }> }>;
}

// Whitespace-tolerant at every token boundary GitHub's expression lexer allows,
// so a reformatted or folded multiline if: still yields its literal instead of [].
const HEAD_REF_PREFIX = /startsWith\s*\(\s*github\s*\.\s*head_ref\s*,\s*(['"])([^'"]*)\1\s*\)/g;

/** Every literal `condition` tests github.head_ref against with startsWith. */
export function headRefPrefixesIn(condition: string | undefined): string[] {
  return [...String(condition ?? "").matchAll(HEAD_REF_PREFIX)].map((m) => m[2] ?? "");
}

/** Every head_ref startsWith literal across the workflow's job- and step-level if: conditions. */
export function headRefPrefixes(wf: HeadRefWorkflow): string[] {
  return Object.values(wf.jobs).flatMap((job) =>
    [job.if, ...(job.steps ?? []).map((step) => step.if)].flatMap(headRefPrefixesIn),
  );
}

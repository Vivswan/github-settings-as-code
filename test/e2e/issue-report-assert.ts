/**
 * The private-report issue-delivery assertions over the mock's request log:
 * which body was delivered for a slug, and the full expect.issue_report
 * check (marker label, label-lookup mechanism, body substrings, final
 * state). Shared by the curated corpus (runScenario) and the fuzz
 * report-body check, so both prove the same delivery contract.
 */

import { MARKER_LABEL } from "../../src/report/issue-report.js";
import type { LoggedRequest } from "./mock/contract.js";
import type { Expect } from "./schema.js";

/** The `body` field of a recorded request payload, when it is a string. */
function stringBody(request: LoggedRequest | undefined): string | undefined {
  const body = (request?.body as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body : undefined;
}

/**
 * The report body delivered for a slug: the create POST body when the issue was
 * created this run, else the last PATCH body (an existing issue updated in
 * place). Undefined when no issue write reached the mock for that slug (e.g. the
 * permission-denied path). Shared by the curated issue_report assertion and the
 * fuzz report-body check.
 */
export function deliveredIssueBody(requests: LoggedRequest[], slug: string): string | undefined {
  const base = `/repos/${slug}/issues`;
  const create = requests.find((r) => r.method === "POST" && r.pathname === base);
  const fromCreate = stringBody(create);
  if (fromCreate !== undefined) {
    return fromCreate;
  }
  const lastPatch = requests
    .filter((r) => r.method === "PATCH" && r.pathname.startsWith(`${base}/`))
    .at(-1);
  return stringBody(lastPatch);
}

/**
 * Assert the private-report issue delivery for one slug against the recorded
 * requests: the report body carried the expected substrings (the full
 * unredacted detail), the issue's title/state matched, and the right number of
 * report issues were created. The report body is the POST /issues create body,
 * or - when the issue already existed and was updated - the PATCH body; state
 * is taken from the last create/patch that set it. `created_count` counts
 * POST /issues for the slug (0 proves no issue was created, e.g. the
 * permission-denied path).
 */
export function assertIssueReport(
  spec: NonNullable<Expect["issue_report"]>,
  requests: LoggedRequest[],
): string[] {
  const failures: string[] = [];
  const issuesPath = `/repos/${spec.slug}/issues`;
  const creates = requests.filter((r) => r.method === "POST" && r.pathname === issuesPath);
  const patches = requests.filter(
    (r) => r.method === "PATCH" && r.pathname.startsWith(`${issuesPath}/`),
  );

  if (spec.created_count !== undefined && creates.length !== spec.created_count) {
    failures.push(
      `issue_report: created ${creates.length} report issue(s) for ${spec.slug}, expected ${spec.created_count}`,
    );
  }

  // The delivered body: the create body if the issue was created this run, else
  // the last PATCH body (an existing issue updated in place).
  const created = creates[0]?.body as { title?: unknown; labels?: unknown } | undefined;
  const deliveredBody = deliveredIssueBody(requests, spec.slug);

  if (spec.title !== undefined && created && created.title !== spec.title) {
    failures.push(`issue_report: title "${String(created.title)}" != expected "${spec.title}"`);
  }
  // A created issue MUST carry the marker label - it is the lookup key that makes
  // the one-issue-per-repo reuse work; without it every run would create a new
  // issue. (Only checked on create; a reuse run PATCHes and adds no labels.)
  if (created) {
    const labels = Array.isArray(created.labels) ? created.labels.map(String) : [];
    if (!labels.includes(MARKER_LABEL)) {
      failures.push(
        `issue_report: created issue for ${spec.slug} is missing the marker label "${MARKER_LABEL}"`,
      );
    }
  }
  // The lookup is by the marker LABEL (one indexed request), not a title/creator
  // scan: assert the issues list GET carried labels=<marker>. This pins the
  // load-bearing lookup mechanism the reuse path depends on.
  if (spec.lookup_by_label) {
    const listedByLabel = requests.some(
      (r) =>
        r.method === "GET" &&
        r.pathname === issuesPath &&
        (r.query ?? "").includes(`labels=${MARKER_LABEL}`),
    );
    if (!listedByLabel) {
      failures.push(
        `issue_report: no issues list GET for ${spec.slug} used the labels=${MARKER_LABEL} filter`,
      );
    }
  }
  // The exact label-name array the last labels-setting write carried: the
  // marker-reattach witness. A fallback-scan hit must reattach the stripped
  // marker without clobbering human-added labels, so order and content are
  // both pinned.
  if (spec.labels) {
    const labelWrites = [...creates, ...patches]
      .map((r) => (r.body as { labels?: unknown } | undefined)?.labels)
      .filter((l): l is unknown[] => Array.isArray(l));
    const written = labelWrites.at(-1)?.map(String);
    if (written === undefined) {
      failures.push(
        `issue_report: no issue write for ${spec.slug} carried a labels array, expected [${spec.labels.join(", ")}]`,
      );
    } else if (
      written.length !== spec.labels.length ||
      spec.labels.some((name, i) => written[i] !== name)
    ) {
      failures.push(
        `issue_report: issue labels written for ${spec.slug} were [${written.join(", ")}], expected [${spec.labels.join(", ")}]`,
      );
    }
  }
  for (const needle of spec.body_contains ?? []) {
    if (deliveredBody === undefined) {
      failures.push(
        `issue_report: no report body delivered for ${spec.slug}, expected "${needle}"`,
      );
    } else if (!deliveredBody.includes(needle)) {
      failures.push(`issue_report: report body for ${spec.slug} missing "${needle}"`);
    }
  }
  if (spec.state !== undefined) {
    // The final state is the last create/patch that set one.
    const stateWrites = [...creates, ...patches]
      .map((r) => (r.body as { state?: unknown } | undefined)?.state)
      .filter((s): s is string => typeof s === "string");
    // A create defaults the issue open; only an explicit state on a later write
    // changes it, so the last explicit state wins (else "open" from the create).
    const finalState = stateWrites.at(-1) ?? (creates.length > 0 ? "open" : undefined);
    if (finalState !== spec.state) {
      failures.push(
        `issue_report: final issue state "${finalState ?? "(none)"}" != expected "${spec.state}"`,
      );
    }
  }
  return failures;
}

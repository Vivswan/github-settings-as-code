/** Shared by the curated corpus (runScenario) and the fuzz report-body check, so both prove the same delivery contract. */

import { MARKER_LABEL } from "../../src/report/issue-report.js";
import type { LoggedRequest } from "./mock/contract.js";
import type { Expect } from "./schema.js";

function stringBody(request: LoggedRequest | undefined): string | undefined {
  const body = (request?.body as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body : undefined;
}

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

  const created = creates[0]?.body as { title?: unknown; labels?: unknown } | undefined;
  const deliveredBody = deliveredIssueBody(requests, spec.slug);

  if (spec.title !== undefined && created && created.title !== spec.title) {
    failures.push(`issue_report: title "${String(created.title)}" != expected "${spec.title}"`);
  }
  // The marker label is the lookup key for one-issue-per-repo reuse. A reuse PATCH re-sends labels only when
  // the creator fallback scan found the marker stripped (the labels check below pins that), so the create carries the assertion.
  if (created) {
    const labels = Array.isArray(created.labels) ? created.labels.map(String) : [];
    if (!labels.includes(MARKER_LABEL)) {
      failures.push(
        `issue_report: created issue for ${spec.slug} is missing the marker label "${MARKER_LABEL}"`,
      );
    }
  }
  // Pins that the label-filtered lookup happened at all; the creator scan is a fallback after a miss, not a replacement.
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
  // The marker-reattach witness: a fallback-scan hit must reattach the stripped marker without
  // clobbering human-added labels, so order and content are both pinned.
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
    const stateWrites = [...creates, ...patches]
      .map((r) => (r.body as { state?: unknown } | undefined)?.state)
      .filter((s): s is string => typeof s === "string");
    const finalState = stateWrites.at(-1) ?? (creates.length > 0 ? "open" : undefined);
    if (finalState !== spec.state) {
      failures.push(
        `issue_report: final issue state "${finalState ?? "(none)"}" != expected "${spec.state}"`,
      );
    }
  }
  return failures;
}

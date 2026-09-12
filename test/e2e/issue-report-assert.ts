/** Shared by the curated corpus (runScenario) and the fuzz report-body check, so both prove the same delivery contract. */

import { MARKER_LABEL } from "../../src/report/issue-report.js";
import type { LoggedRequest } from "./mock/contract.js";
import type { Expect } from "./schema.js";

function stringBody(request: LoggedRequest | undefined): string | undefined {
  const body = (request?.body as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body : undefined;
}

/** A rejected write delivered nothing, so only an accepted one counts as a report; the leak sweep below reads every attempt. */
function accepted(request: LoggedRequest): boolean {
  return request.status >= 200 && request.status < 300;
}

/** Every body GitHub accepted for the slug's report issue, in write order: the create and each body-bearing PATCH. */
function deliveredIssueBodies(requests: LoggedRequest[], slug: string): string[] {
  const base = `/repos/${slug}/issues`;
  return requests
    .filter(
      (r) =>
        accepted(r) &&
        ((r.method === "POST" && r.pathname === base) ||
          (r.method === "PATCH" && r.pathname.startsWith(`${base}/`))),
    )
    .flatMap((r) => {
      const body = stringBody(r);
      return body === undefined ? [] : [body];
    });
}

/** The issue's final body: the latest accepted write that carried one, so a trailing state-only PATCH hides nothing. */
export function deliveredIssueBody(requests: LoggedRequest[], slug: string): string | undefined {
  return deliveredIssueBodies(requests, slug).at(-1);
}

const ISSUE_WRITE = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/\d+)?$/;

/**
 * Every report body the run TRANSMITTED, whichever target it went to and whether or not GitHub accepted it: the create
 * and each reuse or close PATCH. A rejected write still carried its body over the wire, so a leak in it is a leak.
 */
export function transmittedReportBodies(
  requests: LoggedRequest[],
): Array<{ slug: string; body: string }> {
  const out: Array<{ slug: string; body: string }> = [];
  for (const request of requests) {
    const slug = request.pathname.match(ISSUE_WRITE)?.[1];
    if (slug === undefined || (request.method !== "POST" && request.method !== "PATCH")) {
      continue;
    }
    const body = stringBody(request);
    if (body !== undefined) {
      out.push({ slug, body });
    }
  }
  return out;
}

/**
 * The private report is the one surface the redacted transcript reaches, and it is written unmasked so the private slug
 * stays legible there (capturingIo in src/flows/redact.ts). A resolved secret plaintext must still never land in it, so
 * the runner sweeps every delivered body for the run's secrets; the same needles fail the public surfaces via checkLeaks.
 */
export function checkReportLeaks(requests: LoggedRequest[], secrets: string[]): string[] {
  const failures: string[] = [];
  for (const { slug, body } of transmittedReportBodies(requests)) {
    for (const needle of secrets) {
      if (body.includes(needle)) {
        failures.push(`leak: "${needle}" present in the private report body sent to ${slug}`);
      }
    }
  }
  return failures;
}

export function assertIssueReport(
  spec: NonNullable<Expect["issue_report"]>,
  requests: LoggedRequest[],
): string[] {
  const failures: string[] = [];
  const issuesPath = `/repos/${spec.slug}/issues`;
  const creates = requests.filter(
    (r) => accepted(r) && r.method === "POST" && r.pathname === issuesPath,
  );
  const patches = requests.filter(
    (r) => accepted(r) && r.method === "PATCH" && r.pathname.startsWith(`${issuesPath}/`),
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
  // the title fallback scan found the marker stripped (the labels check below pins that), so the create carries the assertion.
  if (created) {
    const labels = Array.isArray(created.labels) ? created.labels.map(String) : [];
    if (!labels.includes(MARKER_LABEL)) {
      failures.push(
        `issue_report: created issue for ${spec.slug} is missing the marker label "${MARKER_LABEL}"`,
      );
    }
  }
  // Pins that the label-filtered lookup happened at all; the title scan is a fallback after a miss, not a replacement.
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
  // Every accepted body, not only the final one: an earlier write already published what a later one replaced. An
  // undelivered report lacks everything; body_contains, or created_count, is what pins delivery.
  for (const needle of spec.body_lacks ?? []) {
    if (deliveredIssueBodies(requests, spec.slug).some((body) => body.includes(needle))) {
      failures.push(`issue_report: report body for ${spec.slug} must not contain "${needle}"`);
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

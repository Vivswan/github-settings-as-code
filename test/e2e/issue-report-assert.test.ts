/**
 * The private-report delivery assertions: which recorded writes count as a delivered report, and the secret sweep the
 * runner applies to every one of them, the surface the redacted transcript reaches unmasked.
 */

import { describe, expect, test } from "bun:test";
import { MARKER_LABEL } from "../../src/report/issue-report.js";
import {
  assertIssueReport,
  checkReportLeaks,
  transmittedReportBodies,
} from "./issue-report-assert.js";
import type { LoggedRequest } from "./mock/contract.js";

function write(method: string, pathname: string, body: unknown, status?: number): LoggedRequest {
  return { method, pathname, query: "", status: status ?? (method === "POST" ? 201 : 200), body };
}

const requests: LoggedRequest[] = [
  write("POST", "/repos/o/a/labels", { name: "settings-as-code-report", color: "0e2a47" }),
  { method: "GET", pathname: "/repos/o/a/issues", query: "labels=x", status: 200 },
  write("POST", "/repos/o/a/issues", {
    title: "t",
    body: "report for o/a: token=ghp_plain",
    labels: [MARKER_LABEL],
  }),
  write("PATCH", "/repos/o/b/issues/7", { body: "report for o/b, clean", state: "closed" }),
  write("PATCH", "/repos/o/b/issues/7", { body: "report for o/b, reopened", state: "open" }),
  // A state-only PATCH carries no body; a hook write under another path is not a report.
  write("PATCH", "/repos/o/b/issues/7", { state: "open" }),
  write("PATCH", "/repos/o/c/hooks/3/config", { body: "ghp_plain" }),
  write("POST", "/repos/o/c/issues/9/comments", { body: "ghp_plain in a comment" }),
  // Rejected by GitHub: transmitted, so it is swept, but it delivered no report.
  write("POST", "/repos/o/r/issues", { title: "t", body: "rejected ghp_plain", labels: [] }, 422),
];

describe("transmittedReportBodies", () => {
  test("keeps every issue create and issue PATCH carrying a string body, accepted or rejected, keyed by the target slug", () => {
    expect(transmittedReportBodies(requests)).toEqual([
      { slug: "o/a", body: "report for o/a: token=ghp_plain" },
      { slug: "o/b", body: "report for o/b, clean" },
      { slug: "o/b", body: "report for o/b, reopened" },
      { slug: "o/r", body: "rejected ghp_plain" },
    ]);
  });
});

describe("checkReportLeaks", () => {
  test("names the secret and the target of every delivered report it appears in, and nothing else", () => {
    expect(checkReportLeaks(requests, ["ghp_plain", "absent", "clean"])).toEqual([
      'leak: "ghp_plain" present in the private report body sent to o/a',
      'leak: "clean" present in the private report body sent to o/b',
      'leak: "ghp_plain" present in the private report body sent to o/r',
    ]);
    expect(checkReportLeaks(requests, ["nowhere"])).toEqual([]);
  });
});

describe("assertIssueReport delivery", () => {
  test("a rejected create is no delivery: it counts toward nothing and carries no body", () => {
    expect(
      assertIssueReport(
        { slug: "o/r", created_count: 1, state: "open", body_contains: ["rejected"] },
        requests,
      ),
    ).toEqual([
      "issue_report: created 0 report issue(s) for o/r, expected 1",
      'issue_report: no report body delivered for o/r, expected "rejected"',
      'issue_report: final issue state "(none)" != expected "open"',
    ]);
  });
});

describe("assertIssueReport body_lacks", () => {
  test("fails on a delivered body carrying a forbidden string and passes when it is absent or nothing was delivered", () => {
    const spec = {
      slug: "o/a",
      body_contains: ["report for o/a"],
      body_lacks: ["ghp_plain", "nope"],
    };
    expect(assertIssueReport(spec, requests)).toEqual([
      'issue_report: report body for o/a must not contain "ghp_plain"',
    ]);
    // The final body is the latest body-bearing write, past the trailing state-only PATCH; body_lacks sweeps
    // every accepted body, so the superseded first PATCH still fails it.
    expect(
      assertIssueReport(
        { slug: "o/b", body_contains: ["reopened"], body_lacks: ["ghp_plain", "clean"] },
        requests,
      ),
    ).toEqual(['issue_report: report body for o/b must not contain "clean"']);
    // Undelivered: body_lacks alone is vacuous by design; body_contains is what reports the missing delivery.
    expect(
      assertIssueReport(
        { slug: "o/none", body_contains: ["x"], body_lacks: ["ghp_plain"] },
        requests,
      ),
    ).toEqual(['issue_report: no report body delivered for o/none, expected "x"']);
  });
});

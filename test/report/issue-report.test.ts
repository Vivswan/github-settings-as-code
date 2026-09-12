import { describe, expect, test } from "bun:test";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import { REPORT_HEADING } from "../../src/report/composer.js";
import {
  deliverIssueReport,
  ISSUE_TITLE,
  type IssueReportMode,
  injectMarkerLabel,
  MARKER_LABEL,
  MARKER_LABEL_CONFIG,
} from "../../src/report/issue-report.js";
import type { SettingsFile } from "../../src/schema.js";
import { MockApi, type Route } from "../mock-api.js";

const SLUG = { owner: "o", name: "private-repo", slug: "o/private-repo" };
const LABEL_CREATE = "POST /repos/o/private-repo/labels";
const LABEL_LOOKUP =
  "GET /repos/o/private-repo/issues?state=all&labels=settings-as-code-report&per_page=100&page=1";
const LABEL_LOOKUP_PAGE_2 =
  "GET /repos/o/private-repo/issues?state=all&labels=settings-as-code-report&per_page=100&page=2";
const ISSUE_CREATE = "POST /repos/o/private-repo/issues";
const TITLE_SCAN =
  "GET /repos/o/private-repo/issues?state=all&sort=created&direction=desc&per_page=100&page=1";

/** An issue the action itself wrote: the exact title over a body opening with the report heading. */
const reportIssue = (number: number, state: "open" | "closed" = "open") => ({
  number,
  title: ISSUE_TITLE,
  body: `${REPORT_HEADING} o/private-repo\n\nan earlier report`,
  state,
  html_url: `https://github.com/o/private-repo/issues/${number}`,
});

/** A same-titled issue a human opened by hand: no report heading anywhere in the body. */
const humanIssue = (number: number, state: "open" | "closed") => ({
  ...reportIssue(number, state),
  body: "Opened by hand to discuss the private report; please do not overwrite.",
  user: { login: "a-human" },
});

describe("deliverIssueReport", () => {
  test("found by marker label: one lookup request, then PATCH body + open", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    const result = await deliverIssueReport(api, SLUG, "the report body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/7" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      "PATCH /repos/o/private-repo/issues/7",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "open" });
  });

  test("a marker issue on page 2 of the label lookup is found, not duplicated", async () => {
    // 100 marker-labelled pull requests fill page 1; a single-page lookup would miss the issue and create a second one.
    const labelled = Array.from({ length: 100 }, (_, i) => ({
      ...reportIssue(100 + i),
      pull_request: { url: `pr-${i}` },
      labels: [MARKER_LABEL],
    }));
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: labelled },
      [LABEL_LOOKUP_PAGE_2]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(8) },
    });
    const result = await deliverIssueReport(api, SLUG, "the report body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/7" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      LABEL_LOOKUP_PAGE_2,
      "PATCH /repos/o/private-repo/issues/7",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "open" });
  });

  test("a healthy result closes the issue on update", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    await deliverIssueReport(api, SLUG, "body", false, "always");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "body", state: "closed" });
  });

  test("pull requests, other titles, and human-written bodies never match, even with the marker label", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: {
        data: [
          { ...reportIssue(1), pull_request: { url: "pr" } },
          { ...reportIssue(2), title: `${ISSUE_TITLE} (fork)` },
          { ...humanIssue(3, "open"), labels: [MARKER_LABEL] },
        ],
      },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    const create = api.calls.find((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(create?.payload).toEqual({ title: ISSUE_TITLE, body: "body", labels: [MARKER_LABEL] });
  });

  test("label-lookup miss runs the title scan BEFORE any create, avoiding duplicates", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      // The label was stripped by a human; the scan still finds the issue.
      [TITLE_SCAN]: { data: [reportIssue(3)] },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/3" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      "PATCH /repos/o/private-repo/issues/3",
    ]);
  });

  test("a fallback-scan hit without the marker is reclaimed and relabelled, whoever created it", async () => {
    // A human stripped the marker and the PAT was since rotated to another account: the scan matches the title, not the
    // creator, and the upsert PATCH reattaches the marker (without it, every future label-filtered lookup misses forever).
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: {
        data: [{ ...reportIssue(3), labels: ["bug"], user: { login: "former-bot" } }],
      },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
      [ISSUE_CREATE]: { data: reportIssue(8) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/3" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      "PATCH /repos/o/private-repo/issues/3",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "body", state: "open", labels: ["bug", MARKER_LABEL] });
  });

  test("an issue found by the label lookup is PATCHed without a labels field", async () => {
    // Human-added labels must never be clobbered; the marker is already attached (that is how the lookup found it).
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: {
        data: [{ ...reportIssue(7), labels: [{ name: "human-added" }, { name: MARKER_LABEL }] }],
      },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    await deliverIssueReport(api, SLUG, "body", true, "always");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "body", state: "open" });
  });

  test("a healthy always run relabels a fallback-found stripped issue while closing it", async () => {
    // Same relabel mechanism, closed state; label objects ({name}) count too.
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [{ ...reportIssue(3), labels: [{ name: "bug" }] }] },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
    });
    await deliverIssueReport(api, SLUG, "body", false, "always");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({
      body: "body",
      state: "closed",
      labels: ["bug", MARKER_LABEL],
    });
  });

  test("the title scan early-exits once a page contains the issue", async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      i === 50 ? reportIssue(150, "closed") : humanIssue(100 + i, "closed"),
    );
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: filler },
      "PATCH /repos/o/private-repo/issues/150": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/150" });
    // A full page came back, but the match stops the walk: no page=2 request.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      "PATCH /repos/o/private-repo/issues/150",
    ]);
  });

  const policyCases: Array<{
    name: string;
    lookup: "label" | "title";
    listed: Array<Record<string, unknown>>;
    picks: number;
  }> = [
    {
      name: "a human's closed same-titled issue is never reclaimed over the real open report",
      lookup: "title",
      listed: [reportIssue(9), humanIssue(1, "closed")],
      picks: 9,
    },
    {
      name: "a human's OPEN same-titled issue, newer than the closed real report, is never reclaimed either",
      lookup: "title",
      listed: [humanIssue(9, "open"), reportIssue(3, "closed")],
      picks: 3,
    },
    {
      name: "a human's open issue wearing the marker label loses to the closed real report by the label lookup too",
      lookup: "label",
      listed: [humanIssue(9, "open"), reportIssue(2, "closed")],
      picks: 2,
    },
    {
      name: "two reports: the open one wins over a newer closed one",
      lookup: "title",
      listed: [reportIssue(9, "closed"), reportIssue(3)],
      picks: 3,
    },
    {
      name: "two open reports: the newest wins",
      lookup: "title",
      listed: [reportIssue(9), reportIssue(3)],
      picks: 9,
    },
    {
      name: "two closed reports: the newest wins",
      lookup: "label",
      listed: [reportIssue(9, "closed"), reportIssue(3, "closed")],
      picks: 9,
    },
  ];
  for (const { name, lookup, listed, picks } of policyCases) {
    test(`candidate policy: ${name}`, async () => {
      // Both lookups walk newest first and share one policy: a report body, then open over closed, then newest. The
      // loser is never written: a same-titled human issue used to be PATCHed with the report, reopened, and relabelled.
      const listedWithMarker = listed.map((issue) => ({ ...issue, labels: [MARKER_LABEL] }));
      const api = new MockApi({
        [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
        [LABEL_LOOKUP]: { data: lookup === "label" ? listedWithMarker : [] },
        [TITLE_SCAN]: { data: lookup === "title" ? listed : [] },
        [ISSUE_CREATE]: { data: reportIssue(50) },
        "PATCH /repos/o/private-repo/issues/*": { data: null },
      });
      const result = await deliverIssueReport(api, SLUG, "body", true, "always");
      expect(result).toEqual({ url: `https://github.com/o/private-repo/issues/${picks}` });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        LABEL_CREATE,
        LABEL_LOOKUP,
        ...(lookup === "title" ? [TITLE_SCAN] : []),
        `PATCH /repos/o/private-repo/issues/${picks}`,
      ]);
      const patch = api.calls.find((c) => c.method === "PATCH");
      expect(patch?.payload).toEqual(
        lookup === "title"
          ? { body: "body", state: "open", labels: [MARKER_LABEL] }
          : { body: "body", state: "open" },
      );
    });
  }

  test("nothing anywhere: POST with the marker label, then close when healthy", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
      "PATCH /repos/o/private-repo/issues/9": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      ISSUE_CREATE,
      "PATCH /repos/o/private-repo/issues/9",
    ]);
    const close = api.calls.find((c) => c.method === "PATCH");
    expect(close?.payload).toEqual({ state: "closed" });
  });

  test("a needs-attention first run creates the issue and leaves it open", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      ISSUE_CREATE,
    ]);
  });

  test("a denied marker-label create is a safe warning and stops everything", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: {
        error: { status: 403, message: "Resource not accessible for o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      warning:
        'could not deliver the private report (HTTP 403). To fix, grant "Issues" (read and write) ' +
        "under the PAT's Repository permissions for the target repository, or set private-report: none",
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LABEL_CREATE]);
  });

  test("a non-permission failure gets re-run advice, no grant prose", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": {
        error: { status: 500, message: "boom o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      warning:
        "could not deliver the private report (HTTP 500). Re-run the workflow, or set " +
        "private-report: none if it persists",
    });
  });

  test("a throwing transport never escapes; the warning stays slug-free", async () => {
    // MockApi throws on unrouted mutations, standing in for a network-level failure (GithubApi throws those with the path in the message).
    const api = new MockApi({});
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      warning:
        "could not deliver the private report: the request failed before an HTTP response " +
        "arrived. Re-run the workflow, or set private-report: none if it persists",
    });
  });

  test("a non-list lookup response is a warning, not a crash", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: { message: "unexpected" } },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      warning:
        "could not deliver the private report: the report-issue lookup returned a non-list " +
        'page. Check the "api-version" input, or set private-report: none',
    });
  });
});

describe("deliverIssueReport under mode: on-failure", () => {
  const OPEN_LOOKUP =
    "GET /repos/o/private-repo/issues?state=open&labels=settings-as-code-report&per_page=100&page=1";
  const OPEN_LOOKUP_PATH =
    "/repos/o/private-repo/issues?state=open&labels=settings-as-code-report&per_page=100&page=1";

  test("healthy with no open issue: exactly one read, zero writes, skipped", async () => {
    const api = new MockApi({ [OPEN_LOOKUP]: { data: [] } });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({ skipped: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${OPEN_LOOKUP_PATH}`]);
  });

  test("healthy with a leftover open issue: PATCH body + closed, no other traffic", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    const result = await deliverIssueReport(api, SLUG, "the report body", false, "on-failure");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/7" });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${OPEN_LOOKUP_PATH}`,
      "PATCH /repos/o/private-repo/issues/7",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "closed" });
  });

  test("healthy with only a human's open same-titled issue under the marker label: skipped, untouched", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { data: [{ ...humanIssue(4, "open"), labels: [MARKER_LABEL] }] },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({ skipped: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${OPEN_LOOKUP_PATH}`]);
  });

  test("a failing quiet-path lookup is a safe warning, never the slug", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { error: { status: 500, message: "boom o/private-repo", body: "" } },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({
      warning:
        "could not deliver the private report (HTTP 500). Re-run the workflow, or set " +
        "private-report: none if it persists",
    });
  });

  test("a failing close-PATCH is a safe warning too", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": {
        error: { status: 403, message: "denied o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({
      warning:
        'could not deliver the private report (HTTP 403). To fix, grant "Issues" (read and write) ' +
        "under the PAT's Repository permissions for the target repository, or set private-report: none",
    });
  });

  test("a non-list quiet-path response is a warning, not a crash", async () => {
    const api = new MockApi({ [OPEN_LOOKUP]: { data: { message: "unexpected" } } });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({
      warning:
        "could not deliver the private report: the open-issue lookup returned a non-list " +
        'page. Check the "api-version" input, or set private-report: none',
    });
  });

  test("needs-attention requests are identical to always, on both upsert paths", async () => {
    const sequence = async (routes: Record<string, Route>, mode: IssueReportMode) => {
      const api = new MockApi(routes);
      await deliverIssueReport(api, SLUG, "body", true, mode);
      return api.calls;
    };
    // path 1: found by the marker label -> ensure-create, lookup, PATCH open
    const patchRoutes = (): Record<string, Route> => ({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
    });
    const patched = await sequence(patchRoutes(), "on-failure");
    expect(patched).toEqual(await sequence(patchRoutes(), "always"));
    expect(patched.some((c) => c.method === "PATCH")).toBe(true);
    // path 2: nothing anywhere -> ensure-create, lookup, title scan, POST create
    const createRoutes = (): Record<string, Route> => ({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const created = await sequence(createRoutes(), "on-failure");
    expect(created).toEqual(await sequence(createRoutes(), "always"));
    expect(created.some((c) => `${c.method} ${c.path}` === ISSUE_CREATE)).toBe(true);
  });
});

describe("injectMarkerLabel", () => {
  test("appends the marker to a declared labels section without mutating the input", () => {
    const settings: SettingsFile = { labels: [{ name: "bug", color: "d73a4a" }] };
    const { settings: injected, outcome } = injectMarkerLabel(settings);
    expect(outcome).toBe("injected");
    expect(injected.labels).toEqual([{ name: "bug", color: "d73a4a" }, MARKER_LABEL_CONFIG]);
    expect(settings.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
  });

  test("a wrapped labels section stays wrapped, keeping its undeclared policy", () => {
    // Injection must rebuild the operator's chosen shape: losing the wrapper here would silently restore the labels default (delete) on the next run.
    const settings: SettingsFile = {
      labels: { _undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("injected");
    expect(result.settings.labels).toEqual({
      _undeclared: "keep",
      entries: [{ name: "bug", color: "d73a4a" }, MARKER_LABEL_CONFIG],
    });
    expect(settings.labels).toEqual({
      _undeclared: "keep",
      entries: [{ name: "bug", color: "d73a4a" }],
    });
  });

  test("a rename-refusal in a wrapped labels section rebuilds the wrapped form", () => {
    const settings: SettingsFile = {
      labels: {
        _undeclared: "keep",
        entries: [{ name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" }],
      },
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("rename-refused");
    expect(result.settings.labels).toEqual({
      _undeclared: "keep",
      entries: [{ name: MARKER_LABEL, new_name: undefined, color: "0e2a47" }],
    });
  });

  test("a bare wrapper (no policy key) stays bare - omission is preserved", () => {
    // Injection must not change the SHAPE of the operator's declaration; the section handler resolves the default policy itself.
    const settings: SettingsFile = { labels: { entries: [{ name: "bug" }] } };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("injected");
    expect(Object.keys(result.settings.labels as object)).toEqual(["entries"]);
    expect(result.settings.labels).toEqual({ entries: [{ name: "bug" }, MARKER_LABEL_CONFIG] });
  });

  test("a rename-refusal in a bare wrapper also preserves the omission", () => {
    const settings: SettingsFile = {
      labels: { entries: [{ name: MARKER_LABEL, new_name: "something-else" }] },
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("rename-refused");
    expect(Object.keys(result.settings.labels as object)).toEqual(["entries"]);
  });

  test("an already-declared marker (any case) is left alone", () => {
    const settings: SettingsFile = { labels: [{ name: "Settings-As-Code-Report" }] };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("unchanged");
    expect(result.settings).toBe(settings);
  });

  test("a rename resolving to the marker counts as declared", () => {
    const settings: SettingsFile = { labels: [{ name: "old-report", new_name: MARKER_LABEL }] };
    expect(injectMarkerLabel(settings).outcome).toBe("unchanged");
  });

  test("a rename moving the marker AWAY is refused (new_name stripped), not injected", () => {
    // Renaming the marker to another name would break the next run's lookup by the constant marker name, so the rename is dropped and flagged.
    const settings: SettingsFile = {
      labels: [{ name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" }],
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("rename-refused");
    expect(result.settings.labels).toEqual([
      { name: MARKER_LABEL, new_name: undefined, color: "0e2a47" },
    ]);
    const original = (settings.labels as Array<{ new_name?: string }> | undefined)?.[0];
    expect(original?.new_name).toBe("something-else");
  });

  test("a rename to the marker (case-insensitive) is NOT treated as moving it away", () => {
    const settings: SettingsFile = {
      labels: [{ name: MARKER_LABEL, new_name: "Settings-As-Code-Report" }],
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("unchanged");
  });

  test("every injection outcome preserves document validity, in both label forms", () => {
    // applyMarkerInjection (src/report/delivery.ts) carries the injected document across the ValidatedSettings brand on the strength of this
    // property; the rename-refused arm, which writes an explicit `new_name: undefined`, is the risky one.
    const cases: Array<{ doc: SettingsFile; expected: string }> = [
      { doc: { labels: [{ name: "bug", color: "d73a4a" }] }, expected: "injected" },
      {
        doc: { labels: { _undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] } },
        expected: "injected",
      },
      { doc: { labels: [{ name: MARKER_LABEL, color: "0e2a47" }] }, expected: "unchanged" },
      {
        doc: { labels: [{ name: MARKER_LABEL, new_name: "elsewhere", color: "0e2a47" }] },
        expected: "rename-refused",
      },
      {
        doc: {
          labels: {
            _undeclared: "keep",
            entries: [{ name: MARKER_LABEL, new_name: "elsewhere", color: "0e2a47" }],
          },
        },
        expected: "rename-refused",
      },
    ];
    for (const { doc, expected } of cases) {
      const result = injectMarkerLabel(doc);
      expect(result.outcome).toBe(expected as typeof result.outcome);
      const verdict = validateSettingsDoc(result.settings, "injected doc", new Set(), silentIo());
      expect(
        verdict.match(() => null, describeProblem),
        `outcome "${expected}" produced a document validation rejects`,
      ).toBeNull();
    }
  });

  test("no labels section means nothing to inject", () => {
    const settings: SettingsFile = { repository: { has_wiki: false } };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("unchanged");
    expect(result.settings).toBe(settings);
  });
});

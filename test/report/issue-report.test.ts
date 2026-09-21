import { describe, expect, test } from "bun:test";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
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
/** The quiet path of mode on-failure: only open marker issues are looked up, and nothing is created. */
const OPEN_LOOKUP_PATH =
  "/repos/o/private-repo/issues?state=open&labels=settings-as-code-report&per_page=100&page=1";
const OPEN_LOOKUP = `GET ${OPEN_LOOKUP_PATH}`;
/** No write reached the target: what a failure before its first write carries. */
const NOTHING_LANDED = { labelCreated: false, createdIssue: null };

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
  test.each<[needsAttention: boolean, state: string]>([
    [true, "open"],
    [false, "closed"],
  ])(
    "found by marker label, needsAttention %p: one lookup request, then PATCH body + %s, leaving the issue's labels alone",
    async (needsAttention, state) => {
      // Human-added labels must never be clobbered; the marker is already attached (that is how the lookup found it).
      const api = new MockApi({
        [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
        [LABEL_LOOKUP]: {
          data: [{ ...reportIssue(7), labels: [{ name: "human-added" }, { name: MARKER_LABEL }] }],
        },
        "PATCH /repos/o/private-repo/issues/7": { data: reportIssue(7) },
      });
      const result = await deliverIssueReport(
        api,
        SLUG,
        "the report body",
        needsAttention,
        "always",
      );
      expect(result).toEqual({ delivered: "updated", number: 7, labelCreated: false });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        LABEL_CREATE,
        LABEL_LOOKUP,
        "PATCH /repos/o/private-repo/issues/7",
      ]);
      const patch = api.calls.find((c) => c.method === "PATCH");
      expect(patch?.payload).toEqual({ body: "the report body", state });
    },
  );

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
    expect(result).toEqual({ delivered: "updated", number: 7, labelCreated: false });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      LABEL_LOOKUP_PAGE_2,
      "PATCH /repos/o/private-repo/issues/7",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "open" });
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
    expect(result).toEqual({ delivered: "created", number: 9, labelCreated: true });
    const create = api.calls.find((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(create?.payload).toEqual({ title: ISSUE_TITLE, body: "body", labels: [MARKER_LABEL] });
  });

  test.each<
    [
      name: string,
      found: Record<string, unknown>,
      needsAttention: boolean,
      state: string,
      labels: string[],
    ]
  >([
    // The label was stripped by a human; the scan still finds the issue. With no labels at all on the hit, the
    // reattached marker is the whole list.
    [
      "a label-less hit gets the marker as its whole list",
      reportIssue(3),
      true,
      "open",
      [MARKER_LABEL],
    ],
    // A human stripped the marker and the PAT was since rotated to another account: the scan matches the title, not the
    // creator, and the upsert PATCH reattaches the marker (without it, every future label-filtered lookup misses forever).
    [
      "a hit without the marker is reclaimed and relabelled, whoever created it",
      { ...reportIssue(3), labels: ["bug"], user: { login: "former-bot" } },
      true,
      "open",
      ["bug", MARKER_LABEL],
    ],
    // Same relabel mechanism, closed state; label objects ({name}) count too.
    [
      "a healthy run relabels a stripped hit while closing it",
      { ...reportIssue(3), labels: [{ name: "bug" }] },
      false,
      "closed",
      ["bug", MARKER_LABEL],
    ],
  ])(
    "label-lookup miss runs the title scan BEFORE any create, avoiding duplicates: %s",
    async (_name, found, needsAttention, state, labels) => {
      const api = new MockApi({
        [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
        [LABEL_LOOKUP]: { data: [] },
        [TITLE_SCAN]: { data: [found] },
        "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
        [ISSUE_CREATE]: { data: reportIssue(8) },
      });
      const result = await deliverIssueReport(api, SLUG, "body", needsAttention, "always");
      expect(result).toEqual({ delivered: "updated", number: 3, labelCreated: true });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        LABEL_CREATE,
        LABEL_LOOKUP,
        TITLE_SCAN,
        "PATCH /repos/o/private-repo/issues/3",
      ]);
      const patch = api.calls.find((c) => c.method === "PATCH");
      expect(patch?.payload).toEqual({ body: "body", state, labels });
    },
  );

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
    expect(result).toEqual({ delivered: "updated", number: 150, labelCreated: true });
    // A full page came back, but the match stops the walk: no page=2 request.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      "PATCH /repos/o/private-repo/issues/150",
    ]);
  });

  test.each<[name: string, listed: Array<Record<string, unknown>>, picks: number]>([
    [
      "two reports: the open one wins over a newer closed one",
      [reportIssue(9, "closed"), reportIssue(3)],
      3,
    ],
    ["two open reports: the newest wins", [reportIssue(9), reportIssue(3)], 9],
    [
      "two closed reports: the newest wins",
      [reportIssue(9, "closed"), reportIssue(3, "closed")],
      9,
    ],
  ])("candidate policy: %s", async (_name, listed, picks) => {
    // Both lookups share one policy: a report body, then open over closed, then newest. The loser is never written.
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: listed },
      [ISSUE_CREATE]: { data: reportIssue(50) },
      "PATCH /repos/o/private-repo/issues/*": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ delivered: "updated", number: picks, labelCreated: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      LABEL_CREATE,
      LABEL_LOOKUP,
      TITLE_SCAN,
      `PATCH /repos/o/private-repo/issues/${picks}`,
    ]);
  });

  test.each<[needsAttention: boolean, trailing: string[], close: unknown]>([
    [false, ["PATCH /repos/o/private-repo/issues/9"], { state: "closed" }],
    [true, [], undefined],
  ])(
    "nothing anywhere, needsAttention %p: POST with the marker label, then a close PATCH only when healthy",
    async (needsAttention, trailing, close) => {
      const api = new MockApi({
        [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
        [LABEL_LOOKUP]: { data: [] },
        [TITLE_SCAN]: { data: [] },
        [ISSUE_CREATE]: { data: reportIssue(9) },
        "PATCH /repos/o/private-repo/issues/9": { data: null },
      });
      const result = await deliverIssueReport(api, SLUG, "body", needsAttention, "always");
      expect(result).toEqual({ delivered: "created", number: 9, labelCreated: true });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        LABEL_CREATE,
        LABEL_LOOKUP,
        TITLE_SCAN,
        ISSUE_CREATE,
        ...trailing,
      ]);
      expect<unknown>(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual(close);
    },
  );

  test("a write that landed before a later failure rides on the warning: the created label, the created issue", async () => {
    // Label created, then the lookup fails: the label is the landed write.
    const afterLabel = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { error: { status: 500, message: "boom", body: "" } },
    });
    expect(await deliverIssueReport(afterLabel, SLUG, "body", true, "always")).toEqual({
      landed: { labelCreated: true, createdIssue: null },
      warning: expect.stringMatching(/^could not deliver the private report \(HTTP 500\)/),
    });
    // Issue created (the label existed), then the healthy close fails: the issue is the landed write.
    const afterCreate = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
      "PATCH /repos/o/private-repo/issues/9": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    expect(await deliverIssueReport(afterCreate, SLUG, "body", false, "always")).toEqual({
      landed: { labelCreated: false, createdIssue: 9 },
      warning: expect.stringMatching(/^could not deliver the private report \(HTTP 403\)/),
    });
  });

  test("a create response without an issue number is a malformed-response warning, whatever the state", async () => {
    const routes: Record<string, Route> = {
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      [TITLE_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: { html_url: "https://github.com/o/private-repo/issues/9" } },
    };
    for (const needsAttention of [true, false]) {
      const api = new MockApi(routes);
      const result = await deliverIssueReport(api, SLUG, "body", needsAttention, "always");
      expect(result).toEqual({
        landed: { labelCreated: true, createdIssue: null },
        warning: expect.stringMatching(
          /^could not deliver the private report: the report issue was created but its response carried no issue number/,
        ),
      });
      expect(api.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    }
  });

  test("a denied marker-label create is a safe warning and stops everything", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: {
        error: { status: 403, message: "Resource not accessible for o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      landed: NOTHING_LANDED,
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
      landed: NOTHING_LANDED,
      warning:
        "could not deliver the private report (HTTP 500). Re-run, or set " +
        "private-report: none if it persists",
    });
  });

  test("a request with no HTTP answer is the same slug-free warning, on the label create and on the lookup", async () => {
    // The client's line embeds the request path (the private slug), so the warning names neither.
    const failed = `POST /repos/o/private-repo/labels failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run`;
    const warning =
      "could not deliver the private report: the request failed before an HTTP response " +
      "arrived. Re-run, or set private-report: none if it persists";
    expect(
      await deliverIssueReport(
        new MockApi({ [LABEL_CREATE]: { failed } }),
        SLUG,
        "body",
        true,
        "always",
      ),
    ).toEqual({ landed: NOTHING_LANDED, warning });
    const onLookup = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { failed },
    });
    const result = await deliverIssueReport(onLookup, SLUG, "body", true, "always");
    expect(result).toEqual({ landed: NOTHING_LANDED, warning });
    expect(JSON.stringify(result)).not.toContain("o/private-repo");
  });

  test("a client that throws instead of answering never escapes; the warning stays slug-free", async () => {
    // MockApi throws on unrouted mutations, standing in for a client that breaks the GitHubClient contract.
    const api = new MockApi({});
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({
      landed: NOTHING_LANDED,
      warning:
        "could not deliver the private report: the request failed before an HTTP response " +
        "arrived. Re-run, or set private-report: none if it persists",
    });
  });

  test.each<
    [mode: IssueReportMode, lookup: string, needsAttention: boolean, routes: Record<string, Route>]
  >([
    [
      "always",
      "the report-issue lookup",
      true,
      {
        [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
        [LABEL_LOOKUP]: { data: { message: "unexpected" } },
      },
    ],
    [
      "on-failure",
      "the open-issue lookup",
      false,
      { [OPEN_LOOKUP]: { data: { message: "unexpected" } } },
    ],
  ])(
    "under mode %s, a non-list lookup response is a warning naming %s, not a crash",
    async (mode, lookup, needsAttention, routes) => {
      const result = await deliverIssueReport(
        new MockApi(routes),
        SLUG,
        "body",
        needsAttention,
        mode,
      );
      expect(result).toEqual({
        landed: NOTHING_LANDED,
        warning:
          `could not deliver the private report: ${lookup} returned a non-list ` +
          'page. Check the "api-version" input, or set private-report: none',
      });
    },
  );
});

describe("deliverIssueReport under mode: on-failure", () => {
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
    expect(result).toEqual({ delivered: "updated", number: 7, labelCreated: false });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${OPEN_LOOKUP_PATH}`,
      "PATCH /repos/o/private-repo/issues/7",
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "the report body", state: "closed" });
  });

  test.each<[failing: string, routes: Record<string, Route>, warning: RegExp]>([
    [
      "quiet-path lookup",
      { [OPEN_LOOKUP]: { error: { status: 500, message: "boom o/private-repo", body: "" } } },
      /^could not deliver the private report \(HTTP 500\)\. Re-run, /,
    ],
    [
      "close-PATCH",
      {
        [OPEN_LOOKUP]: { data: [reportIssue(7)] },
        "PATCH /repos/o/private-repo/issues/7": {
          error: { status: 403, message: "denied o/private-repo", body: "" },
        },
      },
      /^could not deliver the private report \(HTTP 403\)\. To fix, grant "Issues"/,
    ],
  ])("a failing %s is a safe warning, never the slug", async (_failing, routes, warning) => {
    const result = await deliverIssueReport(new MockApi(routes), SLUG, "body", false, "on-failure");
    expect(result).toEqual({
      landed: NOTHING_LANDED,
      warning: expect.stringMatching(warning),
    });
    expect(JSON.stringify(result)).not.toContain("o/private-repo");
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
  type Outcome = ReturnType<typeof injectMarkerLabel>["outcome"];
  const bug = { name: "bug", color: "d73a4a" };
  const markerRenamedAway = { name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" };
  const renameStripped = { name: MARKER_LABEL, new_name: undefined, color: "0e2a47" };

  test.each<[name: string, doc: SettingsFile, outcome: Outcome, labels: unknown]>([
    [
      "appends the marker to a declared labels section",
      { labels: [bug] },
      "injected",
      [bug, MARKER_LABEL_CONFIG],
    ],
    // Injection must rebuild the operator's chosen shape: losing the wrapper here would silently restore the labels
    // default (delete) on the next run.
    [
      "a wrapped labels section stays wrapped, keeping its undeclared policy",
      { labels: { _undeclared: "keep", entries: [bug] } },
      "injected",
      { _undeclared: "keep", entries: [bug, MARKER_LABEL_CONFIG] },
    ],
    [
      "a rename-refusal in a wrapped labels section rebuilds the wrapped form",
      { labels: { _undeclared: "keep", entries: [markerRenamedAway] } },
      "rename-refused",
      { _undeclared: "keep", entries: [renameStripped] },
    ],
    // Injection must not change the SHAPE of the operator's declaration; the section handler resolves the default
    // policy itself, so a wrapper without the policy key stays without it.
    [
      "a bare wrapper (no policy key) stays bare - omission is preserved",
      { labels: { entries: [{ name: "bug" }] } },
      "injected",
      { entries: [{ name: "bug" }, MARKER_LABEL_CONFIG] },
    ],
    [
      "a rename-refusal in a bare wrapper also preserves the omission",
      { labels: { entries: [{ name: MARKER_LABEL, new_name: "something-else" }] } },
      "rename-refused",
      { entries: [{ name: MARKER_LABEL, new_name: undefined }] },
    ],
    [
      "an already-declared marker (any case) is left alone",
      { labels: [{ name: "Settings-As-Code-Report" }] },
      "unchanged",
      [{ name: "Settings-As-Code-Report" }],
    ],
    [
      "a rename resolving to the marker counts as declared",
      { labels: [{ name: "old-report", new_name: MARKER_LABEL }] },
      "unchanged",
      [{ name: "old-report", new_name: MARKER_LABEL }],
    ],
    // Renaming the marker to another name would break the next run's lookup by the constant marker name, so the
    // rename is dropped and flagged.
    [
      "a rename moving the marker AWAY is refused (new_name stripped), not injected",
      { labels: [markerRenamedAway] },
      "rename-refused",
      [renameStripped],
    ],
    [
      "a rename to the marker (case-insensitive) is NOT treated as moving it away",
      { labels: [{ name: MARKER_LABEL, new_name: "Settings-As-Code-Report" }] },
      "unchanged",
      [{ name: MARKER_LABEL, new_name: "Settings-As-Code-Report" }],
    ],
    [
      "no labels section means nothing to inject",
      { repository: { has_wiki: false } },
      "unchanged",
      undefined,
    ],
  ])("%s", (_name, doc, outcome, labels) => {
    const before = structuredClone(doc);
    const result = injectMarkerLabel(doc);
    expect(result.outcome).toBe(outcome);
    // Strict: a key that is merely undefined (a wrapper's absent policy, a stripped new_name) is part of the shape.
    expect<unknown>(result.settings.labels).toStrictEqual(labels);
    // The input is never mutated; an unchanged document is handed back as the caller's own object.
    expect(doc).toStrictEqual(before);
    expect(Object.is(result.settings, doc)).toBe(outcome === "unchanged");
  });

  // applyMarkerInjection (src/report/delivery.ts) sends the injected document back through the validator and treats a
  // refusal as a defect on the strength of this property; the rename-refused arm, which writes an explicit
  // `new_name: undefined`, is the risky one.
  test.each<[outcome: Outcome, doc: SettingsFile]>([
    ["injected", { labels: [bug] }],
    ["injected", { labels: { _undeclared: "keep", entries: [bug] } }],
    ["unchanged", { labels: [{ name: MARKER_LABEL, color: "0e2a47" }] }],
    [
      "rename-refused",
      { labels: [{ name: MARKER_LABEL, new_name: "elsewhere", color: "0e2a47" }] },
    ],
    [
      "rename-refused",
      {
        labels: {
          _undeclared: "keep",
          entries: [{ name: MARKER_LABEL, new_name: "elsewhere", color: "0e2a47" }],
        },
      },
    ],
  ])("the %s outcome preserves document validity: %j", (expected, doc) => {
    const result = injectMarkerLabel(doc);
    expect(result.outcome).toBe(expected);
    const verdict = validateSettingsDoc(
      result.settings,
      "injected doc",
      SectionSelection.ALL,
      silentIo(),
    );
    expect(
      verdict.match(() => null, describeProblem),
      `outcome "${expected}" produced a document validation rejects`,
    ).toBeNull();
  });
});

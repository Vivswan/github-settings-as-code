import { describe, expect, test } from "bun:test";
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

const SLUG = "o/private-repo";
const LABEL_CREATE = "POST /repos/o/private-repo/labels";
const LABEL_LOOKUP =
  "GET /repos/o/private-repo/issues?state=all&labels=settings-as-code-report&per_page=100";
const ISSUE_CREATE = "POST /repos/o/private-repo/issues";
const CREATOR_SCAN =
  "GET /repos/o/private-repo/issues?state=all&creator=bot&sort=created&direction=asc&per_page=100&page=1";

const reportIssue = (number: number) => ({
  number,
  title: ISSUE_TITLE,
  state: "open",
  html_url: `https://github.com/o/private-repo/issues/${number}`,
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
    const lookups = api.calls.filter((c) => c.method === "GET");
    expect(lookups).toHaveLength(1);
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

  test("pull requests and other titles never match, even with the marker label", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: {
        data: [
          { ...reportIssue(1), pull_request: { url: "pr" } },
          { ...reportIssue(2), title: `${ISSUE_TITLE} (fork)` },
        ],
      },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    const create = api.calls.find((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(create?.payload).toEqual({ title: ISSUE_TITLE, body: "body", labels: [MARKER_LABEL] });
  });

  test("label-lookup miss runs the creator scan BEFORE any create, avoiding duplicates", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      // The label was stripped by a human; the scan still finds the issue.
      [CREATOR_SCAN]: { data: [reportIssue(3)] },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/3" });
    expect(api.calls.some((c) => `${c.method} ${c.path}` === ISSUE_CREATE)).toBe(false);
  });

  test("a fallback-scan hit without the marker reattaches it on the upsert PATCH", async () => {
    // The marker was stripped by a human; without relabeling here, every
    // future label-filtered lookup would miss this issue forever.
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [{ ...reportIssue(3), labels: ["bug"] }] },
      "PATCH /repos/o/private-repo/issues/3": { data: reportIssue(3) },
    });
    await deliverIssueReport(api, SLUG, "body", true, "always");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ body: "body", state: "open", labels: ["bug", MARKER_LABEL] });
  });

  test("an issue found by the label lookup is PATCHed without a labels field", async () => {
    // Human-added labels must never be clobbered: the normal upsert leaves
    // the labels alone (the marker is already attached - that is how the
    // lookup found it).
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
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [{ ...reportIssue(3), labels: [{ name: "bug" }] }] },
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

  test("the creator scan early-exits once a page contains the issue", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      number: 100 + i,
      title: i === 50 ? ISSUE_TITLE : `noise ${i}`,
      state: "closed",
      html_url: `https://github.com/o/private-repo/issues/${100 + i}`,
    }));
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: filler },
      "PATCH /repos/o/private-repo/issues/150": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/150" });
    // A full page came back, but the match stops the walk: no page=2 request.
    expect(api.calls.filter((c) => c.path.includes("page=2"))).toHaveLength(0);
  });

  test("nothing anywhere: POST with the marker label, then close when healthy", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
      "PATCH /repos/o/private-repo/issues/9": { data: null },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    const scanAt = api.calls.findIndex((c) => `${c.method} ${c.path}` === CREATOR_SCAN);
    const createAt = api.calls.findIndex((c) => `${c.method} ${c.path}` === ISSUE_CREATE);
    expect(scanAt).toBeGreaterThanOrEqual(0);
    expect(scanAt).toBeLessThan(createAt);
    const close = api.calls.find((c) => c.method === "PATCH");
    expect(close?.payload).toEqual({ state: "closed" });
  });

  test("a needs-attention first run creates the issue and leaves it open", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
      [ISSUE_CREATE]: { data: reportIssue(9) },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    expect(result).toEqual({ url: "https://github.com/o/private-repo/issues/9" });
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("a denied marker-label create is a safe warning and stops everything", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: {
        error: { status: 403, message: "Resource not accessible for o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 403");
    expect(result.warning).toContain('"Issues" (read and write)');
    expect(result.warning).not.toContain(SLUG);
    expect(api.calls).toHaveLength(1);
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
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 500");
    expect(result.warning).toContain("Re-run the workflow");
    expect(result.warning).not.toContain("Issues");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a throwing transport never escapes; the warning stays slug-free", async () => {
    // MockApi throws on unrouted mutations, standing in for a network-level
    // failure (GithubApi throws those with the path in the message).
    const api = new MockApi({});
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("could not deliver the private report");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a non-list lookup response is a warning, not a crash", async () => {
    const api = new MockApi({
      [LABEL_CREATE]: { error: { status: 422, message: "already_exists", body: "" } },
      [LABEL_LOOKUP]: { data: { message: "unexpected" } },
    });
    const result = await deliverIssueReport(api, SLUG, "body", true, "always");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("unexpected shape");
  });
});

describe("deliverIssueReport under mode: on-failure", () => {
  const OPEN_LOOKUP =
    "GET /repos/o/private-repo/issues?state=open&labels=settings-as-code-report&per_page=100";
  const OPEN_LOOKUP_PATH =
    "/repos/o/private-repo/issues?state=open&labels=settings-as-code-report&per_page=100";

  test("healthy with no open issue: exactly one read, zero writes, skipped", async () => {
    const api = new MockApi({ [OPEN_LOOKUP]: { data: [] } });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    expect(result).toEqual({ skipped: true });
    // the single open-issue lookup and nothing else: no label ensure-create,
    // no /user creator-scan fallback, no mutation of any kind
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

  test("a failing quiet-path lookup is a safe warning, never the slug", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { error: { status: 500, message: "boom o/private-repo", body: "" } },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 500");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a failing close-PATCH is a safe warning too", async () => {
    const api = new MockApi({
      [OPEN_LOOKUP]: { data: [reportIssue(7)] },
      "PATCH /repos/o/private-repo/issues/7": {
        error: { status: 403, message: "denied o/private-repo", body: "" },
      },
    });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("HTTP 403");
    expect(result.warning).not.toContain(SLUG);
  });

  test("a non-list quiet-path response is a warning, not a crash", async () => {
    const api = new MockApi({ [OPEN_LOOKUP]: { data: { message: "unexpected" } } });
    const result = await deliverIssueReport(api, SLUG, "body", false, "on-failure");
    if (!("warning" in result)) {
      throw new Error("expected a warning");
    }
    expect(result.warning).toContain("unexpected shape");
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
    // path 2: nothing anywhere -> ensure-create, lookup, creator scan, POST create
    const createRoutes = (): Record<string, Route> => ({
      [LABEL_CREATE]: { data: MARKER_LABEL_CONFIG },
      [LABEL_LOOKUP]: { data: [] },
      "GET /user": { data: { login: "bot" } },
      [CREATOR_SCAN]: { data: [] },
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
    expect(settings.labels).toHaveLength(1);
  });

  test("a wrapped labels section stays wrapped, keeping its undeclared policy", () => {
    // Injection must rebuild the operator's chosen shape: losing the wrapper
    // here would silently restore the labels default (delete) on the next run.
    const settings: SettingsFile = {
      labels: { undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("injected");
    expect(result.settings.labels).toEqual({
      undeclared: "keep",
      entries: [{ name: "bug", color: "d73a4a" }, MARKER_LABEL_CONFIG],
    });
    // input is not mutated
    expect(settings.labels).toEqual({
      undeclared: "keep",
      entries: [{ name: "bug", color: "d73a4a" }],
    });
  });

  test("a rename-refusal in a wrapped labels section rebuilds the wrapped form", () => {
    const settings: SettingsFile = {
      labels: {
        undeclared: "keep",
        entries: [{ name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" }],
      },
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("rename-refused");
    expect(result.settings.labels).toEqual({
      undeclared: "keep",
      entries: [{ name: MARKER_LABEL, new_name: undefined, color: "0e2a47" }],
    });
  });

  test("a bare wrapper (no policy key) stays bare - omission is preserved", () => {
    // Injection must not change the SHAPE of the operator's declaration: a
    // bare wrapper stays bare. In multi-repo mode the merge has already
    // resolved the policy before injection runs; in single-repo mode there
    // is no merge and the section handler resolves the default itself.
    // Materializing the key here would rewrite a declaration the user
    // wrote, for no gain on either path.
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
    // Renaming the marker to another name would break the next run's lookup by
    // the constant marker name, so the rename is dropped and flagged.
    const settings: SettingsFile = {
      labels: [{ name: MARKER_LABEL, new_name: "something-else", color: "0e2a47" }],
    };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("rename-refused");
    // the entry survives but its new_name is gone, so the marker keeps its name
    expect(result.settings.labels).toEqual([
      { name: MARKER_LABEL, new_name: undefined, color: "0e2a47" },
    ]);
    // input is not mutated
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

  test("no labels section means nothing to inject", () => {
    const settings: SettingsFile = { repository: { has_wiki: false } };
    const result = injectMarkerLabel(settings);
    expect(result.outcome).toBe("unchanged");
    expect(result.settings).toBe(settings);
  });
});

/**
 * The `issue` private-report channel: the unredacted report lands as one exact-titled issue on the private target repo,
 * the one GitHub-ACL-private channel a public run has under PAT auth. The body is REPLACED each run (prior reports stay
 * in the edit history) and the state mirrors the run: open needs attention, closed is all well.
 *
 * `issue`             -> written every run
 * `issue-on-failure`  -> created only when the run needs attention; a healthy run closes a still-open issue (body included) or touches nothing
 *
 * Shaped like a SectionModule (ENDPOINTS, a permission) so the mock routes, USED_PATHS, and the PAT prose pick it up,
 * but never registered in sections/registry.ts: report delivery is infrastructure that writes even in check mode.
 */

import type { RepoRef } from "../discovery/targets.js";
import type { ApiError, GithubClient } from "../github/api.js";
import { isPermissionError } from "../github/api.js";
import { paginate } from "../github/paginate.js";
import type { SettingsFile } from "../schema.js";
import { type EndpointDecl, expand } from "../sections/contract/endpoints.js";
import { grantFor, type SectionPermission } from "../sections/contract/permissions.js";
import { nameKey } from "../sections/labels/index.js";
import type { LabelConfig } from "../sections/labels/schema.js";
import type { UndeclaredPolicyList } from "../types.js";
import { REPORT_HEADING } from "./composer.js";

/** The lookup key: one exact-titled report issue per repo, forever reused. */
export const ISSUE_TITLE = "[automated] settings-as-code: private settings report";

/** Makes the lookup one indexed request; the search API is eventually consistent and separately throttled, so it is never used. */
export const MARKER_LABEL = "settings-as-code-report";

export const MARKER_LABEL_CONFIG = {
  name: MARKER_LABEL,
  color: "0e2a47",
  description: "managed by settings-as-code private reporting - do not remove",
} as const satisfies LabelConfig;

export const ISSUE_REPORT_PERMISSION: SectionPermission = { repo: ["issues"] };

export const ISSUE_REPORT_ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/issues",
    statuses: { 200: "the issue list (pull requests included)" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/issues",
    statuses: { 201: "report issue created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    statuses: { 200: "report issue updated" },
  },
  createLabel: {
    route: "POST /repos/{owner}/{repo}/labels",
    statuses: { 201: "marker label created", 422: "the marker label already exists" },
  },
} as const satisfies Record<string, EndpointDecl>;

export type IssueReportMode = "always" | "on-failure";

/** `skipped` is on-failure's healthy path: no open issue needed closing, so nothing was written. */
export type IssueDelivery = { url: string } | { skipped: true } | { warning: string };

/** Public-safe by construction: the HTTP status and generic advice only. The slug, the path, or the API message would land in public logs. */
function deliveryWarning(error: ApiError): { warning: string } {
  const advice = isPermissionError(error)
    ? `To fix, ${grantFor(ISSUE_REPORT_PERMISSION)} for the target repository, or set private-report: none`
    : "Re-run the workflow, or set private-report: none if it persists";
  return { warning: `could not deliver the private report (HTTP ${error.status}). ${advice}` };
}

/** Under the same public-safety rule: `what` is a route template or a structural fact, never the expanded path or response content. */
function malformedWarning(what: string): { warning: string } {
  return {
    warning: `could not deliver the private report: ${what}. Check the "api-version" input, or set private-report: none`,
  };
}

type ReportIssue = { number: number; url: string; labels: string[]; open: boolean };

/**
 * A candidate is one of the action's own reports: an issue (the list includes pull requests) with the exact title and
 * a body line starting with the report heading; the title alone matched an issue a human opened by hand. The label
 * names ride along so a fallback-scan hit can reattach the stripped marker without clobbering human-added labels.
 */
function reportCandidatesIn(items: unknown[]): ReportIssue[] {
  const candidates: ReportIssue[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const issue = item as Record<string, unknown>;
    if (issue.pull_request !== undefined || issue.title !== ISSUE_TITLE) {
      continue;
    }
    if (typeof issue.number !== "number" || !isReportBody(issue.body)) {
      continue;
    }
    const labels = Array.isArray(issue.labels)
      ? issue.labels.flatMap((label) => {
          if (typeof label === "string") {
            return [label];
          }
          const name = (label as { name?: unknown } | null)?.name;
          return typeof name === "string" ? [name] : [];
        })
      : [];
    candidates.push({
      number: issue.number,
      url: typeof issue.html_url === "string" ? issue.html_url : "",
      labels,
      open: issue.state === "open",
    });
  }
  return candidates;
}

function isReportBody(body: unknown): boolean {
  return (
    typeof body === "string" && body.split(/\r?\n/).some((line) => line.startsWith(REPORT_HEADING))
  );
}

/** Among several reports (a duplicate an earlier run left behind), the one still open wins, then the newest. */
function pickReportIssue(candidates: ReportIssue[]): ReportIssue | null {
  const ranked = [...candidates].sort(
    (a, b) => Number(b.open) - Number(a.open) || b.number - a.number,
  );
  return ranked[0] ?? null;
}

/**
 * Walks the issue list newest first, page by page, until a page carries a candidate, then picks among the candidates
 * seen; `lookup` names the query in the malformed warning without exposing the expanded path.
 */
async function findReportIssue(
  api: GithubClient,
  ref: { repo: RepoRef },
  query: Readonly<Record<string, string>>,
  lookup: string,
): Promise<{ found: ReportIssue | null } | { warning: string }> {
  const path = expand(ISSUE_REPORT_ENDPOINTS.list, ref, undefined, query);
  const page = await paginate(
    api,
    path,
    undefined,
    (items) => reportCandidatesIn(items).length > 0,
  );
  if ("error" in page) {
    return deliveryWarning(page.error);
  }
  if ("malformed" in page) {
    return malformedWarning(`${lookup} returned a non-list page`);
  }
  return { found: pickReportIssue(reportCandidatesIn(page.items)) };
}

/**
 * For a human-stripped marker label: scans every issue by title and runs BEFORE any create so a stripped label never
 * causes a duplicate. The creator is deliberately not a filter: a rotated PAT belongs to a different user, and a
 * creator-scoped scan under it would miss the issue and open a second one. The sort is GitHub's default, spelled out
 * so the scan walks the same end of the list as the label lookup.
 */
function fallbackScan(api: GithubClient, ref: { repo: RepoRef }) {
  return findReportIssue(
    api,
    ref,
    { state: "all", sort: "created", direction: "desc" },
    "the issue list (title scan)",
  );
}

/**
 * The label ensure-create and the title scan are skipped on purpose: both exist to keep a CREATE from duplicating, and
 * this path never creates. The cost: a human-stripped marker leaves a stale open issue until the next needs-attention run.
 */
async function closeIfOpen(
  api: GithubClient,
  ref: { repo: RepoRef },
  body: string,
): Promise<IssueDelivery> {
  const listed = await findReportIssue(
    api,
    ref,
    { state: "open", labels: MARKER_LABEL },
    "the open-issue lookup",
  );
  if ("warning" in listed) {
    return listed;
  }
  const found = listed.found;
  if (!found) {
    return { skipped: true };
  }
  const closed = await api.tryRequest(
    "PATCH",
    expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(found.number) }),
    { body, state: "closed" },
  );
  if ("error" in closed) {
    return deliveryWarning(closed.error);
  }
  return { url: found.url };
}

async function deliver(
  api: GithubClient,
  repo: RepoRef,
  body: string,
  needsAttention: boolean,
  mode: IssueReportMode,
): Promise<IssueDelivery> {
  const ref = { repo };
  if (mode === "on-failure" && !needsAttention) {
    return closeIfOpen(api, ref, body);
  }
  // A 422 means the marker label already exists.
  const label = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.createLabel, ref), {
    name: MARKER_LABEL_CONFIG.name,
    color: MARKER_LABEL_CONFIG.color,
    description: MARKER_LABEL_CONFIG.description,
  });
  if ("error" in label && label.error.status !== 422) {
    return deliveryWarning(label.error);
  }
  const listed = await findReportIssue(
    api,
    ref,
    { state: "all", labels: MARKER_LABEL },
    "the report-issue lookup",
  );
  if ("warning" in listed) {
    return listed;
  }
  let found = listed.found;
  // The PATCH leaves labels alone (a human may have added their own) unless the title scan found the issue with the
  // marker stripped: without reattaching it, every label-filtered lookup, the on-failure close included, misses forever.
  let relabel: string[] | undefined;
  if (!found) {
    const scanned = await fallbackScan(api, ref);
    if ("warning" in scanned) {
      return scanned;
    }
    found = scanned.found;
    if (found && !found.labels.includes(MARKER_LABEL)) {
      relabel = [...found.labels, MARKER_LABEL];
    }
  }
  const state = needsAttention ? "open" : "closed";
  if (found) {
    const updated = await api.tryRequest(
      "PATCH",
      expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(found.number) }),
      relabel ? { body, state, labels: relabel } : { body, state },
    );
    if ("error" in updated) {
      return deliveryWarning(updated.error);
    }
    return { url: found.url };
  }
  const created = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.create, ref), {
    title: ISSUE_TITLE,
    body,
    labels: [MARKER_LABEL],
  });
  if ("error" in created) {
    return deliveryWarning(created.error);
  }
  const issue = created.data as { number?: unknown; html_url?: unknown } | null;
  const url = typeof issue?.html_url === "string" ? issue.html_url : "";
  if (state === "closed") {
    // Creation cannot set the state, so a healthy first run closes right after.
    if (typeof issue?.number !== "number") {
      return malformedWarning(
        "the report issue was created but carried no issue number, so it could not be closed for this healthy run",
      );
    }
    const closed = await api.tryRequest(
      "PATCH",
      expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(issue.number) }),
      { state },
    );
    if ("error" in closed) {
      return deliveryWarning(closed.error);
    }
  }
  return { url };
}

/**
 * Never throws: report delivery is auxiliary, so every failure comes back as a public-safe warning and the run's result
 * stays untouched. `needsAttention` (failed, or check-mode drift: exactly what fails the run) opens the issue; a healthy
 * run closes it, or under `on-failure` closes only a still-open one.
 */
export async function deliverIssueReport(
  api: GithubClient,
  repo: RepoRef,
  body: string,
  needsAttention: boolean,
  mode: IssueReportMode,
): Promise<IssueDelivery> {
  try {
    return await deliver(api, repo, body, needsAttention, mode);
  } catch {
    // A throw is a network-level failure whose message embeds the request path (the private slug), so nothing from it may escape.
    return {
      warning:
        "could not deliver the private report: the request failed before an HTTP response arrived. Re-run the workflow, or set private-report: none if it persists",
    };
  }
}

/**
 * A declared `labels` section under the delete policy would DELETE the marker label an earlier run's report delivery
 * created, so the marker joins the declared set unless an entry already manages it. An entry renaming the marker AWAY
 * would break the next run's lookup, so its `new_name` is stripped instead ("rename-refused").
 */
export function injectMarkerLabel(settings: SettingsFile): {
  settings: SettingsFile;
  outcome: "unchanged" | "injected" | "rename-refused";
} {
  // Unwrapped here and rebuilt in the SAME form below, so the injection never rewrites the operator's chosen shape or policy.
  const declaration = settings.labels;
  const wrapped = !Array.isArray(declaration);
  const labels = wrapped
    ? declaration !== undefined && Array.isArray(declaration?.entries)
      ? declaration.entries
      : null
    : declaration;
  if (labels === null || !Array.isArray(labels)) {
    return { settings, outcome: "unchanged" };
  }
  const rebuild = (entries: LabelConfig[]): SettingsFile["labels"] =>
    wrapped ? { ...(declaration as UndeclaredPolicyList<LabelConfig>), entries } : entries;
  const marker = nameKey(MARKER_LABEL);
  const renamesMarkerAway = (label: LabelConfig): boolean =>
    nameKey(label.name) === marker &&
    label.new_name !== undefined &&
    nameKey(label.new_name) !== marker;
  if (labels.some(renamesMarkerAway)) {
    const guarded = labels.map((label) =>
      renamesMarkerAway(label) ? { ...label, new_name: undefined } : label,
    );
    return {
      settings: { ...settings, labels: rebuild(guarded) },
      outcome: "rename-refused",
    };
  }
  const declared = labels.some(
    (label) => nameKey(label.name) === marker || nameKey(label.new_name ?? label.name) === marker,
  );
  if (declared) {
    return { settings, outcome: "unchanged" };
  }
  return {
    settings: { ...settings, labels: rebuild([...labels, MARKER_LABEL_CONFIG]) },
    outcome: "injected",
  };
}

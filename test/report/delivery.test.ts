import { describe, expect, test } from "bun:test";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { parseRepoSlug, type RepoRef } from "../../src/discovery/targets.js";
import {
  type SectionOutcome,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { runOutcome } from "../../src/flows/deliver.js";
import { redactedChannel } from "../../src/flows/redact.js";
import { type Io, silentIo } from "../../src/io.js";
import { isPrivate, type Private } from "../../src/private.js";
import { describeProblem } from "../../src/problem.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import { REPORT_HEADING } from "../../src/report/composer.js";
import {
  applyMarkerInjection,
  openReportChannel,
  type PrivateReportChannel,
  type RedactedDetail,
  type ReportRunMeta,
} from "../../src/report/delivery.js";
import { MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import type { SettingsFile } from "../../src/schema.js";
import type { LabelConfig } from "../../src/sections/labels/schema.js";
import { captureIo } from "../io/capture.js";
import { MockApi } from "../mock-api.js";

const MARKER = "settings-as-code-report";
const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
const META: ReportRunMeta = {
  adminRepo: "admin/repo",
  runUrl: "https://example.com/run/1",
  mode: "check",
  timestamp: "2026-01-01T00:00:00.000Z",
};
const DRIFT: SectionOutcome[] = [
  { key: "repository", status: "drift", detail: ["description: CANARY-live -> CANARY-want"] },
];

/** A redacted target's sealed detail, closed through the real channel so the transcript is genuine. */
function sealed(slug: string, outcomes: SectionOutcome[]): Private<RedactedDetail> {
  const channel = redactedChannel(silentIo(), slug, "private repository #1");
  channel.io.log(`engine line for ${slug}`);
  const detail = channel.close({ outcomes });
  if (!isPrivate(detail)) {
    throw new Error("a redacted channel must close sealed");
  }
  return detail;
}

function repo(slug: string): RepoRef {
  return parseRepoSlug(slug)._unsafeUnwrap();
}

/** A drifting redacted target, concluded as a check-mode run (exit 1) or an apply (exit 0) would. */
function target(slug: string, exitCode: 0 | 1) {
  return {
    repo: repo(slug),
    display: "private repository #1",
    conclusion: runOutcome([{ result: "drift" }], exitCode === 1),
    detail: sealed(slug, DRIFT),
  };
}

/** The issue-channel routes: the marker label exists, issue 7 is found by label, and its PATCH is inspectable. */
function issueApi(overrides: ConstructorParameters<typeof MockApi>[0] = {}): MockApi {
  return new MockApi({
    "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
    [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100&page=1`]: {
      data: [
        {
          number: 7,
          title: ISSUE_TITLE,
          body: `${REPORT_HEADING} o/priv`,
          html_url: "https://github.com/o/priv/issues/7",
        },
      ],
    },
    "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
    ...overrides,
  });
}

function open(api: MockApi, channel: PrivateReportChannel, io: Io, uploader?: ArtifactUploader) {
  return openReportChannel(api, channel, META, "", io, uploader);
}

/** The writes that touched the report issue itself; the marker-label ensure-create is not one of them. */
function issueWrites(api: MockApi): string[] {
  return api
    .mutations()
    .filter((c) => c.path.startsWith("/repos/o/priv/issues"))
    .map((c) => `${c.method} ${c.path}`);
}

describe("the issue channel", () => {
  test("delivers the full unredacted report into the target's issue and opens it when the target's exit is 1", async () => {
    const api = issueApi();
    const { io, annotations, logs } = captureIo();
    const channel = open(api, "issue", io);
    await channel?.deliver(target("o/priv", 1));
    await channel?.flush();
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: string; state?: string };
    expect(payload.state).toBe("open");
    expect(payload.body).toContain("# settings-as-code private report: o/priv");
    expect(payload.body).toContain("CANARY-live");
    expect(payload.body).toContain("engine line for o/priv");
    expect(payload.body).toContain(META.runUrl);
    expect(annotations).toEqual([]);
    expect(logs).toEqual(["report: updated issue #7 in private repository #1"]);
  });

  test("the log line carries the issue number the API answered and the verb of the write path: PATCH is updated, POST is created", async () => {
    const patched = issueApi({
      [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100&page=1`]: {
        data: [{ number: 41, title: ISSUE_TITLE, body: `${REPORT_HEADING} o/priv` }],
      },
      "PATCH /repos/o/priv/issues/41": { data: { number: 41 } },
    });
    const updated = captureIo();
    await open(patched, "issue", updated.io)?.deliver(target("o/priv", 1));
    expect(issueWrites(patched)).toEqual(["PATCH /repos/o/priv/issues/41"]);
    expect(updated.logs).toEqual(["report: updated issue #41 in private repository #1"]);

    const posted = issueApi({
      [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100&page=1`]: { data: [] },
      "GET /repos/o/priv/issues?state=all&sort=created&direction=desc&per_page=100&page=1": {
        data: [],
      },
      "POST /repos/o/priv/issues": { data: { number: 12 } },
    });
    const created = captureIo();
    await open(posted, "issue", created.io)?.deliver(target("o/priv", 1));
    expect(issueWrites(posted)).toEqual(["POST /repos/o/priv/issues"]);
    expect(created.logs).toEqual(["report: created issue #12 in private repository #1"]);
  });

  test("a marker label the run creates gets its own line, ahead of the issue line; an existing label (422) gets none", async () => {
    const created = captureIo();
    await open(
      issueApi({ "POST /repos/o/priv/labels": { data: { name: MARKER } } }),
      "issue",
      created.io,
    )?.deliver(target("o/priv", 1));
    expect(created.logs).toEqual([
      `report: created label "${MARKER}" in private repository #1`,
      "report: updated issue #7 in private repository #1",
    ]);

    const existed = captureIo();
    await open(issueApi(), "issue", existed.io)?.deliver(target("o/priv", 1));
    expect(existed.logs).toEqual(["report: updated issue #7 in private repository #1"]);
  });

  test("a write that landed before a later failure is announced before the warning, so no landed write is silent", async () => {
    // The issue is created (#9), then the healthy close PATCH is denied.
    const api = issueApi({
      [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100&page=1`]: { data: [] },
      "GET /repos/o/priv/issues?state=all&sort=created&direction=desc&per_page=100&page=1": {
        data: [],
      },
      "POST /repos/o/priv/issues": { data: { number: 9 } },
      "PATCH /repos/o/priv/issues/9": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, events } = captureIo();
    await open(api, "issue", io)?.deliver(target("o/priv", 0));
    expect(events).toEqual([
      "log: report: created issue #9 in private repository #1",
      expect.stringMatching(
        /^annotate warning: private repository #1: could not deliver the private report \(HTTP 403\)/,
      ),
    ]);
    expect(events.join("\n")).not.toContain("o/priv");
  });

  test("a delivery failure is one warning naming the placeholder and the HTTP status, never the slug or message", async () => {
    const api = issueApi({
      "PATCH /repos/o/priv/issues/7": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, annotations, logs } = captureIo();
    await open(api, "issue", io)?.deliver(target("o/priv", 1));
    expect(annotations).toEqual([
      expect.stringMatching(
        /^warning: private repository #1: could not deliver the private report \(HTTP 403\)\. To fix, grant "Issues"/,
      ),
    ]);
    expect(annotations[0]).not.toContain("o/priv");
    expect(annotations[0]).not.toContain("Resource not accessible");
    // Nothing landed, so nothing is announced as delivered.
    expect(logs).toEqual([]);
  });

  test("a target whose slug did not parse gets one safe warning and no API traffic", async () => {
    const api = issueApi();
    const { io, annotations, logs } = captureIo();
    await open(api, "issue", io)?.deliver({ ...target("o/priv", 1), repo: null });
    expect(api.calls).toEqual([]);
    expect(annotations).toEqual([
      "warning: private repository #1: could not deliver the private report: the target name is not an owner/name repository slug, so there is no repository to hold the report issue",
    ]);
    expect(logs).toEqual([]);
  });

  test("issue-on-failure writes nothing for a healthy target with no open issue, and says so in the log", async () => {
    const api = issueApi({
      [`GET /repos/o/priv/issues?state=open&labels=${MARKER}&per_page=100&page=1`]: { data: [] },
    });
    const { io, annotations, logs } = captureIo();
    await open(api, "issue-on-failure", io)?.deliver({
      ...target("o/priv", 0),
      conclusion: runOutcome([{ result: "clean" }], true),
    });
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/o/priv/issues?state=open&labels=${MARKER}&per_page=100&page=1`,
    ]);
    expect(annotations).toEqual([]);
    expect(logs).toEqual(["report: nothing to deliver for private repository #1"]);
  });
});

describe("the artifact channel", () => {
  async function harness() {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }> = [];
    const uploader: ArtifactUploader = {
      async upload(name, file) {
        uploads.push({ name, file });
        return { uploaded: true as const };
      },
    };
    const decrypt = async (data: Uint8Array): Promise<string> => {
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      return decrypter.decrypt(data, "text");
    };
    return { recipient, uploader, uploads, decrypt };
  }

  test("accumulates every report and uploads ONE document on flush, each report under its placeholder heading", async () => {
    const { recipient, uploader, uploads, decrypt } = await harness();
    const { io, annotations } = captureIo();
    const channel = openReportChannel(new MockApi({}), "artifact", META, recipient, io, uploader);
    await channel?.deliver(target("o/a", 1));
    // The channel never addresses the target repository, so it mirrors even a target whose slug failed to parse.
    await channel?.deliver({ ...target("o/b", 0), repo: null, display: "private repository #2" });
    expect(uploads).toEqual([]);
    await channel?.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe("settings-as-code-private-report");
    expect(uploads[0]?.file.name).toBe("private-report.md.age");
    const document = await decrypt(uploads[0]?.file.data as Uint8Array);
    const headings = document
      .split("\n")
      .filter((line) => line.startsWith("<!-- private repository"));
    expect(headings).toEqual(["<!-- private repository #1 -->", "<!-- private repository #2 -->"]);
    expect(document.indexOf("private report: o/a")).toBeLessThan(
      document.indexOf("private report: o/b"),
    );
    expect(annotations).toEqual([]);
  });

  test("flush uploads nothing when no target delivered", async () => {
    const { recipient, uploader, uploads } = await harness();
    await openReportChannel(
      new MockApi({}),
      "artifact",
      META,
      recipient,
      silentIo(),
      uploader,
    )?.flush();
    expect(uploads).toEqual([]);
  });

  test("an upload failure is one warning naming the artifact service, never a slug or report content", async () => {
    const { recipient } = await harness();
    const uploader: ArtifactUploader = {
      async upload() {
        throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
      },
    };
    const { io, annotations } = captureIo();
    const channel = openReportChannel(new MockApi({}), "artifact", META, recipient, io, uploader);
    await channel?.deliver(target("o/priv", 1));
    await channel?.flush();
    expect(annotations).toEqual([
      "warning: could not upload the private report artifact: Unable to get the " +
        "ACTIONS_RUNTIME_TOKEN env variable. Re-run, or set private-report: none if " +
        "it persists",
    ]);
  });
});

describe("applyMarkerInjection", () => {
  // Branded through the REAL boundary, so an invalid fixture fails here instead of riding a cast into the injection.
  const validated = (doc: SettingsFile): ValidatedSettings => {
    const verdict = validateSettingsDoc(doc, "test fixture", SectionSelection.ALL, silentIo());
    if (verdict.isErr()) {
      throw new Error(`test fixture failed validation: ${describeProblem(verdict.error)}`);
    }
    return verdict.value;
  };
  const bug = { name: "bug", color: "d73a4a" };
  const marker = { name: MARKER, color: "0e2a47" };
  const INJECTED = expect.stringMatching(/^added the "settings-as-code-report" marker label /);
  const REFUSED = expect.stringMatching(
    /^refused to rename the "settings-as-code-report" marker label/,
  );

  // The validator resolves a bare list to its wrapper with the section default, so the injection meets the wrapper form.
  const resolved = (entries: LabelConfig[]): SettingsFile["labels"] => ({
    _undeclared: "delete",
    entries,
  });
  test.each<[string, SettingsFile, boolean, SettingsFile["labels"], unknown]>([
    ["off: untouched, no notice", { labels: [bug] }, false, resolved([bug]), undefined],
    [
      "on, no labels section: nothing to inject",
      { repository: { has_wiki: false } },
      true,
      undefined,
      undefined,
    ],
    [
      "on, marker absent: appended with a notice",
      { labels: [bug] },
      true,
      resolved([bug, MARKER_LABEL_CONFIG]),
      INJECTED,
    ],
    [
      "on, marker declared: no duplicate, no notice",
      { labels: [marker] },
      true,
      resolved([marker]),
      undefined,
    ],
    [
      "on, marker renamed away: the rename is dropped with its own notice",
      { labels: [{ ...marker, new_name: "something-else" }] },
      true,
      resolved([{ ...marker, new_name: undefined }]),
      REFUSED,
    ],
  ])("%s", (_name, doc, on, labels, notice) => {
    const settings = validated(doc);
    const result = applyMarkerInjection(settings, on);
    expect<unknown>(result.notice).toEqual(notice);
    expect<unknown>(result.settings.labels).toEqual(labels);
    expect(result.settings.repository).toEqual(settings.repository);
  });
});

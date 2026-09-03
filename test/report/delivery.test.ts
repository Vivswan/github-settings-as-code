import { describe, expect, test } from "bun:test";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { runOutcome } from "../../src/action/deliver.js";
import {
  type PrivateReportChannel,
  type RedactedDetail,
  redactedChannel,
} from "../../src/action/redact.js";
import { parseRepoSlug, type RepoRef } from "../../src/discovery/targets.js";
import {
  type SectionOutcome,
  type ValidatedSettings,
  validateSettingsDoc,
} from "../../src/engine/orchestrate.js";
import { type Io, maskRegistry } from "../../src/io.js";
import { isPrivate, type Private } from "../../src/private.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import {
  applyMarkerInjection,
  openReportChannel,
  type ReportRunMeta,
} from "../../src/report/delivery.js";
import { MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import type { SettingsFile } from "../../src/schema.js";
import { silentIo } from "../io-fake.js";
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

function recordingIo(): { io: Io; annotations: string[] } {
  const annotations: string[] = [];
  return {
    io: {
      ...silentIo(),
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      ...maskRegistry(() => {}),
    },
    annotations,
  };
}

/** A redacted target's sealed detail, closed through the real channel so the transcript is genuine. */
function sealed(slug: string, outcomes: SectionOutcome[]): Private<RedactedDetail> {
  const channel = redactedChannel(silentIo(), slug, "private repository #1");
  channel.io.log(`engine line for ${slug}`);
  const detail = channel.close(outcomes);
  if (!isPrivate(detail)) {
    throw new Error("a redacted channel must close sealed");
  }
  return detail;
}

function repo(slug: string): RepoRef {
  const parsed = parseRepoSlug(slug);
  if (parsed === null) {
    throw new Error(`test slug ${slug} must parse`);
  }
  return parsed;
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
    [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100`]: {
      data: [{ number: 7, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/7" }],
    },
    "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
    ...overrides,
  });
}

function open(api: MockApi, channel: PrivateReportChannel, io: Io, uploader?: ArtifactUploader) {
  return openReportChannel(api, channel, META, "", io, uploader);
}

describe("the issue channel", () => {
  test("delivers the full unredacted report into the target's issue and opens it when the target's exit is 1", async () => {
    const api = issueApi();
    const { io, annotations } = recordingIo();
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
  });

  test("a delivery failure is one warning naming the placeholder and the HTTP status, never the slug or message", async () => {
    const api = issueApi({
      "PATCH /repos/o/priv/issues/7": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, annotations } = recordingIo();
    await open(api, "issue", io)?.deliver(target("o/priv", 1));
    expect(annotations).toHaveLength(1);
    const warning = annotations[0] ?? "";
    expect(warning).toStartWith(
      "warning: private repository #1: could not deliver the private report",
    );
    expect(warning).toContain("HTTP 403");
    expect(warning).not.toContain("o/priv");
    expect(warning).not.toContain("Resource not accessible");
  });

  test("a target whose slug did not parse gets one safe warning and no API traffic", async () => {
    const api = issueApi();
    const { io, annotations } = recordingIo();
    await open(api, "issue", io)?.deliver({ ...target("o/priv", 1), repo: null });
    expect(api.calls).toEqual([]);
    expect(annotations).toEqual([
      "warning: private repository #1: could not deliver the private report: the target name is not an owner/name repository slug, so there is no repository to hold the report issue",
    ]);
  });

  test("issue-on-failure writes nothing for a healthy target with no open issue", async () => {
    const api = issueApi({
      [`GET /repos/o/priv/issues?state=open&labels=${MARKER}&per_page=100`]: { data: [] },
    });
    const { io, annotations } = recordingIo();
    await open(api, "issue-on-failure", io)?.deliver({
      ...target("o/priv", 0),
      conclusion: runOutcome([{ result: "clean" }], true),
    });
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/o/priv/issues?state=open&labels=${MARKER}&per_page=100`,
    ]);
    expect(annotations).toEqual([]);
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
    const { io, annotations } = recordingIo();
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
    const headings = document.match(/^<!-- .* -->$/gm);
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
    const { io, annotations } = recordingIo();
    const channel = openReportChannel(new MockApi({}), "artifact", META, recipient, io, uploader);
    await channel?.deliver(target("o/priv", 1));
    await channel?.flush();
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toStartWith("warning: could not upload the private report artifact");
    expect(annotations[0]).toContain("ACTIONS_RUNTIME_TOKEN");
    expect(annotations[0]).not.toContain("o/priv");
    expect(annotations[0]).not.toContain("CANARY");
  });
});

describe("applyMarkerInjection", () => {
  // Fixtures are branded through the REAL boundary, so an invalid one fails
  // here instead of riding a cast into the injection.
  const validated = (doc: SettingsFile): ValidatedSettings => {
    const verdict = validateSettingsDoc(doc, "test fixture", new Set(), silentIo());
    if ("error" in verdict) {
      throw new Error(`test fixture failed validation: ${verdict.error}`);
    }
    return verdict.settings;
  };
  const bug = { name: "bug", color: "d73a4a" };
  const marker = { name: MARKER, color: "0e2a47" };
  const INJECTED = `added the "${MARKER}" marker label to the managed labels so private reporting can reuse its issue; it is managed like any declared label`;
  const REFUSED = `refused to rename the "${MARKER}" marker label: private reporting reuses its issue by that exact name, so the rename was dropped`;

  test.each<[string, SettingsFile, boolean, SettingsFile["labels"], string | undefined]>([
    ["off: untouched, no notice", { labels: [bug] }, false, [bug], undefined],
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
      [bug, MARKER_LABEL_CONFIG],
      INJECTED,
    ],
    [
      "on, marker declared: no duplicate, no notice",
      { labels: [marker] },
      true,
      [marker],
      undefined,
    ],
    [
      "on, marker renamed away: the rename is dropped with its own notice",
      { labels: [{ ...marker, new_name: "something-else" }] },
      true,
      [{ ...marker, new_name: undefined }],
      REFUSED,
    ],
  ])("%s", (_name, doc, on, labels, notice) => {
    const settings = validated(doc);
    const result = applyMarkerInjection(settings, on);
    expect(result.notice).toBe(notice);
    expect(result.settings.labels).toEqual(labels);
    expect(result.settings.repository).toEqual(settings.repository);
  });
});

import { describe, expect, test } from "bun:test";
import {
  concludeRun,
  type Delivery,
  type DeliveryConfig,
  type Exposure,
  engineOutcome,
  failRun,
  runOutcome,
  type TargetResult,
  withDelivery,
} from "../../src/action/deliver.js";
import {
  type PrivateReportChannel,
  publicChannel,
  REDACTED_NOTE,
  redactedChannel,
  type TargetChannel,
} from "../../src/action/redact.js";
import { parseRepoSlug, type RepoRef } from "../../src/discovery/targets.js";
import type { RepoResult, SectionOutcome } from "../../src/engine/orchestrate.js";
import { type Io, maskRegistry } from "../../src/io.js";
import { isPrivate } from "../../src/private.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import { MockApi } from "../mock-api.js";

const MARKER = "settings-as-code-report";
const ISSUE_TITLE = "[automated] settings-as-code: private settings report";

/** Every channel of the port in one ordered event log, so a test pins the sequence, not one surface. */
function eventIo(): { io: Io; events: string[]; outputs: Record<string, string> } {
  const events: string[] = [];
  const outputs: Record<string, string> = {};
  return {
    io: {
      annotate: (level, message) => events.push(`${level}: ${message}`),
      log: (line) => events.push(`log: ${line}`),
      debug: () => {},
      summary: (markdown) => events.push(`summary: ${markdown.split("\n")[0]}`),
      output: (name, value) => {
        outputs[name] = value;
        events.push(`output ${name}=${value}`);
      },
      ...maskRegistry(() => {}),
    },
    events,
    outputs,
  };
}

/** A MockApi whose requests land in the same event log as the port's lines. */
class TracingApi extends MockApi {
  constructor(
    routes: ConstructorParameters<typeof MockApi>[0],
    private readonly events: string[],
  ) {
    super(routes);
  }
  override async tryRequest(
    ...args: Parameters<MockApi["tryRequest"]>
  ): ReturnType<MockApi["tryRequest"]> {
    this.events.push(`api ${args[0]} ${args[1]}`);
    return super.tryRequest(...args);
  }
}

function repo(slug: string): RepoRef {
  const parsed = parseRepoSlug(slug);
  if (parsed === null) {
    throw new Error(`test slug ${slug} must parse`);
  }
  return parsed;
}

const FAILED_LABELS: SectionOutcome[] = [
  {
    key: "labels",
    status: "failed",
    detail: ["POST /repos/o/priv/labels: 403 Forbidden"],
    httpStatus: 403,
  },
];
const outcome = (result: RepoResult, outcomes: SectionOutcome[] = []): TargetResult => ({
  result,
  outcomes,
});

const cfg = (privateReport: PrivateReportChannel, mode: "apply" | "check"): DeliveryConfig => ({
  mode,
  privateReport,
  reportPublicKey: "",
  selfSlug: "admin/repo",
  runUrl: "https://example.com/run/1",
});
const PRIVATE: Exposure = { kind: "redacted", visibility: "private" };
const SHOWN: Exposure = { kind: "shown" };

const issueRoutes = {
  "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
  [`GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100`]: {
    data: [{ number: 7, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/7" }],
  },
  "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
};

/** Open a delivery around `body` and hand back the events and API traffic the whole scope produced. */
async function delivered(
  config: DeliveryConfig,
  routes: ConstructorParameters<typeof MockApi>[0],
  body: (delivery: Delivery, io: Io, events: string[]) => Promise<void>,
  uploader?: ArtifactUploader,
) {
  const { io, events } = eventIo();
  const api = new TracingApi(routes, events);
  await withDelivery({ api, cfg: config, io, uploader }, (delivery) => body(delivery, io, events));
  return { api, events };
}

describe("runOutcome", () => {
  test.each<[RepoResult[], boolean, RepoResult, 0 | 1]>([
    [[], false, "applied", 0],
    [[], true, "clean", 0],
    [["applied", "clean"], false, "applied", 0],
    [["clean", "skipped", "applied"], false, "skipped", 0],
    [["clean", "partial"], false, "partial", 0],
    [["clean", "drift"], false, "drift", 0],
    [["clean", "drift"], true, "drift", 1],
    [["applied", "failed", "drift"], false, "failed", 1],
    [["clean", "failed"], true, "failed", 1],
  ])("%j in check=%p -> %s exits %i", (results, check, result, exitCode) => {
    const conclusion = runOutcome(
      results.map((r) => ({ result: r })),
      check,
    );
    expect([conclusion.result, conclusion.exitCode]).toEqual([result, exitCode]);
  });
});

describe("engineOutcome", () => {
  test("passes a run through, and turns a preflight denial into one channel line and a note", () => {
    const { io, events } = eventIo();
    const ran = { repo: "o/r", result: "applied" as const, outcomes: [], preflightDenied: [] };
    expect(engineOutcome(ran, io)).toEqual({ result: "applied", outcomes: [] });
    const denied = { ...ran, result: "failed" as const, preflightDenied: ["labels", "rulesets"] };
    expect(engineOutcome(denied, io)).toEqual({
      result: "failed",
      outcomes: [],
      note: "preflight denied 2 section(s); nothing was applied to this repository",
    });
    expect(events).toEqual([
      "error: preflight failed: the token cannot access 2 section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn to skip those sections",
    ]);
  });
});

describe("withDelivery", () => {
  test.each<[PrivateReportChannel, Exposure, boolean]>([
    ["none", PRIVATE, false],
    ["issue", PRIVATE, true],
    ["issue", { kind: "redacted", visibility: "internal" }, true],
    ["issue", { kind: "redacted", visibility: "unknown" }, false],
    ["issue", SHOWN, false],
    ["issue-on-failure", PRIVATE, true],
    ["artifact", PRIVATE, false],
  ])("under %s a %j target injects the marker: %p", async (channel, exposure, injects) => {
    await delivered(cfg(channel, "apply"), {}, async (delivery, io) => {
      const opened = { repo: repo("o/priv"), channel: publicChannel(io, "o/priv", true), exposure };
      await delivery.target(opened, async (injectsMarker) => {
        expect(injectsMarker).toBe(injects);
        return outcome("clean");
      });
    });
  });

  test("channel none: a redacted target closes sealed and speaks one closed-value line; a shown target closes open and stays silent", async () => {
    const { api } = await delivered(cfg("none", "apply"), {}, async (delivery, io, events) => {
      const hidden = redactedChannel(io, "o/priv", "private repository #1");
      hidden.io.annotate("error", "labels: POST /repos/o/priv/labels: 403 Forbidden");
      const redacted = await delivery.target(
        { repo: repo("o/priv"), channel: hidden, exposure: PRIVATE },
        async () => outcome("failed", FAILED_LABELS),
      );
      expect(redacted.display).toBe("private repository #1");
      expect(isPrivate(redacted.detail)).toBe(true);
      expect(events).toEqual([
        `error: private repository #1: failed - labels (403). ${REDACTED_NOTE}`,
      ]);

      events.length = 0;
      const shown = publicChannel(io, "o/pub", true);
      shown.io.annotate("error", "labels: 403 Forbidden");
      const open = await delivery.target(
        { repo: repo("o/pub"), channel: shown, exposure: SHOWN },
        async () => outcome("failed", FAILED_LABELS),
      );
      expect(open).toEqual({
        result: "failed",
        display: "o/pub",
        detail: { slug: "o/pub", outcomes: FAILED_LABELS, note: undefined },
      });
      // The engine's own line already carried the slug; delivery adds nothing.
      expect(events).toEqual(["error: o/pub: labels: 403 Forbidden"]);
    });
    expect(api.calls).toEqual([]);
  });

  test("channel issue: the report is delivered before the public line, withheld for an unproven target, and never carries the slug", async () => {
    const { api } = await delivered(
      cfg("issue", "check"),
      issueRoutes,
      async (delivery, io, events) => {
        const proven = redactedChannel(io, "o/priv", "private repository #1");
        await delivery.target(
          { repo: repo("o/priv"), channel: proven, exposure: PRIVATE },
          async () => outcome("drift", [{ key: "labels", status: "drift", detail: ["+ CANARY"] }]),
        );
        expect(events).toEqual([
          "api POST /repos/o/priv/labels",
          `api GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100`,
          "api PATCH /repos/o/priv/issues/7",
          `warning: private repository #1: drift - labels. ${REDACTED_NOTE}`,
        ]);

        events.length = 0;
        const unproven = redactedChannel(io, "o/maybe", "private repository #2");
        await delivery.target(
          {
            repo: repo("o/maybe"),
            channel: unproven,
            exposure: { kind: "redacted", visibility: "unknown" },
          },
          async () => outcome("clean"),
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toStartWith(
          "notice: private repository #2: visibility could not be verified",
        );
        expect(events.join("\n")).not.toContain("o/maybe");
      },
    );
    const patch = api.calls.find((c) => c.method === "PATCH");
    const payload = (patch?.payload ?? {}) as { body?: string; state?: string };
    // A check-mode drift fails the run, so the issue opens; the unproven target added no traffic.
    expect(payload.state).toBe("open");
    expect(payload.body).toContain("CANARY");
    expect(api.calls.every((c) => c.path.startsWith("/repos/o/priv/"))).toBe(true);
  });

  test("channel artifact: each target's public line is emitted as it closes, and the ONE upload follows them all when the scope ends", async () => {
    const uploads: string[] = [];
    let log: string[] = [];
    const uploader: ArtifactUploader = {
      async upload(name) {
        log.push(`upload ${name}`);
        uploads.push(name);
      },
    };
    const config = {
      ...cfg("artifact", "check"),
      reportPublicKey: "age1wshulnlu6mpa4rx54w6xs9kscqw7uqem3fh748xsrfyqusgmfv2qfca3qt",
    };
    const { api, events } = await delivered(
      config,
      {},
      async (delivery, io, events) => {
        log = events;
        for (const [slug, n] of [
          ["o/a", 1],
          ["o/b", 2],
        ] as const) {
          const channel = redactedChannel(io, slug, `private repository #${n}`);
          await delivery.target({ repo: repo(slug), channel, exposure: PRIVATE }, async () =>
            outcome("drift", [{ key: "labels", status: "drift", detail: [`+ ${slug}`] }]),
          );
        }
        expect(uploads).toEqual([]);
      },
      uploader,
    );
    expect(events).toEqual([
      `warning: private repository #1: drift - labels. ${REDACTED_NOTE}`,
      `warning: private repository #2: drift - labels. ${REDACTED_NOTE}`,
      "upload settings-as-code-private-report",
    ]);
    expect(uploads).toHaveLength(1);
    expect(api.calls).toEqual([]);
  });

  test("a body that throws still flushes what it accumulated, and the throw propagates", async () => {
    const uploads: string[] = [];
    const uploader: ArtifactUploader = {
      async upload(name) {
        uploads.push(name);
      },
    };
    const config = {
      ...cfg("artifact", "check"),
      reportPublicKey: "age1wshulnlu6mpa4rx54w6xs9kscqw7uqem3fh748xsrfyqusgmfv2qfca3qt",
    };
    await expect(
      delivered(
        config,
        {},
        async (delivery, io) => {
          const channel = redactedChannel(io, "o/a", "private repository #1");
          await delivery.target({ repo: repo("o/a"), channel, exposure: PRIVATE }, async () =>
            outcome("drift", [{ key: "labels", status: "drift", detail: ["+ x"] }]),
          );
          throw new Error("engine bug");
        },
        uploader,
      ),
    ).rejects.toThrow("engine bug");
    expect(uploads).toEqual(["settings-as-code-private-report"]);
  });
});

describe("concludeRun", () => {
  const applied: SectionOutcome = { key: "labels", status: "applied", detail: [] };
  const skipped: SectionOutcome = {
    key: "rulesets",
    status: "skipped",
    detail: [],
    httpStatus: 403,
  };

  test("single: the summary, the outputs, the result line, and the exit code, in that order", () => {
    const { io, events, outputs } = eventIo();
    const channel: TargetChannel = publicChannel(io, "o/r", false);
    const code = concludeRun(io, {
      kind: "single",
      mode: "check",
      target: {
        result: "drift",
        display: "o/r",
        detail: channel.close([{ key: "labels", status: "drift", detail: ["+ bug"] }, skipped]),
      },
    });
    expect(code).toBe(1);
    expect(outputs).toEqual({ "skipped-sections": "rulesets", result: "drift" });
    expect(events).toEqual([
      "summary: ## github-settings-as-code (check)",
      "output skipped-sections=rulesets",
      "output result=drift",
      "log: result: drift",
    ]);
  });

  test("multi: repos-result keys a redacted target by its placeholder, skipped sections dedupe across targets, worst-of decides", () => {
    const { io, events, outputs } = eventIo();
    const hidden = redactedChannel(io, "o/priv", "private repository #1");
    const shown = publicChannel(io, "o/pub", true);
    const code = concludeRun(io, {
      kind: "multi",
      mode: "apply",
      targets: [
        {
          source: "remote",
          result: "partial",
          display: shown.display,
          detail: shown.close([applied, skipped]),
        },
        {
          source: "central",
          result: "partial",
          display: hidden.display,
          detail: hidden.close([skipped], "note with o/priv inside"),
        },
      ],
    });
    expect(code).toBe(0);
    expect(JSON.parse(outputs["repos-result"] ?? "")).toEqual({
      "o/pub": { result: "partial", source: "remote", skippedSections: ["rulesets"] },
      "private repository #1": {
        result: "partial",
        source: "central",
        skippedSections: ["rulesets"],
      },
    });
    expect(outputs).toEqual({
      "repos-result": outputs["repos-result"] ?? "",
      "skipped-sections": "rulesets",
      result: "partial",
    });
    expect(events.map((e) => e.split("=")[0])).toEqual([
      "summary: ## github-settings-as-code (apply, 2 repositories)",
      "output repos-result",
      "output skipped-sections",
      "output result",
      "log: result: partial",
    ]);
    expect(events.join("\n")).not.toContain("o/priv");
  });

  test("failRun: the error line, then the conclusion a failed target gets, with no summary", () => {
    const { io, events, outputs } = eventIo();
    expect(failRun(io, "the token input is required")).toBe(1);
    expect(outputs).toEqual({ "skipped-sections": "", result: "failed" });
    expect(events).toEqual([
      "error: the token input is required",
      "output skipped-sections=",
      "output result=failed",
      "log: result: failed",
    ]);
  });
});

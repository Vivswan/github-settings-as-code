import { describe, expect, test } from "bun:test";
import { parseRepoSlug, type RepoRef } from "../../src/discovery/targets.js";
import type { RepoResult, SectionOutcome } from "../../src/engine/orchestrate.js";
import type { RunOutcome } from "../../src/engine/outcome.js";
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
} from "../../src/flows/deliver.js";
import {
  publicChannel,
  REDACTED_NOTE,
  redactedChannel,
  type TargetChannel,
} from "../../src/flows/redact.js";
import type { Io } from "../../src/io.js";
import { isPrivate } from "../../src/private.js";
import { describeProblem } from "../../src/problem.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import { REPORT_HEADING } from "../../src/report/composer.js";
import type { PrivateReportChannel } from "../../src/report/delivery.js";
import { captureIo } from "../io/capture.js";
import { MockApi } from "../mock-api.js";

const MARKER = "settings-as-code-report";
const ISSUE_TITLE = "[automated] settings-as-code: private settings report";

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
  return parseRepoSlug(slug)._unsafeUnwrap();
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
};

/** Open a delivery around `body` and hand back the events and API traffic the whole scope produced. */
async function delivered(
  config: DeliveryConfig,
  routes: ConstructorParameters<typeof MockApi>[0],
  body: (delivery: Delivery, io: Io, events: string[]) => Promise<void>,
  uploader?: ArtifactUploader,
) {
  const { io, events } = captureIo();
  const api = new TracingApi(routes, events);
  await withDelivery({ api, cfg: config, io, uploader }, (delivery) => body(delivery, io, events));
  return { api, events };
}

describe("runOutcome", () => {
  // The ranking is worstOf's (test/engine/outcome.test.ts); the rows here vary the exit rule over it.
  test.each<[RunOutcome[], boolean, RunOutcome, 0 | 1]>([
    [["applied", "clean"], false, "applied", 0],
    [["clean", "skipped", "applied"], false, "skipped", 0],
    [["clean", "partial"], true, "partial", 0],
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
  test("passes a run through when preflight denied nothing", () => {
    const { io, events } = captureIo();
    const ran = { repo: "o/r", result: "applied" as const, outcomes: [], preflightDenied: [] };
    expect(engineOutcome(ran, io)).toEqual({ result: "applied", outcomes: [] });
    expect(events).toEqual([]);
  });

  test.each<[string[], string]>([
    [["labels"], "1 section"],
    [["labels", "rulesets"], "2 sections"],
  ])(
    "turns a preflight denial of %j into one channel line and a note counting %s",
    (denied, count) => {
      const { io, events } = captureIo();
      const ran = { repo: "o/r", result: "failed" as const, outcomes: [], preflightDenied: denied };
      expect(engineOutcome(ran, io)).toEqual({
        result: "failed",
        outcomes: [],
        note: `preflight denied ${count}; nothing was applied to this repository`,
      });
      expect(events).toEqual([
        `annotate error: preflight failed: the token cannot access ${count}, so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
      ]);
    },
  );
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
    // The artifact channel opens only with an upload port; nothing is delivered here.
    const uploader: ArtifactUploader | undefined =
      channel === "artifact" ? { upload: async () => {} } : undefined;
    await delivered(
      cfg(channel, "apply"),
      {},
      async (delivery, io) => {
        const opened = {
          repo: repo("o/priv"),
          channel: publicChannel(io, "o/priv", true),
          exposure,
        };
        await delivery.target(opened, async (injectsMarker) => {
          expect(injectsMarker).toBe(injects);
          return outcome("clean");
        });
      },
      uploader,
    );
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
        `annotate error: private repository #1: failed - labels (403). ${REDACTED_NOTE}`,
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
      expect(events).toEqual(["annotate error: o/pub: labels: 403 Forbidden"]);
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
          `api GET /repos/o/priv/issues?state=all&labels=${MARKER}&per_page=100&page=1`,
          "api PATCH /repos/o/priv/issues/7",
          "log: report: updated issue #7 in private repository #1",
          `annotate warning: private repository #1: drift - labels. ${REDACTED_NOTE}`,
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
          "annotate notice: private repository #2: visibility could not be verified",
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
      `annotate warning: private repository #1: drift - labels. ${REDACTED_NOTE}`,
      `annotate warning: private repository #2: drift - labels. ${REDACTED_NOTE}`,
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
    const { io, events, outputs } = captureIo();
    const channel: TargetChannel = publicChannel(io, "o/r", false);
    const code = concludeRun(io, {
      kind: "single",
      mode: "check",
      target: {
        result: "drift",
        display: "o/r",
        detail: channel.close({
          outcomes: [{ key: "labels", status: "drift", detail: ["+ bug"] }, skipped],
        }),
      },
    });
    expect(code).toBe(1);
    expect(outputs).toEqual({
      result: "drift",
      "skipped-sections": "rulesets",
      "repos-result": "{}",
    });
    expect(events).toEqual([
      "summary: ## github-settings-as-code (check)",
      "output result=drift",
      "output skipped-sections=rulesets",
      "output repos-result={}",
      "log: result: drift",
    ]);
  });

  test("multi: repos-result keys a redacted target by its placeholder, skipped sections dedupe across targets, worst-of decides", () => {
    const { io, events, outputs } = captureIo();
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
          detail: shown.close({ outcomes: [applied, skipped] }),
        },
        {
          source: "central",
          result: "partial",
          display: hidden.display,
          detail: hidden.close({ outcomes: [skipped], note: "note with o/priv inside" }),
        },
      ],
    });
    expect(code).toBe(0);
    expect(JSON.parse(outputs["repos-result"] ?? "")).toEqual({
      "o/pub": { result: "partial", source: "remote", "skipped-sections": ["rulesets"] },
      "private repository #1": {
        result: "partial",
        source: "central",
        "skipped-sections": ["rulesets"],
      },
    });
    expect(outputs).toEqual({
      result: "partial",
      "skipped-sections": "rulesets",
      "repos-result": outputs["repos-result"] ?? "",
    });
    expect(events.map((e) => e.split("=")[0])).toEqual([
      "summary: ## github-settings-as-code (apply, 2 repositories)",
      "output result",
      "output skipped-sections",
      "output repos-result",
      "log: result: partial",
    ]);
    expect(events.join("\n")).not.toContain("o/priv");
  });

  test("failRun: the problem's line, then the conclusion a failed target gets, with no summary", () => {
    const { io, events, outputs } = captureIo();
    const problem = { code: "input-token-missing" } as const;
    expect(failRun(io, problem)).toBe(1);
    expect(outputs).toEqual({ result: "failed", "skipped-sections": "", "repos-result": "{}" });
    // The line is describeProblem's text, whole (its wording: test/problem.test.ts), placed before the outputs.
    expect(events).toEqual([
      `annotate error: ${describeProblem(problem)}`,
      "output result=failed",
      "output skipped-sections=",
      "output repos-result={}",
      "log: result: failed",
    ]);
  });
});

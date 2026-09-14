import { describe, expect, test } from "bun:test";
import {
  attempt,
  capturingIo,
  emitRedactedResult,
  openTargetChannel,
  planRedaction,
  privatePlaceholder,
  publicChannel,
  publicDetail,
  REDACTED_DETAIL,
  REDACTED_NOTE,
  redactedChannel,
  toPublicView,
} from "../../src/flows/redact.js";
import { type Io, maskRegistry, prefixedIo } from "../../src/io.js";
import { isPrivate, markPrivate } from "../../src/private.js";
import { captureIo } from "../io/capture.js";

/** A private-set predicate from a lowercase-keyed slug list. */
function privateSet(...slugs: string[]): (slug: string) => boolean {
  const set = new Set(slugs.map((s) => s.toLowerCase()));
  return (slug) => set.has(slug.toLowerCase());
}

describe("planRedaction", () => {
  test("numbers redacted targets 1-based in target order, keyed lowercase", () => {
    const plan = planRedaction(
      "redact",
      ["o/pub", "o/PrivA", "o/pub2", "o/privB"],
      [],
      privateSet("o/priva", "o/privb"),
      "admin/repo",
    );
    expect(plan.isRedacted("o/pub")).toBe(false);
    expect(plan.display("o/pub")).toBe("o/pub");
    expect(plan.isRedacted("o/PrivA")).toBe(true);
    expect(plan.display("o/PrivA")).toBe("private repository #1");
    expect(plan.isRedacted("o/privB")).toBe(true);
    expect(plan.display("o/privB")).toBe("private repository #2");
    expect(plan.display("O/PRIVA")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/PrivA", "o/privB"]);
  });

  test("a central and remote entry for the same slug share one placeholder", () => {
    const plan = planRedaction(
      "redact",
      ["o/priv", "o/PRIV"],
      [],
      privateSet("o/priv"),
      "admin/repo",
    );
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.display("o/PRIV")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("the self slug is never redacted (carve-out, case-insensitive)", () => {
    const plan = planRedaction(
      "redact",
      ["Admin/Repo", "o/priv"],
      [],
      privateSet("admin/repo", "o/priv"),
      "admin/repo",
    );
    expect(plan.isRedacted("Admin/Repo")).toBe(false);
    expect(plan.display("Admin/Repo")).toBe("Admin/Repo");
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("discovery-filtered privates are unsealed into the mask set but get no placeholder", () => {
    const plan = planRedaction(
      "redact",
      ["o/priv"],
      [markPrivate("o/filtered"), markPrivate("o/PRIV")],
      privateSet("o/priv"),
      "admin/repo",
    );
    expect(plan.maskedSlugs).toContain("o/filtered");
    expect(plan.maskedSlugs).toContain("o/priv");
    expect(plan.isRedacted("o/filtered")).toBe(false);
    expect(plan.display("o/filtered")).toBe("o/filtered");
    expect(plan.maskedSlugs.filter((s) => s.toLowerCase() === "o/priv")).toHaveLength(1);
  });

  test("the self slug is excluded from the masked set even as an extra private", () => {
    const plan = planRedaction(
      "redact",
      [],
      [markPrivate("admin/repo")],
      privateSet("admin/repo"),
      "admin/repo",
    );
    expect(plan.maskedSlugs).toEqual([]);
  });

  test("under show nothing is redacted or masked, whatever the visibility says", () => {
    const plan = planRedaction(
      "show",
      ["o/priv"],
      [markPrivate("o/filtered")],
      privateSet("o/priv", "o/filtered"),
      "admin/repo",
    );
    expect(plan.isRedacted("o/priv")).toBe(false);
    expect(plan.display("o/priv")).toBe("o/priv");
    expect(plan.maskedSlugs).toEqual([]);
  });
});

const outcomes = [
  {
    key: "repository" as const,
    status: "applied" as const,
    detail: ["changed description to SECRET"],
  },
  { key: "labels" as const, status: "failed" as const, detail: ["denied SECRET"], httpStatus: 403 },
  { key: "rulesets" as const, status: "drift" as const, detail: ["drifted SECRET"] },
];

describe("target channels", () => {
  test("a public channel emits in the clear with the slug prefix and closes with its detail open", () => {
    const { io, events } = captureIo();
    const channel = publicChannel(io, "o/pub", true);
    channel.io.annotate("error", "boom");
    channel.io.log("changed");
    channel.unprefixed.annotate(
      "warning",
      "ignoring unknown section in o/pub:.github/settings.yml",
    );
    expect(events).toEqual([
      "annotate error: o/pub: boom",
      "log: o/pub: changed",
      "annotate warning: ignoring unknown section in o/pub:.github/settings.yml",
    ]);
    const detail = channel.close({ outcomes, note: "n" });
    expect(isPrivate(detail)).toBe(false);
    expect(detail).toEqual({ slug: "o/pub", outcomes, note: "n" });
    expect(channel.display).toBe("o/pub");
  });

  test("a redacted channel captures every line and closes sealed with a transcript snapshot", () => {
    const { io, events } = captureIo();
    const channel = redactedChannel(io, "o/priv", "private repository #1");
    channel.io.annotate("error", "boom SECRET");
    channel.unprefixed.annotate("warning", "ignoring SECRET");
    channel.io.log("changed SECRET");
    channel.io.mask("o/priv");
    expect(events).toEqual(["mask: o/priv"]);
    const detail = channel.close({ outcomes });
    // A line written after the close never reaches the sealed transcript.
    channel.io.log("late SECRET");
    expect(detail).toEqual(
      markPrivate({
        slug: "o/priv",
        outcomes,
        note: undefined,
        transcript: [
          { level: "error", line: "boom SECRET" },
          { level: "warning", line: "ignoring SECRET" },
          { line: "changed SECRET" },
        ],
      }),
    );
    expect(channel.display).toBe("private repository #1");
  });

  test("the plan opens a redacted channel for a hidden slug and a prefixed public one otherwise", () => {
    const plan = planRedaction("redact", ["o/pub", "o/priv"], [], privateSet("o/priv"), "a/r");
    const { io, events } = captureIo();
    const pub = openTargetChannel(plan, io, "o/pub");
    const priv = openTargetChannel(plan, io, "o/priv");
    pub.io.log("visible");
    priv.io.log("hidden");
    expect(events).toEqual(["log: o/pub: visible"]);
    expect(pub.display).toBe("o/pub");
    expect(priv.display).toBe("private repository #1");
    expect(isPrivate(pub.close({ outcomes: [] }))).toBe(false);
    expect(isPrivate(priv.close({ outcomes: [] }))).toBe(true);
  });
});

describe("attempt", () => {
  const violation = "preflight: repository: PATCH /repos/o/priv was attempted in check mode";
  const crash = () => Promise.reject(new Error(violation));
  const failed = (message: string) => ({ result: "failed" as const, message });

  test("a crash on a redacted target is captured into its transcript and never emitted", async () => {
    const { io, events } = captureIo();
    const channel = redactedChannel(io, "o/priv", "private repository #1");
    expect(await attempt(channel, crash, failed)).toEqual({ result: "failed", message: violation });
    expect(events).toEqual([]);
    expect(channel.close({ outcomes: [] })).toEqual(
      markPrivate({
        slug: "o/priv",
        outcomes: [],
        note: undefined,
        transcript: [{ level: "error", line: violation }],
      }),
    );
  });

  test("the same crash in the clear is annotated in full, and a success passes through", async () => {
    const { io, events } = captureIo();
    const channel = publicChannel(io, "o/priv", true);
    await attempt(channel, crash, failed);
    expect(events).toEqual([`annotate error: o/priv: ${violation}`]);
    const ok = (): Promise<ReturnType<typeof failed>> =>
      Promise.resolve({ result: "failed", message: "not a crash" });
    expect(await attempt(channel, ok, failed)).toEqual({
      result: "failed",
      message: "not a crash",
    });
    expect(events).toHaveLength(1);
  });
});

describe("public projections", () => {
  const sealed = markPrivate({ slug: "o/priv", outcomes, note: "boom SECRET", transcript: [] });

  test("open detail passes through byte-identical", () => {
    expect(publicDetail({ slug: "o/pub", outcomes, note: "preflight denied 1 section" })).toEqual({
      outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
      note: "preflight denied 1 section",
    });
  });

  test("sealed detail keeps key+status, hides detail, appends HTTP code only on failed/skipped, and notes the redaction", () => {
    const view = publicDetail(sealed);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view).toEqual({
      outcomes: [
        { key: "repository", status: "applied", detail: ["hidden (private repository)"] },
        { key: "labels", status: "failed", detail: ["hidden (private repository), HTTP 403"] },
        { key: "rulesets", status: "drift", detail: ["hidden (private repository)"] },
      ],
      note: REDACTED_NOTE,
    });
  });

  test("toPublicView keys a target by its display label and projects its detail", () => {
    const view = toPublicView({
      source: "remote",
      result: "failed",
      display: "private repository #2",
      detail: sealed,
    });
    expect(view).toEqual({
      display: "private repository #2",
      source: "remote",
      result: "failed",
      ...publicDetail(sealed),
    });
  });

  test("a snapshot target's file path names the slug: hidden under the seal, passed through in the clear, absent when nothing was written", () => {
    const rows = [
      { key: "labels" as const, status: "snapshot" as const, detail: ["labels[hush]"] },
    ];
    const { io } = captureIo();
    const hidden = redactedChannel(io, "o/priv", privatePlaceholder(1));
    expect(
      publicDetail(hidden.close({ outcomes: rows, note: "written", file: "out/o/priv.yml" })),
    ).toEqual({
      outcomes: [{ key: "labels", status: "snapshot", detail: [REDACTED_DETAIL] }],
      note: REDACTED_NOTE,
      file: REDACTED_DETAIL,
    });
    const shown = publicChannel(io, "o/pub", true);
    expect(
      publicDetail(shown.close({ outcomes: rows, note: "written", file: "out/o/pub.yml" })),
    ).toEqual({
      outcomes: rows,
      note: "written",
      file: "out/o/pub.yml",
    });
    expect(publicDetail(hidden.close({ outcomes: [], note: "failed" }))).not.toHaveProperty("file");
    expect(publicDetail(shown.close({ outcomes: [], note: "failed" }))).not.toHaveProperty("file");
  });

  test.each([
    ["failed", "error: private repository #1: failed - labels (403). "],
    ["drift", "warning: private repository #1: drift - rulesets. "],
    // No row is skipped in this fixture, so the partial line carries no section list; the flow test in
    // test/flows/single.test.ts pins the `- labels (403)` form.
    ["partial", "warning: private repository #1: partial. "],
    ["skipped", "notice: private repository #1: skipped. "],
  ] as const)("emitRedactedResult on %s names only closed values", (result, head) => {
    const { io, events } = captureIo();
    emitRedactedResult(io, "private repository #1", result, sealed);
    expect(events).toEqual([`annotate ${head}${REDACTED_NOTE}`]);
  });

  test("emitRedactedResult says nothing for a healthy result", () => {
    const { io, events } = captureIo();
    emitRedactedResult(io, "private repository #1", "applied", sealed);
    emitRedactedResult(io, "private repository #1", "clean", sealed);
    expect(events).toEqual([]);
  });

  test("a sealed value cannot reach a public sink or a string template without a projection", () => {
    const { io, events } = captureIo();
    const slug = markPrivate("o/priv");
    // @ts-expect-error a Private<string> is not a string: io.log cannot take it
    io.log(slug);
    // @ts-expect-error nor can an annotation
    io.annotate("error", slug);
    // @ts-expect-error nor an action output
    io.output("result", slug);
    // @ts-expect-error nor the summary channel
    io.summary(slug);
    // The runtime shape is an opaque box: even forced through, the slug text is not what a sink would print.
    expect(`${slug}`).not.toContain("o/priv");
    expect(events.join("\n")).not.toContain("o/priv");
  });
});

describe("capturingIo", () => {
  test("suppresses public annotate/log but records them in order", () => {
    const { io: base, events } = captureIo();
    const { io, drain } = capturingIo(base);
    io.log("first");
    io.annotate("warning", "second");
    io.log("third");
    expect(events).toEqual([]);
    expect(drain()).toEqual([
      { line: "first" },
      { level: "warning", line: "second" },
      { line: "third" },
    ]);
  });

  test("the mask registry passes through; every other channel is dropped, not forwarded", () => {
    // The debug trace, summary, and outputs are the run's own, written elsewhere from the public view, so a stray write through the capture must
    // reach nowhere.
    const through: string[] = [];
    const base: Io = {
      annotate: () => {},
      log: () => {},
      debug: (line) => through.push(`debug ${line}`),
      summary: (markdown) => through.push(`summary ${markdown}`),
      output: (name, value) => through.push(`output ${name}=${value}`),
      ...maskRegistry((v) => through.push(`mask ${v}`)),
    };
    const { io, drain } = capturingIo(base);
    io.mask("o/secret");
    io.debug("GET /x -> 200 SECRET");
    io.summary("## SECRET");
    io.output("result", "SECRET");
    expect(through).toEqual(["mask o/secret"]);
    expect(io.masked()).toBe(base.masked());
    expect([...io.masked()]).toEqual(["o/secret"]);
    expect(drain()).toEqual([]);
  });
});

describe("prefixedIo", () => {
  test("prefixes annotate and log only; the other channels pass through raw", () => {
    const through: string[] = [];
    const base: Io = {
      annotate: (l, m) => through.push(`${l}: ${m}`),
      log: (line) => through.push(line),
      debug: (line) => through.push(`debug ${line}`),
      summary: (markdown) => through.push(`summary ${markdown}`),
      output: (name, value) => through.push(`output ${name}=${value}`),
      ...maskRegistry((v) => through.push(`mask ${v}`)),
    };
    const io = prefixedIo(base, "x/y: ");
    io.annotate("warning", "drift");
    io.log("changed");
    io.debug("GET /x -> 200");
    io.summary("## s");
    io.output("result", "drift");
    io.mask("o/secret");
    expect(through).toEqual([
      "warning: x/y: drift",
      "x/y: changed",
      "debug GET /x -> 200",
      "summary ## s",
      "output result=drift",
      "mask o/secret",
    ]);
    expect(io.masked()).toBe(base.masked());
    expect([...io.masked()]).toEqual(["o/secret"]);
  });
});

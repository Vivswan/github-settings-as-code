import { describe, expect, test } from "bun:test";
import {
  attempt,
  capturingIo,
  emitRedactedResult,
  openTargetChannel,
  planRedaction,
  publicChannel,
  publicDetail,
  REDACTED_NOTE,
  redactedChannel,
  toPublicView,
} from "../../src/action/redact.js";
import { type Io, maskRegistry, prefixedIo } from "../../src/io.js";
import { isPrivate, markPrivate } from "../../src/private.js";

/** The channels a test does not observe, spread into each fake sink. */
const idle: Pick<Io, "debug" | "summary" | "output"> = {
  debug: () => {},
  summary: () => {},
  output: () => {},
};

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
    // case-insensitive lookup finds the same placeholder
    expect(plan.display("O/PRIVA")).toBe("private repository #1");
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
    // the private non-self target still gets #1, not #2
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("public targets are neither redacted nor masked", () => {
    const plan = planRedaction("redact", ["o/a", "o/b"], [], privateSet(), "admin/repo");
    expect(plan.isRedacted("o/a")).toBe(false);
    expect(plan.maskedSlugs).toEqual([]);
  });

  test("discovery-filtered privates are unsealed into the mask set but get no placeholder", () => {
    const plan = planRedaction(
      "redact",
      ["o/priv"],
      [markPrivate("o/filtered"), markPrivate("o/PRIV")],
      privateSet("o/priv"),
      "admin/repo",
    );
    // filtered slug is masked
    expect(plan.maskedSlugs).toContain("o/filtered");
    expect(plan.maskedSlugs).toContain("o/priv");
    // but never placeholdered
    expect(plan.isRedacted("o/filtered")).toBe(false);
    expect(plan.display("o/filtered")).toBe("o/filtered");
    // the target already masked is not duplicated by the extra list
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

/** An Io recording every public emission, for the channel and projection tests. */
function recordingIo(): { io: Io; emitted: string[] } {
  const emitted: string[] = [];
  const io: Io = {
    ...idle,
    ...maskRegistry((v) => emitted.push(`mask ${v}`)),
    annotate: (level, message) => emitted.push(`${level}: ${message}`),
    log: (line) => emitted.push(line),
  };
  return { io, emitted };
}

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
    const { io, emitted } = recordingIo();
    const channel = publicChannel(io, "o/pub", true);
    channel.io.annotate("error", "boom");
    channel.io.log("changed");
    channel.unprefixed.annotate(
      "warning",
      "ignoring unknown section in o/pub:.github/settings.yml",
    );
    expect(emitted).toEqual([
      "error: o/pub: boom",
      "o/pub: changed",
      "warning: ignoring unknown section in o/pub:.github/settings.yml",
    ]);
    const detail = channel.close(outcomes, "n");
    expect(isPrivate(detail)).toBe(false);
    expect(detail).toEqual({ slug: "o/pub", outcomes, note: "n" });
    expect(channel.display).toBe("o/pub");
  });

  test("a redacted channel captures every line and closes sealed with a transcript snapshot", () => {
    const { io, emitted } = recordingIo();
    const channel = redactedChannel(io, "o/priv", "private repository #1");
    channel.io.annotate("error", "boom SECRET");
    channel.unprefixed.annotate("warning", "ignoring SECRET");
    channel.io.log("changed SECRET");
    channel.io.mask("o/priv");
    expect(emitted).toEqual(["mask o/priv"]);
    const detail = channel.close(outcomes);
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
    const { io, emitted } = recordingIo();
    const pub = openTargetChannel(plan, io, "o/pub");
    const priv = openTargetChannel(plan, io, "o/priv");
    pub.io.log("visible");
    priv.io.log("hidden");
    expect(emitted).toEqual(["o/pub: visible"]);
    expect(pub.display).toBe("o/pub");
    expect(priv.display).toBe("private repository #1");
    expect(isPrivate(pub.close([]))).toBe(false);
    expect(isPrivate(priv.close([]))).toBe(true);
  });
});

describe("attempt", () => {
  const violation = "preflight: repository: PATCH /repos/o/priv was attempted in check mode";
  const crash = () => Promise.reject(new Error(violation));
  const failed = (message: string) => ({ result: "failed" as const, message });

  test("a crash on a redacted target is captured into its transcript and never emitted", async () => {
    const { io, emitted } = recordingIo();
    const channel = redactedChannel(io, "o/priv", "private repository #1");
    expect(await attempt(channel, crash, failed)).toEqual({ result: "failed", message: violation });
    expect(emitted).toEqual([]);
    expect(channel.close([])).toEqual(
      markPrivate({
        slug: "o/priv",
        outcomes: [],
        note: undefined,
        transcript: [{ level: "error", line: violation }],
      }),
    );
  });

  test("the same crash in the clear is annotated in full, and a success passes through", async () => {
    const { io, emitted } = recordingIo();
    const channel = publicChannel(io, "o/priv", true);
    await attempt(channel, crash, failed);
    expect(emitted).toEqual([`error: o/priv: ${violation}`]);
    const ok = (): Promise<ReturnType<typeof failed>> =>
      Promise.resolve({ result: "failed", message: "not a crash" });
    expect(await attempt(channel, ok, failed)).toEqual({
      result: "failed",
      message: "not a crash",
    });
    expect(emitted).toHaveLength(1);
  });
});

describe("public projections", () => {
  const sealed = markPrivate({ slug: "o/priv", outcomes, note: "boom SECRET", transcript: [] });

  test("open detail passes through byte-identical", () => {
    expect(
      publicDetail({ slug: "o/pub", outcomes, note: "preflight denied 1 section(s)" }),
    ).toEqual({
      outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
      note: "preflight denied 1 section(s)",
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
      outcomes: [
        { key: "repository", status: "applied", detail: ["hidden (private repository)"] },
        { key: "labels", status: "failed", detail: ["hidden (private repository), HTTP 403"] },
        { key: "rulesets", status: "drift", detail: ["hidden (private repository)"] },
      ],
      note: REDACTED_NOTE,
    });
  });

  test.each([
    ["failed", "error: private repository #1: failed - labels (403). "],
    ["drift", "warning: private repository #1: drift - rulesets. "],
    ["skipped", "notice: private repository #1: skipped. "],
  ] as const)("emitRedactedResult on %s names only closed values", (result, head) => {
    const { io, emitted } = recordingIo();
    emitRedactedResult(io, "private repository #1", result, sealed);
    expect(emitted).toEqual([`${head}${REDACTED_NOTE}`]);
  });

  test("emitRedactedResult says nothing for a healthy result", () => {
    const { io, emitted } = recordingIo();
    emitRedactedResult(io, "private repository #1", "applied", sealed);
    emitRedactedResult(io, "private repository #1", "clean", sealed);
    expect(emitted).toEqual([]);
  });

  test("a sealed value cannot reach a public sink or a string template without a projection", () => {
    const { io, emitted } = recordingIo();
    const slug = markPrivate("o/priv");
    // @ts-expect-error a Private<string> is not a string: io.log cannot take it
    io.log(slug);
    // @ts-expect-error nor can an annotation
    io.annotate("error", slug);
    // @ts-expect-error nor an action output
    io.output("result", slug);
    // @ts-expect-error nor the summary channel
    io.summary(slug);
    // The runtime shape is an opaque box: even forced through, the slug text
    // is not what a sink would print.
    expect(`${slug}`).not.toContain("o/priv");
    expect(emitted.join("\n")).not.toContain("o/priv");
  });
});

describe("capturingIo", () => {
  test("suppresses public annotate/log but records them in order", () => {
    const emitted: string[] = [];
    const base: Io = {
      ...idle,
      ...maskRegistry(() => {}),
      annotate: (level, message) => emitted.push(`annotate ${level}: ${message}`),
      log: (line) => emitted.push(`log: ${line}`),
    };
    const { io, drain } = capturingIo(base);
    io.log("first");
    io.annotate("warning", "second");
    io.log("third");
    expect(emitted).toEqual([]);
    expect(drain()).toEqual([
      { line: "first" },
      { level: "warning", line: "second" },
      { line: "third" },
    ]);
  });

  test("the mask registry passes through; every other channel is dropped, not forwarded", () => {
    // A redacted target's sink must let nothing textual out: the debug trace,
    // summary, and outputs are the run's own, written elsewhere from the
    // public view, so a stray write through the capture reaches nowhere.
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

  test("composes as capturingIo(prefixedIo(io, display)): capture is per-target, mask stays raw", () => {
    // The plan wraps prefixedIo INSIDE capturingIo. capturingIo suppresses the
    // wrapped sink's emission entirely, so the prefix never reaches the base;
    // each target owns its own capture buffer, so the recorded lines need no
    // prefix to be attributable. mask still passes through to the base.
    const masks: string[] = [];
    const emitted: string[] = [];
    const base: Io = {
      ...idle,
      ...maskRegistry((v) => masks.push(v)),
      annotate: (l, m) => emitted.push(`${l}: ${m}`),
      log: (line) => emitted.push(line),
    };
    const { io, drain } = capturingIo(prefixedIo(base, "private repository #1: "));
    io.log("changed a label");
    io.mask("o/secret");
    expect(emitted).toEqual([]);
    expect(drain()).toEqual([{ line: "changed a label" }]);
    expect(masks).toEqual(["o/secret"]);
  });
});

describe("prefixedIo", () => {
  test("empty prefix returns the sink unchanged", () => {
    const base: Io = { ...idle, ...maskRegistry(() => {}), annotate: () => {}, log: () => {} };
    expect(prefixedIo(base, "")).toBe(base);
  });

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

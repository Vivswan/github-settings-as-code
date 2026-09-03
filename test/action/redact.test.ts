import { describe, expect, test } from "bun:test";
import { capturingIo, planRedaction } from "../../src/action/redact.js";
import { type Io, maskRegistry, prefixedIo } from "../../src/io.js";

/** A private-set predicate from a lowercase-keyed slug list. */
function privateSet(...slugs: string[]): (slug: string) => boolean {
  const set = new Set(slugs.map((s) => s.toLowerCase()));
  return (slug) => set.has(slug.toLowerCase());
}

describe("planRedaction", () => {
  test("numbers redacted targets 1-based in target order, keyed lowercase", () => {
    const plan = planRedaction(
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
    const plan = planRedaction(["o/priv", "o/PRIV"], [], privateSet("o/priv"), "admin/repo");
    expect(plan.display("o/priv")).toBe("private repository #1");
    expect(plan.display("o/PRIV")).toBe("private repository #1");
    expect(plan.maskedSlugs).toEqual(["o/priv"]);
  });

  test("the self slug is never redacted (carve-out, case-insensitive)", () => {
    const plan = planRedaction(
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
    const plan = planRedaction(["o/a", "o/b"], [], privateSet(), "admin/repo");
    expect(plan.isRedacted("o/a")).toBe(false);
    expect(plan.maskedSlugs).toEqual([]);
  });

  test("discovery-filtered privates are masked but get no placeholder", () => {
    const plan = planRedaction(
      ["o/priv"],
      ["o/filtered", "o/PRIV"],
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
    const plan = planRedaction([], ["admin/repo"], privateSet("admin/repo"), "admin/repo");
    expect(plan.maskedSlugs).toEqual([]);
  });
});

/** The channels a test does not observe, spread into each fake sink. */
const idle: Pick<Io, "debug" | "summary" | "output"> = {
  debug: () => {},
  summary: () => {},
  output: () => {},
};

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

  test("every other channel passes through to the base sink untouched", () => {
    // Only the public annotate/log lines are captured; the mask registry, the
    // debug trace, the summary, and the outputs are the run's, not the target's.
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
    io.debug("GET /x -> 200");
    io.summary("## s");
    io.output("result", "clean");
    expect(through).toEqual([
      "mask o/secret",
      "debug GET /x -> 200",
      "summary ## s",
      "output result=clean",
    ]);
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

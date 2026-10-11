import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { parseSettingsDoc } from "../../src/flows/settings-read.js";

/**
 * A document's source lines must never reach the log through the parser, so the whole outcome (result, warnings, stderr) is pinned. Warnings are
 * emitted on a later tick, so the capture drains one before it detaches.
 */
async function captureOutput<T>(
  fn: () => T,
): Promise<{ result: T; warnings: string[]; stderr: string }> {
  const warnings: string[] = [];
  let stderr = "";
  const onWarning = (warning: Error) => {
    warnings.push(`${warning.name}: ${warning.message}`);
  };
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  process.on("warning", onWarning);
  try {
    const result = fn();
    await new Promise((resolve) => setImmediate(resolve));
    return { result, warnings, stderr };
  } finally {
    process.off("warning", onWarning);
    process.stderr.write = originalWrite;
  }
}

const MARKER = "MARKER_VALUE_MUST_NOT_PRINT";

describe("parseSettingsDoc", () => {
  test("a document the parser warns on at its default log level parses to the same object and prints nothing", async () => {
    // An unresolved tag: the default log level would quote this line, value included, to stderr.
    expect(
      await captureOutput(() =>
        parseSettingsDoc(`repository:\n  description: !unknown ${MARKER}\n`),
      ),
    ).toEqual({
      result: ok({ repository: { description: MARKER } }),
      warnings: [],
      stderr: "",
    });
  });

  test("a plain document parses to its object; an empty one becomes {}", async () => {
    expect(
      await captureOutput(() => parseSettingsDoc("repository:\n  name: x\nlabels:\n  - name: a\n")),
    ).toEqual({
      result: ok({ repository: { name: "x" }, labels: [{ name: "a" }] }),
      warnings: [],
      stderr: "",
    });
    expect(await captureOutput(() => parseSettingsDoc(""))).toEqual({
      result: ok({}),
      warnings: [],
      stderr: "",
    });
  });

  test("a `<<: *base` merge key folds the anchored mapping into its entry instead of surviving as a literal key", async () => {
    // The Probot app's js-yaml resolved merge keys, so a migrated file relying on them would otherwise create the
    // second label with no color, no description, and a "<<" field riding the create payload.
    expect(
      await captureOutput(() =>
        parseSettingsDoc(
          [
            "labels:",
            "  - &base",
            "    name: bug",
            "    color: ff0000",
            "    description: Something broken",
            "  - <<: *base",
            "    name: defect",
            "",
          ].join("\n"),
        ),
      ),
    ).toEqual({
      result: ok({
        labels: [
          { name: "bug", color: "ff0000", description: "Something broken" },
          { name: "defect", color: "ff0000", description: "Something broken" },
        ],
      }),
      warnings: [],
      stderr: "",
    });
  });

  test.each([
    [
      "a syntax error",
      "labels: [oops, unclosed\n",
      /^YAMLParseError: Flow sequence in block collection/,
    ],
    // The parser reports this one while building the object, not while reading the source.
    ["an unresolved alias", "labels: *nowhere\n", /^ReferenceError: Unresolved alias .*: nowhere$/],
  ])(
    "%s fails through the error path, not a partial parse or a throw",
    async (_what, raw, reason) => {
      expect(await captureOutput(() => parseSettingsDoc(raw))).toEqual({
        result: err({ code: "yaml-invalid", reason: expect.stringMatching(reason) }),
        warnings: [],
        stderr: "",
      });
    },
  );

  // The parser resolves an alias into the node its own anchor opens as a cyclic object; the refusal names that anchor.
  test.each([
    ["a mapping aliased inside itself", "repository: &loop {self: *loop}\n", "loop"],
    [
      "a list aliased from inside one of its entries",
      "repository:\n  topics: &all\n    - name: a\n      nested: *all\n",
      "all",
    ],
    [
      "a merge key aliasing the mapping it sits in",
      "repository: &base\n  <<: *base\n  x: 1\n",
      "base",
    ],
    ["a cycle after an earlier legitimate alias", "a: &x {b: 1}\nc: &y {d: *x, e: *y}\n", "y"],
  ])(
    "%s is refused by anchor name, before the cyclic object exists",
    async (_what, raw, anchor) => {
      expect(await captureOutput(() => parseSettingsDoc(raw))).toEqual({
        result: err({
          code: "yaml-invalid",
          reason:
            `alias *${anchor} refers back into the node its anchor &${anchor} opens (a YAML alias cycle), ` +
            "which no settings document can carry. An alias may only reference a completed node: write " +
            "the value out again, or move the anchor to a sibling",
        }),
        warnings: [],
        stderr: "",
      });
    },
  );

  test("an alias to a completed node still resolves: a scalar shared by siblings, an entry repeated, an anchor redefined", async () => {
    const bug = { name: "bug", color: "ff0000" };
    const docs = { name: "docs", color: "0075ca" };
    expect(
      await captureOutput(() =>
        parseSettingsDoc(
          [
            "repository:",
            "  description: &d hello",
            "  homepage: *d",
            "labels:",
            "  - &base {name: bug, color: ff0000}",
            "  - *base",
            "  - &base {name: docs, color: 0075ca}",
            "  - *base",
            "",
          ].join("\n"),
        ),
      ),
    ).toEqual({
      result: ok({
        repository: { description: "hello", homepage: "hello" },
        labels: [bug, bug, docs, docs],
      }),
      warnings: [],
      stderr: "",
    });
  });
});

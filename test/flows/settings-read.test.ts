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

  test("a syntax error still fails through the error path, not a partial parse", async () => {
    const captured = await captureOutput(() => parseSettingsDoc("labels: [oops, unclosed\n"));
    expect(captured).toEqual({
      result: err({
        code: "yaml-invalid",
        reason: expect.stringMatching(/^YAMLParseError: Flow sequence in block collection/),
      }),
      warnings: [],
      stderr: "",
    });
  });
});

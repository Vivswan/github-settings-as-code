import { describe, expect, test } from "bun:test";
import { parseSettingsDoc } from "../../src/flows/settings-read.js";

/**
 * Runs `fn` while recording every process warning and every stderr write it
 * causes: a document's source lines must never reach the log through the
 * parser, so the whole outcome (result, warnings, stderr) is what a test pins.
 * Warnings are emitted on a later tick, so the capture drains one before it
 * detaches.
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

/**
 * A representative set of documents the yaml library parses successfully
 * while emitting a warning at its default log level (others exist, such as
 * an unsupported %YAML version); each warning quotes the offending source
 * line (the collection key, its stringified key), so each document carries
 * the marker there. The parse result is the one the library produced before
 * the warnings were silenced.
 */
const WARNING_DOCUMENTS: Array<{ name: string; raw: string; doc: unknown }> = [
  {
    name: "an unknown directive",
    raw: `%FOO ${MARKER}\n---\nlabels:\n  - name: a\n`,
    doc: { labels: [{ name: "a" }] },
  },
  {
    name: "an unresolved custom tag",
    raw: `repository:\n  description: !unknown ${MARKER}\n`,
    doc: { repository: { description: MARKER } },
  },
  {
    name: "a scalar tag on a collection",
    raw: `labels: !!str [${MARKER}]\n`,
    doc: { labels: [MARKER] },
  },
  {
    name: "an anchor ending in a colon",
    raw: `repository:\n  description: &desc: ${MARKER}\n  homepage: *desc:\n`,
    doc: { repository: { description: MARKER, homepage: MARKER } },
  },
  {
    name: "a collection used as a key",
    raw: `? [${MARKER}, b]\n: v\n`,
    doc: { [`[ ${MARKER}, b ]`]: "v" },
  },
];

describe("parseSettingsDoc", () => {
  test.each(WARNING_DOCUMENTS)(
    "a document with $name parses to the same object and prints nothing",
    async ({ raw, doc }) => {
      expect(await captureOutput(() => parseSettingsDoc(raw))).toEqual({
        result: { doc },
        warnings: [],
        stderr: "",
      });
    },
  );

  test("a plain document parses to its object; an empty one becomes {}", async () => {
    expect(
      await captureOutput(() => parseSettingsDoc("repository:\n  name: x\nlabels:\n  - name: a\n")),
    ).toEqual({
      result: { doc: { repository: { name: "x" }, labels: [{ name: "a" }] } },
      warnings: [],
      stderr: "",
    });
    expect(await captureOutput(() => parseSettingsDoc(""))).toEqual({
      result: { doc: {} },
      warnings: [],
      stderr: "",
    });
  });

  test("a syntax error still fails through the error path, not a partial parse", async () => {
    const captured = await captureOutput(() => parseSettingsDoc("labels: [oops, unclosed\n"));
    expect(captured).toEqual({
      result: {
        error: expect.stringMatching(/^YAMLParseError: Flow sequence in block collection/),
      },
      warnings: [],
      stderr: "",
    });
  });
});

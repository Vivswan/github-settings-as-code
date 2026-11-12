/**
 * The file-header gate (bun run check:headers): the first thing in every .ts file under src/ and .github/scripts/
 * is a `/**` block comment, a shebang line and blank lines apart. Whether that comment is a good header is review's
 * to judge, not this script's.
 *
 *   src/generated/                           -> skipped: a generator writes those files whole
 *   the commit hook (lefthook.yml)           -> runs this script
 *   test/scripts/check-file-headers.test.ts  -> runs it over the repository, so CI's test job carries the gate
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countNoun } from "../../src/text.js";
import { runMain } from "./lib/entry.js";

/** The directories the gate reads, repository-relative. */
const SOURCE_DIRS = ["src", ".github/scripts"];

/** The directory of whole-file generated TypeScript. */
const GENERATED_DIR = "src/generated/";

/** Anchored at the file's first character, so a comment after code is no header. */
const HEADER_OPENER = /^(?:#![^\n]*\n)?\s*\/\*\*/;

/** Whether `text` opens with a `/**` comment, an optional shebang line and blank lines apart. */
export function opensWithHeader(text: string): boolean {
  return HEADER_OPENER.test(text);
}

/** The gated files under `root` that do not open with a header, repository-relative and sorted. */
export function filesWithoutHeader(root: string): string[] {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
      .map((entry) => join(dir, entry))
      .filter((file) => file.endsWith(".ts") && !file.startsWith(GENERATED_DIR))
      .filter((file) => !opensWithHeader(readFileSync(join(root, file), "utf8"))),
  ).sort();
}

if (import.meta.main) {
  await runMain("check-file-headers", () => {
    const files = filesWithoutHeader(process.cwd());
    if (files.length > 0) {
      console.error(
        `check:headers: ${countNoun(files.length, "file opens", "files open")} without a header comment:\n  ${files.join("\n  ")}\n` +
          "Open each with a /** ... */ block comment saying what the file owns (CONTRIBUTING.md, Code conventions).",
      );
      return 1;
    }
    console.log("check:headers: every source file opens with a header comment");
  });
}

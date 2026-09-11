/**
 * The workflow-snippet version-pin sweep shared by the README and guides
 * tests: one home for the manifest read, the pre-release guard, the major
 * derivation, and the uses:-pin pattern, so the two tests cannot drift on
 * what counts as a pin. Callers keep their own file sets and messages.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** One stale workflow-snippet pin: where it sits and what it names. */
export interface StalePin {
  label: string;
  line: number;
  ref: string;
  text: string;
}

/**
 * Scan `files` for `uses:` pins of this action and report the current moving
 * major tag, the total pin count, and every pin naming anything else. Returns
 * null before the first release (manifest version 0.0.0), when no tag exists
 * and no pin can be right yet.
 */
export function stalePins(
  files: ReadonlyArray<{ label: string; text: string }>,
): { major: string; references: number; stale: StalePin[] } | null {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
  ) as Record<string, string>;
  const version = manifest["."] ?? "";
  if (version === "0.0.0") {
    return null;
  }
  const major = `v${version.split(".")[0]}`;
  let references = 0;
  const stale: StalePin[] = [];
  for (const file of files) {
    for (const [index, line] of file.text.split("\n").entries()) {
      for (const m of line.matchAll(/uses: Vivswan\/github-settings-as-code@(\S+)/g)) {
        references++;
        if (m[1] !== major) {
          stale.push({ label: file.label, line: index + 1, ref: m[1] ?? "", text: line.trim() });
        }
      }
    }
  }
  return { major, references, stale };
}

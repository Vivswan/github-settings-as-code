/**
 * The "is the fetched artifact on disk current?" decision behind `--when-stale` in trim-openapi.ts and
 * fetch-graphql-schema.ts: the test, test:e2e, and fuzz scripts run both in that mode first, so a fresh checkout fetches the
 * gitignored artifacts once and a current file costs no network. Each artifact records the URL it was fetched from,
 * which carries the pinned ref (and, for the spec, the API version), so a bumped pin regenerates it on the next run.
 * Mtimes cannot carry this decision: actions/cache restores yesterday's mtime under today's checkout, so every CI
 * run would look stale and refetch.
 */

import { readFileSync } from "node:fs";

export function whenStale(argv: readonly string[]): boolean {
  return argv.includes("--when-stale");
}

export function readArtifact(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** The root key the trimmed OpenAPI spec records its source URL under (an OpenAPI `x-` extension). */
export const SOURCE_KEY = "x-source-url";

/** Why the trimmed OpenAPI spec `raw` must be regenerated from `sourceUrl` with `usedPaths`, or null when current. */
export function specStaleness(
  raw: string | null,
  sourceUrl: string,
  usedPaths: readonly string[],
): string | null {
  if (raw === null) {
    return "the file is absent";
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return "the file is not valid JSON";
  }
  if (typeof doc !== "object" || doc === null) {
    return "the file is not a JSON object";
  }
  const { [SOURCE_KEY]: recorded, paths } = doc as Record<string, unknown>;
  if (recorded !== sourceUrl) {
    const from = typeof recorded === "string" ? recorded : "an unrecorded URL";
    return `it was trimmed from ${from}, the script fetches ${sourceUrl}`;
  }
  const have = typeof paths === "object" && paths !== null ? Object.keys(paths).sort() : [];
  const want = [...usedPaths].sort();
  if (have.length !== want.length || have.some((path, i) => path !== want[i])) {
    return "its paths differ from USED_PATHS";
  }
  return null;
}

/** The GraphQL sibling of specStaleness(): the source URL lives in the file's first line. */
export function schemaStaleness(raw: string | null, marker: string): string | null {
  if (raw === null) {
    return "the file is absent";
  }
  const firstLine = raw.split("\n", 1)[0] ?? "";
  if (firstLine !== marker) {
    return `its first line is ${JSON.stringify(firstLine)}, the script writes ${JSON.stringify(marker)}`;
  }
  return null;
}

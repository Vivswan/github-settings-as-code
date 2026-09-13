/**
 * The "is the fetched artifact on disk current?" decision behind `--when-stale` in trim-openapi.ts and
 * fetch-graphql-schema.ts: `bun run test` runs both scripts in that mode first, so a fresh checkout fetches the
 * gitignored artifacts once and a current file costs no network. Each artifact records the upstream ref it was cut
 * from, so bumping a script's pin regenerates it on the next run. Mtimes cannot carry this decision: actions/cache
 * restores yesterday's mtime under today's checkout, so every CI run would look stale and refetch.
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

/** The root key the trimmed OpenAPI spec records its upstream ref under (an OpenAPI `x-` extension). */
export const REF_KEY = "x-upstream-ref";

/** Why the trimmed OpenAPI spec `raw` must be regenerated for `ref` and `usedPaths`, or null when it is current. */
export function specStaleness(
  raw: string | null,
  ref: string,
  usedPaths: readonly string[],
): string | null {
  if (raw === null) {
    return "the file is absent";
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "the file is not valid JSON";
  }
  const recorded = doc[REF_KEY];
  if (recorded !== ref) {
    const from = typeof recorded === "string" ? recorded : "an unrecorded ref";
    return `it was trimmed from ${from}, the script pins ${ref}`;
  }
  const paths = doc.paths;
  const have = typeof paths === "object" && paths !== null ? Object.keys(paths).sort() : [];
  const want = [...usedPaths].sort();
  if (have.length !== want.length || have.some((path, i) => path !== want[i])) {
    return "its paths differ from USED_PATHS";
  }
  return null;
}

/** The GraphQL sibling of specStaleness(): the pin lives in the file's first line. */
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

/**
 * Fetches GitHub's public GraphQL schema to disk, the GraphQL sibling of trim-openapi.ts. This script is the ONLY
 * thing that touches the network; the output is a fetched, gitignored artifact.
 *   test/sections/graphql-queries.test.ts  -> loads it from disk
 *   local dev                              -> runs this once
 *   CI                                     -> restores it from cache, re-fetches on a miss
 *   UPSTREAM_REF                           -> PINNED to a github/docs commit, so two runs months apart fetch byte-identical text
 *
 * Run: `bun .github/scripts/fetch-graphql-schema.ts`; re-run after bumping UPSTREAM_REF.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSchema } from "graphql";
import { fetchTextWithRetry } from "./lib/fetch-retry.js";

const UPSTREAM_REF = "01f2174e1ab5d15d4946cfe96ef7dfb5c9a8b889";

/** fpt is the free-tier (github.com) flavor, the one the action targets. */
const SCHEMA_URL =
  `https://raw.githubusercontent.com/github/docs/${UPSTREAM_REF}` +
  "/src/graphql/data/fpt/schema.docs.graphql";

const OUT_PATH = join(import.meta.dir, "..", "..", "test", "e2e", "graphql", "schema.docs.graphql");

const FETCH_TIMEOUT_MS = 60_000;

async function main(): Promise<number> {
  console.log(`fetching ${SCHEMA_URL}`);
  const fetched = await fetchTextWithRetry("GraphQL schema", SCHEMA_URL, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    throw new Error(
      `failed to fetch the GraphQL schema: ${fetched.status} ${fetched.statusText} for ${SCHEMA_URL}. Check UPSTREAM_REF and the schema path`,
    );
  }
  const text = fetched.text;
  // A truncated download or a moved upstream file must fail HERE, not as an opaque parse error in the disk-only consumer.
  try {
    buildSchema(text);
  } catch (error) {
    throw new Error(
      `the fetched GraphQL schema from ${SCHEMA_URL} failed to parse: ${error instanceof Error ? error.message : String(error)}. The download may be truncated (re-run), or the upstream file changed shape (check UPSTREAM_REF)`,
    );
  }
  // Temp file then rename, so an aborted run leaves the previously written schema intact. The directory holds no
  // tracked file, so a fresh checkout must create it first.
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const tmpPath = `${OUT_PATH}.tmp`;
  writeFileSync(tmpPath, text);
  renameSync(tmpPath, OUT_PATH);
  const sizeKb = Math.round(Buffer.byteLength(text) / 1024);
  console.log(`wrote ${OUT_PATH} (${sizeKb} KB)`);
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

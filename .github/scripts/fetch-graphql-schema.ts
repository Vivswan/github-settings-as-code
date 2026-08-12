/**
 * Fetch GitHub's public GraphQL schema and write it to disk, the GraphQL
 * sibling of trim-openapi.ts. The query-validation unit test
 * (test/sections/graphql-queries.test.ts) loads the schema from disk - never
 * the network - so test runs stay hermetic and fast; this script is the ONLY
 * thing that touches the network. The output is a FETCHED, gitignored
 * artifact (a multi-MB generated blob kept out of history): local devs run
 * this once, and CI restores it from actions/cache or re-fetches on a miss.
 *
 * Run: `bun .github/scripts/fetch-graphql-schema.ts` (writes the schema in
 * place). Re-run to adopt a newer upstream ref.
 *
 * The upstream ref is PINNED to a github/docs commit SHA (the docs pipeline
 * publishes the schema at src/graphql/data/fpt/schema.docs.graphql and
 * updates it continuously on main), so two runs months apart fetch
 * byte-identical schema text - the same reproducibility contract as
 * trim-openapi's UPSTREAM_REF.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSchema } from "graphql";
import { fetchTextWithRetry } from "./lib/fetch-retry.js";

/**
 * The github/docs commit the schema is fetched at. Bump this (and re-run) to
 * adopt upstream schema changes; pinning to a SHA keeps the output
 * reproducible.
 */
const UPSTREAM_REF = "01f2174e1ab5d15d4946cfe96ef7dfb5c9a8b889";

/** The free-tier (github.com) schema, the flavor the action targets. */
const SCHEMA_URL =
  `https://raw.githubusercontent.com/github/docs/${UPSTREAM_REF}` +
  "/src/graphql/data/fpt/schema.docs.graphql";

const OUT_PATH = join(import.meta.dir, "..", "..", "test", "e2e", "graphql", "schema.docs.graphql");

/** Abandon a fetch attempt if the (large) schema has not arrived in this long. */
const FETCH_TIMEOUT_MS = 60_000;

async function main(): Promise<number> {
  console.log(`fetching ${SCHEMA_URL}`);
  // Per-attempt timeout plus bounded retry (lib/fetch-retry.ts): a hung
  // connection or a transient blip - even mid-download - fails loudly with
  // advice instead of the script stalling forever, or one blip failing the
  // whole CI gate.
  const fetched = await fetchTextWithRetry("GraphQL schema", SCHEMA_URL, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    throw new Error(
      `failed to fetch the GraphQL schema: ${fetched.status} ${fetched.statusText} for ${SCHEMA_URL}. Check UPSTREAM_REF and the schema path`,
    );
  }
  const text = fetched.text;
  // Integrity at generation, the assertRefFree analog: a truncated download
  // or a moved upstream file must fail HERE, not as an opaque parse error in
  // the disk-only consumer.
  try {
    buildSchema(text);
  } catch (error) {
    throw new Error(
      `the fetched GraphQL schema from ${SCHEMA_URL} failed to parse: ${error instanceof Error ? error.message : String(error)}. The download may be truncated (re-run), or the upstream file changed shape (check UPSTREAM_REF)`,
    );
  }
  // Atomic write: serialize to a temp file, then rename over the target, so
  // an aborted run leaves the previously written schema intact. The directory
  // holds no tracked file, so a fresh checkout must create it first.
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

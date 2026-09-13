/**
 * The --when-stale decision both fetch scripts share: pure over the file's text, so no test touches the network or
 * the real artifacts. The absent/current pairs are the positive cases; each stale reason is its own negative control.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readArtifact,
  SOURCE_KEY,
  schemaStaleness,
  specStaleness,
  whenStale,
} from "../../.github/scripts/lib/fetched-artifact.js";
import { withTempDir } from "../temp-dir.js";

const URL =
  "https://raw.githubusercontent.com/github/rest-api-description/16bc535a/api.2022-11-28.deref.json";
const OTHER_URL = URL.replace("2022-11-28", "2025-01-01");
const PATHS = ["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/labels"];

function spec(sourceUrl: unknown, paths: readonly string[]): string {
  const doc: Record<string, unknown> = {
    openapi: "3.0.3",
    paths: Object.fromEntries(paths.map((p) => [p, {}])),
  };
  if (sourceUrl !== undefined) {
    doc[SOURCE_KEY] = sourceUrl;
  }
  return JSON.stringify(doc);
}

describe("whenStale", () => {
  test("is the --when-stale flag anywhere in argv", () => {
    expect(whenStale(["bun", "script.ts", "--when-stale"])).toBe(true);
    expect(whenStale(["bun", "script.ts"])).toBe(false);
  });
});

describe("readArtifact", () => {
  test("returns the text of a present file and null for an absent one", () =>
    withTempDir("fetched-artifact-", (dir) => {
      const path = join(dir, "artifact.txt");
      expect(readArtifact(path)).toBeNull();
      writeFileSync(path, "hello\n");
      expect(readArtifact(path)).toBe("hello\n");
    }));
});

describe("specStaleness", () => {
  test("a spec trimmed from the source URL with exactly USED_PATHS is current, in any path order", () => {
    expect(specStaleness(spec(URL, PATHS), URL, PATHS)).toBeNull();
    expect(specStaleness(spec(URL, [...PATHS].reverse()), URL, PATHS)).toBeNull();
  });

  test.each<[string, string | null, string]>([
    ["an absent file", null, "the file is absent"],
    ["invalid JSON", "{", "the file is not valid JSON"],
    ["a JSON null root", "null", "the file is not a JSON object"],
    ["a JSON string root", '"spec"', "the file is not a JSON object"],
    [
      "another URL (a different API version)",
      spec(OTHER_URL, PATHS),
      `it was trimmed from ${OTHER_URL}, the script fetches ${URL}`,
    ],
    [
      "no recorded URL",
      spec(undefined, PATHS),
      `it was trimmed from an unrecorded URL, the script fetches ${URL}`,
    ],
    ["a missing path", spec(URL, PATHS.slice(1)), "its paths differ from USED_PATHS"],
    ["an extra path", spec(URL, [...PATHS, "/user"]), "its paths differ from USED_PATHS"],
    ["no paths object", JSON.stringify({ [SOURCE_KEY]: URL }), "its paths differ from USED_PATHS"],
  ])("%s is stale (negative control)", (_, raw, reason) => {
    expect(specStaleness(raw, URL, PATHS)).toBe(reason);
  });
});

describe("schemaStaleness", () => {
  const marker = "# https://raw.githubusercontent.com/github/docs/01f2174e/schema.docs.graphql";

  test("a schema whose first line is the marker is current", () => {
    expect(schemaStaleness(`${marker}\ntype Query { a: Int }\n`, marker)).toBeNull();
  });

  test.each<[string, string | null, string]>([
    ["an absent file", null, "the file is absent"],
    [
      "a file without the marker",
      "type Query { a: Int }\n",
      `its first line is "type Query { a: Int }", the script writes ${JSON.stringify(marker)}`,
    ],
    [
      "another URL",
      "# https://raw.githubusercontent.com/github/docs/00000000/schema.docs.graphql\ntype Query { a: Int }\n",
      `its first line is "# https://raw.githubusercontent.com/github/docs/00000000/schema.docs.graphql", the script writes ${JSON.stringify(marker)}`,
    ],
  ])("%s is stale (negative control)", (_, raw, reason) => {
    expect(schemaStaleness(raw, marker)).toBe(reason);
  });
});

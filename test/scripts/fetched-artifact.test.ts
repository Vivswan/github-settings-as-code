/**
 * The --when-stale decision both fetch scripts share: pure over the file's text, so no test touches the network or
 * the real artifacts. The absent/current pairs are the positive cases; each stale reason is its own negative control.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REF_KEY,
  readArtifact,
  schemaStaleness,
  specStaleness,
  whenStale,
} from "../../.github/scripts/lib/fetched-artifact.js";
import { withTempDir } from "../temp-dir.js";

const REF = "16bc535ad66fac59d585b1516d1d52f58f787962";
const PATHS = ["/repos/{owner}/{repo}", "/repos/{owner}/{repo}/labels"];

function spec(ref: unknown, paths: readonly string[]): string {
  const doc: Record<string, unknown> = {
    openapi: "3.0.3",
    paths: Object.fromEntries(paths.map((p) => [p, {}])),
  };
  if (ref !== undefined) {
    doc[REF_KEY] = ref;
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
  test("a spec trimmed from the pinned ref with exactly USED_PATHS is current, in any path order", () => {
    expect(specStaleness(spec(REF, PATHS), REF, PATHS)).toBeNull();
    expect(specStaleness(spec(REF, [...PATHS].reverse()), REF, PATHS)).toBeNull();
  });

  test.each<[string, string | null, string]>([
    ["an absent file", null, "the file is absent"],
    ["invalid JSON", "{", "the file is not valid JSON"],
    ["another ref", spec("0000000", PATHS), `it was trimmed from 0000000, the script pins ${REF}`],
    [
      "no recorded ref",
      spec(undefined, PATHS),
      `it was trimmed from an unrecorded ref, the script pins ${REF}`,
    ],
    ["a missing path", spec(REF, PATHS.slice(1)), "its paths differ from USED_PATHS"],
    ["an extra path", spec(REF, [...PATHS, "/user"]), "its paths differ from USED_PATHS"],
    ["no paths object", JSON.stringify({ [REF_KEY]: REF }), "its paths differ from USED_PATHS"],
  ])("%s is stale (negative control)", (_, raw, reason) => {
    expect(specStaleness(raw, REF, PATHS)).toBe(reason);
  });
});

describe("schemaStaleness", () => {
  const marker = "# github/docs@01f2174e1ab5d15d4946cfe96ef7dfb5c9a8b889";

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
      "another ref",
      "# github/docs@0000000\ntype Query { a: Int }\n",
      `its first line is "# github/docs@0000000", the script writes ${JSON.stringify(marker)}`,
    ],
  ])("%s is stale (negative control)", (_, raw, reason) => {
    expect(schemaStaleness(raw, marker)).toBe(reason);
  });
});

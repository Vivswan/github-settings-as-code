/**
 * docs/reference/semantics.md restates the retry model the GitHub client
 * implements; pin its numbers to the client's own constants so the prose
 * cannot drift from the code.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_RETRIES, MAX_RETRY_WAIT_S } from "../../src/github/api.js";

const ROOT = join(import.meta.dir, "..", "..");
const semantics = readFileSync(join(ROOT, "docs", "reference", "semantics.md"), "utf8").replace(
  /\s+/g,
  " ",
);

// The written-out counts the prose uses; extend deliberately when the retry
// budget outgrows it (the lookup failing IS the tripwire).
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five"] as const;

describe("semantics.md retry prose", () => {
  test("the retry count and the wait cap derive from the api client's constants", () => {
    const word = COUNT_WORDS[MAX_RETRIES];
    if (word === undefined) {
      throw new Error("extend COUNT_WORDS: MAX_RETRIES outgrew the lookup");
    }
    expect(
      semantics.includes(`up to ${word} retries`),
      `the page must say "up to ${word} retries" (MAX_RETRIES is ${MAX_RETRIES})`,
    ).toBe(true);
    expect(
      semantics.includes(`a reset more than ${MAX_RETRY_WAIT_S} seconds away fails loudly`),
      `the page must say a reset more than ${MAX_RETRY_WAIT_S} seconds away fails loudly (MAX_RETRY_WAIT_S is ${MAX_RETRY_WAIT_S})`,
    ).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/action/inputs.js";

/**
 * parseConfig() reads inputs from the INPUT_* environment (via
 * @actions/core), so each test sets exactly the env it needs and the
 * afterEach restores every touched key.
 */
const ENV_KEYS = [
  "INPUT_TOKEN",
  "INPUT_REPOSITORY",
  "INPUT_REQUIRED-SECTIONS",
  "INPUT_SECTIONS",
  "GITHUB_REPOSITORY",
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function setEnv(inputs: Record<string, string>): void {
  process.env.INPUT_TOKEN = "t";
  process.env.INPUT_REPOSITORY = "o/r";
  delete process.env["INPUT_REQUIRED-SECTIONS"];
  delete process.env.INPUT_SECTIONS;
  for (const [key, value] of Object.entries(inputs)) {
    process.env[`INPUT_${key.toUpperCase()}`] = value;
  }
}

describe("required-sections x sections cross-validation", () => {
  test("rejects a required section excluded by the sections allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "repository" });
    const parsed = parseConfig();
    if (!("error" in parsed)) {
      throw new Error("expected a rejection");
    }
    expect(parsed.error).toContain('the "required-sections" entry "labels" is excluded');
    expect(parsed.error).toContain('Add it to the "sections" input');
  });

  test("names every excluded required section at once", () => {
    setEnv({ "required-sections": "labels,milestones,repository", sections: "repository" });
    const parsed = parseConfig();
    if (!("error" in parsed)) {
      throw new Error("expected a rejection");
    }
    expect(parsed.error).toContain('entries "labels", "milestones" are excluded');
    expect(parsed.error).not.toContain('"repository"');
  });

  test("accepts required sections inside the allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "labels,repository" });
    const parsed = parseConfig();
    expect("error" in parsed).toBe(false);
  });

  test("an empty sections input restricts nothing, so any required section passes", () => {
    setEnv({ "required-sections": "labels" });
    const parsed = parseConfig();
    expect("error" in parsed).toBe(false);
  });

  test("unknown-name validation still wins over the cross-check", () => {
    setEnv({ "required-sections": "nope", sections: "repository" });
    const parsed = parseConfig();
    if (!("error" in parsed)) {
      throw new Error("expected a rejection");
    }
    expect(parsed.error).toContain('unknown section "nope" in the "required-sections" input');
  });
});

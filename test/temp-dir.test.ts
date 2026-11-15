import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "./temp-dir.js";

describe("withTempDir", () => {
  // Without it, a test comparing its path with one a tool printed (tsc, git) fails only where the temp root is a symlink, as on macOS.
  test("the body gets the directory's real path", () =>
    withTempDir("temp-dir-real-", (dir) => {
      expect(dir).toBe(realpathSync(dir));
    }));

  // Without it, a failing test would leave its directory behind and nothing else in the suite would notice.
  test("a body that fails still leaves nothing behind", async () => {
    let seen = "";
    const failed = withTempDir("temp-dir-fail-", (dir) => {
      seen = dir;
      writeFileSync(join(dir, "file.txt"), "kept until the body ends");
      return Promise.reject(new Error("the body failed"));
    });
    await expect(failed).rejects.toThrow("the body failed");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packedTarball, withTempDirs } from "../../.github/scripts/package-smoke.js";

describe("package smoke helpers", () => {
  test("withTempDirs removes every directory after a successful body", async () => {
    let seen: string[] = [];
    const value = await withTempDirs("gsac-smoke-test-", 2, (dirs) => {
      seen = dirs;
      for (const dir of dirs) {
        writeFileSync(join(dir, "file.txt"), "x");
      }
      return "done";
    });
    expect(value).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen.map((dir) => existsSync(dir))).toEqual([false, false]);
  });

  test("withTempDirs removes every directory when the body throws", async () => {
    let seen: string[] = [];
    await expect(
      withTempDirs("gsac-smoke-test-", 1, (dirs) => {
        seen = dirs;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen).toHaveLength(1);
    expect(seen.map((dir) => existsSync(dir))).toEqual([false]);
  });

  test("packedTarball reads npm 11's array and npm 12's keyed object", () => {
    const entry = { filename: "vivswan-github-settings-as-code-2.0.0.tgz" };
    expect(packedTarball(JSON.stringify([entry]), "/dest")).toBe(
      "/dest/vivswan-github-settings-as-code-2.0.0.tgz",
    );
    expect(
      packedTarball(JSON.stringify({ "@vivswan/github-settings-as-code": entry }), "/dest"),
    ).toBe("/dest/vivswan-github-settings-as-code-2.0.0.tgz");
  });

  test("packedTarball rejects anything but exactly one tarball", () => {
    for (const output of [
      "[]",
      "{}",
      JSON.stringify([{}]),
      JSON.stringify([{ filename: "a" }, { filename: "b" }]),
    ]) {
      expect(() => packedTarball(output, "/dest"), output).toThrow("exactly one tarball");
    }
  });
});

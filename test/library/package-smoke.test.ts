import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packedTarball, withSmokeDirs } from "../../.github/scripts/package-smoke.js";

describe("package smoke helpers", () => {
  test("withSmokeDirs hands out pack/ and consumer/ under one root and removes the root after the body", async () => {
    let seen = { pack: "", consumer: "" };
    const value = await withSmokeDirs("gsac-smoke-test-", (dirs) => {
      seen = dirs;
      writeFileSync(join(dirs.pack, "file.txt"), "x");
      writeFileSync(join(dirs.consumer, "file.txt"), "x");
      return "done";
    });
    expect(value).toBe("done");
    expect(dirname(seen.pack)).toBe(dirname(seen.consumer));
    expect([seen.pack.endsWith("/pack"), seen.consumer.endsWith("/consumer")]).toEqual([
      true,
      true,
    ]);
    expect(existsSync(dirname(seen.pack))).toBe(false);
  });

  test("withSmokeDirs removes the root when the body throws", async () => {
    let seen = { pack: "", consumer: "" };
    await expect(
      withSmokeDirs("gsac-smoke-test-", (dirs) => {
        seen = dirs;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen.pack).not.toBe("");
    expect(existsSync(dirname(seen.pack))).toBe(false);
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

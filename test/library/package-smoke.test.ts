import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  packArguments,
  packedTarball,
  withSmokeDirs,
} from "../../.github/scripts/package-smoke.js";
import { withTempDir } from "../temp-dir.js";

/** Room for the `npm pack` below: 1 to 3 s as a rule, and past bun's 5 s default on a slow runner. */
const NPM_PACK_TIMEOUT = 30_000;

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
    const root = dirname(seen.pack);
    expect(seen).toEqual({ pack: join(root, "pack"), consumer: join(root, "consumer") });
    expect(existsSync(root)).toBe(false);
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

  test(
    "npm pack under the smoke's arguments prints the JSON alone for a package whose prepare script prints",
    () =>
      withTempDir("gsac-pack-test-", (dir) => {
        // Without --foreground-scripts=false an npm that runs `prepare` under --ignore-scripts (npm 10) puts what the
        // script prints ahead of the JSON. CI packs with npm 11, which skips prepare, so its smoke job cannot see it.
        const pkg = join(dir, "pkg");
        const destination = join(dir, "out");
        mkdirSync(pkg);
        mkdirSync(destination);
        writeFileSync(
          join(pkg, "package.json"),
          JSON.stringify({
            name: "prints-on-prepare",
            version: "1.0.0",
            scripts: { prepare: "echo sync hooks" },
          }),
        );
        const stdout = execFileSync("npm", packArguments(destination), {
          cwd: pkg,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const tarball = packedTarball(stdout, destination);
        expect(tarball).toBe(join(destination, "prints-on-prepare-1.0.0.tgz"));
        expect(existsSync(tarball)).toBe(true);
      }),
    NPM_PACK_TIMEOUT,
  );

  test("packedTarball rejects anything but exactly one tarball", () => {
    for (const output of [
      "[]",
      JSON.stringify([{}]),
      JSON.stringify([{ filename: "a" }, { filename: "b" }]),
    ]) {
      expect(() => packedTarball(output, "/dest"), output).toThrow("exactly one tarball");
    }
  });
});

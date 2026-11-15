/**
 * The action runs on node24, which has no Uint8Array.fromBase64, so @scure/base decodes there with its pure-JS
 * decoder; Bun has the builtin, so every other test here takes the native one. Without this file the decoder
 * every user runs could turn looser than libsodium, or stop reading a GitHub sealing key, with CI green.
 * @scure/base picks its decoder once, at import, so only a fresh process whose preload removes the builtin
 * reaches the pure-JS one.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../root.js";
import { withTempDir } from "../../temp-dir.js";

const SUITE = join("test", "sections", "shared", "sealed-box.test.ts");

const PRELOAD = [
  'Reflect.deleteProperty(Uint8Array, "fromBase64");',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the template is the child's source, not this file's.
  'console.error(`preload: Uint8Array.fromBase64 is ${typeof Reflect.get(Uint8Array, "fromBase64")}`);',
].join("\n");

test(
  "sealed-box.test.ts passes on @scure/base's pure-JS base64 decoder, the one node24 runs",
  () =>
    withTempDir("sealed-box-fallback-", (dir) => {
      const preload = join(dir, "preload.ts");
      writeFileSync(preload, PRELOAD);
      const run = spawnSync(process.execPath, ["test", "--preload", preload, SUITE], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const summary = Bun.stripANSI(run.stderr);
      expect(summary).toContain("preload: Uint8Array.fromBase64 is undefined");
      expect(summary).toMatch(/^ *[1-9]\d* pass$/m);
      expect(summary).toMatch(/^ *0 fail$/m);
      expect(run.status).toBe(0);
    }),
  60_000,
);

/**
 * The streams the CLI tests hand the program: everything written is kept, so
 * a test reads stdout and stderr back as text; runCli drives main() over them.
 */

import { Writable } from "node:stream";
import { main } from "../../src/cli/program.js";
import type { ConfigEnv, GithubClient } from "../../src/index.js";
import { MockApi } from "../mock-api.js";

export interface MemoryStream {
  readonly stream: Writable;
  text(): string;
}

export function memoryStream(): MemoryStream {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** Run `args` (after the program name) through main() against `api`, capturing what it printed. */
export async function runCli(
  args: readonly string[],
  api: GithubClient = new MockApi({}),
  env: ConfigEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await main(["node", "gsac", ...args], {
    host: { env, createClient: () => api },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: false,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

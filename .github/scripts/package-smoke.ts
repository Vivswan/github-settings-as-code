/**
 * The package smoke, the gate behind the npm library build: build lib/pkg/,
 * judge the package shape (publint, attw), pack a tarball, install it into a
 * fresh consumer project, import it under Node (the entry and the schema
 * subpath), and compile a TypeScript consumer against the bundled index.d.ts
 * with skipLibCheck off - a declaration that leaks a devDependency type, or a
 * type the emitter could not name, fails here instead of on a consumer's
 * machine. The installed bin is run under Node too: its help must name every
 * subcommand, and `validate` must accept a small settings file.
 *
 * Usage: `bun .github/scripts/package-smoke.ts` from anywhere; the temp
 * directory is removed on every path, failure included.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_COMMANDS } from "../../src/cli/program.js";
import { SECTION_KEYS } from "../../src/schema.js";

/** This script lives at .github/scripts/, two levels below the repository root. */
const REPO_ROOT = join(import.meta.dir, "..", "..");

const PACKAGE = "@vivswan/github-settings-as-code";

/**
 * The node that runs the consumer. The build tooling (tsdown) needs a newer
 * node than the engines floor package.json advertises, so CI builds on the
 * PATH node and names the floor's binary here for the consumer alone.
 */
const CONSUMER_NODE = process.env.SMOKE_CONSUMER_NODE ?? "node";

/** The `$id` the committed schema publishes; the schema subpath must serve that document. */
const SCHEMA_ID =
  "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/HEAD/lib/settings.schema.json";

/**
 * The consumer's runtime import. The section list and the schema id are
 * pinned from this checkout's source, so the tarball's bundle must expose
 * exactly what src/ declares, not merely something.
 */
const NODE_CONSUMER = `import { deepStrictEqual } from "node:assert/strict";
import { SECTION_KEYS, validateSettings } from "${PACKAGE}";
import schema from "${PACKAGE}/settings.schema.json" with { type: "json" };
const result = validateSettings({ labels: [] });
if (result.isErr()) throw new Error("validateSettings rejected an empty labels list: " + result.error.code);
deepStrictEqual(result.value, { settings: { labels: [] }, warnings: [] });
deepStrictEqual([...SECTION_KEYS], ${JSON.stringify(SECTION_KEYS)});
deepStrictEqual(schema.$id, ${JSON.stringify(SCHEMA_ID)});
console.log("imported " + SECTION_KEYS.length + " section keys and the schema");
`;

/** The consumer compiled against index.d.ts: a value and a type from the entry, both used. */
const TS_CONSUMER = `import { SECTION_KEYS, type SectionKey, validateSettings } from "${PACKAGE}";
const first: SectionKey | undefined = SECTION_KEYS[0];
const result = validateSettings({ labels: [] });
export const ok: boolean = result.isOk() && first === "repository";
`;

/** The settings file the installed CLI validates: one section, valid as written. */
const SETTINGS_FILE = "labels:\n  - name: bug\n    color: d73a4a\n";

/** Run a command to completion in `cwd`, streaming its output; a non-zero exit throws. */
function run(command: string, args: string[], cwd: string): void {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** Run a command and return its stdout. */
function capture(command: string, args: string[], cwd: string): string {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export interface SmokeDirs {
  readonly pack: string;
  readonly consumer: string;
}

export async function withSmokeDirs<T>(
  prefix: string,
  body: (dirs: SmokeDirs) => Promise<T> | T,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const dirs: SmokeDirs = { pack: join(root, "pack"), consumer: join(root, "consumer") };
    mkdirSync(dirs.pack);
    mkdirSync(dirs.consumer);
    return await body(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The tarball `npm pack --json` reports, as an absolute path. npm 11 prints a
 * one-element array, npm 12 an object keyed by package name; both are read.
 */
export function packedTarball(packJson: string, destination: string): string {
  const parsed = JSON.parse(packJson) as unknown;
  const entries = Array.isArray(parsed)
    ? (parsed as Array<{ filename?: string }>)
    : Object.values((parsed ?? {}) as Record<string, { filename?: string }>);
  const filename = entries[0]?.filename;
  if (entries.length !== 1 || typeof filename !== "string") {
    throw new Error(`npm pack --json must report exactly one tarball, got: ${packJson.trim()}`);
  }
  return join(destination, filename);
}

async function main(): Promise<void> {
  run("bun", ["run", "build:lib"], REPO_ROOT);
  run("bun", ["run", "lint:package"], REPO_ROOT);
  await withSmokeDirs("gsac-smoke-", ({ pack, consumer }) => {
    // --ignore-scripts keeps the prepare hook's output out of the JSON stdout.
    const tarball = packedTarball(
      capture("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", pack], REPO_ROOT),
      pack,
    );
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    run("npm", ["install", tarball, "--no-audit", "--no-fund"], consumer);
    writeFileSync(join(consumer, "main.mjs"), NODE_CONSUMER);
    run(CONSUMER_NODE, ["--version"], consumer);
    run(CONSUMER_NODE, ["main.mjs"], consumer);
    // The bin through its installed shim, under the consumer's Node: the package's own runtime.
    const bin = join(consumer, "node_modules", ".bin", "gsac");
    const help = capture(CONSUMER_NODE, [bin, "--help"], consumer);
    const missing = CLI_COMMANDS.filter((command) => !help.includes(`  ${command}`));
    if (missing.length > 0) {
      throw new Error(`the installed CLI's help names no ${missing.join(", ")} command`);
    }
    writeFileSync(join(consumer, "settings.yml"), SETTINGS_FILE);
    run(CONSUMER_NODE, [bin, "validate", "settings.yml"], consumer);
    writeFileSync(join(consumer, "main.ts"), TS_CONSUMER);
    run(
      join(REPO_ROOT, "node_modules", ".bin", "tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "es2022",
        "main.ts",
      ],
      consumer,
    );
  });
  console.log("package smoke: ok");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // The failing command already streamed its own output; one line names it.
    console.error(`package smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

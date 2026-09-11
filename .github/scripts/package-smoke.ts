/**
 * The package smoke, the gate behind the npm library build: build lib/pkg/,
 * judge the package shape (publint, attw), pack a tarball, install it into a
 * fresh consumer project, import it under Node (the entry and the schema
 * subpath), and compile a TypeScript consumer against the bundled index.d.ts
 * with skipLibCheck off - a declaration that leaks a devDependency type, or a
 * type the emitter could not name, fails here instead of on a consumer's
 * machine.
 *
 * Usage: `bun .github/scripts/package-smoke.ts` from anywhere; every temp
 * directory is removed on every path, failure included.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** This script lives at .github/scripts/, two levels below the repository root. */
const REPO_ROOT = join(import.meta.dir, "..", "..");

const PACKAGE = "@vivswan/github-settings-as-code";

/** The consumer's runtime import: the entry names and the schema subpath, each asserted. */
const NODE_CONSUMER = `import { SECTION_KEYS, validateSettings } from "${PACKAGE}";
import schema from "${PACKAGE}/settings.schema.json" with { type: "json" };
const result = validateSettings({ labels: [] });
if (!result.ok) throw new Error("validateSettings rejected an empty labels list: " + result.error);
if (!SECTION_KEYS.includes("labels")) throw new Error("SECTION_KEYS lacks labels");
if (typeof schema.$schema !== "string") throw new Error("the schema subpath did not resolve to the JSON Schema");
console.log("imported " + SECTION_KEYS.length + " section keys and the schema");
`;

/** The consumer compiled against index.d.ts: a value and a type from the entry, both used. */
const TS_CONSUMER = `import { SECTION_KEYS, type SectionKey, validateSettings } from "${PACKAGE}";
const first: SectionKey | undefined = SECTION_KEYS[0];
const result = validateSettings({ labels: [] });
export const ok: boolean = result.ok && first === "repository";
`;

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

/**
 * Give `body` fresh temp directories under `prefix` and remove every one of
 * them when it returns or throws.
 */
export async function withTempDirs<T>(
  prefix: string,
  count: number,
  body: (dirs: string[]) => Promise<T> | T,
): Promise<T> {
  // Allocated inside the try, so a failing second mkdtemp still removes the first.
  const dirs: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      dirs.push(mkdtempSync(join(tmpdir(), prefix)));
    }
    return await body(dirs);
  } finally {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
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
  await withTempDirs("gsac-smoke-", 2, ([packDir, consumerDir]) => {
    if (packDir === undefined || consumerDir === undefined) {
      throw new Error("withTempDirs handed out fewer directories than asked");
    }
    // --ignore-scripts keeps the prepare hook's output out of the JSON stdout.
    const tarball = packedTarball(
      capture(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        REPO_ROOT,
      ),
      packDir,
    );
    writeFileSync(
      join(consumerDir, "package.json"),
      `${JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    run("npm", ["install", tarball, "--no-audit", "--no-fund"], consumerDir);
    writeFileSync(join(consumerDir, "main.mjs"), NODE_CONSUMER);
    run("node", ["main.mjs"], consumerDir);
    writeFileSync(join(consumerDir, "main.ts"), TS_CONSUMER);
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
      consumerDir,
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

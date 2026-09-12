/**
 * The compat-marker gate. Backward-compatibility code that stays is marked in a comment, `COMPAT(vN): <what stays
 * working and what to delete>` with N the major that removes it, and this script fails once that major is current.
 * A release PR's tree already carries the version it cuts, so a major release still holding its markers fails here.
 *
 *   bun .github/scripts/check-compat-markers.ts                     due line: package.json's major
 *   bun .github/scripts/check-compat-markers.ts --target-major 3    due line: a major to plan for, by hand
 *
 * The tree is `git ls-files` with untracked files and without ignored ones, minus the skip set below. Markdown may
 * name the convention in inline code as `COMPAT(vN)`; everywhere else the version is digits, so a marker cannot
 * dodge the gate by leaving its major out. Node builtins only, like its .github/scripts siblings. Fixture tests:
 * test/scripts/check-compat-markers.test.ts.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Built output, dependencies, the fetched spec, release-please's changelog (it quotes PR titles, so a removal PR's
 * title would outlive the marker it deleted), and the two files that spell the syntax to define and test it.
 * A trailing slash skips a directory; anything else is one exact path. */
const SKIPPED_PATHS = [
  "lib/",
  "node_modules/",
  "test/e2e/openapi/github-openapi.trimmed.json",
  "CHANGELOG.md",
  ".github/scripts/check-compat-markers.ts",
  "test/scripts/check-compat-markers.test.ts",
];

function skipped(path: string): boolean {
  return SKIPPED_PATHS.some((skip) => (skip.endsWith("/") ? path.startsWith(skip) : path === skip));
}

const OCCURRENCE = /COMPAT\(/g;
const MARKER = /^COMPAT\(v(0|[1-9]\d*)\):(.*)$/;
/** The placeholder inside an inline-code span: a backtick before it (checked at the call) and one after it. */
const PLACEHOLDER = /^COMPAT\(vN\)[^`]*`/;
// A description ends at its block comment's closer; in a line comment or Markdown prose it runs to the end of the
// line. A `#` or `//` before the marker is not an opener: "/* See #123. COMPAT(v3): */" sits in the block comment.
const BLOCK_OPENER = /\/\*|<!--/g;
const CLOSER_OF: Readonly<Record<string, string>> = { "/*": "*/", "<!--": "-->" };
const SYNTAX = "COMPAT(v<major>): <what stays working and what to delete>";

export interface Marker {
  path: string;
  line: number;
  major: number;
  text: string;
}

export interface Malformed {
  path: string;
  line: number;
  found: string;
}

export interface Scan {
  markers: Marker[];
  malformed: Malformed[];
}

/** Every `COMPAT(` occurrence in `text` is a marker, the Markdown placeholder in inline code, or malformed. An occurrence runs to
 * the next one on its line, and its description ends where its comment does. */
export function scanText(path: string, text: string): Scan {
  const scan: Scan = { markers: [], malformed: [] };
  const markdown = path.endsWith(".md");
  text.split("\n").forEach((content, index) => {
    const starts = [...content.matchAll(OCCURRENCE)].map((occurrence) => occurrence.index);
    starts.forEach((start, position) => {
      const segment = content.slice(start, starts[position + 1]);
      if (markdown && content[start - 1] === "`" && PLACEHOLDER.test(content.slice(start))) {
        return;
      }
      const line = index + 1;
      const marker = MARKER.exec(segment);
      const description = descriptionOf(marker?.[2] ?? "", content.slice(0, start));
      if (marker === null || description === "") {
        scan.malformed.push({ path, line, found: segment.trim().slice(0, 80) });
        return;
      }
      scan.markers.push({ path, line, major: Number(marker[1]), text: description });
    });
  });
  return scan;
}

function descriptionOf(body: string, before: string): string {
  const opener = [...before.matchAll(BLOCK_OPENER)].at(-1);
  if (opener === undefined) {
    return body.trim();
  }
  const closer = CLOSER_OF[opener[0]] as string;
  const open = !before.slice(opener.index + opener[0].length).includes(closer);
  const end = open ? body.indexOf(closer) : -1;
  return (end === -1 ? body : body.slice(0, end)).trim();
}

/** The checked-in and untracked files of the repository at `cwd`, ignored ones excluded, minus the skip set.
 * Symlinks are dropped: AGENTS.md is reached through three of them, and a marker is reported once. A tracked file
 * deleted from the working tree has nothing to scan; any other reason a listed path cannot be inspected is an error,
 * never a shorter scan. */
export function listFiles(cwd: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path !== "" && !skipped(path))
    .filter((path) => {
      try {
        return lstatSync(join(cwd, path)).isFile();
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });
}

export function scanTree(cwd: string): Scan {
  const scan: Scan = { markers: [], malformed: [] };
  for (const path of listFiles(cwd)) {
    const found = scanText(path, readFileSync(join(cwd, path), "utf8"));
    scan.markers.push(...found.markers);
    scan.malformed.push(...found.malformed);
  }
  return scan;
}

function packageVersion(cwd: string): { version: string; major: number } {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: unknown };
  const version = String(pkg.version);
  const major = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (major === null) {
    throw new Error(
      `package.json's version ${JSON.stringify(version)} is not X.Y.Z; refusing to derive the due line from it.`,
    );
  }
  return { version, major: Number(major[1]) };
}

export interface CheckOptions {
  cwd: string;
  /** The major a release cuts; defaults to package.json's. Never below it: a release never targets an older major. */
  targetMajor?: number;
}

/** The whole run as the CLI prints it: the table of remaining markers on stdout, every failure on stderr. */
export interface CheckResult {
  code: 0 | 1;
  stdout: string;
  stderr: string;
}

export function checkCompatMarkers(options: CheckOptions): CheckResult {
  const { cwd } = options;
  const current = packageVersion(cwd);
  const target = options.targetMajor ?? current.major;
  if (target < current.major) {
    throw new Error(
      `--target-major ${target} is below package.json's major ${current.major} (${current.version}); a release never targets an older major.`,
    );
  }
  const dueLine =
    options.targetMajor === undefined
      ? `the current major v${current.major} (package.json ${current.version})`
      : `the release target v${target}`;
  const { markers, malformed } = scanTree(cwd);
  const failures = [
    ...malformed.map(
      ({ path, line, found }) =>
        `${path}:${line}: malformed marker ${JSON.stringify(found)}; write ${SYNTAX}`,
    ),
    ...markers
      .filter((marker) => marker.major <= target)
      .map(
        ({ path, line, major }) =>
          `${path}:${line}: COMPAT(v${major}) is due: v${major} is at or below ${dueLine}; delete the compat path or re-justify it with a higher major`,
      ),
  ];
  return {
    code: failures.length === 0 ? 0 : 1,
    stdout: `${renderTable(markers, current.version, options.targetMajor).join("\n")}\n`,
    stderr: failures.length === 0 ? "" : `${failures.join("\n")}\n`,
  };
}

/** The planning view: every well-formed marker under its removal major, ascending, in tree order within a major. */
function renderTable(
  markers: Marker[],
  version: string,
  targetMajor: number | undefined,
): string[] {
  const context =
    targetMajor === undefined
      ? `package.json ${version}`
      : `package.json ${version}, release target v${targetMajor}`;
  if (markers.length === 0) {
    return [`no COMPAT markers (${context})`];
  }
  const byMajor = new Map<number, Marker[]>();
  for (const marker of markers) {
    byMajor.set(marker.major, [...(byMajor.get(marker.major) ?? []), marker]);
  }
  const lines = [`COMPAT markers by removal major (${context}):`];
  for (const major of [...byMajor.keys()].sort((a, b) => a - b)) {
    lines.push(`  v${major}`);
    for (const { path, line, text } of byMajor.get(major) ?? []) {
      lines.push(`    ${path}:${line}  ${text}`);
    }
  }
  return lines;
}

function parseTargetMajor(argv: string[]): number | undefined {
  const [flag, value, ...rest] = argv;
  if (flag === undefined) {
    return undefined;
  }
  if (
    flag !== "--target-major" ||
    value === undefined ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    rest.length > 0
  ) {
    throw new Error(
      `usage: check-compat-markers.ts [--target-major <major>]; got ${JSON.stringify(argv)}`,
    );
  }
  return Number(value);
}

if (import.meta.main) {
  try {
    const result = checkCompatMarkers({
      cwd: process.cwd(),
      targetMajor: parseTargetMajor(process.argv.slice(2)),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  } catch (error) {
    console.error(
      `check-compat-markers: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

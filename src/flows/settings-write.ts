/**
 * The one place a run writes a settings document (a snapshot, the merged file, init's starting file): staged beside
 * the destination and renamed into place, so a write that fails partway (disk full, an interrupted run) leaves the
 * previous file intact instead of a truncated one. The rename is atomic on POSIX and a single replace call on
 * Windows. The staging name is unique to the write (pid and random bytes), so no file of the user's is ever unlinked
 * or written through: an existing path there fails the write instead.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { err, ok, type Result } from "neverthrow";

/**
 * `path` as the filesystem names it: the real path of what exists, the rest
 * as spelled. Built one segment at a time, so ".." steps out of a symlink's
 * TARGET as the write will: handed "link/../x" whole, bun's realpath collapses
 * the ".." lexically before following the link and names a different file
 * than the one the write reaches. Every step retries realpath, since
 * "missing/../link" is back on existing ground after the "..". The flows
 * compare a destination against the files they read through this name, so a
 * spelling through a symlinked directory (macOS's /tmp for /private/tmp) or a
 * case alias cannot slip a write onto an input.
 */
export function canonicalPath(path: string): string {
  // The platform reads the root (a drive-relative "C:x" resolves on that drive); the walk reads the rest.
  const { root } = parse(path);
  let real = realOrSpelled(root === "" ? process.cwd() : resolve(root));
  for (const part of path.slice(root.length).split(sep === "\\" ? /[\\/]/ : sep)) {
    if (part === "" || part === ".") {
      continue;
    }
    real = part === ".." ? dirname(real) : realOrSpelled(join(real, part));
  }
  return real;
}

/** `path`'s real path when it exists, else `path` itself. */
function realOrSpelled(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The error is the filesystem's own reason; each caller names the input that chose the path. */
export function writeReplacing(path: string, text: string): Result<void, string> {
  const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, text, { flag: "wx" });
    renameSync(staging, path);
    return ok();
  } catch (error) {
    // Only this write's own staging file is removed, and the write's error is the one reported.
    try {
      rmSync(staging, { force: true });
    } catch {}
    return err(String(error));
  }
}

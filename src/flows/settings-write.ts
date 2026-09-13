/**
 * The one place a run writes a settings document (a snapshot, the merged file, init's starting file): staged beside
 * the destination and renamed into place, so a write that fails partway (disk full, an interrupted run) leaves the
 * previous file intact instead of a truncated one. The rename is atomic on POSIX and a single replace call on
 * Windows. The staging name is unique to the write (pid and random bytes), so no file of the user's is ever unlinked
 * or written through: an existing path there fails the write instead. A destination that is a symlink is replaced by
 * the rename, the link itself, never its referent, so the written document is always a regular file at `path`. The
 * guards over the writer hold one promise: an input layer is never the destination, under any name the read follows
 * or the rename reaches; deliberate evasion (hardlinks, mounts, races) is out of scope. A hard crash mid-write leaves
 * the staging file for the user to remove (.gitignore hides it); no run sweeps a file another process may be writing.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
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

const SEGMENT = sep === "\\" ? /[\\/]/ : sep;
const SEPARATORS = sep === "\\" ? "\\/" : "/";

/** `path` without its trailing separators, the root's own kept: basename ignores them, so slicing its length off `out.yml/` would leave `o`. */
function withoutTrailingSeparators(path: string): string {
  const floor = parse(path).root.length;
  let end = path.length;
  while (end > floor && SEPARATORS.includes(path[end - 1] ?? "")) {
    end--;
  }
  return path.slice(0, end);
}

/** An entry's identity on its filesystem, the same under every name it has. */
function entryId(stat: { dev: number | bigint; ino: number | bigint }): string {
  return `${stat.dev}:${stat.ino}`;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Every entry a read of `path` follows, by identity: each component as the OS resolves it, every link along the way
 * (hop by hop, so a chain's middle entries count), and the final file. Stops recording where nothing exists.
 */
export function readEntries(path: string): Set<string> {
  const ids = new Set<string>();
  walkRecording(process.cwd(), path, ids, { hops: 64 });
  return ids;
}

function walkRecording(
  base: string,
  path: string,
  ids: Set<string>,
  budget: { hops: number },
): string {
  const { root } = parse(path);
  let current = root === "" ? base : resolve(root);
  for (const part of path.slice(root.length).split(SEGMENT)) {
    if (part === "" || part === ".") {
      continue;
    }
    current = part === ".." ? dirname(current) : join(current, part);
    let stat = lstatOrNull(current);
    while (stat?.isSymbolicLink() && budget.hops-- > 0) {
      ids.add(entryId(stat));
      let target: string;
      try {
        target = readlinkSync(current);
      } catch {
        return current;
      }
      current = walkRecording(dirname(current), target, ids, budget);
      stat = lstatOrNull(current);
    }
    if (stat !== null) {
      ids.add(entryId(stat));
    }
  }
  return current;
}

/**
 * The identity of the entry a rename onto `path` replaces: the leaf under the parent as the OS resolves it, the leaf
 * itself unfollowed (a link there is replaced, not its referent). Null when no entry exists yet, which no read can
 * have followed.
 */
export function renameEntry(path: string): string | null {
  const parent = walkRecording(process.cwd(), dirname(path), new Set(), { hops: 64 });
  const stat = lstatOrNull(join(parent, basename(path)));
  return stat === null ? null : entryId(stat);
}

/** `path`'s real path when it exists, else `path` itself. */
function realOrSpelled(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The bits a replaced regular file keeps; a link at `path` is stat-followed, since the write replaces the link with a regular file of its referent's mode. */
function regularFileMode(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name the write reaches: the directory as the filesystem names it plus the leaf as spelled, since a rename
 * replaces a link at the leaf rather than following it.
 */
export function renameTarget(path: string): string {
  return join(canonicalPath(dirname(path)), basename(path));
}

/**
 * Every name a write to `path` lands on, for a flow comparing its destination against its inputs: the rename target,
 * and, when the leaf is not a link (a link is replaced, its referent untouched), the referent as the filesystem names
 * it now, which on a case-insensitive filesystem is the existing file's own spelling.
 */
export function landingNames(path: string): string[] {
  const names = [renameTarget(path)];
  if (!isSymlink(path)) {
    names.push(canonicalPath(path));
  }
  return [...new Set(names)];
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The error is the filesystem's own reason; each caller names the input that chose the path. The staging file sits in
 * the destination's directory, spelled as the caller spelled it up to the leaf (a `link/..` segment is the OS's to
 * resolve, the same way for both names; a drive-relative `C:x` stays on that drive's current directory, which dirname
 * or join would turn into the drive root), under a short name of its own (the destination's leaf may already be at
 * NAME_MAX), and takes an existing regular destination's mode, so a replaced 0600 file stays 0600.
 */
export function writeReplacing(path: string, text: string): Result<void, string> {
  const spelled = withoutTrailingSeparators(path);
  const directory = spelled.slice(0, spelled.length - basename(spelled).length);
  const staging = `${directory}.gsac-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  // Set once the exclusive open succeeded: only a staging file THIS write made is removed on failure, never one
  // another writer got there first with (`wx` fails on it, and that failure is the one reported).
  let created = false;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const mode = regularFileMode(path);
    fd = openSync(staging, "wx");
    created = true;
    if (mode !== undefined) {
      fchmodSync(fd, mode);
    }
    writeFileSync(fd, text);
    closeSync(fd);
    fd = undefined;
    renameSync(staging, path);
    return ok();
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (created) {
      try {
        rmSync(staging, { force: true });
      } catch {}
    }
    return err(String(error));
  }
}

/**
 * Central-mode target resolution: per-repo settings files checked into the
 * admin repository under repos-dir.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, parse } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { type SlugKey, slugKey } from "../github/slug.js";
import type { CentralFileProblem, ProblemOf } from "../problem.js";
import { type CentralTarget, parseRepoSlug } from "./targets.js";

const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

/** What a repos-dir entry is once a symbolic link is followed; `broken-link` is a link whose target is gone or cannot be read. */
type EntryKind = "directory" | "file" | "broken-link";

/** Only a link costs a stat: the listing already carries every other entry's type. */
function entryKind(entry: Dirent, path: string): EntryKind {
  if (!entry.isSymbolicLink()) {
    return entry.isDirectory() ? "directory" : "file";
  }

  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "broken-link";
  }
}

interface Entry {
  readonly name: string;
  readonly path: string;
  readonly kind: EntryKind;
}

/** The entries of `dir` in code-unit order of their names, the order `readdirSync(dir).sort()` gave, so targets and warnings keep theirs. */
function entriesOf(dir: string): Entry[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return { name: entry.name, path, kind: entryKind(entry, path) };
    });
}

function brokenLinkWarning(path: string): string {
  return `ignoring ${path}: a symbolic link whose target cannot be read, so it defines no target repository. Repair the link or remove it`;
}

export function resolveCentralTargets(
  reposDir: string,
  adminOwner: string,
): Result<
  { targets: CentralTarget[]; warnings: string[] },
  ProblemOf<"repos-dir-missing" | "repos-dir-unreadable" | "repos-dir-invalid-files">
> {
  if (!existsSync(reposDir)) {
    return err({ code: "repos-dir-missing", reposDir });
  }
  const targets: CentralTarget[] = [];
  const warnings: string[] = [];
  // Invalid filenames and duplicate slugs are collected across the WHOLE walk: each fix is a rename or deletion, so N
  // bad files must cost one run to discover, not N.
  const errors: CentralFileProblem[] = [];
  const seen = new Map<SlugKey, string>();
  const addTarget = (slug: string, filePath: string): void => {
    const parsed = parseRepoSlug(slug);
    if (parsed.isErr()) {
      errors.push({ kind: "not-a-slug", filePath, slug });
      return;
    }
    const key = slugKey(slug);
    const existing = seen.get(key);
    if (existing) {
      errors.push({ kind: "duplicate", slug, first: existing, second: filePath });
      return;
    }
    seen.set(key, filePath);
    targets.push({ repo: parsed.value, source: "central", origin: filePath, filePath });
  };

  const scanOwnerDir = (dirPath: string, owner: string): void => {
    for (const { name: inner, kind, path: innerPath } of entriesOf(dirPath)) {
      if (kind === "broken-link") {
        warnings.push(brokenLinkWarning(innerPath));
        continue;
      }
      if (kind === "directory") {
        warnings.push(
          `ignoring ${innerPath}: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory`,
        );
        continue;
      }
      if (!YAML_EXTENSIONS.has(extname(inner))) {
        warnings.push(
          `ignoring ${innerPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      addTarget(`${owner}/${parse(inner).name}`, innerPath);
    }
  };

  try {
    // Top-level files needing an unknown owner share ONE root cause and are reported as one error below.
    const ownerlessFiles: string[] = [];
    for (const { name: entry, kind, path: entryPath } of entriesOf(reposDir)) {
      if (kind === "broken-link") {
        warnings.push(brokenLinkWarning(entryPath));
        continue;
      }
      if (kind === "directory") {
        scanOwnerDir(entryPath, entry);
        continue;
      }
      if (!YAML_EXTENSIONS.has(extname(entry))) {
        warnings.push(
          `ignoring ${entryPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      if (!adminOwner) {
        ownerlessFiles.push(entryPath);
        continue;
      }
      addTarget(`${adminOwner}/${parse(entry).name}`, entryPath);
    }
    if (ownerlessFiles.length > 0) {
      errors.push({ kind: "ownerless", files: ownerlessFiles });
    }
  } catch (error) {
    return err({ code: "repos-dir-unreadable", reposDir, reason: String(error) });
  }
  if (errors.length > 0) {
    return err({ code: "repos-dir-invalid-files", reposDir, files: errors });
  }
  return ok({ targets, warnings });
}

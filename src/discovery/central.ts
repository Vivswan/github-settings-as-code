/**
 * Central-mode target resolution: per-repo settings files checked into the
 * admin repository under repos-dir.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { CentralFileProblem, ProblemOf } from "../problem.js";
import { type CentralTarget, SLUG_RE } from "./targets.js";

const YAML_EXT = /\.ya?ml$/;

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
  const seen = new Map<string, string>();
  const addTarget = (slug: string, filePath: string): void => {
    if (!SLUG_RE.test(slug)) {
      errors.push({ kind: "not-a-slug", filePath, slug });
      return;
    }
    const key = slug.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      errors.push({ kind: "duplicate", slug, first: existing, second: filePath });
      return;
    }
    seen.set(key, filePath);
    targets.push({ slug, source: "central", origin: filePath, filePath });
  };

  const scanOwnerDir = (dirPath: string, owner: string): void => {
    for (const inner of readdirSync(dirPath).sort()) {
      const innerPath = join(dirPath, inner);
      if (statSync(innerPath).isDirectory()) {
        warnings.push(
          `ignoring ${innerPath}: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory`,
        );
        continue;
      }
      if (!YAML_EXT.test(inner)) {
        warnings.push(
          `ignoring ${innerPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      addTarget(`${owner}/${inner.replace(YAML_EXT, "")}`, innerPath);
    }
  };

  try {
    // Top-level files needing an unknown owner share ONE root cause and are reported as one error below.
    const ownerlessFiles: string[] = [];
    for (const entry of readdirSync(reposDir).sort()) {
      const entryPath = join(reposDir, entry);
      if (statSync(entryPath).isDirectory()) {
        scanOwnerDir(entryPath, entry);
        continue;
      }
      if (!YAML_EXT.test(entry)) {
        warnings.push(
          `ignoring ${entryPath}: not a .yml/.yaml file, so it defines no target repository`,
        );
        continue;
      }
      if (!adminOwner) {
        ownerlessFiles.push(entryPath);
        continue;
      }
      addTarget(`${adminOwner}/${entry.replace(YAML_EXT, "")}`, entryPath);
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

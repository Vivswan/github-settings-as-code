/**
 * Central-mode target resolution: per-repo settings files checked into the
 * admin repository under repos-dir.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CentralTarget, SLUG_RE } from "./targets.js";

const YAML_EXT = /\.ya?ml$/;

/**
 * Read the repos-dir layout: `<name>.yml` (owner = the admin repo's owner)
 * at the top level, `<owner>/<name>.yml` one directory deep.
 */
export function resolveCentralTargets(
  reposDir: string,
  adminOwner: string,
): { targets: CentralTarget[]; warnings: string[] } | { error: string } {
  if (!existsSync(reposDir)) {
    return {
      error: `repos-dir "${reposDir}" does not exist in the workspace, so there are no central settings files to read. Add an actions/checkout step before this action, or fix the repos-dir path`,
    };
  }
  const targets: CentralTarget[] = [];
  const warnings: string[] = [];
  // Invalid filenames and duplicate slugs are collected across the WHOLE
  // walk and reported once: each fix is a file rename or deletion, so N bad
  // files must cost one run to discover, not N.
  const errors: string[] = [];
  const seen = new Map<string, string>(); // lowercased slug -> origin
  const addTarget = (slug: string, filePath: string): void => {
    if (!SLUG_RE.test(slug)) {
      errors.push(
        `${filePath} resolves to the target "${slug}", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes`,
      );
      return;
    }
    const key = slug.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      errors.push(
        `duplicate target ${slug}: defined by both ${existing} and ${filePath}. Keep exactly one settings file per repository`,
      );
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
    // Top-level files needing an owner share ONE root cause when it is
    // unknown; they are collected and reported as one error below.
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
      errors.push(
        `cannot resolve ${ownerlessFiles.join(", ")}: top-level repos-dir files use the current repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml layout instead`,
      );
    }
  } catch (error) {
    return {
      error: `cannot read repos-dir "${reposDir}": ${String(error)}. Check that it is a readable directory of settings files`,
    };
  }
  if (errors.length > 0) {
    return {
      error: `repos-dir "${reposDir}" has ${errors.length} invalid settings file(s):\n- ${errors.join("\n- ")}`,
    };
  }
  return { targets, warnings };
}

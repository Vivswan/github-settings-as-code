/**
 * The multi-repo target model. Central files WIN over repos-input entries for the same repository: the checked-in
 * file is a curated, code-reviewed artifact; the remote file is self-service.
 */

import { err, ok, type Result } from "neverthrow";
import type { ProblemOf } from "../problem.js";

interface TargetBase {
  slug: string; // owner/name, original casing
  /** Where this target came from, for messages: a file path or the input name. */
  origin: string;
}

export type CentralTarget = TargetBase & {
  source: "central";
  /** The checked-in settings file to read. */
  filePath: string;
};

export type RemoteTarget = TargetBase & { source: "remote" };

export type Target = CentralTarget | RemoteTarget;

export const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/** PARSED ONCE at a validating boundary, so downstream code never re-splits a string; the only constructor derives all three from one value. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * The smart constructor lives beside SLUG_RE so every boundary (the repository input, the repos list, discovery's
 * full_name) validates and splits through the same definition.
 */
export function parseRepoSlug(raw: string): Result<RepoRef, ProblemOf<"repo-slug-invalid">> {
  if (!SLUG_RE.test(raw)) {
    return err({ code: "repo-slug-invalid", value: raw });
  }
  const separator = raw.indexOf("/");
  return ok({ owner: raw.slice(0, separator), name: raw.slice(separator + 1), slug: raw });
}

/**
 * A central file wins over a repos-input entry for the same repository (noticed, not an error). The notice renders the
 * slug through `display`; a CENTRAL origin is a repos-dir FILE PATH that can embed the real repository name, so for a
 * redacted target it is rendered generically ("a repos-dir file") to keep the name away from its placeholder.
 */
export function dedupeTargets(
  central: CentralTarget[],
  remote: RemoteTarget[],
  notice: (message: string) => void,
  display: (slug: string) => string,
  isRedacted: (slug: string) => boolean = () => false,
): Target[] {
  const centralBySlug = new Map<string, CentralTarget>();
  for (const target of central) {
    const key = target.slug.toLowerCase();
    if (!centralBySlug.has(key)) {
      centralBySlug.set(key, target);
    }
  }
  const out: Target[] = [...central];
  for (const target of remote) {
    const winner = centralBySlug.get(target.slug.toLowerCase());
    if (winner) {
      const centralOrigin = isRedacted(target.slug) ? "a repos-dir file" : winner.origin;
      notice(
        `${display(target.slug)}: using the central file ${centralOrigin}; the entry for the same repository from ${target.origin} is ignored`,
      );
      continue;
    }
    out.push(target);
  }
  return out;
}

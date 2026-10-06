/**
 * The multi-repo target model. Central files WIN over repos-input entries for the same repository: the checked-in
 * file is a curated, code-reviewed artifact; the remote file is self-service.
 */

import { err, ok, type Result } from "neverthrow";
import { SLUG_SEGMENT, type SlugKey, slugKey } from "../github/slug.js";
import type { ProblemOf } from "../problem.js";

interface TargetBase {
  repo: RepoRef;
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

// A "." or ".." owner or name is refused here: GitHub names nothing that way, and as a path segment either resolves
// the request elsewhere (/repos/../x/labels is /x/labels), so no consumer of a RepoRef guards for them.
const SLUG_RE = new RegExp(String.raw`^(?!\.\.?/)${SLUG_SEGMENT}/(?!\.\.?$)${SLUG_SEGMENT}$`);

/** PARSED ONCE at a validating boundary, so downstream code never re-splits a string; the only constructor derives all three from one value. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * The one constructor: every boundary (the repository input, the repos list, repos-dir filenames, discovery's
 * full_name) validates and splits through it, so a Target never carries an unparsed slug.
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
  const centralBySlug = new Map<SlugKey, CentralTarget>();
  for (const target of central) {
    const key = slugKey(target.repo.slug);
    if (!centralBySlug.has(key)) {
      centralBySlug.set(key, target);
    }
  }
  const out: Target[] = [...central];
  for (const target of remote) {
    const winner = centralBySlug.get(slugKey(target.repo.slug));
    if (winner) {
      const centralOrigin = isRedacted(target.repo.slug) ? "a repos-dir file" : winner.origin;
      notice(
        `${display(target.repo.slug)}: using the central file ${centralOrigin}; the entry for the same repository from ${target.origin} is ignored`,
      );
      continue;
    }
    out.push(target);
  }
  return out;
}

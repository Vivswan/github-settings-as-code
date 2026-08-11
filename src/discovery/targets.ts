/**
 * The multi-repo target model shared by central resolution, repos-input
 * parsing, and discovery. Central files WIN over repos-input entries for
 * the same repository: the checked-in file is a curated, code-reviewed
 * artifact; the remote file is self-service.
 */

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

/**
 * A repository reference PARSED ONCE at a validating boundary: the owner and
 * name halves plus the original slug, so downstream code never re-splits a
 * string (and an owner that disagrees with its slug is unconstructible in
 * practice - the only constructor derives all three from one value).
 */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Parse an owner/name slug into a RepoRef, or null when it is not one. The
 * smart constructor lives beside SLUG_RE so every boundary (the repository
 * input, the repos list, discovery's full_name) validates and splits through
 * the same definition; internal code then carries the parsed proof instead
 * of a bare string.
 */
export function parseRepoSlug(raw: string): RepoRef | null {
  if (!SLUG_RE.test(raw)) {
    return null;
  }
  const separator = raw.indexOf("/");
  return { owner: raw.slice(0, separator), name: raw.slice(separator + 1), slug: raw };
}

/**
 * Merge central and remote target lists. A central file wins over a
 * repos-input entry for the same repository (noticed, not an error).
 * The notice renders the repository slug through `display` so a redacted
 * target's placeholder is what lands in the log. Origins are operator-authored
 * paths and input names; the remote origin already reads as a generic noun
 * phrase (`the "repos" input`, `repos: "*" discovery`), but a CENTRAL origin is
 * a repos-dir FILE PATH that can embed the real repository name - so for a
 * redacted target it is rendered generically ("a repos-dir file") to avoid
 * leaking the name right next to its placeholder.
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

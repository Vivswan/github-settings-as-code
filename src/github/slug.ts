/**
 * GitHub matches repository slugs ("owner/name") case-insensitively, so every cache, mask, and comparison over a
 * slug reads this one key; the brand marks a slug already folded.
 */

declare const repoSlugKey: unique symbol;
export type SlugKey = string & { readonly [repoSlugKey]: true };

export function slugKey(slug: string): SlugKey {
  return slug.toLowerCase() as SlugKey;
}

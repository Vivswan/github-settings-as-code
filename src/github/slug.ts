/**
 * GitHub matches repository slugs ("owner/name") case-insensitively, so every cache, mask, and comparison over a
 * slug reads this one key; the brand marks a slug already folded. Only the slug fold lives here: a section's own
 * identities (collaborator logins, environment names) fold through that section's branded key.
 */

declare const repoSlugKey: unique symbol;
export type SlugKey = string & { readonly [repoSlugKey]: true };

export function slugKey(slug: string): SlugKey {
  return slug.toLowerCase() as SlugKey;
}

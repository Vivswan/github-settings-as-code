/**
 * One definition of the claim-word families, the negator rule, and the window logic, so the three kept/deleted-by-default matchers (COVERAGE rows,
 * the SettingsFile schema descriptions, the Sections table's Notes cells) cannot drift apart.
 */

import type { SectionKey } from "../../src/schema.js";

const DELETE_STEMS = String.raw`delet\w*|remov\w*|drop\w*|clear\w*`;
const KEEP_STEMS = String.raw`kept|keep\w*|retain\w*|preserv\w*`;

/**
 * Prose display names of the delete-by-default sections; a new one fails the enumeration pins through deleteEnumerationProblems until it is added
 * here.
 */
const DELETE_DEFAULT_DISPLAY_NAMES: Partial<Record<SectionKey, string>> = {
  labels: "labels",
  autolinks: "autolinks",
  collaborators: "collaborators",
  actions_variables: "Actions variables",
  agents_variables: "Copilot agents variables",
};

/**
 * Omission-only on purpose: display names like "labels" are ordinary words, so a negative check would false-positive. getting-started, which
 * names backticked KEYS, gets its own exact check.
 */
export function deleteEnumerationProblems(
  prose: string,
  deleteKeys: readonly SectionKey[],
): string[] {
  // Markdown wraps prose at will, so a display name can span a line break.
  const flattened = prose.replace(/\s+/g, " ");
  const problems: string[] = [];
  for (const key of deleteKeys) {
    const display = DELETE_DEFAULT_DISPLAY_NAMES[key];
    if (display === undefined) {
      problems.push(
        `section "${key}" deletes undeclared entries but has no display name in DELETE_DEFAULT_DISPLAY_NAMES (test/docs/claims.ts)`,
      );
      continue;
    }
    if (!flattened.includes(display)) {
      problems.push(
        `the prose omits "${display}" ("${key}" deletes undeclared entries by default)`,
      );
    }
  }
  return problems;
}

/** Word-boundary claim families; "housekeeping" must not read as a keep claim. */
export const CLAIM_FAMILY: Record<"delete" | "keep", RegExp> = {
  delete: new RegExp(String.raw`\b(?:${DELETE_STEMS})\b`, "i"),
  keep: new RegExp(String.raw`\b(?:${KEEP_STEMS})\b`, "i"),
};

/** Every claim stem of either family, for grammar-level matchers. */
export const CLAIM_STEMS = `${DELETE_STEMS}|${KEEP_STEMS}`;

// The one negator list; negation resolves ONLY through stemNegation, so a second grammar cannot grow elsewhere.
const NEGATORS = new Set(["never", "not", "no", "none", "without"]);

export type UndeclaredClaim = "delete" | "keep";

/**
 * A negator counts only within the three word-tokens directly before the stem; further away it governs some other word.
 * Two negators in the span are a double negation this deliberately does not resolve: the caller fails loudly and the prose gets reworded.
 *   "never actually deleted"                                          -> negated
 *   "entries not named in settings are deleted"                       -> plain delete claim
 *   "no other section behaves this way, undeclared autolinks DELETED" -> plain delete claim
 */
export function stemNegation(preceding: string): { negated: boolean } | { doubleNegation: string } {
  const span = preceding
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((token) => token.length > 0)
    .slice(-3);
  const negators = span.filter((token) => NEGATORS.has(token)).length;
  if (negators >= 2) {
    return { doubleNegation: span.join(" ") };
  }
  return { negated: negators === 1 };
}

/**
 * The sentence-bounded windows before each "by default". A window never crosses a sentence delimiter (an adjacent "delete plus recreate" cannot leak
 * into a keep claim) and is capped so a delimiter-free run cannot pull in half a table cell.
 */
function defaultClaimWindows(text: string): string[] {
  return [...text.matchAll(/([^.;:!?]{0,80})by default/g)].map((match) => match[1] ?? "");
}

/**
 * A mixed-family negated clause ("not deleted but kept by default") is REJECTED as ambiguous rather than parsed: the negator lands in both stems'
 * spans and the flipped reading contradicts the plain one, so the fix is rewording.
 */
export function defaultClaimProblems(text: string, policy: UndeclaredClaim): string[] {
  const windows = defaultClaimWindows(text);
  if (windows.length === 0) {
    return [`no "by default" clause states the "${policy}" default`];
  }
  const stemRe = new RegExp(String.raw`\b(${CLAIM_STEMS})\b`, "gi");
  const problems: string[] = [];
  let ownClaims = 0;
  for (const window of windows) {
    for (const match of window.matchAll(stemRe)) {
      const stem = match[1] ?? "";
      const family: UndeclaredClaim = CLAIM_FAMILY.delete.test(stem) ? "delete" : "keep";
      const negation = stemNegation(window.slice(0, match.index));
      if ("doubleNegation" in negation) {
        problems.push(
          `a double negation governs "${negation.doubleNegation} ${stem}" in "...${window.trim()} by default"; reword it - double negatives are not resolved`,
        );
        continue;
      }
      const flipped: UndeclaredClaim = family === "delete" ? "keep" : "delete";
      const effective = negation.negated ? flipped : family;
      if (effective === policy) {
        ownClaims++;
      } else {
        problems.push(
          `"...${window.trim()} by default" claims the opposite of the "${policy}" default${negation.negated ? " (negated claim)" : ""}`,
        );
      }
    }
  }
  if (ownClaims === 0 && problems.length === 0) {
    problems.push(`no "by default" clause claims the "${policy}" default`);
  }
  return problems;
}

/**
 * Shared vocabulary for the kept/deleted-by-default contradiction tests
 * (COVERAGE rows, SettingsFile JSDoc, README Notes cells). One definition of
 * the claim-word families, the negator rule, and the window logic, so the
 * three matchers cannot drift apart on what counts as a claim.
 */

const DELETE_STEMS = String.raw`delet\w*|remov\w*|drop\w*|clear\w*`;
const KEEP_STEMS = String.raw`kept|keep\w*|retain\w*|preserv\w*`;

/** Word-boundary claim families; "housekeeping" must not read as a keep claim. */
export const CLAIM_FAMILY: Record<"delete" | "keep", RegExp> = {
  delete: new RegExp(String.raw`\b(?:${DELETE_STEMS})\b`, "i"),
  keep: new RegExp(String.raw`\b(?:${KEEP_STEMS})\b`, "i"),
};

/** Every claim stem of either family, for grammar-level matchers. */
export const CLAIM_STEMS = `${DELETE_STEMS}|${KEEP_STEMS}`;

// The one negator list; consumers resolve negation ONLY through
// stemNegation, so a second negation grammar cannot grow elsewhere.
const NEGATORS = new Set(["never", "not", "no", "none", "without"]);

export type UndeclaredClaim = "delete" | "keep";

/**
 * Whether the claim stem that follows `preceding` is negated. A negator
 * counts only when it sits within the three word-tokens directly before the
 * stem ("never actually deleted", "not kept"); one further away governs some
 * other word, so "entries not named in settings are deleted" and "no other
 * section behaves this way, undeclared autolinks DELETED" both read as plain
 * delete claims. Two negators inside the span ("not without deleting") are a
 * double negation this deliberately does not resolve - the caller must fail
 * loudly so the prose gets reworded.
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
 * The sentence-bounded windows preceding each "by default" in `text`. A
 * window never crosses a sentence delimiter (so an adjacent sentence's
 * "delete plus recreate" cannot leak into a keep claim) and is capped so a
 * delimiter-free run cannot pull in half a table cell.
 */
function defaultClaimWindows(text: string): string[] {
  return [...text.matchAll(/([^.;:!?]{0,80})by default/g)].map((match) => match[1] ?? "");
}

/**
 * Check the "... by default" claims in `text` against the expected policy:
 * at least one window must claim it, and no window may claim the opposite.
 * Every claim stem in a window resolves its own negation via stemNegation,
 * so a stray negator elsewhere in the clause cannot invert an unrelated
 * claim. A mixed-family negated clause ("not deleted but kept by default")
 * is deliberately REJECTED as ambiguous rather than parsed: the negator
 * lands in both stems' spans, the flipped reading contradicts the plain one,
 * and the fix is rewording the prose, not smarter parsing. Returns problem
 * strings (empty = consistent) so callers fail with the offending window.
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

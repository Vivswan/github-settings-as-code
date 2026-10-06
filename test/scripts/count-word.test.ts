/**
 * The written-out counts (.github/scripts/lib/count-word.ts): the tripwire past the range is a BUG: invariant,
 * never a numeral fallback, so a derived list outgrowing the words fails the build as a programming error.
 */

import { expect, test } from "bun:test";
import { countWord } from "../../.github/scripts/lib/count-word.js";

test("a count with no word throws a BUG: invariant naming the list to extend, whatever shape the count has", () => {
  for (const count of [21, -1, 1.5, Number.NaN]) {
    expect(() => countWord(count)).toThrow(
      `BUG: extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${count}`,
    );
  }
});

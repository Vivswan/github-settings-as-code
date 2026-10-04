/** The written-out counts (.github/scripts/lib/count-word.ts): the tripwire past the range, never a numeral fallback. */

import { expect, test } from "bun:test";
import { countWord } from "../../.github/scripts/lib/count-word.js";

test("a count with no word throws naming the list to extend, whatever shape the count has", () => {
  for (const count of [21, -1, 1.5, Number.NaN]) {
    expect(() => countWord(count)).toThrow(
      `extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${count}`,
    );
  }
});

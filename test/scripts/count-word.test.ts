/** The written-out counts (.github/scripts/lib/count-word.ts): the range's last word, and the tripwire past it. */

import { expect, test } from "bun:test";
import { countWord } from "../../.github/scripts/lib/count-word.js";

test("the range ends at twenty and throws loudly past it", () => {
  // The words in use are held by the generated pages (a shifted list misrenders a committed count sentence).
  expect(countWord(20)).toBe("twenty");
  for (const count of [21, -1, 1.5, Number.NaN]) {
    expect(() => countWord(count)).toThrow(
      `extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${count}`,
    );
  }
});

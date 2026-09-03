/** The written-out counts (.github/scripts/lib/count-word.ts): the listed range and the tripwire past it. */

import { expect, test } from "bun:test";
import { countWord } from "../../.github/scripts/lib/count-word.js";

test("spells every listed count and throws loudly past the range", () => {
  const words =
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
  expect(words.split(" ").map((_word, count) => countWord(count))).toEqual(words.split(" "));
  for (const count of [21, -1, 1.5, Number.NaN]) {
    expect(() => countWord(count)).toThrow(
      `extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${count}`,
    );
  }
});

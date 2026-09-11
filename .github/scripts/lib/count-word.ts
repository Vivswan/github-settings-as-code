/**
 * The written-out counts docs prose uses ("Fifteen sections list ..."), shared by the generators
 * and the docs pins. The loud throw is the tripwire: a derived list outgrowing the words fails
 * the build instead of the prose silently falling back to a numeral.
 */

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
] as const;

/** The written-out form of `n`; throws past the listed range. */
export function countWord(n: number): string {
  const word = COUNT_WORDS[n];
  if (word === undefined) {
    throw new Error(
      `extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${n}`,
    );
  }
  return word;
}

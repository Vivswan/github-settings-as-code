/**
 * The written-out counts docs prose uses ("Fifteen sections list ..."), shared by the generators
 * and the docs pins. Every caller counts a list the code derives (a registry, a constant), never a
 * number read from a page, so a count past the words is a BUG: invariant: the derived list outgrew
 * the table and the build fails instead of the prose silently falling back to a numeral.
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

export function countWord(n: number): string {
  const word = COUNT_WORDS[n];
  if (word === undefined) {
    throw new Error(
      `BUG: extend COUNT_WORDS (.github/scripts/lib/count-word.ts): no word for count ${n}`,
    );
  }
  return word;
}

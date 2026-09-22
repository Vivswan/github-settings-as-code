/**
 * The translation of compilable-form.ts against PCRE's grammar, row by row: a PCRE-only form's raw
 * spelling fails a flagless RegExp (or compiles as another pattern, noted per row) and its
 * translation compiles; an untouched form stays as is; a form PCRE refuses stays refused, among
 * them the ones a careless rewrite would repair.
 */

import { describe, expect, test } from "bun:test";
import {
  compilableForm,
  compileFailure,
} from "../../../src/sections/secret_scanning_custom_patterns/compilable-form.js";

function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

describe("compilableForm", () => {
  test.each<[form: string, raw: string, translated: string]>([
    ["a Python-style named group", "(?P<token>key_[A-Z0-9]{32})", "(?<token>key_[A-Z0-9]{32})"],
    ["an inline comment", "(?#vendor)key_[A-Z0-9]{32}", "key_[A-Z0-9]{32}"],
    ["a braced hex escape in a class range", "[\\x{41}-\\x{5A}]{32}", "[\\u0041-\\u005a]{32}"],
    ["a braced octal escape in a class range", "[\\o{141}-\\o{172}]+", "[\\u0061-\\u007a]+"],
    // `\c[` is one escape (ESC) to PCRE; a flagless RegExp would read `\c` and then open a class.
    ["a control escape whose character opens a class", "\\c[++", "\\u001b+"],
    ["a single-quoted named group", "(?'token'key_[A-Z0-9]{32})", "(?<token>key_[A-Z0-9]{32})"],
    // To PCRE `\a` is BEL and `\e` ESC; a flagless RegExp reads the letters, so the ranges run backwards.
    ["a class range from the bell to the backspace escape", "[\\a-\\b]", "[\\u0007-\\b]"],
    ["a class range from the escape character to a punctuation mark", "[\\e-!]", "[\\u001b-!]"],
    // PCRE takes one hex digit after `\x`; a flagless RegExp wants two and otherwise reads an x.
    ["a class range from a one-digit hex escape", "[\\xF-\\x10]", "[\\u000f-\\u0010]"],
    ["an inline option modifier", "(?i)key_[a-z0-9]{8}", "key_[a-z0-9]{8}"],
    ["several modifiers, some negated", "(?im-s)key", "key"],
    ["a negation-only modifier group", "(?-i)key", "key"],
    ["an atomic group", "(?>key)_[0-9]+", "(?:key)_[0-9]+"],
    ["a possessive plus", "a++", "a+"],
    ["a possessive star", "a*+", "a*"],
    ["a possessive question mark", "a?+", "a?"],
    ["a possessive brace quantifier", "a{2,}+", "a{2,}"],
    // PCRE drops a comment before it reads quantifiers, so the `+` after the comment is possessive.
    ["a possessive plus split by a comment", "a+(?#x)+", "a+"],
    ["a quantifier after a comment", "a(?#x)*b", "a*b"],
    // Quoted text is literal to PCRE, so a comment opening inside it is text and the `+` quantifies its last character.
    ["a comment opening inside a quote", "\\Q(?#x)\\E+", "\\(\\?#x\\)+"],
    // PCRE reads a `]` before any member as a literal one; a flagless RegExp closes the class there.
    ["a literal bracket first in a class", "[]a(]", "[\\]a(]"],
    ["a literal bracket first in a negated class", "[^](]", "[^\\](]"],
    ["a literal bracket after an empty quote, still first", "[\\Q\\E]a(]", "[\\]a(]"],
    // PCRE reads the negation after the empty quote it drops; a flagless RegExp reads the quote letters and the caret as members.
    ["a class negated after an empty quote, then a literal bracket", "[\\Q\\E^](]", "[^\\](]"],
    // The comment breaks the quantifier, so PCRE reads the braces as text; dropping it must not let the RegExp read `{2,1}`.
    ["a brace quantifier split by a comment, which makes it text", "a{2(?#c),1}", "a\\{2,1\\}"],
    ["a brace opened by a comment, which makes it text", "{(?#c)2}", "\\{2\\}"],
    // Hyperscan reads its control verbs at the start of the pattern; a flagless RegExp reads a group opening and a dangling star.
    ["the UTF8 control verb", "(*UTF8)key_[0-9]+", "key_[0-9]+"],
    ["the UTF control verb", "(*UTF)key_[0-9]+", "key_[0-9]+"],
    ["the UCP control verb", "(*UCP)\\w+", "\\w+"],
    ["a run of control verbs", "(*UTF8)(*UCP)key", "key"],
  ])("%s: the raw form fails, the translated form compiles", (_form, raw, translated) => {
    expect(compiles(raw)).toBe(false);
    expect(compilableForm(raw)).toBe(translated);
    expect(compiles(translated)).toBe(true);
    expect(compileFailure(raw)).toBeUndefined();
  });

  // These raw forms compile flagless, but not as the pattern Hyperscan reads: `\x{A}` is a literal
  // x repeated, `\Q` an identity escape, and `(?i:...)` a modifier group on V8 since Node 23 and
  // a syntax error before; the translation makes the check read one spelling everywhere.
  test.each<[form: string, raw: string, translated: string]>([
    ["a braced hex escape of one digit, padded", "\\x{A}", "\\u000a"],
    ["a flagged non-capturing group", "(?i:key)_[0-9]+", "(?:key)_[0-9]+"],
    // PCRE drops the empty quote before it reads quantifiers, so the second `+` is possessive.
    ["a possessive plus split by an empty quote", "a+\\Q\\E+", "a+"],
    // A POSIX class is one member to PCRE; a flagless RegExp reads a nested `[` and closes the class at its `]`.
    ["a POSIX class followed by a literal bracket", "[[:alpha:][]", "[\\w[]"],
    ["a quoted literal", "\\Qa.b(\\E[0-9]+", "a\\.b\\([0-9]+"],
    ["a quoted literal without its closing escape, running to the end", "id=\\Q(x", "id=\\(x"],
    // Hyperscan and PCRE before 10.43 read `{,n}` as text; the check follows them, not PCRE2's quantifier reading.
    ["a brace PCRE reads as a literal", "a{,2}", "a\\{,2\\}"],
    ["a literal closing brace before a plus", "x}+", "x\\}+"],
    ["the last code point PCRE accepts", "\\x{10FFFF}", "\\uFFFF"],
    // PCRE reads `\\x` with no digit as NUL and `\\0` with up to two more octal digits; fixed-width, so a digit after a drop stays its own.
    ["a hex escape with no digit, which is NUL", "\\x", "\\u0000"],
    ["an octal escape after a zero, in a class range", "[\\012-\\015]", "[\\u000a-\\u000d]"],
    [
      "an octal zero split from digits by a stray quote end, the digits their own range",
      "[\\0\\E77-8]",
      "[\\u000077-8]",
    ],
    // Inside a class `\\1` to `\\7` are octal to PCRE and Hyperscan (no backreference can sit there); outside they pass through.
    ["a three-digit octal escape inside a class", "[\\177]", "[\\u007f]"],
    ["a class octal split from digits by a stray quote end", "[\\1\\E77-8]", "[\\u000177-8]"],
  ])("%s: translated to one spelling", (_form, raw, translated) => {
    expect(compilableForm(raw)).toBe(translated);
    expect(compiles(translated)).toBe(true);
  });

  test.each<[form: string, source: string]>([
    ["GitHub's default delimiters", "\\A|[^0-9A-Za-z]"],
    ["the PCRE escapes a flagless RegExp reads as identity escapes", "\\A\\z\\Z\\h\\R\\K"],
    ["a lookahead", "(?=key_)[0-9]+"],
    ["a backreference (Hyperscan refuses it at apply, the check does not see it)", "(a)\\1"],
    ["a negative lookbehind (Hyperscan refuses it at apply, the check does not see it)", "(?<!x)y"],
    // PCRE refuses an anchor inside a class; the check does not (recorded), and the raw spelling compiles.
    ["an anchor inside a class", "[\\A]"],
    ["a JavaScript-style named group", "(?<token>key)"],
    ["a lazy quantifier", "a+?b*?c??"],
    ["a group opening spelled inside a character class", "[(?i)]"],
    ["an escaped parenthesis before ?P, which is a quantifier on the literal", "\\(?P<n>"],
    ["lookbehind (Hyperscan refuses it at apply, the check does not see it)", "(?<=key_)[0-9]+"],
    ["a comment opening spelled inside a character class", "[(?#x)]"],
  ])("%s passes through untouched and compiles", (_form, source) => {
    expect(compilableForm(source)).toBe(source);
    expect(compileFailure(source)).toBeUndefined();
  });

  test("a braced hex escape beyond the BMP stays one literal at the top of a range, so a range from any BMP point compiles", () => {
    expect(compileFailure("[\\x{41}-\\x{1F600}]+")).toBeUndefined();
  });

  // Extended mode changes how PCRE lexes what follows (whitespace skipped, `#` to the end of the line a
  // comment), which the tokenizer does not follow; such a pattern is left to GitHub's own check at apply.
  test.each<[form: string, source: string]>([
    // Valid to PCRE: the `)` sits in a comment. A check reading the raw text would refuse an unmatched `)`.
    ["a closing parenthesis inside an extended-mode comment", "(?x)foo # )\n"],
    // PCRE skips the space and refuses the quantified anchor `\A+`; the check does not, and GitHub's 422 names it.
    ["a quantifier split from an anchor by extended-mode whitespace", "(?x)\\A +"],
    ["extended mode turned on with another flag", "(?ix)foo # )\n"],
    ["extended mode turned on after other tokens", "key_(?x)foo # )\n"],
    ["extended mode scoped to a group", "(?x:foo # )\n)"],
    ["PCRE2's extended-more mode", "(?xx)foo # )\n"],
    ["extended mode turned on while another flag is turned off", "(?x-i)foo # )\n"],
  ])("%s passes unchecked", (_form, source) => {
    expect(compileFailure(source)).toBeUndefined();
  });

  test.each<[form: string, source: string]>([
    ["an unmatched closing parenthesis after a hash, outside extended mode", "foo # )\n"],
    ["an unmatched closing parenthesis after a group turning extended mode off", "(?-x)foo # )\n"],
    // PCRE unsets an option named on both sides of the `-`, so the group leaves extended mode off.
    ["an extended-mode flag set and unset in one group", "(?x-x)foo # )\n"],
    ["an extended-mode flag set and unset in one scoped group", "(?x-x:foo # )\n)"],
    // The letters of the flag group are text inside a quote or a class, so extended mode never turns on.
    ["an extended-mode flag inside a quote", "\\Q(?x)\\Efoo # )\n"],
    ["an extended-mode flag inside a class", "[(?x)]foo # )\n"],
    ["an extended-mode flag inside a comment", "(?#(?x))foo # )\n"],
  ])("%s is refused: the pattern is not in extended mode", (_form, source) => {
    expect(compileFailure(source)).toBeDefined();
  });

  test.each<[form: string, source: string]>([
    ["an unbalanced group", "(key_[A-Z0-9]{32}"],
    ["an unterminated character class", "[0-9"],
    ["a dangling quantifier", "*token"],
    ["a trailing backslash", "key\\"],
    ["a range out of order", "[z-a]"],
    ["a quantifier on a quantifier", "a+++"],
    ["a lazy quantifier made possessive", "a??+"],
    ["an unterminated inline comment", "(?#vendor"],
    // A control verb is read at the start of the pattern only; past it, `(*` is a group opening and a dangling star.
    ["a control verb after the start", "key(*UTF8)"],
    ["a control verb after a comment, which is not the start", "(?#c)(*UTF8)key"],
    ["a control verb Hyperscan does not know", "(*CRLF)key"],
    ["a named group left unbalanced after translation", "(?P<t>key_[0-9"],
    // The forms a rewrite could repair: each is a PCRE error the translated spelling must keep.
    ["a lazy modifier on a possessive quantifier", "a++?"],
    ["a possessive star made lazy", "a*+?"],
    ["a brace quantifier after a possessive plus", "a++{2}"],
    ["a quantifier on an option group", "a(?i)*"],
    ["an option group quantified at the start", "(?i)*a"],
    ["a Python-style group name PCRE refuses", "(?P<$>a)"],
    ["a lazy modifier split from its possessive by an empty quote", "a++\\Q\\E?"],
    ["a quantifier split from its option group by an empty quote", "a(?i)\\Q\\E*"],
    // PCRE refuses a duplicate group name in either spelling; a rewrite of the second `(?P<` would let the RegExp take it.
    ["a Python-style group name used twice", "(?P<a>x)|(?P<a>y)"],
    ["a Python-style group name a JavaScript-style group already took", "(?<a>x)(?P<a>y)"],
    ["a Python-style group name a JavaScript-style group takes later", "(?P<a>x)|(?<a>y)"],
    // PCRE ignores a `\E` with no `\Q`, so the quantifier after it still follows the possessive or the option group.
    ["a lazy modifier split from its possessive by a stray quote end", "a++\\E?"],
    ["a quantifier split from its option group by a stray quote end", "a(?i)\\E*"],
    // PCRE cannot repeat an anchor; a flagless RegExp reads `\A` as a literal A, so dropping the `+` would let `\A+` through.
    ["a possessive quantifier on the start anchor", "\\A++"],
    ["a possessive quantifier on the end anchor", "\\z*+"],
    ["a plus on the start anchor", "\\A+"],
    ["a question mark on the start anchor", "\\A?"],
    ["a lazy plus on the start anchor", "\\A+?"],
    ["a brace quantifier on the end anchor", "\\z{2}"],
    ["a star on the end-or-newline anchor", "\\Z*"],
    ["a plus on the match reset", "\\K+"],
    ["a plus on the previous-match anchor", "\\G+"],
    // PCRE reads a quantifier after `(`, `|`, `^`, `$` or a group opening as an error; a dropped token must not re-fuse `(` and `?` into a group.
    ["a quantifier after a group opening split by a comment", "((?#c)?:a)"],
    ["a quantifier after a group opening split by an empty quote", "(\\Q\\E?:a)"],
    ["a named group opening split by a comment", "(?<(?#c)n>a)"],
    ["a quantifier after an alternation bar", "a|*b"],
    ["a quantifier on the caret anchor", "^+"],
    ["a quantifier on a word boundary", "\\b+"],
    ["a brace quantifier on a brace quantifier", "a{2}{3}"],
    // The `(?` openings PCRE may accept and Hyperscan refuses (branch reset, recursion, a Python-style backreference).
    ["a branch reset group", "(?|a|b)"],
    ["a recursion", "a(?R)?"],
    ["a Python-style backreference", "(?P<n>a)(?P=n)"],
    // PCRE refuses a group name declared twice in any spelling; V8 takes it across alternatives since Node 24.
    ["a JavaScript-style group name used twice across alternatives", "(?<a>x)|(?<a>y)"],
    // PCRE reads `\\c` with the printable ASCII character after it, and refuses it at the end or before any other.
    ["a control escape at the end of the pattern", "\\c"],
    ["a control escape at the end of the pattern, after text", "a\\c"],
    ["a control escape before a tab", "\\c\t"],
    // PCRE refuses a code point above U+10FFFF; the fixed BMP literal stands in only up to there.
    ["a braced hex escape above the last code point", "\\x{110000}"],
    ["a braced octal escape above the last code point", "\\o{77777777}"],
    ["a braced hex escape far above the last code point", "\\x{FFFFFFFFFFFF}"],
    // PCRE reads the `]` as a literal, so the class never closes; a flagless RegExp would read an empty class.
    ["an empty class", "[]"],
    ["a class whose literal bracket starts a range out of order, split by a comment", "[]z-(?#x)]"],
    ["a class whose POSIX member is followed by a range out of order", "[[:alpha:]z-(?#x)]"],
    ["a class whose only member is a stray quote end", "[\\E]"],
    // The digits after the drop are members of their own, so the range they start runs backwards.
    ["an octal zero split from a reversed range by a stray quote end", "[\\0\\E40-!]"],
    ["a hex escape with no digit split from a reversed range by a stray quote end", "[\\x\\E20-!]"],
    ["a class octal split from a reversed range by a stray quote end", "[\\1\\E0-!]"],
    // PCRE and Hyperscan both refuse a malformed code point escape; a flagless RegExp reads an x, an o, or a c.
    ["a braced hex escape with non-hex digits", "\\x{ZZ}"],
    ["a braced hex escape left open", "\\x{"],
    ["a braced octal escape with a non-octal digit", "\\o{8}"],
    ["an octal escape without its braces", "\\o"],
    ["a JavaScript-style group name PCRE refuses", "(?<$>a)"],
    // The caret after the empty quote negates, so the `]` is the first member and the class never closes.
    ["a class negated after an empty quote, never closed", "[\\Q\\E^]"],
    // The quote closes before the `)`, so the comment opening is text and the parenthesis is unmatched.
    ["a quote closed inside a comment opening", "\\Q(?#\\E)"],
    // The quote runs to the end of the pattern, swallowing the `]`, in PCRE as here.
    ["a quote opened inside a class and never closed", "[\\Qx]"],
  ])("%s is refused after translation", (_form, source) => {
    expect(compileFailure(source)).toBeDefined();
  });
});

describe("the check's own reasons, as the pattern refusal renders them", () => {
  // PCRE's wording for what it refuses; the RegExp engine's own message passes through for the rest and is not pinned.
  test.each<[source: string, reason: string]>([
    ["*a", "quantifier does not follow a repeatable item"],
    ["\\x{ZZ}", "non-hex character or missing } in \\x{}"],
    ["\\o{8}", "non-octal character or missing braces in \\o{}"],
    ["\\c", "\\c needs a printable ASCII character after it"],
    ["\\x{110000}", "\\x{110000} is above U+10FFFF"],
    ["(?#x", "missing ) after (?# comment"],
    ["(?$a)", "unrecognized character after (?"],
    ["(?<a>x)(?<a>y)", "two named groups have the same name (a)"],
  ])("%s is refused as %s", (source, reason) => {
    expect(compileFailure(source)).toBe(reason);
  });
});

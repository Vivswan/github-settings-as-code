/**
 * The syntax check behind every regex field of a secret scanning custom pattern. GitHub compiles
 * them with Hyperscan, a PCRE subset this action cannot run, so the check is a flagless JavaScript
 * RegExp over a translation of the PCRE-only forms, refusing only what PCRE refuses too. What
 * Hyperscan alone refuses compiles here and fails at apply as the bulk create's 422. Left to that
 * 422 as well: a pattern in extended mode (`(?x)`), whose whitespace and `#` comments this
 * tokenizer does not read, so it passes unchecked rather than refused on a lexing it cannot follow.
 */

/**
 * The pattern as PCRE lexes it, one token per unit. What PCRE reads and then ignores (a `(?#...)`
 * comment, an empty `\Q\E`, a `\E` with no `\Q`) is a `dropped` token, so the adjacency rules see
 * the tokens PCRE sees: `a+(?#x)+` is a possessive `+`, and `a++\E?` a quantifier after a
 * possessive, which PCRE refuses. What PCRE refuses outright and no JavaScript spelling would keep
 * refusing once the drops are gone (a quantifier on an unrepeatable item, a `(?` opening no row
 * knows, a malformed code point escape) is a `refused` token naming PCRE's reason. A code point
 * escape is its value, so the render can spell it at one fixed width.
 */
type Token =
  | { kind: "literal"; text: string }
  | { kind: "escape"; text: string }
  | { kind: "codePoint"; value: number }
  | { kind: "refused"; text: string; reason: string }
  | { kind: "quote"; literal: string }
  | { kind: "dropped" }
  | { kind: "classOpen"; negated: boolean }
  | { kind: "posixClass" }
  | { kind: "classClose" }
  | { kind: "group"; text: string; form: string; name: string | undefined }
  | { kind: "quantifier"; text: string }
  | { kind: "lazy" }
  | { kind: "possessive" };

/** A PCRE group name: JavaScript takes more (a `$`), so a name outside this stays in the PCRE spelling and fails. */
const GROUP_NAME = "([A-Za-z_][A-Za-z0-9_]{0,127})";

/** One group opening `(?...`: its syntax anchored at the opening, and the JavaScript spelling (`$1` keeps the name). */
interface GroupRewrite {
  syntax: RegExp;
  form: string;
}

/** The `(?` openings the check rewrites; a `(?#` comment is dropped before the table is read, and any other `(?` outside it (a subroutine call, a conditional) is refused as unrecognized rather than guessed at. */
const GROUP_REWRITES: readonly GroupRewrite[] = [
  { syntax: new RegExp(`^\\(\\?P<${GROUP_NAME}>`), form: "(?<$1>" },
  { syntax: new RegExp(`^\\(\\?'${GROUP_NAME}'`), form: "(?<$1>" },
  // JavaScript's own named group, listed so its name counts toward a duplicate.
  { syntax: new RegExp(`^\\(\\?<${GROUP_NAME}>`), form: "(?<$1>" },
  // A flag-only group (`(?i)`, `(?im-s)`, PCRE's empty `(?)`) is removed: flags change what a pattern matches, never
  // whether it parses, except the extended-mode `x`, which extendedMode() names and compileFailure() passes unchecked.
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?)\)/, form: "" },
  // A flagged non-capturing group and an atomic group are plain non-capturing groups to the check.
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?):/, form: "(?:" },
  { syntax: /^\(\?>/, form: "(?:" },
  // The lookarounds are their own spelling.
  { syntax: /^\(\?<?[=!]/, form: "$&" },
];

/** A flag group that leaves extended mode on: `x` set (`(?x)`, `(?xx)`, `(?ix)`, `(?x:`) and not unset after the `-`, as `(?x-x)` and `(?-x)` do. */
const EXTENDED_MODE_GROUP = /^\(\?[ims]*x[imsx]*(?:-[ims]*)?[):]$/;

/**
 * Whether `tokens` turn extended mode on anywhere. From that group on PCRE skips unescaped
 * whitespace and reads `#` to the end of the line as a comment, a lexing this tokenizer does not
 * follow: `(?x)foo # )` is valid, `(?x)\A +` a quantified anchor. Decided over the tokens, so the
 * same letters inside a class, a quote, or a comment are the text PCRE reads them as, and the
 * first such group is lexed under the plain rules that hold up to it.
 */
function extendedMode(tokens: readonly Token[]): boolean {
  return tokens.some((token) => token.kind === "group" && EXTENDED_MODE_GROUP.test(token.text));
}

/** The escapes PCRE cannot repeat, its anchors and the match reset, which a flagless RegExp reads as repeatable letters. */
const UNREPEATABLE_ESCAPE = /^\\[AbBGKzZ]$/;

/**
 * Whether PCRE lets a quantifier follow `previous`: not at the start, after `(`, `|`, `^`, `$`, a
 * group opening, another quantifier or its modifier, or an anchor. Decided over the tokens PCRE
 * sees, so a dropped comment never re-fuses `(` and `?` into a group opening: `((?#c)?:a)` stays
 * the error PCRE reads.
 */
function repeatable(previous: Token | undefined): boolean {
  switch (previous?.kind) {
    case undefined:
    case "group":
    case "quantifier":
    case "lazy":
    case "possessive":
      return false;
    case "literal":
      return !"(|^$".includes(previous.text);
    case "escape":
      return !UNREPEATABLE_ESCAPE.test(previous.text);
    default:
      return true;
  }
}

/** PCRE2's own wording, so the refusal reads as the engine's would. */
const NOT_REPEATABLE = "quantifier does not follow a repeatable item";

/** Hyperscan's control verbs, a run at the very start only, dropped before lexing so `(*` is not a literal and a dangling quantifier; a `(*` anywhere else stays that refusal. */
const START_VERBS = /^(?:\(\*(?:UTF8|UTF|UCP)\))+/;

/** The `{m}`, `{m,}`, `{m,n}` quantifier at a `{`; any other brace is a literal to Hyperscan and to a flagless RegExp alike. */
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/** A POSIX class member inside a class, one unit to PCRE where a flagless RegExp reads a nested `[` and a closing `]`. */
const POSIX_CLASS =
  /^\[:\^?(?:alnum|alpha|ascii|blank|cntrl|digit|graph|lower|print|punct|space|upper|word|xdigit):\]/;

/** The last code point a braced `\x{}` or `\o{}` may spell; PCRE refuses anything above it. */
const LAST_CODE_POINT = 0x10ffff;

/** One code point spelling: its syntax anchored at the backslash, capturing what the value is read from. */
interface CodePointEscape {
  syntax: RegExp;
  value: (captured: string) => number;
  inClassOnly?: true;
}

/** PCRE's code point spellings, each reaching exactly as far as PCRE reads (so `\0\E40` is NUL, 4, 0) and rendered as their value, since a flagless RegExp reads `\x{41}` as a repeated x and `\a` as an a. */
const CODE_POINT_ESCAPES: readonly CodePointEscape[] = [
  { syntax: /^\\x\{([0-9A-Fa-f]+)\}/, value: (hex) => Number.parseInt(hex, 16) },
  {
    syntax: /^\\x(?!\{)([0-9A-Fa-f]{0,2})/,
    value: (hex) => (hex === "" ? 0 : Number.parseInt(hex, 16)),
  },
  { syntax: /^\\o\{([0-7]+)\}/, value: (octal) => Number.parseInt(octal, 8) },
  { syntax: /^\\(0[0-7]{0,2})/, value: (octal) => Number.parseInt(octal, 8) },
  {
    // `\1` to `\7` are octal only inside a class; outside they are backreferences, which pass through.
    syntax: /^\\([1-7][0-7]{0,2})/,
    value: (octal) => Number.parseInt(octal, 8),
    inClassOnly: true,
  },
  { syntax: /^\\c([\x20-\x7E])/, value: (letter) => letter.toUpperCase().charCodeAt(0) ^ 0x40 },
  { syntax: /^\\([ae])/, value: (letter) => (letter === "a" ? 0x07 : 0x1b) },
];

/** The code point spellings PCRE and Hyperscan refuse when malformed, with PCRE's reason; tried after the well-formed rows. */
const MALFORMED_ESCAPES: readonly [syntax: RegExp, reason: string][] = [
  [/^\\x\{/, "non-hex character or missing } in \\x{}"],
  [/^\\o/, "non-octal character or missing braces in \\o{}"],
  [/^\\c/, "\\c needs a printable ASCII character after it"],
];

/** The `\Q...\E` quote at `index`, reaching to the end of the pattern when unclosed; an empty one is dropped. */
function quoteAt(source: string, index: number): [Token, number] {
  const end = source.indexOf("\\E", index + 2);
  const literal = end === -1 ? source.slice(index + 2) : source.slice(index + 2, end);
  const token: Token = literal === "" ? { kind: "dropped" } : { kind: "quote", literal };
  return [token, (end === -1 ? source.length : end + 2) - index];
}

/** The code point escape opening `rest`, with how far it reaches, or null when no spelling matches there. */
function codePointAt(rest: string, inClass: boolean): [Token, number] | null {
  for (const row of CODE_POINT_ESCAPES) {
    if (row.inClassOnly && !inClass) {
      continue;
    }

    const match = row.syntax.exec(rest);
    if (match === null) {
      continue;
    }

    const text = match[0];
    const value = row.value(match[1] as string);
    const token: Token =
      value > LAST_CODE_POINT
        ? { kind: "refused", text, reason: `${text} is above U+10FFFF` }
        : { kind: "codePoint", value };
    return [token, text.length];
  }

  return null;
}

/** The escape starting at `index` as PCRE reads it, with how far it reaches. */
function escapeAt(source: string, index: number, inClass: boolean): [Token, number] {
  if (source.startsWith("\\Q", index)) {
    return quoteAt(source, index);
  }

  if (source.startsWith("\\E", index)) {
    return [{ kind: "dropped" }, 2];
  }

  const rest = source.slice(index);
  const codePoint = codePointAt(rest, inClass);
  if (codePoint !== null) {
    return codePoint;
  }

  const malformed = MALFORMED_ESCAPES.find(([syntax]) => syntax.test(rest));
  if (malformed !== undefined) {
    return [{ kind: "refused", text: rest.slice(0, 2), reason: malformed[1] }, 2];
  }

  // A lone trailing backslash is a one-character escape the RegExp then refuses.
  const text = rest.slice(0, 2);
  return [{ kind: "escape", text }, text.length];
}

/**
 * One walk of the tokenizer: `previous` is the last token PCRE sees (a dropped one never takes the
 * slot), and `classHasMember` whether the open class has read a member yet, which decides how a
 * `]` reads.
 */
interface Walk {
  tokens: Token[];
  previous: Token | undefined;
  inClass: boolean;
  classHasMember: boolean;
}

/** Records `token` and hands back `advance`; a dropped token leaves `previous` and the class membership untouched. */
function push(walk: Walk, token: Token, advance: number): number {
  walk.tokens.push(token);
  if (token.kind !== "dropped") {
    walk.previous = token;
    walk.classHasMember = walk.inClass;
  }
  return advance;
}

/** The next unit inside a class, with how far it reaches: the negation, a closing `]`, a POSIX class, or one character. */
function classUnitAt(walk: Walk, rest: string): number {
  const ch = rest[0] as string;
  const { previous } = walk;
  if (ch === "^" && previous?.kind === "classOpen" && !previous.negated) {
    // The negation is the first thing PCRE reads after the `[` and what it drops: `[\Q\E^]` is negated.
    previous.negated = true;
    return 1;
  }

  if (ch === "]" && !walk.classHasMember) {
    // PCRE reads a `]` before any member as a literal one, where a flagless RegExp would close the class.
    return push(walk, { kind: "escape", text: "\\]" }, 1);
  }

  if (ch === "]") {
    walk.inClass = false;
    return push(walk, { kind: "classClose" }, 1);
  }

  const posix = POSIX_CLASS.exec(rest);
  if (posix === null) {
    return push(walk, { kind: "literal", text: ch }, 1);
  }
  return push(walk, { kind: "posixClass" }, posix[0].length);
}

/** The `(?` opening at the start of `rest` as PCRE reads it (a `(?#` comment is dropped), or null when `rest` opens with no `(?`. */
function groupOpeningAt(rest: string): [Token, number] | null {
  if (rest.startsWith("(?#")) {
    const end = rest.indexOf(")");
    if (end === -1) {
      return [{ kind: "refused", text: rest, reason: "missing ) after (?# comment" }, rest.length];
    }
    return [{ kind: "dropped" }, end + 1];
  }

  if (!rest.startsWith("(?")) {
    return null;
  }

  for (const row of GROUP_REWRITES) {
    const match = row.syntax.exec(rest);
    if (match === null) {
      continue;
    }

    const token: Token = {
      kind: "group",
      text: match[0],
      form: match[0].replace(row.syntax, row.form),
      name: match[1],
    };
    return [token, match[0].length];
  }

  // PCRE's other `(?` openings (conditions, recursion, callouts, branch reset, `(?P=`) it may accept
  // and Hyperscan refuses; refused here as one unit, so a dropped token cannot re-fuse one into a known form.
  const text = rest.slice(0, 3);
  return [{ kind: "refused", text, reason: "unrecognized character after (?" }, text.length];
}

/** The quantifier spelled at the start of `rest` (`*`, `+`, `?`, or a `{m,n}` brace), or null when `rest` opens with none. */
function quantifierText(rest: string): string | null {
  const ch = rest[0] as string;
  if (ch === "*" || ch === "+" || ch === "?") {
    return ch;
  }

  if (ch !== "{") {
    return null;
  }
  return BRACE_QUANTIFIER.exec(rest)?.[0] ?? null;
}

/** What a quantifier spelled `text` is after `previous`: a modifier on a quantifier, a quantifier on a repeatable item, else PCRE's refusal. */
function quantifierToken(previous: Token | undefined, text: string): Token {
  // One modifier at most after a quantifier: `?` lazy, `+` possessive; anything more is a quantifier again, dangling.
  if (previous?.kind === "quantifier" && text === "?") {
    return { kind: "lazy" };
  }

  if (previous?.kind === "quantifier" && text === "+") {
    return { kind: "possessive" };
  }

  if (repeatable(previous)) {
    return { kind: "quantifier", text };
  }
  return { kind: "refused", text, reason: NOT_REPEATABLE };
}

function tokenize(source: string): Token[] {
  const walk: Walk = { tokens: [], previous: undefined, inClass: false, classHasMember: false };
  let i = START_VERBS.exec(source)?.[0].length ?? 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = rest[0] as string;
    if (ch === "\\") {
      const [token, advance] = escapeAt(source, i, walk.inClass);
      i += push(walk, token, advance);
      continue;
    }

    if (walk.inClass) {
      i += classUnitAt(walk, rest);
      continue;
    }

    if (ch === "[") {
      i += push(walk, { kind: "classOpen", negated: false }, 1);
      walk.inClass = true;
      walk.classHasMember = false;
      continue;
    }

    const group = groupOpeningAt(rest);
    if (group !== null) {
      const [token, advance] = group;
      i += push(walk, token, advance);
      continue;
    }

    const quantifier = quantifierText(rest);
    if (quantifier !== null) {
      i += push(walk, quantifierToken(walk.previous, quantifier), quantifier.length);
      continue;
    }

    i += push(walk, { kind: "literal", text: ch }, 1);
  }

  return walk.tokens;
}

/** Every character `\Q...\E` quotes that would otherwise be syntax, spelled as its escape. */
function quoteLiteral(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

/** A code point as JavaScript spells it: `\uHHHH` inside the BMP, one fixed BMP literal beyond it. */
function codePointEscape(codePoint: number): string {
  return codePoint <= 0xffff ? `\\u${codePoint.toString(16).padStart(4, "0")}` : "\\uFFFF";
}

/** The group names `tokens` declare more than once, in either spelling. */
function duplicateNames(tokens: readonly Token[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const token of tokens) {
    if (token.kind === "group" && token.name !== undefined) {
      (seen.has(token.name) ? duplicates : seen).add(token.name);
    }
  }
  return duplicates;
}

/**
 * What PCRE refuses and no JavaScript spelling can keep refusing: the refused token's reason, or a
 * group name declared twice (V8 takes one across alternatives since Node 24); undefined otherwise.
 */
function pcreRefusal(tokens: readonly Token[]): string | undefined {
  const refused = tokens.find((token) => token.kind === "refused");
  if (refused !== undefined && refused.kind === "refused") {
    return refused.reason;
  }
  const duplicates = duplicateNames(tokens);
  return duplicates.size === 0
    ? undefined
    : `two named groups have the same name (${[...duplicates].join(", ")})`;
}

/** `tokens` in the JavaScript spelling; anything the table does not name passes through untouched. */
function render(tokens: readonly Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.kind) {
      case "literal":
        // A brace PCRE read as text stays text once the drops are gone: `a{2(?#c),1}` is not `a{2,1}`.
        out += token.text === "{" || token.text === "}" ? `\\${token.text}` : token.text;
        break;
      case "quantifier":
      case "refused":
      case "escape":
        out += token.text;
        break;
      case "codePoint":
        out += codePointEscape(token.value);
        break;
      case "quote":
        out += quoteLiteral(token.literal);
        break;
      case "classOpen":
        out += token.negated ? "[^" : "[";
        break;
      case "posixClass":
        out += "\\w";
        break;
      case "classClose":
        out += "]";
        break;
      case "group":
        out += token.form;
        break;
      case "lazy":
        out += "?";
        break;
      case "possessive":
        break;
    }
  }
  return out;
}

/** The tokens the adjacency rules and the render see: PCRE's, without what it drops. */
function lex(source: string): Token[] {
  return tokenize(source).filter((token) => token.kind !== "dropped");
}

export function compilableForm(source: string): string {
  return render(lex(source));
}

/**
 * Why `source` fails the check (PCRE's own refusal, else the RegExp's compile error), or undefined
 * when it passes; a pattern in extended mode passes unchecked, since its tokens past the flag were
 * lexed under rules PCRE no longer applies there.
 */
export function compileFailure(source: string): string | undefined {
  const tokens = lex(source);
  if (extendedMode(tokens)) {
    return undefined;
  }
  const refusal = pcreRefusal(tokens);
  if (refusal !== undefined) {
    return refusal;
  }
  try {
    new RegExp(render(tokens));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

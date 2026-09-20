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

/**
 * The `(?` group openings the check knows. The flag-only group (`(?i)`, `(?im-s)`, and PCRE's empty
 * `(?)`) is removed: flags change what a pattern matches, never whether it parses, except the
 * extended-mode `x`, which changes how PCRE lexes what follows; `extendedMode()` names that case
 * and `compileFailure()` passes it unchecked. An atomic group
 * and a flagged non-capturing group are plain non-capturing groups to the check. A JavaScript-style
 * named group and the lookarounds are their own spelling, listed so a name counts toward a
 * duplicate and so no `(?` PCRE knows falls to the refusal of the ones it does not.
 */
const GROUP_REWRITES: readonly GroupRewrite[] = [
  { syntax: new RegExp(`^\\(\\?P<${GROUP_NAME}>`), form: "(?<$1>" },
  { syntax: new RegExp(`^\\(\\?'${GROUP_NAME}'`), form: "(?<$1>" },
  { syntax: new RegExp(`^\\(\\?<${GROUP_NAME}>`), form: "(?<$1>" },
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?)\)/, form: "" },
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?):/, form: "(?:" },
  { syntax: /^\(\?>/, form: "(?:" },
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

const NOT_REPEATABLE = "quantifier does not follow a repeatable item";

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
  /** `\1` to `\7` are octal only inside a class; outside they are backreferences, which pass through. */
  inClassOnly?: true;
}

/**
 * PCRE's code point spellings, each reaching as far as PCRE reads it (`\x` takes zero to two hex
 * digits, `\0` zero to two more octal digits), so a digit after a dropped token never joins one:
 * `\0\E40` is NUL, 4, 0. A flagless RegExp reads several of these differently (`\x{41}` as an x
 * repeated, `\a` as an a), so they render as their value.
 */
const CODE_POINT_ESCAPES: readonly CodePointEscape[] = [
  { syntax: /^\\x\{([0-9A-Fa-f]+)\}/, value: (hex) => Number.parseInt(hex, 16) },
  {
    syntax: /^\\x(?!\{)([0-9A-Fa-f]{0,2})/,
    value: (hex) => (hex === "" ? 0 : Number.parseInt(hex, 16)),
  },
  { syntax: /^\\o\{([0-7]+)\}/, value: (octal) => Number.parseInt(octal, 8) },
  { syntax: /^\\(0[0-7]{0,2})/, value: (octal) => Number.parseInt(octal, 8) },
  {
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

/** The escape starting at `index` as PCRE reads it, with how far it reaches. */
function escapeAt(source: string, index: number, inClass: boolean): [Token, number] {
  if (source.startsWith("\\Q", index)) {
    const end = source.indexOf("\\E", index + 2);
    const literal = end === -1 ? source.slice(index + 2) : source.slice(index + 2, end);
    const token: Token = literal === "" ? { kind: "dropped" } : { kind: "quote", literal };
    return [token, (end === -1 ? source.length : end + 2) - index];
  }
  if (source.startsWith("\\E", index)) {
    return [{ kind: "dropped" }, 2];
  }
  const rest = source.slice(index);
  for (const row of CODE_POINT_ESCAPES) {
    const match = row.inClassOnly && !inClass ? null : row.syntax.exec(rest);
    if (match !== null) {
      const text = match[0];
      const value = row.value(match[1] as string);
      const token: Token =
        value > LAST_CODE_POINT
          ? { kind: "refused", text, reason: `${text} is above U+10FFFF` }
          : { kind: "codePoint", value };
      return [token, text.length];
    }
  }
  const malformed = MALFORMED_ESCAPES.find(([syntax]) => syntax.test(rest));
  if (malformed !== undefined) {
    return [{ kind: "refused", text: rest.slice(0, 2), reason: malformed[1] }, 2];
  }
  // A lone trailing backslash is a one-character escape the RegExp then refuses.
  const text = rest.slice(0, 2);
  return [{ kind: "escape", text }, text.length];
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let previous: Token | undefined;
  let inClass = false;
  let classHasMember = false;
  const push = (token: Token, advance: number): number => {
    tokens.push(token);
    if (token.kind !== "dropped") {
      previous = token;
      classHasMember = inClass;
    }
    return advance;
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = rest[0] as string;
    if (ch === "\\") {
      const [token, advance] = escapeAt(source, i, inClass);
      i += push(token, advance);
      continue;
    }
    if (inClass) {
      if (ch === "^" && previous?.kind === "classOpen" && !previous.negated) {
        // The negation is the first thing PCRE reads after the `[` and what it drops: `[\Q\E^]` is negated.
        previous.negated = true;
        i += 1;
        continue;
      }
      if (ch === "]" && !classHasMember) {
        // PCRE reads a `]` before any member as a literal one, where a flagless RegExp would close the class.
        i += push({ kind: "escape", text: "\\]" }, 1);
        continue;
      }
      if (ch === "]") {
        inClass = false;
        i += push({ kind: "classClose" }, 1);
        continue;
      }
      const posix = POSIX_CLASS.exec(rest);
      i +=
        posix === null
          ? push({ kind: "literal", text: ch }, 1)
          : push({ kind: "posixClass" }, posix[0].length);
      continue;
    }
    if (ch === "[") {
      i += push({ kind: "classOpen", negated: false }, 1);
      inClass = true;
      classHasMember = false;
      continue;
    }
    if (rest.startsWith("(?#")) {
      const end = rest.indexOf(")");
      i +=
        end === -1
          ? push(
              { kind: "refused", text: rest, reason: "missing ) after (?# comment" },
              rest.length,
            )
          : push({ kind: "dropped" }, end + 1);
      continue;
    }
    const rewrite = GROUP_REWRITES.map((row) => ({ row, match: row.syntax.exec(rest) })).find(
      (candidate) => candidate.match !== null,
    );
    if (rewrite?.match) {
      const { row, match } = rewrite;
      i += push(
        {
          kind: "group",
          text: match[0],
          form: match[0].replace(row.syntax, row.form),
          name: match[1],
        },
        match[0].length,
      );
      continue;
    }
    if (rest.startsWith("(?")) {
      // PCRE's other `(?` openings (conditions, recursion, callouts, branch reset, `(?P=`) it may accept
      // and Hyperscan refuses; refused here as one unit, so a dropped token cannot re-fuse one into a known form.
      const text = rest.slice(0, 3);
      i += push({ kind: "refused", text, reason: "unrecognized character after (?" }, text.length);
      continue;
    }
    const brace = ch === "{" ? BRACE_QUANTIFIER.exec(rest) : null;
    if (ch === "*" || ch === "+" || ch === "?" || brace !== null) {
      const text = brace === null ? ch : brace[0];
      // One modifier at most after a quantifier: `?` lazy, `+` possessive; anything more is a quantifier again, dangling.
      if (previous?.kind === "quantifier" && ch === "?") {
        i += push({ kind: "lazy" }, 1);
      } else if (previous?.kind === "quantifier" && ch === "+") {
        i += push({ kind: "possessive" }, 1);
      } else if (repeatable(previous)) {
        i += push({ kind: "quantifier", text }, text.length);
      } else {
        i += push({ kind: "refused", text, reason: NOT_REPEATABLE }, text.length);
      }
      continue;
    }
    i += push({ kind: "literal", text: ch }, 1);
  }
  return tokens;
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

/** `source` with the PCRE-only forms rewritten into the JavaScript spelling: the translation alone, without `pcreRefusal()`; `compileFailure()` is the check. */
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

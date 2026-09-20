/**
 * The syntax check behind every regex field of a secret scanning custom pattern. GitHub compiles
 * them with Hyperscan, a PCRE subset this action cannot run, so the check is a flagless JavaScript
 * RegExp over a translation of the PCRE-only forms, refusing only what PCRE refuses too. What
 * Hyperscan alone refuses compiles here and fails at apply as the bulk create's 422.
 */

/**
 * The pattern as PCRE lexes it, one token per unit. What PCRE reads and then ignores (a `(?#...)`
 * comment, an empty `\Q\E`, a `\E` with no `\Q`) is a `dropped` token, so the adjacency rules see
 * the tokens PCRE sees: `a+(?#x)+` is a possessive `+`, and `a++\E?` a quantifier after a
 * possessive, which PCRE refuses.
 */
type Token =
  | { kind: "literal"; text: string }
  | { kind: "escape"; text: string }
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
 * The group openings the check translates. The flag-only group (`(?i)`, `(?im-s)`, and PCRE's empty
 * `(?)`) is removed: flags change what a pattern matches, never whether it parses. An atomic group
 * and a flagged non-capturing group are plain non-capturing groups to the check. A JavaScript-style
 * named group is its own spelling, listed so its name counts toward a duplicate.
 */
const GROUP_REWRITES: readonly GroupRewrite[] = [
  { syntax: new RegExp(`^\\(\\?P<${GROUP_NAME}>`), form: "(?<$1>" },
  { syntax: new RegExp(`^\\(\\?'${GROUP_NAME}'`), form: "(?<$1>" },
  { syntax: new RegExp(`^\\(\\?<${GROUP_NAME}>`), form: "(?<$1>" },
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?)\)/, form: "" },
  { syntax: /^\(\?(?:[imsx]*(?:-[imsx]+)?):/, form: "(?:" },
  { syntax: /^\(\?>/, form: "(?:" },
];

/** The `{m}`, `{m,}`, `{m,n}` quantifier at a `{`; any other brace is a literal to PCRE and to a flagless RegExp alike. */
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/** A POSIX class member inside a class, one unit to PCRE where a flagless RegExp reads a nested `[` and a closing `]`. */
const POSIX_CLASS =
  /^\[:\^?(?:alnum|alpha|ascii|blank|cntrl|digit|graph|lower|print|punct|space|upper|word|xdigit):\]/;

/** The PCRE anchors a flagless RegExp reads as repeatable literals; a quantifier on one is a PCRE error the RegExp must keep seeing. */
const UNREPEATABLE_ESCAPE = /^\\[AzZGK]$/;

/** The escape starting at `index` as PCRE reads it, with how far it reaches. */
function escapeAt(source: string, index: number): [Token, number] {
  if (source.startsWith("\\Q", index)) {
    const end = source.indexOf("\\E", index + 2);
    const literal = end === -1 ? source.slice(index + 2) : source.slice(index + 2, end);
    const token: Token = literal === "" ? { kind: "dropped" } : { kind: "quote", literal };
    return [token, (end === -1 ? source.length : end + 2) - index];
  }
  if (source.startsWith("\\E", index)) {
    return [{ kind: "dropped" }, 2];
  }
  const long = /^\\(?:x\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{1,2}|o\{[0-7]+\}|c[\x20-\x7E])/.exec(
    source.slice(index),
  );
  const text = long === null ? source.slice(index, index + 2) : long[0];
  // A lone trailing backslash is a one-character escape the RegExp then refuses.
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
      const [token, advance] = escapeAt(source, i);
      i += push(token, advance);
      continue;
    }
    if (inClass) {
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
      const negated = rest[1] === "^";
      i += push({ kind: "classOpen", negated }, negated ? 2 : 1);
      inClass = true;
      classHasMember = false;
      continue;
    }
    if (rest.startsWith("(?#")) {
      const end = rest.indexOf(")");
      // Unterminated, the `(?#` stays for the RegExp to refuse, as PCRE refuses it.
      i += end === -1 ? push({ kind: "literal", text: ch }, 1) : push({ kind: "dropped" }, end + 1);
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
    const brace = ch === "{" ? BRACE_QUANTIFIER.exec(rest) : null;
    if (ch === "*" || ch === "+" || ch === "?" || brace !== null) {
      const text = brace === null ? ch : brace[0];
      // One modifier at most after a quantifier: `?` lazy, `+` possessive; anything more is a quantifier again, dangling.
      if (previous?.kind === "quantifier" && ch === "?") {
        i += push({ kind: "lazy" }, 1);
      } else if (previous?.kind === "quantifier" && ch === "+") {
        i += push({ kind: "possessive" }, 1);
      } else {
        i += push({ kind: "quantifier", text }, text.length);
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

/** The code points PCRE spells as an escape and a flagless RegExp reads as a letter (`\a` is an a): the letter's value. */
const LETTER_ESCAPES: Readonly<Record<string, number>> = { a: 0x07, e: 0x1b };

/**
 * PCRE's code point spellings a flagless RegExp reads differently (hex with braces or one digit,
 * braced octal, `\cX`, `\a`, `\e`) as JavaScript spells them, so a class range over them keeps its
 * order; any other escape as is.
 */
function renderEscape(text: string): string {
  const hex = /^\\x\{?([0-9A-Fa-f]+)\}?$/.exec(text);
  if (hex !== null) {
    return codePointEscape(Number.parseInt(hex[1] as string, 16));
  }
  const octal = /^\\o\{([0-7]+)\}$/.exec(text);
  if (octal !== null) {
    return codePointEscape(Number.parseInt(octal[1] as string, 8));
  }
  const control = /^\\c(.)$/.exec(text);
  if (control !== null) {
    return codePointEscape((control[1] as string).toUpperCase().charCodeAt(0) ^ 0x40);
  }
  const letter = LETTER_ESCAPES[text.slice(1)];
  return letter === undefined || text.length !== 2 ? text : codePointEscape(letter);
}

/** The group names `tokens` declare more than once, in either spelling: PCRE refuses the pattern, so no rewrite may repair it. */
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
 * `source` with the PCRE-only forms rewritten into the JavaScript spelling, so
 * `new RegExp(compilableForm(source))` is the syntax check. A rewrite that would repair a PCRE
 * error is withheld: a quantifier right after a possessive `+` or an option group, a possessive `+`
 * on an anchor, and a Python-style group whose name is declared twice keep the PCRE spelling.
 * Anything the table does not name passes through untouched.
 */
export function compilableForm(source: string): string {
  const tokens = tokenize(source).filter((token) => token.kind !== "dropped");
  const duplicates = duplicateNames(tokens);
  let out = "";
  for (const [index, token] of tokens.entries()) {
    const quantifierNext = tokens[index + 1]?.kind === "quantifier";
    switch (token.kind) {
      case "literal":
      case "quantifier":
        out += token.text;
        break;
      case "escape":
        out += renderEscape(token.text);
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
      case "group": {
        const withheld =
          (token.form === "" && quantifierNext) ||
          (token.name !== undefined && duplicates.has(token.name));
        out += withheld ? token.text : token.form;
        break;
      }
      case "lazy":
        out += "?";
        break;
      case "possessive": {
        const atom = tokens[index - 2];
        const onAnchor = atom?.kind === "escape" && UNREPEATABLE_ESCAPE.test(atom.text);
        out += quantifierNext || onAnchor ? "+" : "";
        break;
      }
    }
  }
  return out;
}

export function compileFailure(source: string): string | undefined {
  try {
    new RegExp(compilableForm(source));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The `exclude` input's glob grammar: one pattern compiled once at the input boundary, every flaw named beside its
 * fix, and the match of a compiled pattern against a discovered repository's slug or name.
 *
 * The grammar is owned here, not left to picomatch, because picomatch accepts far more than a repository name can
 * hold ("(a)+" a quantifier, "\d" a digit class, "{az..bz}" a range, "./" silently dropped, "***" losing the
 * escape of a later dot) and compiles several such inputs to a wrong or never-matching regex with no option to
 * refuse them. The pattern is the user's input, so a flaw is refused naming its fix, never repaired, and every
 * flaw of one pattern is named at once, so N flaws cost one run to discover, not N: each step names one fix and
 * hands the next step the view with it applied, in the order the sentences take. What is left for the user to
 * write is named last with no fix applied: the length cap, an empty body, the sides around a "/", a side that is
 * only dots, and a regex the engine itself refuses.
 */

import { err, ok, type Result } from "neverthrow";
import picomatch from "picomatch";
import type { ProblemOf } from "../problem.js";
import { quote } from "../text.js";

/**
 * One `exclude` entry, compiled once at the input boundary. Plain data on purpose: a config built from argv must
 * equal one built from the environment, so the matcher is picomatch's RegExp, not a closure over it.
 */
export interface ExcludePattern {
  /** The operator's text, for the skip notice. */
  readonly pattern: string;

  /** "slug" when the pattern has a "/" and is compared against owner/name, "name" when against the name alone. */
  readonly scope: "slug" | "name";

  /** picomatch's matcher for the pattern, run against the text the scope picks. */
  readonly regex: RegExp;
}

/** picomatch is built for file paths and a slug is a GitHub identifier, so each option is set for a name, none left to its default. */
const EXCLUDE_GLOB_OPTIONS = {
  nocase: true, // GitHub compares repository names case-insensitively
  dot: true, // a leading "." is an ordinary name character (".github"), not the hidden-file marker
  posix: true, // "[!ab]" is a negated class, as in a shell, not a class holding "!"
  fastpaths: false, // the star-led shortcut regexes demand a character after a literal dot, so "*.*" would miss "archive."
  debug: true, // an invalid class like "[z-a]" throws instead of compiling to a never-matching regex
  windows: false, // pinned: only picomatch's main callable reads the host OS; makeRe never does
  literalBrackets: false, // no alternation with the class's literal text (no name holds it); thousands compile in milliseconds, under the engine's limit
} as const;

/** Every character no owner or repository name holds and no glob operator here uses. */
const EXCLUDE_STRAYS = /[^\w.\-/*?[\]!^]/g;

/** A class: "!" or "^" may open it, its members are name characters, and a "-" is a range between two of them or a literal first or last, nothing else, so turning a backwards range around can never pair a new one. */
const EXCLUDE_CLASS = /^\[[!^]?(?:-?(?:[\w.](?:-[\w.])?)+-?|-)\]$/;

/** One side of the "/": name characters, "*", "?", and classes. */
const EXCLUDE_SEGMENT = new RegExp(`^(?:[\\w.\\-*?]|${EXCLUDE_CLASS.source.slice(1, -1)})+$`);

/** picomatch refuses a longer pattern; judged here so the refusal names the fix beside the pattern's other flaws. */
const EXCLUDE_MAX_LENGTH = picomatch.constants.MAX_LENGTH;

/** `where` of every unpaired bracket: a "[" pairs with the next "]" on its side of the "/", nothing else does. */
function unpairedBrackets(view: string): number[] {
  const unpaired: boolean[] = [];
  let open = -1;
  for (let i = 0; i < view.length; i++) {
    const char = view[i];
    if (char === "[" && open < 0) {
      open = i;
      continue;
    }

    if (char === "[") {
      unpaired[i] = true;
      continue;
    }

    if (char === "]" && open < 0) {
      unpaired[i] = true;
      continue;
    }

    if (char === "]") {
      open = -1;
      continue;
    }

    if (char === "/" && open >= 0) {
      unpaired[open] = true;
      open = -1;
    }
  }

  if (open >= 0) {
    unpaired[open] = true;
  }

  return Array.from({ length: view.length }, (_, i) => i).filter((i) => unpaired[i] === true);
}

/** `where` of every "!" or "^" that neither negates (a "!" first) nor opens a class (right after "["). */
function misplacedMarks(view: string): number[] {
  const where: number[] = [];
  for (let i = 0; i < view.length; i++) {
    const char = view[i];
    if ((char === "!" || char === "^") && !(i === 0 && char === "!") && view[i - 1] !== "[") {
      where.push(i);
    }
  }
  return where;
}

function without(view: string, where: readonly number[]): string {
  const skip = new Set(where);
  return view
    .split("")
    .filter((_, i) => !skip.has(i))
    .join("");
}

/** The classes of a view whose brackets pair, in order: each "[" up to the next "]", with where it starts. */
function classesOf(view: string): Array<{ at: number; text: string }> {
  const classes: Array<{ at: number; text: string }> = [];
  let open = view.indexOf("[");
  while (open >= 0) {
    const close = view.indexOf("]", open);
    if (close < 0) {
      break;
    }
    classes.push({ at: open, text: view.slice(open, close + 1) });
    open = view.indexOf("[", close);
  }
  return classes;
}

/** The members of one class with every literal "-" moved last, the one interior place the grammar refuses it. */
function withHyphensLast(members: string): string {
  const kept: string[] = [];
  let literal = false;
  for (let i = 0; i < members.length; i++) {
    const char = members[i] ?? "";
    const high = members[i + 2] ?? "";
    if (char === "-") {
      literal = true;
    } else if (members[i + 1] === "-" && /[\w.]/.test(high)) {
      kept.push(`${char}-${high}`);
      i += 2;
    } else {
      kept.push(char);
    }
  }
  return `${kept.join("")}${literal ? "-" : ""}`;
}

const listed = <T>(items: readonly T[], render: (item: T) => string): string =>
  items.map(render).join(" and ");

/** One operator or bracket of a view, with where it sits. */
interface MarkAt {
  readonly char: string;
  readonly index: number;
}

const marksAt = (view: string, where: readonly number[]): MarkAt[] =>
  where.map((index) => ({ char: view[index] ?? "", index }));

/**
 * One flaw of a pattern: its kind, and the fragments of the pattern its sentence quotes. Only shownFlaw reads the
 * fragments; the hidden form is HIDDEN_FLAW, keyed by kind alone, so it can print no character of the pattern.
 */
export type ExcludeFlaw =
  | { readonly kind: "whitespace" }
  | { readonly kind: "strays"; readonly strays: readonly string[] }
  | { readonly kind: "unpaired-brackets"; readonly at: readonly MarkAt[] }
  | { readonly kind: "misplaced-marks"; readonly at: readonly MarkAt[] }
  | { readonly kind: "class-operators"; readonly cls: string; readonly fixed: string }
  | { readonly kind: "class-empty"; readonly cls: string }
  | { readonly kind: "class-hyphen"; readonly cls: string; readonly fixed: string }
  | {
      readonly kind: "class-backwards";
      readonly cls: string;
      readonly ranges: readonly string[];
      readonly fixed: string;
    }
  | { readonly kind: "dot-slash" }
  | { readonly kind: "star-run" }
  | { readonly kind: "too-long"; readonly length: number }
  | { readonly kind: "empty" }
  | { readonly kind: "bare-negation" }
  | { readonly kind: "slash-sides" }
  | { readonly kind: "dots-only" }
  | { readonly kind: "not-a-glob" }
  | { readonly kind: "engine-refused" };

/** Each kind's sentence for a run that hides private repositories: the flaw and the fix, and nothing of the pattern. */
export const HIDDEN_FLAW: Readonly<Record<ExcludeFlaw["kind"], string>> = {
  whitespace: "it is wrapped in whitespace, so trim it",
  strays: "it holds a character no owner or repository name contains, so remove each one",
  "unpaired-brackets": "it has a bracket with no partner, so remove it",
  "misplaced-marks": "it has a negation mark that neither negates nor opens a class, so remove it",
  "class-operators":
    "it has a class holding a glob operator, and a class takes name characters only, so remove the operator",
  "class-empty": "it has a class that matches nothing, so delete the class",
  "class-hyphen":
    "it has a class with a hyphen where it reads as a range operator, so keep one hyphen and put it last in the class",
  "class-backwards": "it has a class with a backwards range, so turn the range around",
  "dot-slash": "it starts with a dot and a slash, which names no owner, so drop that lead",
  "star-run":
    "it holds a run of stars, which matches no more than one star does, so write one star",
  "too-long": `it is longer than the cap of ${EXCLUDE_MAX_LENGTH} characters, so shorten it`,
  empty: "it is empty",
  "bare-negation": "it is a negation mark with nothing to negate",
  "slash-sides": "it takes at most one slash, with a glob on each side of it",
  "dots-only": "one side of it is one dot or two dots, which is never a name",
  "not-a-glob":
    "it is not name characters, stars, question marks, and classes on each side of the slash",
  "engine-refused":
    "it compiles to a regular expression the runtime refuses, so shorten it or split it across several patterns",
};

/** The sentence that quotes the pattern's own fragments beside the fix. */
function shownFlaw(flaw: ExcludeFlaw): string {
  switch (flaw.kind) {
    case "whitespace":
      return "it is wrapped in whitespace, so trim it";
    case "strays":
      return (
        `it holds ${flaw.strays.map(quote).join(", ")}, which no owner or repository name contains, so remove ` +
        `${flaw.strays.length === 1 ? "it" : "them"}`
      );
    case "unpaired-brackets": {
      const one = flaw.at.length === 1;
      return `its ${listed(flaw.at, markAt)} ${one ? "has" : "have"} no partner, so remove ${one ? "it" : "them"}`;
    }
    case "misplaced-marks": {
      const one = flaw.at.length === 1;
      return (
        `its ${listed(flaw.at, markAt)} neither negate${one ? "s" : ""} ` +
        `nor open${one ? "s" : ""} a class, so remove ${one ? "it" : "them"}`
      );
    }
    case "class-operators":
      return `the class "${flaw.cls}" takes name characters only, so write it as "${flaw.fixed}"`;
    case "class-empty":
      return `the class "${flaw.cls}" matches nothing, so delete it`;
    case "class-hyphen":
      return `the class "${flaw.cls}" has a "-" where it reads as a range operator, so write it as "${flaw.fixed}"`;
    case "class-backwards":
      return `the class "${flaw.cls}" has the backwards range ${listed(flaw.ranges, quote)}, so write it as "${flaw.fixed}"`;
    case "dot-slash":
      return `it starts with "./", which names no owner, so drop every leading "./"`;
    case "star-run":
      return `it holds a run of stars, which matches no more than one "*" does, so write one "*"`;
    case "too-long":
      return `it is ${flaw.length} characters long, past the cap of ${EXCLUDE_MAX_LENGTH}, so shorten it`;
    case "empty":
      return "it is empty";
    case "bare-negation":
      return `"!" has nothing to negate`;
    case "slash-sides":
      return `it takes at most one "/", with a non-empty glob on each side of it`;
    case "dots-only":
      return `"." and ".." are never names`;
    case "not-a-glob":
      return `it is not name characters, "*", "?", and classes "[abc]" or "[!abc]" on each side of the "/"`;
    case "engine-refused":
      return "it compiles to a regular expression the runtime refuses, so shorten it or split it across several patterns";
  }
}

const markAt = (mark: MarkAt): string => `${quote(mark.char)} at ${mark.index}`;

/** A step's result: the view with its fix applied and the sentence naming it; `done` ends the pass. */
interface Pass {
  /** The pattern with this step's fix applied. */
  readonly view: string;

  /** The flaw this step found, none when the view was already right. */
  readonly flaws: readonly ExcludeFlaw[];

  /** Ends the pass: no later step can judge the view. */
  readonly done?: boolean;

  /** The view compiled, from the step that probes the engine, so the clean path compiles once. */
  readonly regex?: RegExp;
}

/** Every step reads only the view the steps before it left, so none can judge the raw pattern. */
type Step = (view: string) => Pass;

const unchanged = (view: string): Pass => ({ view, flaws: [] });

const applied = (view: string, fixed: string, flaw: ExcludeFlaw): Pass =>
  fixed === view ? unchanged(view) : { view: fixed, flaws: [flaw] };

const named = (view: string, flaw: ExcludeFlaw): Pass => ({ view, flaws: [flaw] });

/** The classes are rewritten in one walk, so a pattern of many flawed classes costs one pass, not one per class. */
function rewriteClasses(view: string): Pass {
  const flaws: ExcludeFlaw[] = [];
  let rebuilt = "";
  let cursor = 0;
  for (const { at, text } of classesOf(view)) {
    rebuilt += view.slice(cursor, at);
    cursor = at + text.length;
    let cls = text;
    const rewrite = (to: string, flaw: ExcludeFlaw): void => {
      if (to !== cls) {
        flaws.push(flaw);
        cls = to;
      }
    };
    const kept = cls.replace(/[*?]/g, "");
    rewrite(kept, { kind: "class-operators", cls, fixed: kept });
    if (/^\[[!^]?\]$/.test(cls)) {
      rewrite("", { kind: "class-empty", cls });
      continue;
    }
    if (!EXCLUDE_CLASS.test(cls)) {
      const [, opener = "", members = ""] = /^\[([!^]?)(.*)\]$/.exec(cls) ?? [];
      const settled = `[${opener}${withHyphensLast(members)}]`;
      rewrite(settled, { kind: "class-hyphen", cls, fixed: settled });
    }
    const backwards: string[] = [];
    const turned = cls.replace(/([\w.])-([\w.])/g, (range, low: string, high: string) => {
      if (low <= high) {
        return range;
      }
      backwards.push(range);
      return `${high}-${low}`;
    });
    rewrite(turned, { kind: "class-backwards", cls, ranges: backwards, fixed: turned });
    rebuilt += cls;
  }
  return { view: rebuilt + view.slice(cursor), flaws };
}

/** Each step names one fix and hands the next the view with it applied; the header says why the grammar is owned here. */
const EXCLUDE_STEPS: readonly Step[] = [
  (view) => applied(view, view.trim(), { kind: "whitespace" }),
  (view) => {
    const strays = [...new Set(view.match(EXCLUDE_STRAYS) ?? [])];
    return applied(view, view.replace(EXCLUDE_STRAYS, ""), { kind: "strays", strays });
  },
  (view) => {
    const where = unpairedBrackets(view);
    return applied(view, without(view, where), {
      kind: "unpaired-brackets",
      at: marksAt(view, where),
    });
  },
  (view) => {
    const where = misplacedMarks(view);
    return applied(view, without(view, where), {
      kind: "misplaced-marks",
      at: marksAt(view, where),
    });
  },
  rewriteClasses,
  (view) => applied(view, view.replace(/^(!?)(?:\.\/)+/, "$1"), { kind: "dot-slash" }),
  (view) => applied(view, view.replace(/\*{2,}/g, "*"), { kind: "star-run" }),
  (view) =>
    view.length > EXCLUDE_MAX_LENGTH
      ? named(view, { kind: "too-long", length: view.length })
      : unchanged(view),
  (view) => {
    const negated = view.startsWith("!");
    const body = negated ? view.slice(1) : view;
    return body === ""
      ? { view, flaws: [{ kind: negated ? "bare-negation" : "empty" }], done: true }
      : unchanged(view);
  },
  (view) => {
    const segments = view.replace(/^!/, "").split("/");
    return segments.length > 2 || segments.includes("")
      ? named(view, { kind: "slash-sides" })
      : unchanged(view);
  },
  (view) =>
    view
      .replace(/^!/, "")
      .split("/")
      .some((side) => side === "." || side === "..")
      ? named(view, { kind: "dots-only" })
      : unchanged(view),
  (view) =>
    view
      .replace(/^!/, "")
      .split("/")
      .every((side) => side === "" || EXCLUDE_SEGMENT.test(side))
      ? unchanged(view)
      : named(view, { kind: "not-a-glob" }),
  (view) => {
    if (view.length > EXCLUDE_MAX_LENGTH) {
      return unchanged(view);
    }
    try {
      // V8 compiles a RegExp on its first use, so the engine's own refusal (a class too wide for its tables, a
      // nesting too deep) surfaces here, in the same refusal as the other flaws.
      const regex = picomatch.makeRe(view, EXCLUDE_GLOB_OPTIONS);
      regex.test("");
      return { view, flaws: [], regex };
    } catch {
      return named(view, { kind: "engine-refused" });
    }
  },
];

/** Every flaw of the pattern, and the compiled view when the engine step reached and accepted it. */
function judgeExcludePattern(pattern: string): { flaws: ExcludeFlaw[]; regex: RegExp | undefined } {
  const flaws: ExcludeFlaw[] = [];
  let view = pattern;
  let regex: RegExp | undefined;
  for (const step of EXCLUDE_STEPS) {
    const next = step(view);
    for (const flaw of next.flaws) {
      flaws.push(flaw);
    }
    view = next.view;
    regex = next.regex;
    if (next.done) {
      break;
    }
  }
  return { flaws, regex };
}

/**
 * The scope split mirrors the repos-dir `<name>.yml` vs `<owner>/<name>.yml` pairing; picomatch's own basename
 * mode cannot express it (a slashed pattern stops matching the whole slug under it).
 */
function compile(pattern: string): Result<ExcludePattern, ExcludeFlaw[]> {
  const { flaws, regex } = judgeExcludePattern(pattern);
  if (flaws.length > 0) {
    return err(flaws);
  }
  if (regex === undefined) {
    throw new Error("BUG: an exclude pattern passed every step but the engine step never ran");
  }
  const scope = pattern.includes("/") ? "slug" : "name";
  return ok({ pattern, scope, regex });
}

/** The refusal quotes the pattern and each flaw's fragment of it: the form for a run that hides nothing. */
export function compileExcludePattern(
  pattern: string,
): Result<ExcludePattern, ProblemOf<"input-exclude-pattern-invalid">> {
  return compile(pattern).mapErr((flaws) => ({
    code: "input-exclude-pattern-invalid",
    pattern,
    reason: flaws.map(shownFlaw).join(", and "),
  }));
}

/**
 * The refusal for a run that hides private repositories: the pattern is named by its 1-based `position` in the
 * list and each kind of flaw by a sentence with no character of the pattern in it. `revealable` is the caller's:
 * whether its face accepts `private-repos: show`.
 */
export function compileHiddenExcludePattern(
  pattern: string,
  position: number,
  revealable: boolean,
): Result<ExcludePattern, ProblemOf<"input-exclude-pattern-invalid-hidden">> {
  return compile(pattern).mapErr((flaws) => ({
    code: "input-exclude-pattern-invalid-hidden",
    position,
    revealable,
    reason: [...new Set(flaws.map((flaw) => HIDDEN_FLAW[flaw.kind]))].join(", and "),
  }));
}

export function excludeMatches(exclude: ExcludePattern, slug: string): boolean {
  const candidate = exclude.scope === "slug" ? slug : slug.slice(slug.indexOf("/") + 1);
  return exclude.regex.test(candidate);
}

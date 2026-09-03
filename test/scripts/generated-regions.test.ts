// The marker splice and placement check every generator shares (.github/scripts/lib/generated-regions.ts):
// byte-exact splices per comment syntax, malformed or look-alike markers refused, and a region whose
// markers moved from their home, into a code block, or around authored text refused by name.

import { describe, expect, test } from "bun:test";
import {
  assertRegionPlacement,
  type MarkerSyntax,
  markerSyntaxFor,
  type RegionSpec,
  regenerateRegions,
  regionBounds,
  replaceRegion,
} from "../../.github/scripts/lib/generated-regions.js";
import { relocatedRegion } from "./relocated-region.js";

const HTML_BLOCK = [
  "before",
  "<!-- BEGIN GENERATED: table (bun run build:docs; edit x) -->",
  "old",
  "<!-- END GENERATED: table -->",
  "after",
].join("\n");

// Look-alikes for the region "tab" under the html syntax: a name the target only prefixes, name
// suffixes, bare text, an unterminated comment, a markdown heading, and YAML-form markers.
const HTML_NEAR_MISSES = [
  "<!-- BEGIN GENERATED: table -->",
  "<!-- BEGIN GENERATED: tab.extra -->",
  "<!-- BEGIN GENERATED: tab_y -->",
  "<!-- BEGIN GENERATED: tabX -->",
  "BEGIN GENERATED: tab",
  "<!-- BEGIN GENERATED: tab",
  "# BEGIN GENERATED: tab",
  "<!-- END GENERATED: table -->",
  "END GENERATED: tab",
  "# END GENERATED: tab",
].join("\n");

// Look-alikes for "tab" under the yaml syntax: trailing text, a trailing comment, HTML-form
// markers as values, and marker-shaped lines that are scalar CONTENT (literal and folded block
// scalars, a multiline double-quoted and single-quoted scalar).
const YAML_NEAR_MISSES = [
  "# BEGIN GENERATED: tab and more",
  "key: 1 # BEGIN GENERATED: tab",
  "html: <!-- BEGIN GENERATED: tab -->",
  "literal: |",
  "  # BEGIN GENERATED: tab",
  "  # END GENERATED: tab",
  "folded: >-",
  "  # BEGIN GENERATED: tab (hint)",
  'quoted: "one',
  "  # END GENERATED: tab",
  '  two"',
  "single: 'one",
  "  # BEGIN GENERATED: tab",
  "  two'",
  "html2: <!-- END GENERATED: tab -->",
].join("\n");

describe("markerSyntaxFor", () => {
  test.each<[path: string, syntax: MarkerSyntax]>([
    ["README.md", "html"],
    ["docs/operate/check-mode.md", "html"],
    ["action.yml", "yaml"],
    [".github/workflows/x.yaml", "yaml"],
  ])("%s uses %s markers", (path, syntax) => {
    expect(markerSyntaxFor(path)).toBe(syntax);
  });

  test("a file type without a marker syntax throws instead of guessing", () => {
    expect(() => markerSyntaxFor("lib/settings.schema.json")).toThrow(
      "no generated-region marker syntax is defined for lib/settings.schema.json",
    );
  });
});

describe("replaceRegion", () => {
  test.each<
    [
      label: string,
      syntax: MarkerSyntax,
      text: string,
      name: string,
      body: string,
      expected: string,
    ]
  >([
    [
      "an HTML block region whose BEGIN carries a hint",
      "html",
      HTML_BLOCK,
      "table",
      "\nnew\n",
      "before\n<!-- BEGIN GENERATED: table (bun run build:docs; edit x) -->\nnew\n<!-- END GENERATED: table -->\nafter",
    ],
    [
      "an inline HTML region inside a sentence",
      "html",
      "a (<!-- BEGIN GENERATED: list -->x<!-- END GENERATED: list -->) b",
      "list",
      "y",
      "a (<!-- BEGIN GENERATED: list -->y<!-- END GENERATED: list -->) b",
    ],
    [
      "an empty HTML region",
      "html",
      "<!-- BEGIN GENERATED: e --><!-- END GENERATED: e -->",
      "e",
      "z",
      "<!-- BEGIN GENERATED: e -->z<!-- END GENERATED: e -->",
    ],
    [
      "an HTML region whose surroundings mention the markers in prose and in look-alike forms",
      "html",
      `the BEGIN GENERATED: tab line and END GENERATED: tab line\n${HTML_NEAR_MISSES}\n${HTML_BLOCK.replace(/table/g, "tab")}`,
      "tab",
      "\nnew\n",
      `the BEGIN GENERATED: tab line and END GENERATED: tab line\n${HTML_NEAR_MISSES}\nbefore\n<!-- BEGIN GENERATED: tab (bun run build:docs; edit x) -->\nnew\n<!-- END GENERATED: tab -->\nafter`,
    ],
    [
      "a YAML region at column zero",
      "yaml",
      "# BEGIN GENERATED: inputs\nold\n# END GENERATED: inputs\n",
      "inputs",
      "\nnew\n",
      "# BEGIN GENERATED: inputs\nnew\n# END GENERATED: inputs\n",
    ],
    [
      "an indented YAML region, the markers' indentation kept outside the span",
      "yaml",
      "a: 1\n  # BEGIN GENERATED: y (edit z)\n  old: 1\n  # END GENERATED: y\nb: 2\n",
      "y",
      "\n  new: 1\n  ",
      "a: 1\n  # BEGIN GENERATED: y (edit z)\n  new: 1\n  # END GENERATED: y\nb: 2\n",
    ],
    [
      "a YAML region whose markers carry trailing whitespace, kept outside the span",
      "yaml",
      "# BEGIN GENERATED: t (h)  \nold\n# END GENERATED: t \n",
      "t",
      "\nnew\n",
      "# BEGIN GENERATED: t (h)  \nnew\n# END GENERATED: t \n",
    ],
    [
      "a YAML region whose scalars hold marker-shaped content, with the real markers at the scalars' own indentation",
      "yaml",
      `${YAML_NEAR_MISSES}\ninputs:\n  # BEGIN GENERATED: tab\n  old: 1\n  # END GENERATED: tab\n`,
      "tab",
      "\n  new: 1\n  ",
      `${YAML_NEAR_MISSES}\ninputs:\n  # BEGIN GENERATED: tab\n  new: 1\n  # END GENERATED: tab\n`,
    ],
  ])("splices %s byte-exactly", (_label, syntax, text, name, body, expected) => {
    expect(replaceRegion(text, name, body, syntax)).toBe(expected);
  });

  test.each<[label: string, syntax: MarkerSyntax, text: string, name: string, error: string]>([
    [
      "a region with no markers",
      "html",
      HTML_BLOCK,
      "missing",
      'region "missing" needs exactly one BEGIN and one END marker, found 0 and 0',
    ],
    ["only HTML look-alikes", "html", HTML_NEAR_MISSES, "tab", "found 0 and 0"],
    ["only YAML look-alikes and scalar content", "yaml", YAML_NEAR_MISSES, "tab", "found 0 and 0"],
    [
      "YAML markers offered to the html syntax",
      "html",
      "# BEGIN GENERATED: x\n# END GENERATED: x",
      "x",
      "found 0 and 0",
    ],
    [
      "HTML markers offered to the yaml syntax",
      "yaml",
      "<!-- BEGIN GENERATED: x -->\n<!-- END GENERATED: x -->",
      "x",
      "found 0 and 0",
    ],
    [
      "a name that only prefixes the markers' name",
      "html",
      "<!-- BEGIN GENERATED: x-long -->\n<!-- END GENERATED: x-long -->",
      "x",
      "found 0 and 0",
    ],
    ["a missing END marker", "html", "<!-- BEGIN GENERATED: x -->\nbody", "x", "found 1 and 0"],
    [
      "a duplicated BEGIN marker",
      "html",
      "<!-- BEGIN GENERATED: x -->\n<!-- BEGIN GENERATED: x -->\n<!-- END GENERATED: x -->",
      "x",
      "found 2 and 1",
    ],
    ["a duplicated pair", "html", `${HTML_BLOCK}\n${HTML_BLOCK}`, "table", "found 2 and 2"],
    [
      "END before BEGIN",
      "html",
      "<!-- END GENERATED: t -->\n<!-- BEGIN GENERATED: t -->",
      "t",
      'region "t" has its END marker before its BEGIN marker',
    ],
    [
      "END before BEGIN in YAML",
      "yaml",
      "# END GENERATED: t\n# BEGIN GENERATED: t",
      "t",
      'region "t" has its END marker before its BEGIN marker',
    ],
    [
      "a hint spanning lines (it would swallow content)",
      "html",
      "<!-- BEGIN GENERATED: x (a\nb) -->\n<!-- END GENERATED: x -->",
      "x",
      "found 0 and 1",
    ],
    [
      "a hint on the END marker",
      "html",
      "<!-- BEGIN GENERATED: x -->\n<!-- END GENERATED: x (h) -->",
      "x",
      "found 1 and 0",
    ],
    [
      "a # marker with trailing text",
      "yaml",
      "# BEGIN GENERATED: x and more\n# END GENERATED: x",
      "x",
      "found 0 and 1",
    ],
    [
      "a # marker that is not the whole line",
      "yaml",
      "key: 1 # BEGIN GENERATED: x\n# END GENERATED: x",
      "x",
      "found 0 and 1",
    ],
    [
      "a BEGIN marker that is literal block-scalar content",
      "yaml",
      "d: |\n  # BEGIN GENERATED: x\n# END GENERATED: x",
      "x",
      "found 0 and 1",
    ],
    [
      "an END marker that is folded block-scalar content",
      "yaml",
      "# BEGIN GENERATED: x\nd: >\n  # END GENERATED: x\n",
      "x",
      "found 1 and 0",
    ],
    [
      "a BEGIN marker inside a multiline double-quoted scalar",
      "yaml",
      'd: "one\n  # BEGIN GENERATED: x\n  two"\n# END GENERATED: x',
      "x",
      "found 0 and 1",
    ],
  ])("throws on %s", (_label, syntax, text, name, error) => {
    expect(() => replaceRegion(text, name, "x", syntax)).toThrow(error);
  });

  test.each(["Bad.Name", "UPPER", "a_b", "a b", "", "x*"])(
    "rejects the region name %j before scanning, even when such a marker pair exists",
    (name) => {
      const text = `<!-- BEGIN GENERATED: ${name} -->old<!-- END GENERATED: ${name} -->`;
      expect(() => replaceRegion(text, name, "new", "html")).toThrow(
        `a region name is lowercase letters, digits, and dashes; got "${name}"`,
      );
    },
  );
});

describe("regionBounds", () => {
  test("returns each marker's [start, end) offsets so callers can inspect the body and its context", () => {
    const begin = "<!-- BEGIN GENERATED: table (bun run build:docs; edit x) -->";
    const end = "<!-- END GENERATED: table -->";
    const beginStart = HTML_BLOCK.indexOf(begin);
    const endStart = HTML_BLOCK.indexOf(end);
    expect(regionBounds(HTML_BLOCK, "table", "html")).toEqual({
      begin: [beginStart, beginStart + begin.length],
      end: [endStart, endStart + end.length],
    });
    expect(HTML_BLOCK.slice(beginStart + begin.length, endStart)).toBe("\nold\n");
  });
});

// A page with a table region and an inline region under "## Inputs", a fenced block holding a
// heading-shaped line, and a link-definition region closing the file.
const PAGE = [
  "# Title",
  "",
  "Intro.",
  "",
  "## Inputs",
  "",
  "<!-- BEGIN GENERATED: table (edit x) -->",
  "| A | B |",
  "|---|---|",
  "| `x` | 1 |",
  "<!-- END GENERATED: table -->",
  "",
  "Result: (<!-- BEGIN GENERATED: list -->`a` / `b`<!-- END GENERATED: list -->).",
  "",
  "## Example",
  "",
  "```yaml",
  "# not a heading",
  "key: value",
  "```",
  "",
  "## Notes",
  "",
  "Prose.",
  "",
  "<!-- BEGIN GENERATED: link -->",
  "[form]: https://example.com",
  "<!-- END GENERATED: link -->",
  "",
].join("\n");

const TABLE: RegionSpec = {
  name: "table",
  placement: { kind: "under-heading", heading: "## Inputs" },
  body: /^\n(?:\| A \| B \|\n\|---\|---\|\n(?:\| `[a-z]+` \| \d+ \|\n)*)?$/,
};
const LIST: RegionSpec = {
  name: "list",
  placement: { kind: "under-heading", heading: "## Inputs" },
  body: /^(?:`[a-z]`(?: \/ `[a-z]`)*)?$/,
};
const LINK: RegionSpec = {
  name: "link",
  placement: { kind: "tail" },
  body: /^\n(?:\[form\]: \S+\n)?$/,
};

// An action manifest: two mapping regions, the END markers at column zero as action.yml writes them.
const MANIFEST = [
  "name: x",
  "",
  "inputs:",
  "  # BEGIN GENERATED: ins (edit y)",
  "  token:",
  "    description: >-",
  "      The token.",
  "    default: ''",
  "# END GENERATED: ins",
  "",
  "outputs:",
  "  # BEGIN GENERATED: outs",
  "  result:",
  "    description: >-",
  "      The result.",
  "# END GENERATED: outs",
  "",
  "runs:",
  "  using: node24",
  "",
].join("\n");

const ENTRIES = /^\n(?: {2}[a-z]+:\n(?: {4,}[^\n]*\n)+)*$/;
/** The file each fixture region is checked in, which picks its marker syntax. */
const PATH_OF: Readonly<Record<string, string>> = {
  table: "doc.md",
  list: "doc.md",
  link: "doc.md",
  ins: "action.yml",
  outs: "action.yml",
};
const INS: RegionSpec = {
  name: "ins",
  placement: { kind: "under-key", key: "inputs" },
  body: ENTRIES,
};
const OUTS: RegionSpec = {
  name: "outs",
  placement: { kind: "under-key", key: "outputs" },
  body: ENTRIES,
};

describe("assertRegionPlacement", () => {
  test("accepts each region where its spec puts it, with an authored comment or a fenced heading-shaped line in between", () => {
    for (const spec of [TABLE, LIST, LINK]) {
      expect(() => assertRegionPlacement(PAGE, spec, "doc.md")).not.toThrow();
    }
    // Heading-shaped lines inside a fence, a raw block, or a blockquote head nothing outside
    // them, so "## Inputs" stays the heading above the table.
    for (const between of ["```\n# fake\n```\n\n", "<pre>\n## fake\n</pre>\n\n", "> ## fake\n\n"]) {
      const shadowed = PAGE.replace("## Inputs\n\n", `## Inputs\n\n${between}`);
      expect(() => assertRegionPlacement(shadowed, TABLE, "doc.md"), between).not.toThrow();
    }
    // A marker on the line right after a quoted paragraph is a real marker, not a lazy
    // continuation: an HTML block (CommonMark type 2) interrupts a paragraph and closes the quote.
    const afterQuote = PAGE.replace(
      "## Inputs\n\n<!-- BEGIN GENERATED: table",
      "## Inputs\n\n> quoted paragraph\n<!-- BEGIN GENERATED: table",
    );
    expect(() => assertRegionPlacement(afterQuote, TABLE, "doc.md")).not.toThrow();
    // Up to three columns of indentation leave a marker a marker.
    const indented = PAGE.replace("<!-- BEGIN GENERATED: table", "   <!-- BEGIN GENERATED: table");
    expect(() => assertRegionPlacement(indented, TABLE, "doc.md")).not.toThrow();
    // Blocks closed by their own rule leave the region outside: fences by a matching closer, a
    // raw block by any recognized closing tag; a tag inside a fence and a fence inside a raw block
    // are content.
    for (const before of [
      "```\ncode\n```\n",
      "~~~js\n```\n~~~\n",
      "````\n```\n````\n",
      "```\n<pre>\n```\n",
      "<pre>\n```\n</pre>\n",
      "<pre>code</pre>\n",
      "<style>\ncss\n</style>\n",
      "<script>\njs\n</pre>\n",
      "Prose mentioning `<pre>` inline, which is no block.\n",
      "> ```\n> quoted code\n",
      "> <pre>\n> quoted raw\n",
      "<pre-widget>\n",
    ]) {
      const closed = PAGE.replace("\n## Inputs\n", `\n${before}\n## Inputs\n`);
      expect(() => assertRegionPlacement(closed, TABLE, "doc.md"), before).not.toThrow();
    }
    for (const spec of [INS, OUTS]) {
      expect(() => assertRegionPlacement(MANIFEST, spec, "action.yml")).not.toThrow();
    }
    const commented = MANIFEST.replace("inputs:\n", "inputs:\n  # authored\n\n");
    expect(() => assertRegionPlacement(commented, INS, "action.yml")).not.toThrow();
  });

  test.each<[label: string, text: string, spec: RegionSpec, error: string]>([
    [
      "a table moved under another heading",
      relocatedRegion(PAGE, "table", "html", "## Notes\n\n"),
      TABLE,
      'the table region must sit under "## Inputs" in doc.md; "## Notes" is the heading above its BEGIN marker',
    ],
    [
      "a table moved above every heading",
      relocatedRegion(PAGE, "table", "html", "Intro.\n\n").replace("# Title\n\n", ""),
      TABLE,
      'the table region must sit under "## Inputs" in doc.md; no heading precedes its BEGIN marker',
    ],
    [
      "a table under a heading a blockquote holds",
      PAGE.replace("## Inputs\n", "> ## Inputs\n"),
      TABLE,
      'the table region must sit under "## Inputs" in doc.md; "# Title" is the heading above its BEGIN marker',
    ],
    [
      "a table whose BEGIN marker is indented four spaces",
      PAGE.replace("<!-- BEGIN GENERATED: table", "    <!-- BEGIN GENERATED: table"),
      TABLE,
      "the table region's BEGIN marker sits on a line indented as code in doc.md",
    ],
    [
      "a table whose END marker is indented with a tab",
      PAGE.replace("<!-- END GENERATED: table", "\t<!-- END GENERATED: table"),
      TABLE,
      "the table region's END marker sits on a line indented as code in doc.md",
    ],
    [
      "an inline region on a line indented four spaces, text ahead of its marker",
      PAGE.replace("Result: (", "    Result: ("),
      LIST,
      "the list region's BEGIN marker sits on a line indented as code in doc.md",
    ],
    [
      "an inline region on a quoted line",
      PAGE.replace("Result: (", "> Result: ("),
      LIST,
      "the list region sits inside a blockquote in doc.md",
    ],
    [
      "a table whose BEGIN marker carries the quote prefix of the paragraph above it",
      PAGE.replace(
        "## Inputs\n\n<!-- BEGIN GENERATED: table",
        "## Inputs\n\n> quoted paragraph\n> <!-- BEGIN GENERATED: table",
      ),
      TABLE,
      "the table region sits inside a blockquote in doc.md",
    ],
    [
      "a table whose END marker moved past the next heading",
      PAGE.replace("<!-- END GENERATED: table -->\n", "").replace(
        "## Example\n",
        "## Example\n<!-- END GENERATED: table -->\n",
      ),
      TABLE,
      'the table region must sit under "## Inputs" in doc.md; "## Example" is the heading above its END marker',
    ],
    [
      "a table whose END marker moved below an authored paragraph in its own section",
      PAGE.replace("<!-- END GENERATED: table -->\n\n", "").replace(
        "\n## Example\n",
        "\n<!-- END GENERATED: table -->\n\n## Example\n",
      ),
      TABLE,
      "the table region in doc.md encloses content the generator would not write; move its marker back",
    ],
    [
      "list markers moved around a look-alike in the right section",
      PAGE.replace(
        "<!-- BEGIN GENERATED: list -->`a` / `b`<!-- END GENERATED: list -->",
        "",
      ).replace("| A | B |", "| <!-- BEGIN GENERATED: list -->A | B<!-- END GENERATED: list --> |"),
      LIST,
      "the list region in doc.md encloses content the generator would not write",
    ],
    [
      "a link region no longer closing the file",
      `${PAGE}\nTrailing prose.\n`,
      LINK,
      "the link region must close doc.md",
    ],
    [
      "a link region whose BEGIN marker moved over the heading above it",
      PAGE.replace("<!-- BEGIN GENERATED: link -->\n", "").replace(
        "## Notes\n",
        "<!-- BEGIN GENERATED: link -->\n## Notes\n",
      ),
      LINK,
      "the link region in doc.md encloses content the generator would not write",
    ],
    [
      "a link region around another definition",
      PAGE.replace("[form]: https://example.com", "[other]: https://example.com"),
      LINK,
      "the link region in doc.md encloses content the generator would not write",
    ],
    [
      "a mapping region moved under another key",
      relocatedRegion(MANIFEST, "ins", "yaml", "runs:\n"),
      INS,
      'the ins region must sit directly under the "inputs:" mapping in action.yml; "runs:" precedes its BEGIN marker',
    ],
    [
      "a mapping region with an entry of its mapping left before its BEGIN marker",
      MANIFEST.replace("inputs:\n", "inputs:\n  stray: 1\n"),
      INS,
      'the ins region must sit directly under the "inputs:" mapping in action.yml; "stray: 1" precedes its BEGIN marker',
    ],
    [
      "a mapping region with only comments above it",
      "# authored\n# BEGIN GENERATED: outs\nresult: 1\n# END GENERATED: outs\n",
      { ...OUTS, body: /[\s\S]*/ },
      'the outs region must sit directly under the "outputs:" mapping in action.yml; nothing precedes its BEGIN marker',
    ],
    [
      "a mapping region with an entry of its mapping left after its END marker",
      MANIFEST.replace(
        "# END GENERATED: ins\n",
        "# END GENERATED: ins\n  stray:\n    default: 1\n",
      ),
      INS,
      'the ins region must end the "inputs:" mapping in action.yml; "stray:" follows its END marker',
    ],
    [
      "a mapping region enclosing the next top-level mapping whole",
      MANIFEST.replace(
        "# END GENERATED: outs\n\nruns:\n  using: node24\n",
        "runs:\n  using: node24\n# END GENERATED: outs\n",
      ),
      OUTS,
      "the outs region in action.yml encloses content the generator would not write",
    ],
    [
      "a heading placement on a YAML file",
      MANIFEST,
      { ...INS, placement: { kind: "under-heading", heading: "## Inputs" } },
      "the ins region declares a markdown placement, but action.yml uses yaml markers",
    ],
    [
      "a mapping placement on a markdown file",
      PAGE,
      { ...TABLE, placement: { kind: "under-key", key: "inputs" } },
      "the table region declares a YAML parent key, but doc.md uses html markers",
    ],
    ...(["g", "y"] as const).map((flag): [string, string, RegionSpec, string] => [
      `a body shape with the stateful "${flag}" flag, which would pass and fail on alternate calls`,
      PAGE,
      { ...TABLE, body: new RegExp(TABLE.body.source, flag) },
      `the table region's body shape carries the stateful "${flag}" flags`,
    ]),
  ])("refuses %s", (_label, text, spec, error) => {
    expect(() => assertRegionPlacement(text, spec, PATH_OF[spec.name] ?? "")).toThrow(error);
  });

  test.each<[label: string, before: string, block: string]>([
    ["an unclosed fence", "```\n", "fenced code"],
    ["mixed delimiters", "```\n~~~\n", "fenced code"],
    ["a shorter closer", "````\n```\n", "fenced code"],
    [
      "a backtick fence whose info string holds a backtick, then a real opener",
      "```a`b\n```\n",
      "fenced code",
    ],
    ["an unclosed raw block", "<pre>\n", "raw HTML"],
    ["an unclosed script block", "<script>\n", "raw HTML"],
    ["an unclosed textarea block", "<textarea>\n", "raw HTML"],
    ["a stray closing tag, then a real opening one", "</pre>\n<pre>\n", "raw HTML"],
    [
      "a fence opened inside a raw block, then a real opener",
      "<pre>\n```\n</pre>\n```\n",
      "fenced code",
    ],
    ["a quoted fence, with the region quoted along", "> ```\n> ", "fenced code"],
    ["a root fence holding a quoted fence line", "```\n> ```\n", "fenced code"],
    [
      "a quoted fence holding a deeper quoted fence line, with the region quoted along",
      "> ```\n> > ```\n> ",
      "fenced code",
    ],
    ["a quoted raw block, with the region quoted along", "> <pre>\n> ", "raw HTML"],
  ])(
    "refuses a region left inside %s, which a line-parity count would let through",
    (_label, before, block) => {
      // Each `before` leaves a block open ahead of "## Inputs" under the CommonMark rule its label
      // names; one ending in "> " opens it inside a blockquote that goes on to hold the heading
      // and the region, so the blockquote's end cannot close the block first.
      const quoted = before.endsWith("> ");
      const inside = PAGE.replace(
        /\n## Inputs\n\n([\s\S]*?<!-- END GENERATED: table -->\n)/,
        (_, region: string) =>
          quoted
            ? `\n${before}## Inputs\n>\n${region.replace(/^/gm, "> ")}`
            : `\n${before}\n## Inputs\n\n${region}`,
      );
      expect(() => assertRegionPlacement(inside, TABLE, "doc.md")).toThrow(
        `the table region sits inside a ${block} block in doc.md`,
      );
    },
  );

  test("refuses a region whose END marker alone sits inside a raw HTML block", () => {
    const insideBody = PAGE.replace("| `x` | 1 |\n", "| `x` | 1 |\n<pre>\n");
    expect(() => assertRegionPlacement(insideBody, TABLE, "doc.md")).toThrow(
      "the table region sits inside a raw HTML block in doc.md",
    );
  });
});

describe("regenerateRegions", () => {
  const render = (body: string) => () => body;

  test("checks every region's placement, then re-renders each body verbatim", () => {
    const out = regenerateRegions(
      PAGE,
      [
        { ...TABLE, render: render("\n| A | B |\n|---|---|\n| `y` | 2 |\n") },
        { ...LIST, render: render("`c`") },
        { ...LINK, render: render("\n[form]: https://example.org\n") },
      ],
      "doc.md",
    );
    expect(out).toBe(
      PAGE.replace("| `x` | 1 |", "| `y` | 2 |")
        .replace("`a` / `b`", "`c`")
        .replace("https://example.com", "https://example.org"),
    );
    expect(() =>
      regenerateRegions(
        relocatedRegion(PAGE, "table", "html", "## Notes\n\n"),
        [{ ...TABLE, render: render("\n") }],
        "doc.md",
      ),
    ).toThrow('the table region must sit under "## Inputs" in doc.md');
  });

  test("refuses a rendering the region's own shape rejects, before splicing it", () => {
    expect(() =>
      regenerateRegions(PAGE, [{ ...LIST, render: render("prose, not a list") }], "doc.md"),
    ).toThrow(
      'the list region\'s renderer wrote a body its own shape rejects: "prose, not a list"',
    );
  });

  test("refuses a region declared twice instead of letting the second renderer win", () => {
    expect(() =>
      regenerateRegions(
        PAGE,
        [
          { ...TABLE, render: render("\n") },
          { ...TABLE, render: render("\n| A | B |\n|---|---|\n") },
        ],
        "doc.md",
      ),
    ).toThrow("the table region of doc.md is declared twice");
  });
});

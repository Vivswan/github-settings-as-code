// The marker splice every generator shares (.github/scripts/lib/generated-regions.ts): each
// comment syntax spliced byte-exactly, malformed marker sets refused with their counts, look-alikes
// (near-miss text, the other syntax, YAML scalar content) ignored, the name grammar enforced first.

import { describe, expect, test } from "bun:test";
import {
  type MarkerSyntax,
  markerSyntaxFor,
  regionBounds,
  replaceRegion,
} from "../../.github/scripts/lib/generated-regions.js";

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

// The relocation mutation the placement suites share: a block region moves with its marker
// lines, an inline region (mid-line, ending its line, or alone on it) moves as its marker span.

import { expect, test } from "bun:test";
import { relocatedRegion } from "./relocated-region.js";

const PAGE = [
  "# A",
  "",
  "<!-- BEGIN GENERATED: block -->",
  "body",
  "<!-- END GENERATED: block -->",
  "",
  "Mid (<!-- BEGIN GENERATED: mid -->x<!-- END GENERATED: mid -->) line.",
  "",
  "Tail: <!-- BEGIN GENERATED: eol -->y<!-- END GENERATED: eol -->",
  "",
  "<!-- BEGIN GENERATED: sol -->z<!-- END GENERATED: sol -->",
  "",
  "# B",
  "",
].join("\n");

test.each<[name: string, expected: string]>([
  [
    "block",
    [
      "# A",
      "",
      "",
      "Mid (<!-- BEGIN GENERATED: mid -->x<!-- END GENERATED: mid -->) line.",
      "",
      "Tail: <!-- BEGIN GENERATED: eol -->y<!-- END GENERATED: eol -->",
      "",
      "<!-- BEGIN GENERATED: sol -->z<!-- END GENERATED: sol -->",
      "",
      "# B",
      "<!-- BEGIN GENERATED: block -->",
      "body",
      "<!-- END GENERATED: block -->",
      "",
    ].join("\n"),
  ],
  [
    "mid",
    [
      "# A",
      "",
      "<!-- BEGIN GENERATED: block -->",
      "body",
      "<!-- END GENERATED: block -->",
      "",
      "Mid () line.",
      "",
      "Tail: <!-- BEGIN GENERATED: eol -->y<!-- END GENERATED: eol -->",
      "",
      "<!-- BEGIN GENERATED: sol -->z<!-- END GENERATED: sol -->",
      "",
      "# B",
      "<!-- BEGIN GENERATED: mid -->x<!-- END GENERATED: mid -->",
    ].join("\n"),
  ],
  [
    "eol",
    [
      "# A",
      "",
      "<!-- BEGIN GENERATED: block -->",
      "body",
      "<!-- END GENERATED: block -->",
      "",
      "Mid (<!-- BEGIN GENERATED: mid -->x<!-- END GENERATED: mid -->) line.",
      "",
      "Tail: ",
      "",
      "<!-- BEGIN GENERATED: sol -->z<!-- END GENERATED: sol -->",
      "",
      "# B",
      "<!-- BEGIN GENERATED: eol -->y<!-- END GENERATED: eol -->",
    ].join("\n"),
  ],
  [
    "sol",
    [
      "# A",
      "",
      "<!-- BEGIN GENERATED: block -->",
      "body",
      "<!-- END GENERATED: block -->",
      "",
      "Mid (<!-- BEGIN GENERATED: mid -->x<!-- END GENERATED: mid -->) line.",
      "",
      "Tail: <!-- BEGIN GENERATED: eol -->y<!-- END GENERATED: eol -->",
      "",
      "",
      "",
      "# B",
      "<!-- BEGIN GENERATED: sol -->z<!-- END GENERATED: sol -->",
    ].join("\n"),
  ],
])("moves the %s region after the anchor, taking only what the region owns", (name, expected) => {
  expect(relocatedRegion(PAGE, name, "html", "# B\n")).toBe(expected);
});

test("moves a block region closing a file without a final newline", () => {
  const page = "# A\n\n# B\n\n<!-- BEGIN GENERATED: last -->\nbody\n<!-- END GENERATED: last -->";
  expect(relocatedRegion(page, "last", "html", "# A\n")).toBe(
    "# A\n<!-- BEGIN GENERATED: last -->\nbody\n<!-- END GENERATED: last -->\n# B\n\n",
  );
});

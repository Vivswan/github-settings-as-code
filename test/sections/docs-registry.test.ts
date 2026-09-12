import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";
import { readDocsYaml, SectionDocs } from "../../src/sections/contract/docs.js";
import { endpointPath, type Route } from "../../src/sections/contract/endpoints.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";
import { CLAIM_FAMILY, CLAIM_STEMS, defaultClaimProblems, stemNegation } from "../docs/claims.js";

const ROOT = join(import.meta.dir, "..", "..");

/** `text` as a regex source matching itself literally. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-identifier, case-insensitive: "the pinEnvironment mutation" names PinEnvironment, "DocumentPinEnvironmentAudit" does not.
function namesOperation(prose: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, "i").test(prose);
}

// A route in prose bounds a segment with "/" or "{", so "monkeys" never satisfies "keys" and "labels/{name}" does.
function mentionsSegment(prose: string, segment: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(segment)}(?![A-Za-z0-9_-])`).test(prose);
}

/** A section's coverage Notes cells joined, since a section may span several rows. */
function coverageNotes(key: SectionKey): string {
  return DOCS[key].coverage.map((row) => row.notes).join(" ");
}

/** The distinctive leading segment of an endpoint's path below the repo, or "" for the bare repo endpoint. */
function leadingSegment(route: Route): string {
  const tail = endpointPath(route)
    .replace("/repos/{owner}/{repo}", "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\/+$/g, "");
  return tail.replace(/^\//, "").split("/")[0] ?? "";
}

/** Whether a source path is documentation code: the docs registry or the docs document shapes. */
function isDocsFile(path: string): boolean {
  return path.endsWith("/contract/docs.ts") || path.endsWith("/docs-registry.ts");
}

// Bun's own scanner, so no import form slips past a regex; type-only imports are erased and carry no prose.
const transpiler = new Bun.Transpiler({ loader: "ts" });
function importSpecifiers(source: string): string[] {
  return transpiler.scanImports(source).map((entry) => entry.path);
}

/** Every source file transitively imported from `entry` (.js -> .ts, a directory -> its index.ts). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      let resolved = join(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        resolved = join(resolved, "index.ts");
      }
      if (!existsSync(resolved)) {
        throw new Error(
          `${relative(ROOT, file)} imports "${specifier}", which resolves to nothing`,
        );
      }
      queue.push(resolved);
    }
  }
  return seen;
}

describe("docs registry reachability", () => {
  test("the specifier scan sees every import form a docs file could hide behind", () => {
    // Control for the walk below; the type-only import is erased on purpose, since it puts nothing in the bundle.
    const source = [
      'import { a } from "./static.js";',
      "import {",
      "  b,",
      '} from "./multiline.js";',
      'import type { C } from "./type-only.js";',
      'export { d } from "./reexport.js";',
      'import "./side-effect.js";',
      'const e = await import("./dynamic.js");',
      "const f = await import(`./template.js`);",
      'const g = require("./required.js");',
      'const h = await import(/* note */ "./commented.js", { with: { type: "json" } });',
      'import { z } from "zod";',
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "./static.js",
        "./multiline.js",
        "./reexport.js",
        "./side-effect.js",
        "./dynamic.js",
        "./template.js",
        "./required.js",
        "./commented.js",
        "zod",
      ].sort(),
    );
  });

  test("no docs file is reachable from the bundle entrypoint", () => {
    const bundled = [...importGraph(join(ROOT, "src", "main.ts"))].map((file) =>
      relative(ROOT, file),
    );
    // Control: the walk must reach the section modules, or "no docs file found" would be vacuous.
    expect(bundled).toContain("src/sections/registry.ts");
    expect(bundled).toContain("src/sections/labels/index.ts");
    expect(bundled.filter(isDocsFile)).toEqual([]);
  });

  test("the generator does reach the docs code, so the walk sees it", () => {
    const reached = [...importGraph(join(ROOT, ".github", "scripts", "gen-docs.ts"))]
      .map((file) => relative(ROOT, file))
      .filter(isDocsFile)
      .sort();
    expect(reached).toEqual(["src/sections/contract/docs.ts", "src/sections/docs-registry.ts"]);
  });
});

describe("section docs completeness", () => {
  /** A well-formed docs document, line by line: the control the malformed fixtures deviate from. */
  const WELL_FORMED_DOCS = [
    "sections_table:",
    "  endpoints: labels CRUD",
    "  notes: upsert by name",
    "coverage:",
    "  - area: Labels",
    "    notes: CRUD",
    "schema:",
    "  LabelConfig: One label.",
  ];

  test("every section has a <key>.docs.yml and every docs file belongs to a section", () => {
    // Loading DOCS proves each SectionKey's file exists; the reverse pin catches a stray leftover file. shared/shared.docs.yml is the factories'
    // schema prose (see docs-registry.ts).
    const onDisk = readdirSync(join(ROOT, "src", "sections"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "shared" &&
          existsSync(join(entry.parentPath, entry.name, `${entry.name}.docs.yml`)),
      )
      .map((entry) => entry.name)
      .sort();
    expect(onDisk).toEqual([...SECTION_KEYS].sort());
    expect(Object.keys(DOCS).sort()).toEqual([...SECTION_KEYS].sort());
  });

  test("a malformed docs file fails naming the file and the issue, a missing one naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-yml-"));
    try {
      const malformed = join(dir, "docs.yml");
      writeFileSync(
        malformed,
        [
          "sections_table:",
          "  endpoints: labels CRUD",
          "  notes: ''",
          "  extra: 1",
          "coverage: []",
        ].join("\n"),
      );
      // The body is zod's own prettified issue list, so only our header, each issue's path, and one stable phrase are pinned.
      for (const issue of [
        `${malformed} is not a valid docs document:`,
        'Unrecognized key: "extra"',
        "at sections_table",
        "at schema",
        "at sections_table.notes",
        "at coverage[0]",
      ]) {
        expect(() => readDocsYaml(malformed, SectionDocs)).toThrow(new RegExp(escapeRe(issue)));
      }
      // The tail of a missing-file error is the runtime's ENOENT prose, so only our prefix is pinned.
      const absent = join(dir, "absent.yml");
      expect(() => readDocsYaml(absent, SectionDocs)).toThrow(
        new RegExp(`^${escapeRe(`${absent} is not valid YAML: `)}`),
      );
      // YAML that does not even parse (a duplicated key, which the loader refuses) names the file too.
      writeFileSync(malformed, ["sections_table:", "  endpoints: a", "  endpoints: b"].join("\n"));
      expect(() => readDocsYaml(malformed, SectionDocs)).toThrow(
        new RegExp(`${escapeRe(malformed)} is not valid YAML: .*unique`),
      );
      // Control: the same reader accepts a well-formed document.
      writeFileSync(malformed, WELL_FORMED_DOCS.join("\n"));
      expect(readDocsYaml(malformed, SectionDocs)).toEqual({
        sections_table: { endpoints: "labels CRUD", notes: "upsert by name" },
        coverage: [{ area: "Labels", notes: "CRUD" }],
        schema: { LabelConfig: "One label." },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a docs file still keyed by the table's former name fails naming the file and the rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-yml-"));
    try {
      const stale = join(dir, "labels.docs.yml");
      writeFileSync(
        stale,
        WELL_FORMED_DOCS.map((line) => line.replace(/^sections_table:/, "readme:")).join("\n"),
      );
      // toThrow(string) matches a substring, so the whole message is compared outright.
      let message = "did not throw";
      try {
        readDocsYaml(stale, SectionDocs);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        [
          `${stale} is not a valid docs document:`,
          '\u2716 Unrecognized key: "readme"; the Sections table cells key "readme" was renamed to "sections_table" (the table renders into docs/reference/sections.md)',
          "\u2716 Invalid input: expected object, received undefined",
          "  \u2192 at sections_table",
        ].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Notes cells vs undeclaredDefault", () => {
  test("a knobbed section's Notes cell never claims the opposite of its undeclaredDefault", () => {
    // A claim is a claim-family word joined to "default"; a cell that mentions a default without a parseable claim fails loudly rather than leaving
    // the sweep.
    const claimRe = new RegExp(
      String.raw`\b(${CLAIM_STEMS})\b(?:[\s-]by[\s-]|\s+(?:is|are|stays?|remains?)\s+the\s+)default`,
      "gi",
    );
    const trigger = /by[\s-]default|\bthe default\b/i;
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      const notes = DOCS[section.key].sections_table.notes;
      const claims = [...notes.matchAll(claimRe)];
      if (trigger.test(notes)) {
        // Per-section tripwire: a global counter would let one section's unrecognized grammar hide behind another's claims.
        expect(
          claims.length,
          `the ${section.key} Notes cell mentions a default but no claim parses; reword the cell or extend the claim grammar`,
        ).toBeGreaterThan(0);
      }
      for (const claim of claims) {
        const family = CLAIM_FAMILY.delete.test(claim[1] ?? "") ? "delete" : "keep";
        const negation = stemNegation(notes.slice(0, claim.index));
        if ("doubleNegation" in negation) {
          throw new Error(
            `the ${section.key} Notes cell: a double negation governs "${negation.doubleNegation} ${claim[1]}"; reword it - double negatives are not resolved`,
          );
        }
        const flipped = family === "delete" ? "keep" : "delete";
        const effective = negation.negated ? flipped : family;
        expect(
          effective,
          `the ${section.key} Notes cell claims "${claim[0]}"${negation.negated ? " (negated)" : ""}, contradicting its "${section.undeclaredDefault}" undeclaredDefault`,
        ).toBe(section.undeclaredDefault);
      }
    }
  });
});

describe("Endpoints cells vs declared operations", () => {
  test("each Endpoints cell names every distinct leading resource segment its section calls", () => {
    // The cells are terse ("labels CRUD"), so the pin is each endpoint tail's leading segment, matched as a WHOLE word or its singular ("branch
    // protection" satisfies "branches"; "homepage" never satisfies "pages").
    const normalize = (text: string): string => text.toLowerCase().replace(/[-_]/g, " ");
    const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A compound satisfies its base segment only where the compound IS the resource's common name; extend this map, not the matching.
    const COMPOUND_MENTIONS: Record<string, readonly string[]> = { hooks: ["webhooks"] };
    for (const endpoint of Object.values(allEndpoints())) {
      const segment = leadingSegment(endpoint.route);
      if (segment === "") {
        continue; // the bare repo endpoint has no distinctive resource
      }
      const needle = normalize(segment);
      // Singular variants of the LAST word only, each a whole word, so an over-stripped form ("pag") never matches inside an unrelated word.
      const words = needle.split(" ");
      const last = words.pop() ?? "";
      const lastForms = new Set([last]);
      if (last.endsWith("es")) {
        lastForms.add(last.slice(0, -2));
      }
      if (last.endsWith("s")) {
        lastForms.add(last.slice(0, -1));
      }
      const variants = [
        ...[...lastForms].map((form) => [...words, form].join(" ")),
        ...(COMPOUND_MENTIONS[needle] ?? []),
      ];
      const cell = normalize(DOCS[endpoint.section].sections_table.endpoints);
      expect(
        variants.some((variant) => new RegExp(`\\b${escapeRe(variant)}\\b`).test(cell)),
        `the ${endpoint.section} Endpoints cell never mentions "${needle}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
    // GraphQL operations have no path to derive a segment from, so the cell must name each by its wire operationName.
    for (const op of Object.values(allGraphqlOps())) {
      expect(
        namesOperation(DOCS[op.section].sections_table.endpoints, op.name),
        `the ${op.section} Endpoints cell never mentions the GraphQL operation "${op.name}"`,
      ).toBe(true);
    }
  });
});

describe("coverage rows vs declarations", () => {
  test("each section's coverage rows name the leading path segment of every endpoint it calls", () => {
    // Control for the matcher: a whole token counts, a longer word does not.
    expect(mentionsSegment("DELETE /repos/{owner}/{repo}/keys/{key_id}", "keys")).toBe(true);
    expect(mentionsSegment("the monkeys endpoint", "keys")).toBe(false);
    // The COVERAGE rows spell endpoints out, so the inventory cannot omit an endpoint the code calls.
    for (const endpoint of Object.values(allEndpoints())) {
      const segment = leadingSegment(endpoint.route);
      if (segment === "") {
        continue; // the bare repo endpoint has no distinctive resource
      }
      expect(
        mentionsSegment(coverageNotes(endpoint.section), segment),
        `the ${endpoint.section} coverage rows never mention "${segment}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
  });

  test("each section's coverage rows name every GraphQL operation it issues", () => {
    // Control for the matcher both GraphQL sweeps share.
    expect(namesOperation("the pinEnvironment ({environmentId}) mutation", "PinEnvironment")).toBe(
      true,
    );
    expect(namesOperation("the DocumentPinEnvironmentAudit query", "PinEnvironment")).toBe(false);
    expect(namesOperation("see a.b here", "a.b")).toBe(true);
    expect(namesOperation("see axb here", "a.b")).toBe(false);
    for (const op of Object.values(allGraphqlOps())) {
      expect(
        namesOperation(coverageNotes(op.section), op.name),
        `the ${op.section} coverage rows never mention the GraphQL operation "${op.name}"`,
      ).toBe(true);
    }
  });

  test("a knobbed section's coverage rows state its undeclaredDefault and never the opposite", () => {
    // The claim windows, families, and negator handling live in test/docs/claims.ts, shared with the schema description sweep.
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      for (const problem of defaultClaimProblems(
        coverageNotes(section.key),
        section.undeclaredDefault,
      )) {
        throw new Error(`the ${section.key} coverage rows: ${problem}`);
      }
    }
  });
});

// The docs registry's contracts: authored prose stays consistent with the declarations beside it
// (a Notes cell never contradicts undeclaredDefault, an Endpoints cell names every resource its
// section calls), and no docs file is reachable from the bundle entrypoint.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SECTION_KEYS } from "../../src/schema.js";
import { endpointPath } from "../../src/sections/contract/endpoints.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { allEndpoints, allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";
import { CLAIM_FAMILY, CLAIM_STEMS, stemNegation } from "../docs/claims.js";

const ROOT = join(import.meta.dir, "..", "..");

/** Whether a source path is documentation prose: a section's docs.ts or the docs registry. */
function isDocsFile(path: string): boolean {
  return path.endsWith("/docs.ts") || path.endsWith("/docs-registry.ts");
}

// The specifiers a source file depends on, as the bundler sees them (Bun's own scanner, so no
// import form slips past a regex); type-only imports are erased and carry no prose, so they do not count.
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
    // Control for the walk below: each form yields its specifier, so a
    // docs import in any of them is a reachable edge, not a blind spot. The
    // type-only import is erased on purpose: it puts nothing in the bundle.
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
    // Control: the walk must reach the section modules, or "no docs file
    // found" would be vacuous.
    expect(bundled).toContain("src/sections/registry.ts");
    expect(bundled).toContain("src/sections/labels/index.ts");
    expect(bundled.filter(isDocsFile)).toEqual([]);
  });

  test("the generator does reach every docs file, so the walk sees them", () => {
    const reached = [...importGraph(join(ROOT, ".github", "scripts", "gen-docs.ts"))]
      .map((file) => relative(ROOT, file))
      .filter(isDocsFile)
      .sort();
    // contract/docs.ts is type-only, so the bundler view erases it; the
    // prose-bearing files are the registry and every section's docs.ts.
    expect(reached).toEqual(
      [
        "src/sections/docs-registry.ts",
        ...SECTION_KEYS.map((key) => `src/sections/${key}/docs.ts`),
      ].sort(),
    );
  });
});

describe("Notes cells vs undeclaredDefault", () => {
  test("a knobbed section's Notes cell never claims the opposite of its undeclaredDefault", () => {
    // A claim is a claim-family word joined to "default" ("deleted by default", "keep is the
    // default"); its family, negation resolved by stemNegation, must be the section's own. A cell
    // that mentions a default without a parseable claim fails loudly rather than leaving the sweep.
    const claimRe = new RegExp(
      String.raw`\b(${CLAIM_STEMS})\b(?:[\s-]by[\s-]|\s+(?:is|are|stays?|remains?)\s+the\s+)default`,
      "gi",
    );
    const trigger = /by[\s-]default|\bthe default\b/i;
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      const notes = DOCS[section.key].readme.notes;
      const claims = [...notes.matchAll(claimRe)];
      if (trigger.test(notes)) {
        // Per-section tripwire: THIS cell mentions its default, so at least
        // one claim must parse here - a global counter would let one
        // section's unrecognized grammar hide behind another's claims.
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
    // The cells are terse summaries ("labels CRUD"), so the pin is the leading resource segment of
    // each endpoint tail, matched case- and separator-insensitively as a WHOLE word or its singular
    // form ("branch protection" satisfies "branches"; "homepage" can never satisfy "pages").
    const normalize = (text: string): string => text.toLowerCase().replace(/[-_]/g, " ");
    const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A compound word satisfies its base segment only where the compound IS the resource's common
    // name; whole-word matching is deliberate ("monkeys" must never satisfy "keys"), so extend this
    // map, not the matching, when a cell is reworded ("hooks" -> "webhooks").
    const COMPOUND_MENTIONS: Record<string, readonly string[]> = { hooks: ["webhooks"] };
    for (const endpoint of Object.values(allEndpoints())) {
      const tail = endpointPath(endpoint.route)
        .replace("/repos/{owner}/{repo}", "")
        .replace(/\{[^}]+\}/g, "")
        .replace(/\/+$/g, "");
      if (tail === "" || tail === "/") {
        continue; // the bare repo endpoint has no distinctive resource
      }
      const needle = normalize(tail.replace(/^\//, "").split("/")[0] ?? "");
      // Singular variants of the LAST word only ("branches" -> "branch", "orgs" -> "org"), each
      // matched as a whole word, so an over-stripped form ("pages" -> "pag") never matches inside
      // an unrelated word.
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
      const cell = normalize(DOCS[endpoint.section].readme.endpoints);
      expect(
        variants.some((variant) => new RegExp(`\\b${escapeRe(variant)}\\b`).test(cell)),
        `the ${endpoint.section} Endpoints cell never mentions "${needle}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
    // GraphQL operations have no path to derive a resource segment from, so
    // the cell must name each one by its wire operationName instead.
    for (const op of Object.values(allGraphqlOps())) {
      const cell = normalize(DOCS[op.section].readme.endpoints);
      expect(
        cell.includes(normalize(op.name)),
        `the ${op.section} Endpoints cell never mentions the GraphQL operation "${op.name}"`,
      ).toBe(true);
    }
  });
});

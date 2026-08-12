/**
 * COVERAGE.md contract tests: the Supported table names every section, and the
 * Repo-scoped gaps table never lists an endpoint the action already
 * implements. The anti-test makes implementing a gap force its row to move out
 * of the gaps table.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_KEYS } from "../../src/schema.js";
import {
  endpointMethod,
  endpointPath,
  matchesTemplate,
} from "../../src/sections/contract/endpoints.js";
import { allEndpoints, SECTIONS } from "../../src/sections/registry.js";
import { defaultClaimProblems } from "./claims.js";
import { sectionLines, tableRows } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const coverage = readFileSync(join(ROOT, "COVERAGE.md"), "utf8");

describe("COVERAGE Supported table", () => {
  const rows = tableRows(sectionLines(coverage, "Supported", "COVERAGE.md"));
  // Every row's notes, concatenated per section key (a section may span rows).
  const rowsByKey = new Map<string, string>();
  for (const cells of rows) {
    const key = (cells[1] ?? "").replace(/`/g, "").split(" ")[0] ?? "";
    rowsByKey.set(key, `${rowsByKey.get(key) ?? ""} ${cells[2] ?? ""}`);
  }

  test("every section key appears in at least one Supported row", () => {
    const mentioned = rows.map((cells) => cells[1] ?? "").join(" ");
    for (const key of SECTION_KEYS) {
      expect(
        mentioned.includes(key),
        `COVERAGE Supported table never names the "${key}" section`,
      ).toBe(true);
    }
  });

  test("each section's declared endpoint path tails appear in its rows", () => {
    // For every registered endpoint, the section's Supported row(s) must name
    // the distinctive tail of its path, so the coverage doc cannot omit an
    // endpoint the code calls.
    for (const endpoint of Object.values(allEndpoints())) {
      const tail = endpointPath(endpoint.route)
        .replace("/repos/{owner}/{repo}", "")
        .replace(/\{[^}]+\}/g, "")
        .replace(/\/+$/g, "");
      if (tail === "" || tail === "/") {
        continue; // the bare repo endpoint has no distinctive tail
      }
      const notes = rowsByKey.get(endpoint.section) ?? "";
      const needle = tail.replace(/^\//, "").split("/")[0] ?? "";
      expect(
        notes.includes(needle),
        `COVERAGE Supported row for "${endpoint.section}" never mentions "${needle}" from endpoint ${endpoint.route}`,
      ).toBe(true);
    }
  });

  test("every src/ or test/ path citation resolves on disk", () => {
    // File moves (a module changing directories) silently rot the prose
    // citations; existence on disk is the contract.
    // A citation must carry a file extension so prose slash-pairs
    // ("test/lint jobs") do not read as paths; a directory citation is
    // invisible to this test, so cite files.
    const cited =
      coverage.match(/\b(?:src|test)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[a-z]+\b/g) ?? [];
    expect(cited.length, "COVERAGE.md cites no src/ or test/ path at all").toBeGreaterThan(0);
    for (const path of new Set(cited)) {
      expect(
        existsSync(join(ROOT, path)),
        `COVERAGE.md cites "${path}" but nothing exists there; update the citation to the file's current location`,
      ).toBe(true);
    }
  });

  test("each knobbed section's kept/deleted-by-default wording matches its undeclaredDefault", () => {
    // SectionMeta.undeclaredDefault's JSDoc (src/sections/contract/module.ts)
    // names this table as a consumer of the declaration; this test is that
    // guard. Both names must stay in that JSDoc (word order free) so the
    // pointer and the guard cannot part ways silently.
    const contractSrc = readFileSync(
      join(ROOT, "src", "sections", "contract", "module.ts"),
      "utf8",
    );
    const undeclaredDoc = contractSrc.match(
      /\/\*\*([^*]|\*(?!\/))*\*\/\s*\n\s*readonly undeclaredDefault:/m,
    )?.[0];
    expect(undeclaredDoc, "no JSDoc found above SectionMeta.undeclaredDefault").toBeDefined();
    for (const name of ["README Sections table", "COVERAGE"]) {
      expect(
        undeclaredDoc?.includes(name),
        `the undeclaredDefault JSDoc no longer names "${name}" as a consumer; realign it with this test`,
      ).toBe(true);
    }
    // Every knobbed row states its default in a "... by default" clause; the
    // claim windows, families, and negator handling live in ./claims.ts.
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue;
      }
      const notes = rowsByKey.get(section.key) ?? "";
      for (const problem of defaultClaimProblems(notes, section.undeclaredDefault)) {
        throw new Error(`COVERAGE Supported row for "${section.key}": ${problem}`);
      }
    }
  });
});

describe("COVERAGE gaps anti-test", () => {
  /**
   * Turn a gap-table path template into a concrete-looking path by replacing
   * each {param} with a placeholder segment, so matchesTemplate (which matches
   * a registered TEMPLATE against a CONCRETE path) can decide whether a gap
   * endpoint collides with a route the action already calls.
   */
  function concretize(template: string): string {
    return template.replace(/\{[^}]+\}/g, "_param_");
  }

  test("no fully-spelled gap endpoint matches a registered EndpointDecl", () => {
    const routeTemplates = Object.values(allEndpoints()).map((e) => ({
      method: endpointMethod(e.route),
      path: endpointPath(e.route),
      route: e.route,
    }));
    const gapLines = sectionLines(coverage, "Repo-scoped gaps (not built yet)", "COVERAGE.md");
    // The gaps table spells combined verbs like "GET/POST /repos/..."; expand
    // each method against the following path.
    const methodPath =
      /\b((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*)\s+(\/[^\s;()]+)/g;
    let found = 0;
    for (const line of gapLines) {
      for (const m of line.matchAll(methodPath)) {
        const methods = (m[1] ?? "").split("/");
        const gapPath = concretize(m[2] ?? "");
        for (const method of methods) {
          found++;
          for (const route of routeTemplates) {
            if (route.method === method && matchesTemplate(route.path, gapPath)) {
              throw new Error(
                `COVERAGE gap endpoint "${method} ${m[2]}" matches registered route "${route.route}"; a documented gap must not name an endpoint the action already calls`,
              );
            }
          }
        }
      }
    }
    // Structural, not a tuned constant: EVERY gap row must spell at least one
    // METHOD /path endpoint in its Endpoints cell, so a single row losing its
    // endpoint syntax (or the whole table changing format) fails here by
    // name. Implementing a gap deletes its whole row; an EMPTY table is the
    // legitimate all-gaps-implemented state, which the section prose must
    // declare in so many words - the guard that the table did not silently
    // change format out from under the sweep above.
    const gapRows = tableRows(gapLines);
    if (gapRows.length === 0) {
      expect(
        gapLines.join(" ").includes("The table is EMPTY right now"),
        "the gaps table has no rows but its prose does not declare the empty state; either a row lost its table format or the empty-state sentence was dropped",
      ).toBe(true);
      return;
    }
    expect(found).toBeGreaterThan(0);
    for (const row of gapRows) {
      const endpointCell = row[1] ?? "";
      expect(
        [...endpointCell.matchAll(methodPath)].length,
        `gap row "${row[0] ?? ""}" spells no parseable METHOD /path endpoint; the anti-match sweep above cannot see it`,
      ).toBeGreaterThan(0);
    }
  });
});

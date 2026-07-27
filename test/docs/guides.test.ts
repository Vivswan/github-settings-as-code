/**
 * Guides contract tests: docs/ pages are walkthroughs whose settings examples
 * must stay real. Every fenced block tagged `yaml settings` runs through the
 * full document validation (a schema change that invalidates a guide example
 * fails CI). The fence vocabulary is closed: fences are column-zero triple
 * backticks, and every opening info string must come from a known list, with
 * plain `yaml` reserved for workflow files - so a settings example cannot
 * dodge validation by dropping or misspelling its tag. The guide set itself
 * is pinned (a page cannot silently disappear while links to it remain).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { SPECIAL_KEYS } from "../../src/sections/repository.js";
import { fencedBlocks } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");
const silentIo: Io = { annotate: () => {}, log: () => {}, mask: () => {} };

const REQUIRED_PAGES = [
  "README.md",
  "getting-started.md",
  "examples.md",
  "multi-repo.md",
  "playbooks.md",
  "check-mode.md",
  "undeclared-policy.md",
  "secrets-and-vaults.md",
  "migrating-from-probot.md",
  "troubleshooting.md",
] as const;

function guidePages(): string[] {
  return readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort();
}

const ALLOWED_FENCE_INFO = new Set(["yaml settings", "yaml", "text"]);

/**
 * Fence-policy violations for one markdown document. The fencedBlocks
 * extractor assumes exactly this form, and the closed info vocabulary is
 * what makes example validation unavoidable: `yaml settings` is validated,
 * `yaml` must be a workflow, and the rest of the list is visibly not a
 * settings document. Kept pure so the mutation tests below can prove the
 * guard rejects each realistic authoring mistake. Extend ALLOWED_FENCE_INFO
 * deliberately when a guide needs a new language.
 */
function fenceViolations(markdown: string, allowed: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  let open = false;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (open) {
      // Inside a block, only the exact bare closer counts; fence-like body
      // lines (a guide showing markdown) are content. A malformed closer
      // therefore surfaces as the unclosed-fence problem at the end.
      if (line === "```") {
        open = false;
      }
      continue;
    }
    if (/^[\s>]*(`{3,}|~{3,})/.test(line)) {
      if (!/^`{3}(?!`)/.test(line)) {
        problems.push(
          `line ${index + 1}: fence "${line.trim()}" must start at column zero with exactly three backticks (no indent, no blockquote)`,
        );
        continue;
      }
      // No trim of LEADING whitespace: "``` yaml settings" would pass a
      // trimmed allowlist check while being invisible to fencedBlocks,
      // letting the example dodge validation.
      const info = line.slice(3).trimEnd();
      if (!allowed.has(info)) {
        problems.push(
          `line ${index + 1}: fence info "${info}" is not in the allowed list (${[...allowed].join(", ")})`,
        );
      }
      open = true;
    }
  }
  if (open) {
    problems.push("unclosed fence at end of document");
  }
  return problems;
}

describe("docs/ guide pages", () => {
  test("every required guide page exists", () => {
    const pages = new Set(guidePages());
    for (const page of REQUIRED_PAGES) {
      expect(pages.has(page), `docs/${page} is missing`).toBe(true);
    }
  });

  for (const page of guidePages()) {
    const markdown = readFileSync(join(DOCS, page), "utf8");

    test(`docs/${page}: every \`yaml settings\` block is a valid settings document`, () => {
      for (const block of fencedBlocks(markdown, "yaml settings")) {
        // Unlike the README heuristic, a tagged block gets no benefit of the
        // doubt: a parse error or an unknown key is a failure, not a skip.
        let doc: unknown;
        try {
          doc = parseYaml(block);
        } catch (error) {
          throw new Error(`docs/${page} has an unparseable settings example: ${error}`);
        }
        const invalid = validateSettingsDoc(doc, `docs/${page} example`, new Set(), silentIo);
        expect(invalid, `docs/${page} settings example failed validation: ${invalid}`).toBeNull();
        const repository = (doc as Record<string, unknown>).repository;
        if (repository && typeof repository === "object") {
          for (const key of Object.keys(repository)) {
            if (key.startsWith("enable_") || key === "topics") {
              expect(
                SPECIAL_KEYS.has(key),
                `docs/${page} example uses repository.${key}, which looks like a special key but is not in SPECIAL_KEYS`,
              ).toBe(true);
            }
          }
        }
      }
    });

    test(`docs/${page}: fences are column-zero triple backticks with known info strings`, () => {
      expect(fenceViolations(markdown, ALLOWED_FENCE_INFO)).toEqual([]);
    });

    test(`docs/${page}: plain yaml blocks are workflow files, everything else is tagged`, () => {
      // Guides carry two kinds of yaml: workflow files (plain ```yaml) and
      // settings documents (```yaml settings, validated above). Requiring
      // every plain block to parse as a workflow means a settings example
      // cannot dodge validation by dropping the tag, even with every section
      // key misspelled.
      for (const block of fencedBlocks(markdown, "yaml")) {
        let doc: unknown;
        try {
          doc = parseYaml(block);
        } catch {
          doc = null;
        }
        // A workflow file, structurally: a mapping whose top-level keys all
        // come from the workflow vocabulary, with a non-null jobs mapping.
        // A settings document smuggled in with a decorative jobs key still
        // fails on its section keys.
        const WORKFLOW_TOP_KEYS = new Set([
          "name",
          "run-name",
          "on",
          "permissions",
          "env",
          "defaults",
          "concurrency",
          "jobs",
        ]);
        const record =
          typeof doc === "object" && doc !== null && !Array.isArray(doc)
            ? (doc as Record<string, unknown>)
            : null;
        const isWorkflow =
          record !== null &&
          typeof record.jobs === "object" &&
          record.jobs !== null &&
          Object.keys(record).every((key) => WORKFLOW_TOP_KEYS.has(key));
        expect(
          isWorkflow,
          `docs/${page} has a plain yaml block that is not a workflow file (starts "${block.split("\n")[0]}"); tag settings examples as \`\`\`yaml settings`,
        ).toBe(true);
      }
      // `text` is for log output, the one fence kind that is never yaml. A
      // text block that parses to a mapping carrying a section key is a
      // settings example hiding from validation.
      const known = new Set<string>(SECTION_KEYS);
      for (const block of fencedBlocks(markdown, "text")) {
        let doc: unknown;
        try {
          doc = parseYaml(block);
        } catch {
          continue;
        }
        const settingsShaped =
          typeof doc === "object" &&
          doc !== null &&
          !Array.isArray(doc) &&
          Object.keys(doc).some((key) => known.has(key));
        expect(
          settingsShaped,
          `docs/${page} has a text block shaped like a settings document (starts "${block.split("\n")[0]}"); fence it as \`\`\`yaml settings`,
        ).toBe(false);
      }
    });
  }

  test("the guides carry settings examples at all", () => {
    const total = guidePages()
      .map((page) => fencedBlocks(readFileSync(join(DOCS, page), "utf8"), "yaml settings").length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  test("workflow snippets reference the current major tag", () => {
    // README pins exact versions inside release-please markers; guides use
    // the moving major tag instead so they do not rot per patch release. This
    // pin makes a major-version bump fail here, forcing the guides to follow.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const version = manifest["."] ?? "";
    if (version === "0.0.0") {
      return; // nothing released yet, no tag can be right
    }
    const major = `v${version.split(".")[0]}`;
    let references = 0;
    for (const page of guidePages()) {
      const markdown = readFileSync(join(DOCS, page), "utf8");
      for (const m of markdown.matchAll(/uses: Vivswan\/repo-settings-as-code@(\S+)/g)) {
        references++;
        expect(
          m[1],
          `docs/${page} pins @${m[1]}; guides must use the moving major tag @${major}`,
        ).toBe(major);
      }
      // release-please's generic updater rewrites the FIRST digit run on an
      // annotated line (MAJOR_VERSION_REGEX with String.replace). Every
      // annotated line must therefore keep the @v pin's digit first, or a
      // v2 release PR silently rewrites the wrong number.
      for (const [index, line] of markdown.split("\n").entries()) {
        if (line.includes("x-release-please-major")) {
          expect(
            /^[^\d]*@v\d/.test(line),
            `docs/${page}:${index + 1} carries x-release-please-major but a digit precedes the @v pin; release-please would rewrite that digit instead`,
          ).toBe(true);
        }
      }
    }
    // README.md carries the same inline annotation on its moving-major
    // prose line, subject to the identical first-digit hazard.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const [index, line] of readme.split("\n").entries()) {
      if (line.includes("x-release-please-major")) {
        expect(
          /^[^\d]*@v\d/.test(line),
          `README.md:${index + 1} carries x-release-please-major but a digit precedes the @v pin; release-please would rewrite that digit instead`,
        ).toBe(true);
      }
    }
    // The guides carry workflow snippets, so zero matches means the pattern
    // rotted, not that the docs went snippet-free.
    expect(references).toBeGreaterThan(0);
  });
});

describe("fence policy guard (mutation checks)", () => {
  // Each mutation is a realistic authoring mistake that would make an
  // example invisible to fencedBlocks; the guard must reject every one,
  // or a settings example could dodge validation.
  test("accepts the canonical form", () => {
    expect(fenceViolations("```yaml settings\nlabels: []\n```\n", ALLOWED_FENCE_INFO)).toEqual([]);
  });

  const MUTATIONS: Record<string, string> = {
    "a missing tag": "```\nlabels: []\n```\n",
    "a misspelled tag": "```yml settings\nlabels: []\n```\n",
    "a space before the tag": "``` yaml settings\nlabels: []\n```\n",
    "an indented fence": "  ```yaml settings\nlabels: []\n  ```\n",
    "a blockquoted fence": "> ```yaml settings\nlabels: []\n> ```\n",
    "a tilde fence": "~~~yaml settings\nlabels: []\n~~~\n",
    "a four-backtick fence": "````yaml settings\nlabels: []\n````\n",
    "an unclosed fence": "```yaml settings\nlabels: []\n",
  };
  for (const [name, markdown] of Object.entries(MUTATIONS)) {
    test(`rejects ${name}`, () => {
      expect(fenceViolations(markdown, ALLOWED_FENCE_INFO).length).toBeGreaterThan(0);
    });
  }
});

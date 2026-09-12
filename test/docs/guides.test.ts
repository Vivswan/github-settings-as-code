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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { DecodingMode, decodeHTML } from "entities";
import { ok } from "neverthrow";
import { parse as parseYaml } from "yaml";
import { type Layer, mergeLayers, stripNulls } from "../../src/engine/layers.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import { MERGE_REJECTED_INPUTS } from "../../src/flows/inputs.js";
import { foldLayers } from "../../src/flows/layers.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { NESTED_KEYS } from "../../src/sections/environments/nested.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { STALE_VERSION_HINT } from "../../src/sections/secret_scanning_custom_patterns/index.js";
import { deleteEnumerationProblems } from "./claims.js";
import { fencedBlocks, sectionLines } from "./markdown.js";
import { assertValidSettingsExample } from "./settings-examples.js";
import { stalePins } from "./version-pins.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");

const REQUIRED_PAGES = [
  "README.md",
  "start/getting-started.md",
  "start/examples.md",
  "start/migrating-from-probot.md",
  "reference/sections.md",
  "reference/inputs.md",
  "reference/semantics.md",
  "reference/permissions.md",
  "reference/undeclared-policy.md",
  "reference/forward-compatibility.md",
  "reference/secrets-and-vaults.md",
  "reference/architecture.md",
  "operate/check-mode.md",
  "operate/multi-repo.md",
  "operate/layering.md",
  "operate/private-repositories.md",
  "operate/troubleshooting.md",
  "playbooks/README.md",
  "playbooks/drift-attestation.md",
  "playbooks/fleet-baseline-rings.md",
  "playbooks/incident-freeze.md",
  "playbooks/oidc-trust-contract.md",
  "playbooks/preview-blast-radius.md",
  "playbooks/private-fork-containment.md",
  "playbooks/sunset-decommission.md",
  "playbooks/teams-not-collaborators.md",
  "playbooks/trust-tiers.md",
  "upgrading/README.md",
  "upgrading/v1-to-v2.md",
  "upgrading/v2-to-v3.md",
] as const;

function guidePages(): string[] {
  return readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort();
}

/**
 * The closed fence vocabulary: `yaml settings` is a complete settings document,
 * `yaml layer` one layer of a merge (valid once its null markers are stripped,
 * not necessarily standalone), `yaml` a workflow file, `mermaid` a diagram
 * (pinned to real code in diagrams.test.ts), `text` and `bash` never yaml.
 */
const ALLOWED_FENCE_INFO = new Set([
  "yaml settings",
  "yaml layer",
  "yaml",
  "mermaid",
  "text",
  "bash",
]);

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

/**
 * GitHub's heading slugger, as the anchor-integrity test needs it: lowercase,
 * spaces become hyphens, and punctuation (backticks, $, parentheses, slashes,
 * dots, quotes) is STRIPPED rather than hyphenated; underscores and hyphens
 * survive. Duplicate -1/-2 suffixes are handled by headingSlugs.
 */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * The lines of a document that sit outside fenced code blocks. Tolerates
 * indented fences (the README nests them in list items), unlike the guides'
 * stricter column-zero policy, so it is safe over every markdown file the
 * anchor test scans.
 */
function linesOutsideFences(markdown: string, source: string): string[] {
  const lines: string[] = [];
  let opener: string | null = null;
  for (const line of markdown.split("\n")) {
    if (opener === null) {
      const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (open) {
        opener = open[1] ?? "";
      } else {
        lines.push(line);
      }
      continue;
    }
    const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (close && close[1]?.[0] === opener[0] && (close[1]?.length ?? 0) >= opener.length) {
      opener = null;
    }
  }
  if (opener !== null) {
    // An unclosed fence would silently swallow every heading and link after
    // it; the guides' own fence policy catches this for docs/ pages, but the
    // root files in the scan set have no such check, so fail here instead.
    throw new Error(`unclosed ${opener} fence in ${source} swallows the rest of the document`);
  }
  return lines;
}

/**
 * An attribute value as a browser reads it: HTMLRewriter hands back the source text, so every
 * character reference (numeric, or any of the HTML5 named entities, semicolon-less legacy forms
 * included) is decoded here under the spec's attribute-value rules.
 */
function decodeAttribute(raw: string): string {
  return decodeHTML(raw, DecodingMode.Attribute);
}

/**
 * Every `href` and `src` attribute value in `markdown`, as the rendered page
 * carries it: the markdown is rendered to HTML (so every CommonMark destination
 * form, including entities, backslash escapes, angle brackets, multi-line
 * labels, and raw HTML tags, resolves the way a site build would) and the two
 * attributes are read back from every element carrying them (a, img, video,
 * source, iframe, link, ...) and HTML-unescaped.
 */
async function linkDestinations(markdown: string): Promise<string[]> {
  const destinations: string[] = [];
  await new HTMLRewriter()
    .on("[href], [src]", {
      element(element) {
        for (const attribute of ["href", "src"]) {
          const value = element.getAttribute(attribute);
          if (value !== null) {
            destinations.push(decodeAttribute(value));
          }
        }
      },
    })
    .transform(new Response(Bun.markdown.html(markdown)))
    .text();
  return destinations;
}

/**
 * The stand-in site the guard resolves against: docs/ served under a path no
 * real link names, so a destination that climbs out of it (and even one that
 * climbs out and back into a literal "docs/") lands outside that prefix.
 */
const SITE_ORIGIN = "https://docs-site.invalid";
const SITE_ROOT = "/docs-root-7c1e/";

/**
 * Every relative link or image in the docs/ page at `page` (its path under
 * docs/) that resolves outside docs/, as "docs/<page>:<line>: (<target>)".
 * Resolution is the WHATWG URL parser's, as a browser would do it (whitespace
 * and newlines stripped, backslashes as slashes, dot segments folded). The line
 * is the first one carrying the destination (or, for an encoded one, its file
 * name). The published site is built from docs/ alone, so a link to the
 * README, COVERAGE.md, or lib/ has nothing to land on there; those go through
 * an absolute URL.
 */
async function linksLeavingDocs(markdown: string, page: string): Promise<string[]> {
  const base = new URL(`${SITE_ROOT}${page}`, SITE_ORIGIN);
  const lines = markdown.split("\n");
  const lineOf = (target: string): string => {
    const name = posix.basename(target.split("#")[0] ?? "");
    const decoded = (text: string): string => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    };
    const needles = [target, decoded(target), name, decoded(name)];
    const index = needles
      .map((needle) => lines.findIndex((line) => line.includes(needle)))
      .find((found) => found !== -1);
    return index === undefined ? "?" : String(index + 1);
  };
  const problems: string[] = [];
  for (const destination of await linkDestinations(markdown)) {
    let url: URL;
    try {
      url = new URL(destination, base);
    } catch {
      continue; // not a URL at all; the existence check reports it
    }
    if (url.origin === SITE_ORIGIN && !url.pathname.startsWith(SITE_ROOT)) {
      const target = destination.trim();
      problems.push(`docs/${page}:${lineOf(target)}: (${target}) leaves docs/`);
    }
  }
  return problems;
}

/** Every fragment a file's headings answer to, duplicate suffixes included. */
function headingSlugs(markdown: string, source: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of linesOutsideFences(markdown, source)) {
    // ATX headings may carry a closing hash run ("## Setup ##"), which is
    // not part of the heading text GitHub slugs.
    const heading = line.match(/^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    if (!heading) {
      continue;
    }
    // GitHub resolves a duplicate by probing -1, -2, ... until the slug is
    // free, so an explicit "Setup-1" heading pushes a later duplicate
    // "Setup" to setup-2 rather than colliding on setup-1.
    const base = githubSlug(heading[1] ?? "");
    let slug = base;
    for (let n = 1; slugs.has(slug); n++) {
      slug = `${base}-${n}`;
    }
    slugs.add(slug);
  }
  return slugs;
}

/** One row of the layering guide's refusal tables, with the layer(s) that trigger it. */
interface RefusalRow {
  /** Which gate the table documents, from its header's second cell. */
  readonly gate: "validation" | "fold";
  /** The first cell, the row's name in a failure. */
  readonly has: string;
  /** The refused layer(s), flow YAML, one document each. */
  readonly inputs: string[];
  /** The message the second cell quotes, whole. */
  readonly quoted: string;
}

/**
 * The cells of one GFM table row: the outer pipes are optional, so a row
 * written without them (or with only one) is still a row and still pinned.
 */
function tableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
  }
  return body.split("|").map((cell) => cell.trim());
}

/** A GFM delimiter row (`|---|:--:|`), the one line that opens a table after its header. */
function isDelimiterRow(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line);
}

/**
 * The rows of the layering guide's two refusal tables. The page is the single
 * source: a row's first cell ends with the layer that triggers it, as one code
 * span in parentheses (or several joined by "or" when the page names
 * alternatives), and its second cell quotes the message the engine emits, in
 * one code span. Rows are recognized more permissively than GFM renders them:
 * a header line followed by a delimiter row opens a table (the delimiter's
 * cell count is not checked, so `|---|` under a two-cell header opens one here
 * and renders as prose), every non-blank line after that is a row (outer pipes
 * optional; a list item shaped like a row counts), and a blank line closes it.
 * Every divergence adds a pin, never loses one. A row missing its input or its
 * message fails here by name, so a new row cannot land unpinned.
 */
function refusalRows(section: readonly string[], source: string): RefusalRow[] {
  const GATES: Record<string, RefusalRow["gate"]> = {
    "Caught by": "validation",
    "The fold says": "fold",
  };
  const rows: RefusalRow[] = [];
  let gate: RefusalRow["gate"] | null = null;
  for (let index = 0; index < section.length; index++) {
    const line = section[index] ?? "";
    if (line.trim() === "") {
      gate = null;
      continue;
    }
    if (gate === null) {
      if (!line.includes("|")) {
        continue; // prose between the tables
      }
      // A piped line opens a table only when the delimiter row follows it;
      // one that renders as prose is an authoring slip, not a row to skip.
      if (!isDelimiterRow(section[index + 1])) {
        throw new Error(`${source}: refusal table row outside a known table: ${line.trim()}`);
      }
      const header = tableCells(line);
      if (header.length !== 2) {
        throw new Error(`${source}: refusal table header is not two cells: ${line.trim()}`);
      }
      const [has = "", says = ""] = header;
      gate = has === "The layer has" ? (GATES[says] ?? null) : null;
      if (gate === null) {
        throw new Error(`${source}: unknown refusal table header "${line.trim()}"`);
      }
      index++; // the delimiter row, the only line a table skips
      continue;
    }
    const cells = tableCells(line);
    if (cells.length !== 2) {
      throw new Error(`${source}: refusal table row is not two cells: ${line.trim()}`);
    }
    const [has = "", says = ""] = cells;
    const trigger = has.match(/\((`[^`]+`(?: or `[^`]+`)*)\)$/);
    if (!trigger) {
      throw new Error(
        `${source}: refusal row "${has}" does not end with its layer in parentheses as a code span (or code spans joined by "or"), so it cannot be reproduced`,
      );
    }
    const quoted = says.match(/^(?:Validation: )?`([^`]+)`$/);
    if (!quoted) {
      throw new Error(`${source}: refusal row "${has}" does not quote one message in a code span`);
    }
    rows.push({
      gate,
      has,
      inputs: [...(trigger[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
      quoted: quoted[1] ?? "",
    });
  }
  return rows;
}

/**
 * The validator's wrapper around its problem list. The page quotes the problem
 * alone ("with the same messages a standalone file gets"); holding the whole
 * error to the wrapper around ONE quoted problem proves the row's layer raises
 * that problem and nothing else.
 */
function malformedSectionEntries(layer: string, problem: string): string {
  return (
    `${layer} has malformed section entries: ${problem}. Fix these values in ` +
    `the settings file (only the named keys are validated; extra fields pass through, except ` +
    `in closed sections and strict nested objects like actions.cache, which reject ` +
    `unrecognized keys)`
  );
}

describe("docs/ guide pages", () => {
  test("every required guide page exists, and no page exists outside the set", () => {
    // Exact equality, not inclusion: after the tree restructure this is what
    // proves the old folders actually disappeared instead of lingering as
    // orphaned copies next to the new pages.
    expect(guidePages()).toEqual([...REQUIRED_PAGES].sort());
  });

  /**
   * Every markdown file whose outbound links the two link tests verify: the
   * guides plus the root pages that link into docs/ (README, COVERAGE,
   * CONTRIBUTING, SECURITY), which would otherwise go unchecked.
   */
  const linkScanFiles = () => [
    ...guidePages().map((page) => ({ label: `docs/${page}`, path: join(DOCS, page) })),
    { label: "README.md", path: join(ROOT, "README.md") },
    { label: "COVERAGE.md", path: join(ROOT, "COVERAGE.md") },
    { label: "CONTRIBUTING.md", path: join(ROOT, "CONTRIBUTING.md") },
    { label: ".github/SECURITY.md", path: join(ROOT, ".github", "SECURITY.md") },
  ];

  test("every relative link in the guides, README, and COVERAGE resolves to a real file", () => {
    // The guides moved into group folders, so every cross-link is a relative
    // path that a rename or move can silently break. Resolve each one
    // against its file's directory (anchors stripped; external and
    // in-page links skipped) and require the target to exist.
    const broken: string[] = [];
    for (const file of linkScanFiles()) {
      const markdown = linesOutsideFences(readFileSync(file.path, "utf8"), file.label).join("\n");
      for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^[a-z]+:\/\//.test(target) || target.startsWith("#") || target.startsWith("mailto:")) {
          continue;
        }
        const path = target.split("#")[0] ?? "";
        if (path === "") {
          continue;
        }
        const resolved = join(file.path, "..", path);
        if (!existsSync(resolved)) {
          broken.push(`${file.label}: (${target})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("no guide links outside docs/", async () => {
    // The docs site is built from docs/ alone: every relative link must land
    // on a page inside it, and the repository's root files are reached by URL.
    const leaving: string[] = [];
    for (const page of guidePages()) {
      leaving.push(...(await linksLeavingDocs(readFileSync(join(DOCS, page), "utf8"), page)));
    }
    expect(leaving).toEqual([]);
  });

  test("every relative link with a #fragment points at a real heading", () => {
    // The existence check above ignores fragments, so a heading rename or a
    // section moved to another page used to break silently. Here every
    // relative link carrying a fragment (same-page `#fragment` links
    // included) from the guides, the README, or COVERAGE.md must match a
    // GitHub-slugified heading of its target file.
    const files = linkScanFiles();
    const slugCache = new Map<string, Set<string>>();
    const slugsOf = (path: string): Set<string> => {
      let slugs = slugCache.get(path);
      if (!slugs) {
        slugs = headingSlugs(readFileSync(path, "utf8"), path);
        slugCache.set(path, slugs);
      }
      return slugs;
    };
    const broken: string[] = [];
    for (const file of files) {
      const markdown = linesOutsideFences(readFileSync(file.path, "utf8"), file.label).join("\n");
      for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^[a-z]+:\/\//.test(target) || target.startsWith("mailto:")) {
          continue;
        }
        const hash = target.indexOf("#");
        if (hash === -1) {
          continue;
        }
        const fragment = target.slice(hash + 1);
        const path = target.slice(0, hash);
        const resolved = path === "" ? file.path : join(file.path, "..", path);
        if (!resolved.endsWith(".md")) {
          continue; // only markdown targets have slugified headings
        }
        if (!existsSync(resolved)) {
          broken.push(`${file.label}: (${target}) target file does not exist`);
          continue;
        }
        if (!slugsOf(resolved).has(fragment)) {
          broken.push(`${file.label}: (${target}) fragment matches no heading`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("headings in scanned files carry no markdown links, HTML, or brackets", () => {
    // githubSlug slugs RAW heading text, so a markdown link, HTML tag, or
    // entity inside a heading would slug to garbage the anchor test then
    // trusts. Keep headings plain text and the slugger stays honest.
    const offenders: string[] = [];
    for (const file of linkScanFiles()) {
      for (const line of linesOutsideFences(readFileSync(file.path, "utf8"), file.label)) {
        const heading = line.match(/^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
        if (heading && /[[\]<>&]/.test(heading[1] ?? "")) {
          offenders.push(`${file.label}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Every file the release-please generic updater may rewrite: root-level
   * markdown, the guide pages, and the issue templates. The marker/extra-files
   * equality test and the first-digit hazard guard both iterate this one
   * list, so widening the scan set updates them together.
   */
  function markerScanFiles(): Array<{ label: string; path: string }> {
    const rootPages = readdirSync(ROOT)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({ label: name, path: join(ROOT, name) }));
    const templateDir = join(ROOT, ".github", "ISSUE_TEMPLATE");
    const templates = readdirSync(templateDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => ({
        label: `.github/ISSUE_TEMPLATE/${name}`,
        path: join(templateDir, name),
      }));
    return rootPages
      .concat(guidePages().map((page) => ({ label: `docs/${page}`, path: join(DOCS, page) })))
      .concat(templates);
  }

  test("marker-bearing files equal the release-please extra-files set", () => {
    // release-please's generic updater rewrites version pins only in files
    // listed under extra-files; a page moved without updating
    // release-please-config.json keeps its stale pin silently. A docs
    // restructure is exactly when that happens, so pin the sets equal.
    // An extra-files entry outside markerScanFiles() (action.yml, a
    // workflow) fails this equality and means the scan set needs widening.
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
      packages: Record<string, { "extra-files": string[] }>;
    };
    const extraFiles = config.packages["."]?.["extra-files"] ?? [];
    const marked = markerScanFiles()
      .filter((file) => readFileSync(file.path, "utf8").includes("x-release-please-"))
      .map((file) => file.label);
    expect(marked.sort()).toEqual([...extraFiles].sort());
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
        assertValidSettingsExample(doc, `docs/${page} settings example`);
      }
    });

    test(`docs/${page}: every \`yaml layer\` block is a valid layer`, () => {
      // A layer is judged exactly as the merge step judges it: the nulls the
      // fold reads as markers are dropped first (src/engine/layers.ts
      // stripNulls), then the same document validation apply runs, then the
      // fold's own gates (a duplicate key within the layer, a layering
      // directive on a section without a layering key) admit it alone.
      for (const block of fencedBlocks(markdown, "yaml layer")) {
        let doc: unknown;
        try {
          doc = parseYaml(block);
        } catch (error) {
          throw new Error(`docs/${page} has an unparseable layer example: ${error}`);
        }
        assertValidSettingsExample(stripNulls(doc), `docs/${page} layer example`);
        const folded = mergeLayers([{ name: `docs/${page}`, doc }], { layering: "merge" });
        expect("error" in folded ? folded.error : null).toBeNull();
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

  test("the examples cookbook shows every section at least once", () => {
    // Every section shows at least one cookbook block, derived from
    // SECTION_KEYS so a new section cannot skip the cookbook silently.
    // Nested environment lists ride the same pin (they live inside the
    // environments block).
    const markdown = readFileSync(join(DOCS, "start", "examples.md"), "utf8");
    const fences = fencedBlocks(markdown, "yaml settings").join("\n");
    for (const key of SECTION_KEYS) {
      expect(
        new RegExp(`^${key}:`, "m").test(fences),
        `docs/start/examples.md never declares \`${key}\` in a settings fence`,
      ).toBe(true);
    }
    for (const key of NESTED_KEYS) {
      expect(
        new RegExp(`^ +${key}:`, "m").test(fences),
        `docs/start/examples.md never declares the nested environments[].${key}`,
      ).toBe(true);
    }
  });

  test.each<[string, number, Array<{ layer: string; path: string }>]>([
    ["A first fold", 2, []],
    [
      "A worked example",
      3,
      [
        { layer: "layer-1", path: "repository.has_projects" },
        { layer: "layer-2", path: "pages" },
      ],
    ],
  ])(
    'the layering guide\'s "%s" folds to the merged document it shows',
    (heading, count, notices) => {
      // The `yaml layer` fences under the heading are the layers, lowest first,
      // and the section's one `yaml settings` fence is the result; the real
      // fold must produce exactly that result, so the page cannot describe a
      // dialect the engine does not implement.
      const markdown = readFileSync(join(DOCS, "operate", "layering.md"), "utf8");
      const section = sectionLines(markdown, heading, "docs/operate/layering.md").join("\n");
      const layers: Layer[] = fencedBlocks(section, "yaml layer").map((block, index) => ({
        name: `layer-${index}`,
        doc: parseYaml(block),
      }));
      expect(layers).toHaveLength(count);
      const results = fencedBlocks(section, "yaml settings").map((block) => parseYaml(block));
      expect(results).toHaveLength(1);
      expect(mergeLayers(layers, { layering: "merge" })).toEqual(
        ok({ settings: results[0], notices }),
      );
    },
  );

  test("the layering guide's inputs table names every input mode: merge rejects", () => {
    // The rejected set is derived from the input declarations, so a new
    // apply/check-time input is rejected by the merge the moment it is
    // declared; the table must name it, or the page under-reports the refusal.
    const markdown = readFileSync(join(DOCS, "operate", "layering.md"), "utf8");
    const section = sectionLines(markdown, "Inputs in mode: merge", "docs/operate/layering.md");
    const rejectedRow = section.find((line) => line.includes("| Rejected"));
    if (rejectedRow === undefined) {
      throw new Error('docs/operate/layering.md has no "Rejected" row in its inputs table');
    }
    const named = [...rejectedRow.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]);
    expect(new Set(named)).toEqual(new Set(MERGE_REJECTED_INPUTS));
  });

  describe("the layering guide's refusal tables quote the messages the merge step emits", () => {
    // Each row's layer runs through the merge step's own gates in the page's
    // order (per-layer validation, then the fold), and the row's quoted
    // message must equal the whole error, so neither table can drift from the
    // engine and no row can quote a message its own layer does not raise.
    const PAGE = "docs/operate/layering.md";
    const section = sectionLines(
      readFileSync(join(DOCS, "operate", "layering.md"), "utf8"),
      "Refusals",
      PAGE,
    );
    // The page names the refused layer in the fold's prefix it quotes
    // (`layer "<name>": ...`); every row's layer is folded under that name.
    const prefix = section.join("\n").match(/`layer "([^"`]+)": \.\.\.`/);
    if (!prefix) {
      throw new Error(
        `${PAGE}'s Refusals section no longer quotes the fold's \`layer "<name>": ...\` prefix`,
      );
    }
    const layerName = prefix[1] ?? "";
    const rows = refusalRows(section, PAGE);

    test("both tables are present and populated", () => {
      expect(rows.filter((row) => row.gate === "validation").length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.gate === "fold").length).toBeGreaterThan(0);
    });

    test.each(rows.map((row) => [row.has, row] as const))("%s", (_has, row) => {
      for (const input of row.inputs) {
        const doc = parseYaml(input);
        const expected =
          row.gate === "validation"
            ? malformedSectionEntries(layerName, row.quoted)
            : `layer "${layerName}": ${row.quoted}`;
        const folded = foldLayers([{ name: layerName, doc }], "merged", "merge", silentIo());
        expect(
          folded.match(() => null, describeProblem),
          `layer ${input}`,
        ).toBe(expected);
        if (row.gate === "validation") {
          // "with the same messages a standalone file gets"
          const standalone = validateSettingsDoc(doc, layerName, new Set(), silentIo());
          expect(
            standalone.match(() => null, describeProblem),
            `standalone ${input}`,
          ).toBe(expected);
        }
      }
    });
  });

  test("the v2-to-v3 guide quotes the complete wrapper-key rename error the validator emits", () => {
    // The guide's text fence is the reader's search string, so it is held to
    // the error the validator emits for a v2 wrapper, not to a source substring.
    const guide = readFileSync(join(DOCS, "upgrading", "v2-to-v3.md"), "utf8");
    const result = validateSettingsDoc(
      { labels: { undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] } },
      ".github/settings.yml",
      new Set(),
      silentIo(),
    );
    if (result.isOk()) {
      throw new Error("the validator accepted the v2 wrapper key");
    }
    const message = describeProblem(result.error);
    expect(message).toContain('"undeclared" was renamed to "_undeclared"');
    expect(fencedBlocks(guide, "text").map((block) => block.trim())).toContain(message);
  });

  test("the troubleshooting guide quotes the stale-version hint verbatim", () => {
    // The page quotes the hint character for character; pin the quote to the
    // exported constant so editing the hint cannot leave the page silently
    // wrong.
    const markdown = readFileSync(join(DOCS, "operate", "troubleshooting.md"), "utf8");
    expect(
      markdown.replace(/\n/g, " ").includes(STALE_VERSION_HINT),
      "docs/operate/troubleshooting.md no longer quotes STALE_VERSION_HINT verbatim",
    ).toBe(true);
  });

  test("fencedBlocks sees every tagged settings example the guides carry", () => {
    // The per-page corpus tests validate what fencedBlocks returns, so a
    // blind fencedBlocks would pass them vacuously. Count the openers with
    // an independent scan and pin the one page that must carry an example.
    const seen = Object.fromEntries(
      guidePages().map((page) => {
        const markdown = readFileSync(join(DOCS, page), "utf8");
        return [page, fencedBlocks(markdown, "yaml settings").length];
      }),
    );
    const openers = Object.fromEntries(
      guidePages().map((page) => {
        const markdown = readFileSync(join(DOCS, page), "utf8");
        return [page, markdown.split("\n").filter((line) => line === "```yaml settings").length];
      }),
    );
    expect(seen).toEqual(openers);
    expect(seen["start/getting-started.md"]).toBe(1);
  });

  test("the undeclared-policy guide names every nested per-environment knob", () => {
    // The guides' "carry the same wrapped form" enumerations are prose; this
    // pins them to NESTED_KEYS (the single source the reconciler loops over),
    // so adding a nested knob without documenting its policy fails here
    // instead of rotting silently. check-mode.md carries the same
    // enumeration in its not-verifiable list, so both pages are pinned.
    for (const path of [
      ["reference", "undeclared-policy.md"],
      ["operate", "check-mode.md"],
    ] as const) {
      const page = readFileSync(join(DOCS, ...path), "utf8");
      for (const key of NESTED_KEYS) {
        expect(
          page.includes(`environments[].${key}`),
          `docs/${path.join("/")} never names environments[].${key}; document the nested knob`,
        ).toBe(true);
      }
    }
  });

  test("the guides enumerate every delete-by-default section", () => {
    // The set is derived from the registry so a new delete-by-default
    // section fails here until the prose follows; getting-started drifted
    // to three of five sections once already.
    const deleteKeys = SECTIONS.filter((s) => s.undeclaredDefault === "delete").map((s) => s.key);
    // getting-started names section KEYS in backticks: the paragraph must
    // name exactly the delete-by-default set - no more, no fewer.
    const gettingStarted = readFileSync(join(DOCS, "start", "getting-started.md"), "utf8");
    const paragraph = gettingStarted
      .split("\n\n")
      .find((p) => p.includes("declared list authoritative"));
    expect(
      paragraph,
      'getting-started.md lost its "declared list authoritative" paragraph',
    ).toBeDefined();
    for (const key of deleteKeys) {
      expect(
        (paragraph ?? "").includes(`\`${key}\``),
        `getting-started's exceptions paragraph omits \`${key}\`, which deletes undeclared entries by default`,
      ).toBe(true);
    }
    for (const key of SECTION_KEYS) {
      if (!deleteKeys.includes(key)) {
        expect(
          (paragraph ?? "").includes(`\`${key}\``),
          `getting-started's exceptions paragraph names \`${key}\`, which does not delete undeclared entries by default`,
        ).toBe(false);
      }
    }
    // The migration guide's deletion paragraph uses display names, checked
    // through the shared map in claims.ts.
    const migration = readFileSync(join(DOCS, "start", "migrating-from-probot.md"), "utf8");
    const deletions = migration.split("\n\n").find((p) => p.includes("Deletions still exist"));
    expect(
      deletions,
      'migrating-from-probot.md lost its "Deletions still exist" paragraph',
    ).toBeDefined();
    expect(deleteEnumerationProblems(deletions ?? "", deleteKeys)).toEqual([]);
  });

  test("workflow snippets reference the current major tag", () => {
    // README pins exact versions inside release-please markers; guides use
    // the moving major tag instead so they do not rot per patch release. This
    // pin makes a major-version bump fail here, forcing the guides to follow.
    const pins = stalePins(
      guidePages().map((page) => ({
        label: `docs/${page}`,
        text: readFileSync(join(DOCS, page), "utf8"),
      })),
    );
    if (pins === null) {
      return; // nothing released yet, no tag can be right
    }
    // The guides carry workflow snippets, so zero matches means the pattern
    // rotted, not that the docs went snippet-free.
    expect(pins.references).toBeGreaterThan(0);
    const stale = pins.stale.map((pin) => `${pin.label}:${pin.line} pins @${pin.ref}: ${pin.text}`);
    expect(
      stale,
      `${stale.length} guide snippet(s) do not reference the moving major tag @${pins.major}:\n` +
        `  ${stale.join("\n  ")}\n` +
        `Fix each line by appending " # x-release-please-major" and listing the file under\n` +
        `extra-files in release-please-config.json, so release PRs rewrite the tag; then\n` +
        `set the tag to the current major.`,
    ).toEqual([]);
  });

  test("every x-release-please-major line keeps its version digit first", () => {
    // release-please's generic updater rewrites the FIRST digit run on an
    // annotated line (MAJOR_VERSION_REGEX with String.replace). Every
    // annotated line in every file the updater may rewrite - root markdown,
    // guides, and issue templates alike (markerScanFiles) - must therefore
    // keep its major-version digit first, reached as an @v pin, a /v path
    // segment (the schema hint URLs), or backtick-v prose, or the next
    // major's release PR silently rewrites the wrong number.
    for (const file of markerScanFiles()) {
      const content = readFileSync(file.path, "utf8");
      for (const [index, line] of content.split("\n").entries()) {
        if (line.includes("x-release-please-major")) {
          expect(
            /^[^\d]*[@/`]v\d+(?!\w)/.test(line),
            `${file.label}:${index + 1} carries x-release-please-major but a digit precedes the version token (an @v pin, /v segment, or backtick-v prose); release-please would rewrite that digit instead`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("links-leaving-docs guard (mutation checks)", () => {
  // Every CommonMark way of writing a destination that climbs out of docs/ is
  // named with its page and line, whatever element carries it (a, img, video,
  // source, iframe, link); links that stay inside docs/ from any depth,
  // fenced or inline-code look-alikes, absolute URLs, and in-page fragments
  // never are.
  const page = [
    "# Title",
    "",
    "See [sections](../reference/sections.md#labels) and [the README](../../README.md#sections).",
    "",
    "```yaml",
    "# not a link: [x](../../README.md)",
    "```",
    "",
    "[COVERAGE](../../COVERAGE.md), [site](https://example.com/../x), [here](#title), `[code](../../README.md)`.",
    "",
    "Reference-style: [the README][root], [semantics][sem], [schema][schema], [coverage][cov], and [two",
    "lines][two lines].",
    "",
    "[root]: ../../README.md#sections",
    "[sem]: ../reference/semantics.md",
    "[schema]: <../../lib/settings.schema.json>",
    "[cov]:",
    "../../COVERAGE.md#supported 'Coverage'",
    "[two",
    "lines]: ../../SECURITY.md",
    "",
    'Angle brackets inline: [x](<../../README.md> "Readme"), [y](<../operate/check-mode.md>), and [z](',
    "../../CONTRIBUTING.md",
    ").",
    "",
    "Encoded: [e](&#46;&#46;/&#46;&#46;/LICENSE.md), [b](\\.\\./\\.\\./CHANGELOG.md), and [s](<../../a file.md>).",
    "",
    '> [q](../../quoted.md) and ![img](../../image.png) and <a href="../../raw.html">raw</a>',
    "",
    '<a href="&#46;&#46;/&#x2e;&#x2e;/NOTICE.md">refs</a> <a href="  ../../padded.md ">padded</a> <a href="../a&amp;b.md">amp</a>',
    "",
    '<a href="&#46&#46/&#x2e&#x2e/AUTHORS.md">bare refs</a> <a href="..\\..\\SUPPORT.md">backslashes</a> <a href="../',
    '../FUNDING.md">newline</a> <a href="mailto:x@y.z">mail</a>',
    "",
    '<video src="../../demo.mp4" controls></video> <source src="../../demo.webm"> <video src="../assets/demo.mp4"></video>',
    "",
    '<iframe src="../../embed.html"></iframe> <link href="../../style.css"> <link href="../assets/style.css">',
    "",
    '<a href="&period;&period;/&period;&period;/GOVERNANCE.md">named</a> <a href="&period;&period;&sol;&period;&period;&sol;CODEOWNERS.md">named slashes</a> <a href="../&amp/../../LEGACY.md">legacy bare</a>',
    "",
    // The control: a browser decodes a semicolon-less entity only from the legacy list, so
    // `&period` stays literal and this link resolves inside docs/, escaping nothing.
    '<a href="&period&period/&period&period/MAINTAINERS.md">non-legacy bare</a>',
    "",
  ].join("\n");
  test("names each escaping link by page and line", async () => {
    expect(await linksLeavingDocs(page, "start/getting-started.md")).toEqual([
      "docs/start/getting-started.md:3: (../../README.md#sections) leaves docs/",
      "docs/start/getting-started.md:9: (../../COVERAGE.md) leaves docs/",
      "docs/start/getting-started.md:3: (../../README.md#sections) leaves docs/",
      "docs/start/getting-started.md:16: (../../lib/settings.schema.json) leaves docs/",
      "docs/start/getting-started.md:18: (../../COVERAGE.md#supported) leaves docs/",
      "docs/start/getting-started.md:20: (../../SECURITY.md) leaves docs/",
      "docs/start/getting-started.md:3: (../../README.md) leaves docs/",
      "docs/start/getting-started.md:23: (../../CONTRIBUTING.md) leaves docs/",
      "docs/start/getting-started.md:26: (../../LICENSE.md) leaves docs/",
      "docs/start/getting-started.md:26: (../../CHANGELOG.md) leaves docs/",
      "docs/start/getting-started.md:26: (../../a%20file.md) leaves docs/",
      "docs/start/getting-started.md:28: (../../quoted.md) leaves docs/",
      "docs/start/getting-started.md:28: (../../image.png) leaves docs/",
      "docs/start/getting-started.md:28: (../../raw.html) leaves docs/",
      "docs/start/getting-started.md:30: (../../NOTICE.md) leaves docs/",
      "docs/start/getting-started.md:30: (../../padded.md) leaves docs/",
      "docs/start/getting-started.md:32: (../../AUTHORS.md) leaves docs/",
      "docs/start/getting-started.md:32: (..\\..\\SUPPORT.md) leaves docs/",
      "docs/start/getting-started.md:33: (../\n../FUNDING.md) leaves docs/",
      "docs/start/getting-started.md:35: (../../demo.mp4) leaves docs/",
      "docs/start/getting-started.md:35: (../../demo.webm) leaves docs/",
      "docs/start/getting-started.md:37: (../../embed.html) leaves docs/",
      "docs/start/getting-started.md:37: (../../style.css) leaves docs/",
      "docs/start/getting-started.md:39: (../../GOVERNANCE.md) leaves docs/",
      "docs/start/getting-started.md:39: (../../CODEOWNERS.md) leaves docs/",
      "docs/start/getting-started.md:39: (../&/../../LEGACY.md) leaves docs/",
    ]);
    expect(
      await linksLeavingDocs("[README](../README.md) and [ok](start/x.md)", "README.md"),
    ).toEqual(["docs/README.md:1: (../README.md) leaves docs/"]);
    // Climbing out and back in still leaves the site's root, where no docs/ directory exists.
    expect(await linksLeavingDocs("[up and back](../../docs/start/x.md)", "start/y.md")).toEqual([
      "docs/start/y.md:1: (../../docs/start/x.md) leaves docs/",
    ]);
  });
});

describe("refusal table parser (mutation checks)", () => {
  // Each mutation is a realistic authoring slip on the layering guide's
  // refusal tables; the parser must pin or reject every one, never skip a row.
  const header = ["| The layer has | The fold says |", "|---|---|"];
  const row = (has: string, says = "`the message`"): string => `| ${has} | ${says} |`;

  test("an indented row is parsed as a row, not skipped", () => {
    const rows = refusalRows([...header, `   ${row("Indented (`labels: oops`)")}`], "page");
    expect(rows.map((parsed) => parsed.inputs)).toEqual([["labels: oops"]]);
  });

  test("a row without its outer pipes is parsed as a row, not prose", () => {
    // GFM renders a row with no leading pipe (or no trailing one) as a row,
    // so a last row appended that way must be pinned rather than skipped.
    const unpiped = "New refusal (`_layering: union`) | `WRONG MESSAGE` |";
    const bare = "Bare (`a: 1`) | `also wrong`";
    const rows = refusalRows([...header, row("First (`labels: oops`)"), unpiped, bare], "page");
    expect(rows.map((parsed) => [parsed.inputs, parsed.quoted])).toEqual([
      [["labels: oops"], "the message"],
      [["_layering: union"], "WRONG MESSAGE"],
      [["a: 1"], "also wrong"],
    ]);
  });

  test("a blank line closes a table; the next table needs its own header", () => {
    const rows = refusalRows(
      [...header, row("A (`a: 1`)"), "", "Prose with no pipes.", "", ...header, row("B (`b: 2`)")],
      "page",
    );
    expect(rows.map((parsed) => parsed.inputs)).toEqual([["a: 1"], ["b: 2"]]);
  });

  test("two alternatives joined by or are both inputs", () => {
    const rows = refusalRows([...header, row("Either (`a: 1` or `b: 2`)")], "page");
    expect(rows.map((parsed) => parsed.inputs)).toEqual([["a: 1", "b: 2"]]);
  });

  test.each<[string, string[], RegExp]>([
    [
      "a row without its layer in parentheses",
      [...header, row("No input here")],
      /does not end with its layer/,
    ],
    [
      "a data row whose first cell is a dash run",
      [...header, row("---", "`hidden message`")],
      /refusal row "---" does not end with its layer/,
    ],
    [
      "a row whose message is prose, not one code span",
      [...header, row("X (`a: 1`)", "prose")],
      /does not quote one message/,
    ],
    ["a row with three cells", [...header, "| a | b | c |"], /is not two cells/],
    [
      "a prose line run into the table without a blank line",
      [...header, row("X (`a: 1`)"), "A paragraph GFM reads as a one-cell row."],
      /is not two cells/,
    ],
    [
      "a table under an unknown header",
      ["| The layer has | Something |", "|---|---|"],
      /unknown refusal table header/,
    ],
    [
      "a table whose header is not two cells",
      ["| The layer has | The fold says | Extra |", "|---|---|---|"],
      /header is not two cells/,
    ],
    ["a row before any header", [row("X (`a: 1`)")], /outside a known table/],
    [
      "a piped line with no delimiter row after it (renders as prose)",
      ["| The layer has | The fold says |", row("X (`a: 1`)")],
      /outside a known table/,
    ],
  ])("%s is rejected by name", (_case, section, error) => {
    expect(() => refusalRows(section, "page")).toThrow(error);
  });
});

describe("fence policy guard (mutation checks)", () => {
  // Each mutation is a realistic authoring mistake that would make an
  // example invisible to fencedBlocks; the guard must reject every one,
  // or a settings example could dodge validation.
  test("accepts the canonical form", () => {
    expect(fenceViolations("```yaml settings\nlabels: []\n```\n", ALLOWED_FENCE_INFO)).toEqual([]);
  });

  const notAllowed = (line: number, info: string): string =>
    `line ${line}: fence info "${info}" is not in the allowed list (${[...ALLOWED_FENCE_INFO].join(", ")})`;
  const malformed = (line: number, fence: string): string =>
    `line ${line}: fence "${fence}" must start at column zero with exactly three backticks (no indent, no blockquote)`;
  const MUTATIONS: Record<string, [markdown: string, violations: string[]]> = {
    "a missing tag": ["```\nlabels: []\n```\n", [notAllowed(1, "")]],
    "a misspelled tag": ["```yml settings\nlabels: []\n```\n", [notAllowed(1, "yml settings")]],
    "a space before the tag": [
      "``` yaml settings\nlabels: []\n```\n",
      [notAllowed(1, " yaml settings")],
    ],
    // A malformed opener never opens a block, so its closer is reported too.
    "an indented fence": [
      "  ```yaml settings\nlabels: []\n  ```\n",
      [malformed(1, "```yaml settings"), malformed(3, "```")],
    ],
    "a blockquoted fence": [
      "> ```yaml settings\nlabels: []\n> ```\n",
      [malformed(1, "> ```yaml settings"), malformed(3, "> ```")],
    ],
    "a tilde fence": [
      "~~~yaml settings\nlabels: []\n~~~\n",
      [malformed(1, "~~~yaml settings"), malformed(3, "~~~")],
    ],
    "a four-backtick fence": [
      "````yaml settings\nlabels: []\n````\n",
      [malformed(1, "````yaml settings"), malformed(3, "````")],
    ],
    "an unclosed fence": ["```yaml settings\nlabels: []\n", ["unclosed fence at end of document"]],
  };
  for (const [name, [markdown, violations]] of Object.entries(MUTATIONS)) {
    test(`rejects ${name}`, () => {
      expect(fenceViolations(markdown, ALLOWED_FENCE_INFO)).toEqual(violations);
    });
  }
});

describe("github heading slugger", () => {
  // Real headings from this repo's pages, covering the punctuation GitHub
  // strips: backticks, $, parentheses, slashes, dots, and quotes. A wrong
  // slugging rule fails here, not as a false anchor break in the link test.
  const CASES: Record<string, string> = {
    "The `$NAME` pattern": "the-name-pattern",
    "Behavior does not match src/ (missing or stale bundle)":
      "behavior-does-not-match-src-missing-or-stale-bundle",
    "Example settings.yml": "example-settingsyml",
    'What a "cannot verify" note means': "what-a-cannot-verify-note-means",
    "Compared to the Probot Settings app": "compared-to-the-probot-settings-app",
    "1. Create the token": "1-create-the-token",
    "null as an opt-out": "null-as-an-opt-out",
    "The nested variables, secrets, and deployment knobs":
      "the-nested-variables-secrets-and-deployment-knobs",
  };
  for (const [heading, slug] of Object.entries(CASES)) {
    test(`slugs "${heading}" to "${slug}"`, () => {
      expect(githubSlug(heading)).toBe(slug);
    });
  }

  test("duplicate headings get -1/-2 suffixes", () => {
    expect(headingSlugs("# Setup\n\n## Setup\n\n### Setup\n", "(inline)")).toEqual(
      new Set(["setup", "setup-1", "setup-2"]),
    );
  });

  test("a duplicate probes past an explicit -1 heading, as GitHub does", () => {
    expect(headingSlugs("# Setup\n\n## Setup-1\n\n### Setup\n", "(inline)")).toEqual(
      new Set(["setup", "setup-1", "setup-2"]),
    );
  });

  test("a closing hash run is not part of the heading text", () => {
    expect(headingSlugs("## Setup ##\n", "(inline)")).toEqual(new Set(["setup"]));
  });

  test("tilde fences hide heading-looking lines like backtick fences do", () => {
    expect(headingSlugs("~~~text\n# not a heading\n~~~\n\n# Real\n", "(inline)")).toEqual(
      new Set(["real"]),
    );
  });

  test("heading-looking lines inside fenced blocks are not headings", () => {
    const markdown = [
      "```yaml settings",
      "# yaml-language-server: $schema=https://example.com/schema.json",
      "```",
      "",
      "## Real heading",
      "",
    ].join("\n");
    expect(headingSlugs(markdown, "(inline)")).toEqual(new Set(["real-heading"]));
  });

  test("indented fences hide their contents too", () => {
    const markdown = ["   ```yaml", "   # a comment", "   ```", "# Title"].join("\n");
    expect(headingSlugs(markdown, "(inline)")).toEqual(new Set(["title"]));
  });
});

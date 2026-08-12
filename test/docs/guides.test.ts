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
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { NESTED_KEYS } from "../../src/sections/environments/index.js";
import { SPECIAL_KEYS } from "../../src/sections/repository/index.js";
import { STALE_VERSION_HINT } from "../../src/sections/secret_scanning_custom_patterns/index.js";
import { fencedBlocks } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");
const silentIo: Io = { annotate: () => {}, log: () => {}, mask: () => {} };

const REQUIRED_PAGES = [
  "README.md",
  "start/getting-started.md",
  "start/examples.md",
  "start/migrating-from-probot.md",
  "reference/semantics.md",
  "reference/permissions.md",
  "reference/undeclared-policy.md",
  "reference/forward-compatibility.md",
  "reference/secrets-and-vaults.md",
  "operate/check-mode.md",
  "operate/multi-repo.md",
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
] as const;

function guidePages(): string[] {
  return readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort();
}

const ALLOWED_FENCE_INFO = new Set(["yaml settings", "yaml", "text", "bash"]);

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
    { label: "SECURITY.md", path: join(ROOT, "SECURITY.md") },
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

  test("marker-bearing markdown files equal the release-please extra-files set", () => {
    // release-please's generic updater rewrites version pins only in files
    // listed under extra-files; a page moved without updating
    // release-please-config.json keeps its stale pin silently. A docs
    // restructure is exactly when that happens, so pin the sets equal.
    // Every root-level markdown file is scanned, not a named few, so a
    // marker added to a new root page cannot escape the tripwire. The scan
    // covers markdown only: an extra-files entry outside it (action.yml, a
    // workflow) fails this equality and means the scan set needs widening.
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
      packages: Record<string, { "extra-files": string[] }>;
    };
    const extraFiles = config.packages["."]?.["extra-files"] ?? [];
    const rootPages = readdirSync(ROOT)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({ label: name, path: join(ROOT, name) }));
    const marked = rootPages
      .concat(guidePages().map((page) => ({ label: `docs/${page}`, path: join(DOCS, page) })))
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

  test("the examples cookbook shows every section at least once", () => {
    // Two landings established the convention that a new section adds its
    // cookbook block; this derives it from SECTION_KEYS so the next section
    // cannot skip the cookbook silently. Nested environment lists ride the
    // same pin (they live inside the environments block).
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

  test("the guides carry settings examples at all", () => {
    const total = guidePages()
      .map((page) => fencedBlocks(readFileSync(join(DOCS, page), "utf8"), "yaml settings").length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
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
    const stale: string[] = [];
    for (const page of guidePages()) {
      const markdown = readFileSync(join(DOCS, page), "utf8");
      for (const [index, line] of markdown.split("\n").entries()) {
        const m = line.match(/uses: Vivswan\/github-settings-as-code@(\S+)/);
        if (!m) {
          continue;
        }
        references++;
        if (m[1] !== major) {
          stale.push(`docs/${page}:${index + 1} pins @${m[1]}: ${line.trim()}`);
        }
      }
      // release-please's generic updater rewrites the FIRST digit run on an
      // annotated line (MAJOR_VERSION_REGEX with String.replace). Every
      // annotated line must therefore keep its major-version digit first,
      // reached as an @v pin or a /v path segment (the schema hint URLs), or
      // a v2 release PR silently rewrites the wrong number.
      for (const [index, line] of markdown.split("\n").entries()) {
        if (line.includes("x-release-please-major")) {
          expect(
            /^[^\d]*[@/`]v\d+(?!\w)/.test(line),
            `docs/${page}:${index + 1} carries x-release-please-major but a digit precedes the version token (an @v pin, /v segment, or backtick-v prose); release-please would rewrite that digit instead`,
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
          /^[^\d]*[@/`]v\d+(?!\w)/.test(line),
          `README.md:${index + 1} carries x-release-please-major but a digit precedes the version token (an @v pin, /v segment, or backtick-v prose); release-please would rewrite that digit instead`,
        ).toBe(true);
      }
    }
    // The guides carry workflow snippets, so zero matches means the pattern
    // rotted, not that the docs went snippet-free.
    expect(references).toBeGreaterThan(0);
    expect(
      stale,
      `${stale.length} guide snippet(s) do not reference the moving major tag @${major}:\n` +
        `  ${stale.join("\n  ")}\n` +
        `Fix each line by appending " # x-release-please-major" and listing the file under\n` +
        `extra-files in release-please-config.json, so release PRs rewrite the tag; then\n` +
        `set the tag to the current major.`,
    ).toEqual([]);
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

/**
 * README contract tests: pin the Sections table, the schema link, the example
 * settings.yml blocks, the migration paragraph, and the version pins to their
 * single sources, so a prose claim cannot drift from what the code does.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_PRIVATE_REPOS,
  PRIVATE_REPORT_CHANNELS,
  REDACTED_DETAIL,
} from "../../src/action/redact.js";
import { REPO_RESULTS, validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { ARTIFACT_FILE, ARTIFACT_NAME } from "../../src/report/artifact-report.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import { type PatResource, sectionOperations } from "../../src/sections/contract.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { SPECIAL_KEYS } from "../../src/sections/repository.js";
import { CLAIM_FAMILY, CLAIM_STEMS, defaultClaimProblems, stemNegation } from "./claims.js";
import { fencedBlocks, sectionLines, tableRows } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** The Undeclared default column's display form of each undeclaredDefault. */
const UNDECLARED_DEFAULT_DISPLAY: Record<string, string> = {
  delete: "deleted (settable)",
  keep: "kept (settable)",
  untouched: "untouched",
};

describe("README Sections table", () => {
  const rows = tableRows(sectionLines(readme, "Sections", "README.md"));

  test("one row per section, in SECTION_KEYS order", () => {
    const names = rows.map((cells) => (cells[0] ?? "").replace(/`/g, ""));
    expect(names).toEqual([...SECTION_KEYS]);
  });

  test("each row's Undeclared default column derives from the section's undeclaredDefault", () => {
    const byKey = new Map(SECTIONS.map((section) => [section.key, section]));
    for (const cells of rows) {
      const key = (cells[0] ?? "").replace(/`/g, "");
      // Section | Endpoints | PAT permission | Undeclared default | Notes
      const cell = cells[3] ?? "";
      const section = byKey.get(key as (typeof SECTION_KEYS)[number]);
      if (!section) {
        throw new Error(`README Sections row "${key}" is not a section key`);
      }
      expect(
        cell,
        `README Sections row "${key}" must state "${UNDECLARED_DEFAULT_DISPLAY[section.undeclaredDefault]}" in its Undeclared default column (its undeclaredDefault is "${section.undeclaredDefault}")`,
      ).toBe(UNDECLARED_DEFAULT_DISPLAY[section.undeclaredDefault] as string);
    }
  });

  test("a knobbed row's Notes cell never claims the opposite of its undeclaredDefault", () => {
    // The Notes column restates the default in passing ("the
    // delete-by-default is Probot parity", "keep is the default"). Wherever a
    // Notes cell makes such a claim - a claim-family word joined to "default"
    // by "by" or "is/are/stays/remains the" - the effective family (negation
    // resolved by the shared stemNegation rule from ./claims.ts, so "No
    // labels are deleted by default" reads as keep) must be the section's
    // own; prose that merely mentions deletion elsewhere (opt-ins, upstream
    // behavior) carries no such joint and stays free. A cell that TALKS
    // about the section default ("by default", "the default") without a
    // parseable claim fails loudly, so a reworded claim cannot silently drop
    // out of the sweep - phrases about OTHER defaults ("the org default")
    // carry neither trigger.
    const claimRe = new RegExp(
      String.raw`\b(${CLAIM_STEMS})\b(?:[\s-]by[\s-]|\s+(?:is|are|stays?|remains?)\s+the\s+)default`,
      "gi",
    );
    const trigger = /by[\s-]default|\bthe default\b/i;
    const byKey = new Map(SECTIONS.map((section) => [section.key, section]));
    for (const cells of rows) {
      const key = (cells[0] ?? "").replace(/`/g, "");
      const section = byKey.get(key as (typeof SECTION_KEYS)[number]);
      if (!section || section.undeclaredDefault === "untouched") {
        continue;
      }
      const cell = cells[4] ?? "";
      const claims = [...cell.matchAll(claimRe)];
      if (trigger.test(cell)) {
        // Per-row tripwire: THIS row mentions its default, so at least one
        // claim must parse here - a global counter would let one row's
        // unrecognized grammar hide behind another row's claims.
        expect(
          claims.length,
          `README Sections row "${key}" mentions a default in its Notes cell but no claim parses; reword the cell or extend the claim grammar`,
        ).toBeGreaterThan(0);
      }
      for (const claim of claims) {
        const family = CLAIM_FAMILY.delete.test(claim[1] ?? "") ? "delete" : "keep";
        const negation = stemNegation(cell.slice(0, claim.index));
        if ("doubleNegation" in negation) {
          throw new Error(
            `README Sections row "${key}": a double negation governs "${negation.doubleNegation} ${claim[1]}" in its Notes cell; reword it - double negatives are not resolved`,
          );
        }
        const flipped = family === "delete" ? "keep" : "delete";
        const effective = negation.negated ? flipped : family;
        expect(
          effective,
          `README Sections row "${key}" claims "${claim[0]}"${negation.negated ? " (negated)" : ""} in its Notes cell, contradicting its "${section.undeclaredDefault}" undeclaredDefault`,
        ).toBe(section.undeclaredDefault);
      }
    }
  });
});

describe("README Outputs paragraph", () => {
  test("the result value list names exactly the REPO_RESULTS members", () => {
    // Same pin the action-yml contract test applies to the output
    // description: REPO_RESULTS (src/engine/orchestrate.ts) is the canonical
    // value list. Here the parenthesized enumeration after "Outputs:
    // `result`" must carry each value backticked, and nothing else backticked
    // may sit inside it, so a new value cannot skip the README and a dropped
    // one cannot linger.
    const parenthesized = readme.match(/Outputs: `result` \(([^)]*)\)/)?.[1];
    expect(
      parenthesized,
      'README must enumerate the result values in "Outputs: `result` (...)"',
    ).toBeDefined();
    const listed = [...(parenthesized ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    expect(listed.sort()).toEqual([...REPO_RESULTS].sort());
  });
});

describe("README example settings.yml blocks", () => {
  const silentIo: Io = { annotate: () => {}, log: () => {}, mask: () => {} };

  test("every settings.yml example validates and its repository keys are known", () => {
    // The example block parses to a settings document (other yaml blocks are
    // workflow yaml). Validate any block whose top level is a mapping of known
    // section keys, then confirm repository special-looking keys are real.
    const known = new Set<string>(SECTION_KEYS);
    let validated = 0;
    for (const block of fencedBlocks(readme, "yaml")) {
      let doc: unknown;
      try {
        doc = parseYaml(block);
      } catch {
        continue;
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        continue;
      }
      const keys = Object.keys(doc);
      if (keys.length === 0 || !keys.some((k) => known.has(k))) {
        continue; // not a settings document
      }
      const invalid = validateSettingsDoc(doc, "README example", new Set(), silentIo);
      expect(invalid, `README settings.yml example failed validation: ${invalid}`).toBeNull();
      const repository = (doc as Record<string, unknown>).repository;
      if (repository && typeof repository === "object") {
        for (const key of Object.keys(repository)) {
          if (key.startsWith("enable_") || key === "topics") {
            expect(
              SPECIAL_KEYS.has(key),
              `README example uses repository.${key}, which looks like a special key but is not in SPECIAL_KEYS`,
            ).toBe(true);
          }
        }
      }
      validated++;
    }
    expect(validated, "no settings.yml example block was found in the README").toBeGreaterThan(0);
  });
});

describe("README version pins", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
  ) as Record<string, string>;
  // Before the first release no tag exists, so no pin can be right yet and
  // there is nothing to enforce.
  const version = manifest["."] ?? "";

  test("every uses: pin names the current release's moving major tag", () => {
    if (version === "0.0.0") {
      return;
    }
    // The uses: pins carry the inline x-release-please-major annotation, so
    // every release PR that bumps the major rewrites them together with the
    // manifest; this test is the tripwire for the annotations rotting away.
    const major = `v${version.split(".")[0]}`;
    const pins = [...readme.matchAll(/uses: Vivswan\/github-settings-as-code@(\S+)/g)].map(
      (m) => m[1],
    );
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin, `README pins @${pin}, but the current major tag is ${major}`).toBe(major);
    }
  });

  test("the exact-pin advice names the build/ tag namespace, not a plain version tag", () => {
    // The runnable ref is the release pipeline's build/vX.Y.Z tag
    // (.github/workflows/release.yml); plain vX.Y.Z tags point at
    // source-only commits. A README that offers a bare version tag as the
    // exact pin would send consumers to a ref that does not run, so the
    // namespace must be named and no `@vX.Y.Z` pin may reappear.
    expect(
      readme.includes("`@build/vX.Y.Z`"),
      "README's exact-pin advice must name the `@build/vX.Y.Z` tag namespace",
    ).toBe(true);
    const versionPins = [...readme.matchAll(/@v\d+\.\d+\.\d+/g)].map((m) => m[0]);
    expect(
      versionPins,
      `README offers plain version pin(s) ${versionPins.join(", ")}; those tags are source-only, pin @build/vX.Y.Z instead`,
    ).toEqual([]);
  });
});

describe("schema $schema hints and $id", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8"));
  const id = schema.$id as string;

  /** Every markdown page that may carry a yaml-language-server hint. */
  const hintPages = (): Array<{ label: string; path: string }> => [
    { label: "README.md", path: join(ROOT, "README.md") },
    ...readdirSync(join(ROOT, "docs"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ label: `docs/${name}`, path: join(ROOT, "docs", name) })),
  ];

  test("every yaml-language-server line in the README and the guides names the schema $id", () => {
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    // Per-file counts, pinned: a global total would let one of the README's
    // two hints disappear while the guides' hint keeps the sum positive.
    // Adding a hint to a new page is a conscious edit here.
    const EXPECTED_HINTS: Record<string, number> = {
      "README.md": 2, // the Usage step and the example block
      "docs/start/getting-started.md": 1,
    };
    for (const page of hintPages()) {
      const markdown = readFileSync(page.path, "utf8");
      const hints = [...markdown.matchAll(/yaml-language-server: \$schema=(\S+)/g)];
      expect(
        hints.length,
        `${page.label} carries ${hints.length} $schema hint(s), expected ${EXPECTED_HINTS[page.label] ?? 0}; update EXPECTED_HINTS if the move is deliberate`,
      ).toBe(EXPECTED_HINTS[page.label] ?? 0);
      for (const match of hints) {
        expect(match[1], `${page.label} carries a $schema hint that is not the schema's $id`).toBe(
          id,
        );
      }
    }
  });

  test("the $id points at this repository's raw major-tag copy of the build output", () => {
    // The $id is stamped by finalize-schema.ts with the current release
    // line's moving major tag - the ref the release pipeline points at
    // every release's build commit, so the URL always serves the line's
    // newest schema...
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
    };
    const buildSchema = pkg.scripts["build:schema"] ?? "";
    const outFlag = buildSchema.match(/--out (\S+)/)?.[1];
    expect(outFlag, "package.json build:schema lost its --out flag").toBeDefined();
    // ...and the URL's parts must each match their own single source:
    // https://raw.githubusercontent.com/<owner>/<repo>/<major tag>/<path>.
    const url = new URL(id);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("raw.githubusercontent.com");
    const [owner, repo, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    // <path> is the build output, exactly where --out writes it.
    expect(rest.join("/")).toBe(outFlag as string);
    // <repo> matching the package name is a convention witness, not an
    // authority - nothing forces a repository to be named after its package,
    // but this one is, and the equality catches a rename on either side.
    expect(repo).toBe(pkg.name);
    // <owner>/<repo> is the slug the README's own workflow snippet installs
    // (that pin is itself anchored by the "README version pins" test). An
    // includes() cannot prove EVERY install line agrees - third-party
    // actions share the uses: syntax - but a $id naming a slug no snippet
    // installs fails here.
    expect(
      readme.includes(`uses: ${owner}/${repo}@`),
      `the README never installs "uses: ${owner}/${repo}@...", so the $id's slug matches no workflow snippet`,
    ).toBe(true);
    // <major tag> is the current release line's, from the same manifest the
    // version-pin tests read.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    expect(ref).toBe(`v${(manifest["."] ?? "").split(".")[0]}`);
  });
});

describe("README migration paragraph", () => {
  test("lists exactly the Probot-parity sections", () => {
    const paragraph = sectionLines(
      readme,
      "Migrating from the Probot Settings app",
      "README.md",
    ).join(" ");
    // Isolate the parity clause precisely so later mentions (e.g. "move to
    // `rulesets`") cannot leak in and a filename dot cannot truncate it: the
    // clause runs from "works as-is for" up to its "(for the list sections
    // among them, the plain-array form remains Probot-compatible" marker -
    // the array-form claim is scoped to the list sections, since the
    // object-shaped sections have no array form and the wrapped `undeclared`
    // form is this action's own addition.
    const clause = paragraph.match(
      /works as-is for\s+(.*?)\(for the list sections among them, the plain-array form remains Probot-compatible/s,
    );
    expect(
      clause,
      'README migration paragraph must name the parity sections in a "works as-is for ... (for the list sections among them, the plain-array form remains Probot-compatible" clause',
    ).not.toBeNull();
    const listed = new Set(
      [...(clause?.[1] ?? "").matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1] as string)
        .filter((key) => (SECTION_KEYS as readonly string[]).includes(key)),
    );
    const parity = new Set<string>(PROBOT_PARITY_KEYS);
    // Exact set-equality, both directions: no parity section omitted, and no
    // non-parity section claimed.
    const missing = [...parity].filter((key) => !listed.has(key));
    const extra = [...listed].filter((key) => !parity.has(key));
    expect(
      missing,
      `README migration parity clause omits Probot-parity section(s): ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      extra,
      `README migration parity clause claims parity for non-parity section(s): ${extra.join(", ")}`,
    ).toEqual([]);
  });
});

describe("private repositories guide", () => {
  // The guide is a standalone page whose title is a single `#`, so it is
  // read whole-document rather than via sectionLines() - the stronger pin
  // anyway, since each claim must live somewhere on the page.
  const section = readFileSync(join(ROOT, "docs", "operate", "private-repositories.md"), "utf8");

  test("names every private-report channel the code accepts", () => {
    // A channel added to PRIVATE_REPORT_CHANNELS but never documented (or a
    // documented channel the code dropped) fails here.
    for (const channel of PRIVATE_REPORT_CHANNELS) {
      expect(
        section.includes(`\`private-report: ${channel}\``) || channel === "none",
        `the private repositories guide does not document the "${channel}" channel`,
      ).toBe(true);
    }
    // `none` is the default (it delivers nothing), so it is named as the input
    // default rather than as a delivering channel; assert it appears at all.
    expect(section.includes("none")).toBe(true);
  });

  test("states the default redaction policy and the placeholder/detail constants", () => {
    expect(section).toContain(`\`private-repos: ${DEFAULT_PRIVATE_REPOS}\` (the default)`);
    expect(section).toContain("private repository #N");
    expect(section).toContain(REDACTED_DETAIL);
  });

  test("pins the artifact names and the age keygen/decrypt commands", () => {
    expect(section).toContain(ARTIFACT_NAME);
    expect(section).toContain(ARTIFACT_FILE);
    expect(section).toContain("age-keygen -o key.txt");
    expect(section).toContain(`age -d -i key.txt ${ARTIFACT_FILE}`);
  });

  test("documents the issue-channel PAT grant", () => {
    // The issue channel needs Issues read+write on every target; the grant
    // prose mirrors grantFor(ISSUE_REPORT_PERMISSION).
    expect(section).toContain('`"Issues"` (read and write)');
  });

  test("states the delivery accuracy caveats the review pinned", () => {
    // Delivery is gated on PROVEN private/internal, not merely redacted.
    expect(section.toLowerCase()).toContain("private or internal");
    // The artifact channel does not work on GitHub Enterprise Server.
    expect(section).toContain("GitHub Enterprise Server");
    // A downloaded artifact is a ZIP; the docs give an extraction path.
    expect(section).toContain("gh run download");
  });

  test("the overall-result enumeration names exactly the REPO_RESULTS members", () => {
    // The safe-skeleton paragraph enumerates every result value a redacted
    // target can show; pin the parenthesized list to REPO_RESULTS the same
    // way the action-yml contract test pins the output description.
    const parenthesized = section.replace(/\n/g, " ").match(/the overall result \(([^)]*)\)/)?.[1];
    expect(
      parenthesized,
      'the guide must enumerate the result values in "the overall result (...)"',
    ).toBeDefined();
    const listed = [...(parenthesized ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    expect(listed.sort()).toEqual([...REPO_RESULTS].sort());
  });
});

describe("schema.ts SettingsFile JSDoc deletion claims", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");

  test("the JSDoc for delete/keep sections claims its own policy and never the opposite", () => {
    // Each knobbed JSDoc states its default in a "... by default" clause and
    // may mention the opposite word elsewhere (the `undeclared:` opt-in it
    // documents). The claim windows, families, and negator handling live in
    // ./claims.ts, shared with the COVERAGE sweep.
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue; // "untouched" sections make no per-key deletion claim
      }
      const propRe = new RegExp(`/\\*\\*([^*]|\\*(?!/))*\\*/\\s*\\n\\s*${section.key}\\?:`, "m");
      const match = schemaSrc.match(propRe);
      expect(match, `no JSDoc found above SettingsFile.${section.key}`).not.toBeNull();
      // Flatten the comment decoration so a claim wrapped across lines still
      // sits in one window.
      const flat = (match?.[0] ?? "").replace(/\s*\n\s*\*\s*/g, " ");
      for (const problem of defaultClaimProblems(flat, section.undeclaredDefault)) {
        throw new Error(`SettingsFile.${section.key} JSDoc: ${problem}`);
      }
    }
  });
});

describe("schema.ts file-header additions claim", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");
  // The header block, with URLs removed so a section-key word inside a link
  // (e.g. "repository" in the repository-settings/app URL) cannot match.
  const header = schemaSrc.slice(0, schemaSrc.indexOf("*/")).replace(/https?:\/\/\S+/g, "");

  test("the header defers to PROBOT_PARITY_KEYS", () => {
    // The header must define the additions by exclusion over
    // PROBOT_PARITY_KEYS; the pointer to the constant IS the derivation.
    expect(
      header.includes("PROBOT_PARITY_KEYS"),
      "the schema.ts file header must define the additions via PROBOT_PARITY_KEYS",
    ).toBe(true);
  });

  test("the header names no addition section", () => {
    // An enumeration of the non-parity sections is the copy that drifts, so
    // no section key outside PROBOT_PARITY_KEYS may appear in the header.
    const parity = new Set<string>(PROBOT_PARITY_KEYS);
    for (const key of SECTION_KEYS) {
      if (parity.has(key)) {
        continue;
      }
      expect(
        new RegExp(`\\b${key}\\b`).test(header),
        `the schema.ts file header names the addition section "${key}"; defer to PROBOT_PARITY_KEYS instead of enumerating`,
      ).toBe(false);
    }
  });
});

describe("contract.ts README-heading references", () => {
  const contractSrc = readFileSync(join(ROOT, "src", "sections", "contract.ts"), "utf8");
  // Headings count only outside fenced code blocks: the README carries a
  // "# yaml-language-server:" line inside a yaml fence that is not a heading.
  const readmeProse = readme.replace(/```[\s\S]*?```/g, "");

  test('every README "..." name quoted in the JSDoc is a real README heading', () => {
    // Every quoted name following a README mention must exist as a markdown
    // heading, so a heading rename (or a JSDoc typo) fails here. All quoted
    // names on the mention's line count, not just the first.
    const named: string[] = [];
    for (const line of contractSrc.split("\n")) {
      const mention = line.search(/README'?s?\b/);
      if (mention === -1) {
        continue;
      }
      named.push(...[...line.slice(mention).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
    }
    // Zero extracted names while contract.ts still mentions the README means
    // the extraction went blind (e.g. a rewrap split a mention from its
    // quotes); fail loudly rather than pass on an empty list.
    expect(
      named.length,
      "contract.ts mentions the README but no quoted heading name was extracted; fix the JSDoc line wrap or this extraction",
    ).toBeGreaterThan(0);
    for (const name of named) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        new RegExp(`^#{1,6} ${escaped}\\s*$`, "m").test(readmeProse),
        `contract.ts JSDoc names the README's "${name}", but README.md has no such heading`,
      ).toBe(true);
    }
  });
});

// The written-out counts the prose uses; extend deliberately when a derived
// list outgrows it (the lookup failing IS the tripwire).
const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
] as const;

describe("forward-compatibility closed-sections claim", () => {
  test("the guide's prose names exactly the closedSurface sections", () => {
    // closedSurface is the module-level source of which sections reject
    // unrecognized keys; the forward-compatibility page must list those and
    // no others, the same way undeclaredDefault pins the Sections table.
    // The page's title is a single `#`, so it is read whole-document.
    const closed = SECTIONS.filter((section) => section.closedSurface !== undefined).map(
      (section) => section.key,
    );
    expect(closed.length).toBeGreaterThan(0);
    const paragraph = readFileSync(
      join(ROOT, "docs", "reference", "forward-compatibility.md"),
      "utf8",
    ).replace(/\n/g, " ");
    const sentence = paragraph.match(/[^.]*closed rather than passthrough[^.]*\./)?.[0];
    expect(
      sentence,
      'docs/reference/forward-compatibility.md has no sentence containing "closed rather than passthrough"; restore the phrase or update this extraction',
    ).toBeDefined();
    // The sentence opens with the count in words; pin it to the derived list
    // so the next closed section cannot leave the number stale.
    const word = COUNT_WORDS[closed.length];
    if (word === undefined) {
      throw new Error("extend COUNT_WORDS: more closed sections than the lookup covers");
    }
    const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
    expect(sentence).toContain(`${capitalized} sections are closed`);
    for (const key of closed) {
      expect(sentence).toContain(`\`${key}\``);
    }
    for (const key of SECTION_KEYS) {
      if (!closed.includes(key)) {
        expect(sentence).not.toContain(`\`${key}\``);
      }
    }
  });
});

describe("pre-filled PAT form URL", () => {
  /**
   * The form URL in Usage step 1 is hand-edited and nothing else checks it,
   * so a new PatResource could land with its query parameter forgotten and
   * every test would stay green. The slug map is total over PatResource
   * (satisfies enforces it), so adding a resource forces a choice here:
   * name the form parameter, or record a null exemption with its reason.
   * The parameter names follow the App-permissions schema where they differ
   * from ours (webhooks -> repository_hooks, custom_properties ->
   * repository_custom_properties, variables -> actions_variables); every
   * non-null slug below was verified against the live token form on
   * 2026-07-28 (each pre-selects its permission; the form drops unknown
   * parameters silently, which is how the old variables= spelling failed).
   */
  const RESOURCE_SLUGS = {
    administration: "administration",
    issues: "issues",
    environments: "environments",
    actions: "actions",
    pages: "pages",
    // Rides the repo PATCH's security_and_analysis passthrough for setup;
    // the alerts grant has no verified form parameter today.
    code_scanning_alerts: null,
    contents: "contents",
    variables: "actions_variables",
    webhooks: "repository_hooks",
    secrets: "secrets",
    dependabot_secrets: "dependabot_secrets",
    codespaces_secrets: "codespaces_secrets",
    custom_properties: "repository_custom_properties",
    secret_scanning_alerts: "secret_scanning_alerts",
    // The Copilot agents stores. Verified 2026-08-10 against GitHub's
    // machine-readable fine-grained-PAT permission data (github/docs,
    // src/github-apps/data/fpt-2022-11-28/fine-grained-pat-permissions.json),
    // which keys the repository permissions for the /agents/secrets and
    // /agents/variables endpoints as "agent_secrets"/"agent_variables" - the
    // same vocabulary file that carries every form-verified slug above,
    // including the three that differ from our resource names.
    agent_secrets: "agent_secrets",
    agent_variables: "agent_variables",
    checks: "checks",
  } satisfies Record<PatResource, string | null>;

  test("every PAT resource's form parameter appears in the URL", () => {
    const url = readme.match(/personal-access-tokens\/new\?[^)\s]+/)?.[0] ?? "";
    expect(url.length).toBeGreaterThan(0);
    for (const [resource, slug] of Object.entries(RESOURCE_SLUGS)) {
      if (slug !== null) {
        // Boundary-anchored: "secrets=" is a substring of
        // "dependabot_secrets=", so a bare includes() cannot miss it.
        expect(
          new RegExp(`[?&]${slug}=`).test(url),
          `the pre-filled PAT form URL lacks "${slug}=" (the ${resource} resource)`,
        ).toBe(true);
      }
    }
  });

  /**
   * Resources a section consumes whose form parameter is knowingly absent.
   * The one source the tripwire below exempts from, asserted null in
   * RESOURCE_SLUGS so the two cannot disagree; the WHY lives on the map
   * entry itself.
   */
  const CONSUMED_WITHOUT_FORM_PARAMETER: ReadonlySet<PatResource> = new Set([
    "code_scanning_alerts",
  ]);

  test("every resource a section permission consumes has a non-null slug", () => {
    // A null exemption is only for resources NO section needs yet: once an
    // operation's effective permission names the resource, real tokens need
    // the grant and the form URL must pre-select it. sectionOperations is
    // the flattened REST + GraphQL view with overrides resolved exactly the
    // way the engine resolves them (endpointPermission), so neither a
    // per-endpoint override nor a GraphQL operation's permission can slip
    // past the sweep.
    const consumed = new Set<PatResource>();
    for (const section of SECTIONS) {
      for (const operation of sectionOperations(section)) {
        if (operation.permission === "none") {
          continue;
        }
        for (const resource of operation.permission.repo) {
          consumed.add(resource);
        }
      }
    }
    for (const resource of consumed) {
      if (CONSUMED_WITHOUT_FORM_PARAMETER.has(resource)) {
        expect(
          RESOURCE_SLUGS[resource],
          `"${resource}" is exempted by CONSUMED_WITHOUT_FORM_PARAMETER, so its RESOURCE_SLUGS entry must stay null`,
        ).toBeNull();
        continue;
      }
      expect(
        RESOURCE_SLUGS[resource],
        `the "${resource}" resource is consumed by a section but RESOURCE_SLUGS exempts it; verify its form parameter and name it`,
      ).not.toBeNull();
    }
  });
});

describe("knobbed-section count prose", () => {
  const countWord = COUNT_WORDS[UNDECLARED_POLICY_SECTIONS.length];
  if (countWord === undefined) {
    throw new Error("extend COUNT_WORDS: more knobbed sections than the lookup covers");
  }
  const capitalized = countWord[0]?.toUpperCase() + countWord.slice(1);
  const policyDoc = readFileSync(join(ROOT, "docs", "reference", "undeclared-policy.md"), "utf8");

  test("the undeclared-policy guide's intro counts and names every knobbed section", () => {
    const intro = policyDoc.slice(0, policyDoc.indexOf("\n## "));
    expect(
      intro.includes(`${capitalized} sections list`),
      `the guide's intro must say "${capitalized} sections list"`,
    ).toBe(true);
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      expect(intro.includes(`\`${key}\``), `the guide's intro omits \`${key}\``).toBe(true);
    }
    // The layering boundary paragraph restates the count in words.
    expect(
      policyDoc.includes(`The ${countWord} top-level section lists`),
      `the layering boundary must say "The ${countWord} top-level section lists"`,
    ).toBe(true);
  });

  test("the guide's intro names ONLY knobbed sections", () => {
    // The inclusion loop above cannot catch prose still naming a section
    // that LOST its knob; scope the negative check to the intro so the
    // rest of the page stays free to mention any section.
    const intro = policyDoc.slice(0, policyDoc.indexOf("\n## "));
    const knobbed = new Set<string>(UNDECLARED_POLICY_SECTIONS);
    for (const key of SECTION_KEYS) {
      if (!knobbed.has(key)) {
        expect(
          intro.includes(`\`${key}\``),
          `the intro names \`${key}\`, which carries no undeclared knob`,
        ).toBe(false);
      }
    }
  });

  test("the guide's Defaults table has exactly one row per knobbed section, stating its default", () => {
    const rows = tableRows(
      sectionLines(policyDoc, "Defaults per section", "docs/reference/undeclared-policy.md"),
    );
    const byKey = new Map(
      rows.map((cells) => [(cells[0] ?? "").replace(/`/g, ""), cells[1] ?? ""]),
    );
    // Size equality first: the Map would silently collapse a duplicated row,
    // and "exactly one row per section" is the claim under test.
    expect(byKey.size).toBe(rows.length);
    expect([...byKey.keys()].sort()).toEqual([...UNDECLARED_POLICY_SECTIONS].sort());
    const defaults = new Map(SECTIONS.map((section) => [section.key, section.undeclaredDefault]));
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      const cell = byKey.get(key) ?? "";
      expect(
        cell.startsWith(defaults.get(key) ?? ""),
        `the Defaults row for \`${key}\` must state its "${defaults.get(key)}" default, got: ${cell}`,
      ).toBe(true);
    }
  });
});

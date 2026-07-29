/**
 * README contract tests: pin the Sections table, the schema link, the example
 * settings.yml blocks, the migration paragraph, and the version pins to their
 * single sources, so a prose claim cannot drift from what the code does.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_PRIVATE_REPOS,
  PRIVATE_REPORT_CHANNELS,
  REDACTED_DETAIL,
} from "../../src/action/redact.js";
import { validateSettingsDoc } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import { ARTIFACT_FILE, ARTIFACT_NAME } from "../../src/report/artifact-report.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS, UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import type { PatResource } from "../../src/sections/contract.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { SPECIAL_KEYS } from "../../src/sections/repository.js";
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
  const rows = tableRows(sectionLines(readme, "Sections"));

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
  test("every uses: pin names the current release version", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, string>;
    // The uses: pins sit inside x-release-please-start-version blocks, so
    // every release PR rewrites them together with the manifest; this test is
    // the tripwire for the markers rotting away. Before the first release no
    // tag exists, so no pin can be right yet and there is nothing to enforce.
    const version = manifest["."] ?? "";
    if (version === "0.0.0") {
      return;
    }
    const pins = [...readme.matchAll(/uses: Vivswan\/repo-settings-as-code@(\S+)/g)].map(
      (m) => m[1],
    );
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin, `README pins @${pin}, but the current release is v${version}`).toBe(
        `v${version}`,
      );
    }
  });
});

describe("README schema link", () => {
  test("the $schema line points at lib/settings.schema.json's $id", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "lib", "settings.schema.json"), "utf8"));
    const id = schema.$id as string;
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    expect(
      readme.includes(`$schema=${id}`),
      `README's yaml-language-server line must reference the schema $id ${id}`,
    ).toBe(true);
  });
});

describe("README migration paragraph", () => {
  test("lists exactly the Probot-parity sections", () => {
    const paragraph = sectionLines(readme, "Migrating from the Probot Settings app").join(" ");
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
});

describe("schema.ts SettingsFile JSDoc deletion claims", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");
  const CLAIM_WORD: Record<string, RegExp> = {
    delete: /delete|remove/i,
    keep: /kept|keep/i,
  };

  test("the JSDoc for delete/keep sections matches undeclaredDefault", () => {
    for (const section of SECTIONS) {
      const pattern = CLAIM_WORD[section.undeclaredDefault];
      if (!pattern) {
        continue; // "untouched" sections make no per-key deletion claim
      }
      const propRe = new RegExp(`/\\*\\*([^*]|\\*(?!/))*\\*/\\s*\\n\\s*${section.key}\\?:`, "m");
      const match = schemaSrc.match(propRe);
      expect(match, `no JSDoc found above SettingsFile.${section.key}`).not.toBeNull();
      expect(
        pattern.test(match?.[0] ?? ""),
        `SettingsFile.${section.key} JSDoc must state a "${section.undeclaredDefault}" policy (matching ${pattern})`,
      ).toBe(true);
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
    expect(sentence).toBeDefined();
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
    const rows = tableRows(sectionLines(policyDoc, "Defaults per section"));
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

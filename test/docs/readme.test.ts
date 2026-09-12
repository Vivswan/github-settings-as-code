import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { countWord } from "../../.github/scripts/lib/count-word.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";
import { DEFAULT_PRIVATE_REPOS } from "../../src/flows/inputs.js";
import { REDACTED_DETAIL } from "../../src/flows/redact.js";
import { ARTIFACT_FILE, ARTIFACT_NAME } from "../../src/report/artifact-report.js";
import { PRIVATE_REPORT_CHANNELS } from "../../src/report/delivery.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS } from "../../src/schema.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { defaultClaimProblems, deleteEnumerationProblems } from "./claims.js";
import { fencedBlocks, sectionLines } from "./markdown.js";
import { assertValidSettingsExample } from "./settings-examples.js";
import { stalePins } from "./version-pins.js";

const ROOT = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

function assertBacktickedEnumeration(
  text: string,
  leadRe: RegExp,
  expected: readonly string[],
  label: string,
): void {
  const parenthesized = text.match(leadRe)?.[1];
  expect(parenthesized, label).toBeDefined();
  const listed = [...(parenthesized ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  expect(listed.sort()).toEqual([...expected].sort());
}

describe("README front door", () => {
  // Each pin is a shape the reference content would break if it grew back into the README; the tables live on the reference pages.
  const prose = readme.replace(/```[\s\S]*?```/g, "");

  test("carries exactly the front-door headings, in order", () => {
    expect(prose.match(/^#{1,6} .*$/gm)).toEqual([
      "# GitHub Settings as Code",
      "## Quick start",
      "## Versioning",
      "## Library",
      "## Docs",
      "## Contributing",
    ]);
  });

  test("the token-form link is its only generated region", () => {
    // A reference-table marker reappearing here would regenerate silently.
    const regions = [...readme.matchAll(/<!-- BEGIN GENERATED: ([a-z-]+)/g)].map((m) => m[1]);
    expect(regions).toEqual(["readme-pat-url"]);
  });

  test("the quick-start workflow runs in check mode", () => {
    const workflow = fencedBlocks(readme, "yaml").find((block) => block.includes("uses:"));
    expect(workflow, "README lost its workflow example").toBeDefined();
    const doc = parseYaml(workflow ?? "") as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    const step = Object.values(doc.jobs)
      .flatMap((job) => job.steps)
      .find((candidate) => candidate.uses?.startsWith("Vivswan/github-settings-as-code@"));
    expect(step?.with?.mode).toBe("check");
  });

  test("the Docs table links every guide the front door promises, and each resolves", () => {
    const rows = sectionLines(readme, "Docs", "README.md")
      .map((line) => line.match(/^\| [^|]+ \| \[[^\]]+\]\(([^)]+)\) \|$/)?.[1])
      .filter((target): target is string => target !== undefined);
    expect(rows.sort()).toEqual(
      [
        "docs/start/getting-started.md",
        "docs/start/examples.md",
        "docs/start/migrating-from-probot.md",
        "docs/start/cli.md",
        "docs/reference/sections.md",
        "docs/reference/architecture.md",
        "docs/reference/library.md",
        "docs/reference/inputs.md",
        "docs/reference/semantics.md",
        "docs/reference/permissions.md",
        "docs/reference/undeclared-policy.md",
        "docs/reference/secrets-and-vaults.md",
        "docs/operate/check-mode.md",
        "docs/operate/multi-repo.md",
        "docs/operate/layering.md",
        "docs/operate/private-repositories.md",
        "docs/operate/troubleshooting.md",
        "docs/playbooks/README.md",
        "docs/upgrading/README.md",
      ].sort(),
    );
    for (const target of rows) {
      expect(existsSync(join(ROOT, target)), `README Docs table links ${target}`).toBe(true);
    }
  });

  test("stays a front door in size", () => {
    // The tripwire against the reference tables growing back.
    expect(readme.split("\n").length).toBeLessThanOrEqual(101);
  });
});

describe("README example settings.yml blocks", () => {
  test("every settings.yml example validates and its repository keys are known", () => {
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
      assertValidSettingsExample(doc, "README settings.yml example");
      validated++;
    }
    expect(validated, "no settings.yml example block was found in the README").toBeGreaterThan(0);
  });
});

describe("README version pins", () => {
  test("every uses: pin names the current release's moving major tag", () => {
    const pins = stalePins([{ label: "README.md", text: readme }]);
    if (pins === null) {
      return; // nothing released yet, no pin can be right
    }
    expect(pins.references).toBeGreaterThan(0);
    expect(
      pins.stale.map(
        (pin) => `README pins @${pin.ref}, but the current major tag is ${pins.major}`,
      ),
    ).toEqual([]);
  });

  test("the exact-pin advice names the version tag and the build/ namespace stays retired", () => {
    // Every vX.Y.Z tag points at a packaged commit, so the version tag itself is the exact pin.
    expect(
      readme.includes("`@vX.Y.Z`"),
      "README's exact-pin advice must name the `@vX.Y.Z` tag form",
    ).toBe(true);
    expect(
      readme.includes("build/"),
      "README references the retired build/ tag namespace; version tags are the packaged, runnable refs now",
    ).toBe(false);
    // Concrete version pins would rot on every release.
    const versionPins = [...readme.matchAll(/@v\d+\.\d+\.\d+/g)].map((m) => m[0]);
    expect(
      versionPins,
      `README pins concrete version tag(s) ${versionPins.join(", ")}; offer the moving major or the @vX.Y.Z placeholder instead`,
    ).toEqual([]);
  });
});

describe("delete-by-default enumeration", () => {
  // The quick-start warning drifted to three of five sections once already; the guides' enumerations are pinned in guides.test.ts.
  const deleteKeys = SECTIONS.filter((s) => s.undeclaredDefault === "delete").map((s) => s.key);

  test("the quick-start first-run warning names every delete-by-default section", () => {
    const step = readme.match(/\n3\. Add the workflow[\s\S]*?\n\n/)?.[0] ?? "";
    expect(step, "README lost its '3. Add the workflow' quick-start step").not.toBe("");
    expect(deleteEnumerationProblems(step, deleteKeys)).toEqual([]);
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

  test("every yaml-language-server line in the README and the guides names the schema at the moving major tag", () => {
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    // The $id is version-free (HEAD); the hints are what editors download, so they pin the moving major tag.
    const pins = stalePins([{ label: "README.md", text: readme }]);
    expect(pins, "no release yet, so no major tag for the hints to name").not.toBeNull();
    const idUrl = new URL(id);
    const [owner, repo, , ...rest] = idUrl.pathname.split("/").filter(Boolean);
    const expectedHint = `${idUrl.origin}/${owner}/${repo}/${pins?.major}/${rest.join("/")}`;
    // Per-file counts: a global total would let the README's hint disappear while the guides' keeps the sum positive.
    const EXPECTED_HINTS: Record<string, number> = {
      "README.md": 1, // the quick-start settings example
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
        expect(
          match[1],
          `${page.label} carries a $schema hint that is not the schema at ${pins?.major}`,
        ).toBe(expectedHint);
      }
    }
  });

  test("the $id points at this repository's raw HEAD copy of the build output", () => {
    // gen-settings-schema.ts stamps the $id as the raw copy at HEAD; each URL part is held to its own single source.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      repository: { url: string };
    };
    const url = new URL(id);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("raw.githubusercontent.com");
    const [owner, repo, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    const genScript = readFileSync(
      join(ROOT, ".github", "scripts", "gen-settings-schema.ts"),
      "utf8",
    );
    expect(
      genScript.includes(`join(ROOT, ${rest.map((part) => JSON.stringify(part)).join(", ")})`),
      `gen-settings-schema.ts does not write to ${rest.join("/")}, where the $id points`,
    ).toBe(true);
    // The package name is scoped and cannot serve as the slug, so the manifest's repository URL does; the equality catches a rename on either side.
    const manifestSlug = pkg.repository.url.match(
      /^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/,
    )?.[1];
    expect(`${owner}/${repo}`).toBe(manifestSlug ?? "");
    // includes() cannot prove EVERY install line agrees (third-party actions share the uses: syntax), but a $id naming a slug no snippet installs
    // fails here.
    expect(
      readme.includes(`uses: ${owner}/${repo}@`),
      `the README never installs "uses: ${owner}/${repo}@...", so the $id's slug matches no workflow snippet`,
    ).toBe(true);
    // HEAD is version-free, so a major bump never waits on a schema regeneration to go green.
    expect(ref).toBe("HEAD");
  });
});

describe("migration guide parity paragraph", () => {
  test("lists exactly the Probot-parity sections", () => {
    const paragraph = sectionLines(
      readFileSync(join(ROOT, "docs", "start", "migrating-from-probot.md"), "utf8"),
      "What carries over as-is",
      "docs/start/migrating-from-probot.md",
    ).join(" ");
    // The clause runs from "keeps working for" to its "their original Probot shapes remain compatible" marker, so later mentions of non-parity
    // sections cannot leak in.
    const clause = paragraph.match(
      /keeps working for\s+(.*?): their original Probot shapes remain compatible/s,
    );
    expect(
      clause,
      'the migration guide must name the parity sections in a "keeps working for ...: their original Probot shapes remain compatible" clause',
    ).not.toBeNull();
    const listed = new Set(
      [...(clause?.[1] ?? "").matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1] as string)
        .filter((key) => (SECTION_KEYS as readonly string[]).includes(key)),
    );
    const parity = new Set<string>(PROBOT_PARITY_KEYS);
    const missing = [...parity].filter((key) => !listed.has(key));
    const extra = [...listed].filter((key) => !parity.has(key));
    expect(
      missing,
      `the migration guide's parity clause omits Probot-parity section(s): ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      extra,
      `the migration guide's parity clause claims parity for non-parity section(s): ${extra.join(", ")}`,
    ).toEqual([]);
  });
});

describe("private repositories guide", () => {
  // The page's title is a single `#`, so it is read whole-document rather than via sectionLines().
  const section = readFileSync(join(ROOT, "docs", "operate", "private-repositories.md"), "utf8");

  test("names every private-report channel the code accepts", () => {
    for (const channel of PRIVATE_REPORT_CHANNELS) {
      expect(
        section.includes(`\`private-report: ${channel}\``) || channel === "none",
        `the private repositories guide does not document the "${channel}" channel`,
      ).toBe(true);
    }
    // `none` delivers nothing, so it is named as the input default; a bare "none" would match unrelated prose.
    expect(section).toContain("defaults to `private-report: none`, which delivers nothing");
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
    // The grant prose mirrors grantFor(ISSUE_REPORT_PERMISSION).
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
    assertBacktickedEnumeration(
      section.replace(/\n/g, " "),
      /the overall result \(([^)]*)\)/,
      REPO_RESULTS,
      'the guide must enumerate the result values in "the overall result (...)"',
    );
  });
});

describe("SettingsFile deletion claims", () => {
  test("the description of delete/keep sections claims its own policy and never the opposite", () => {
    // A knobbed section's description states its default in a "... by default" clause and may name the opposite word elsewhere (the `_undeclared:`
    // opt-in it documents).
    for (const section of SECTIONS) {
      if (section.undeclaredDefault === "untouched") {
        continue; // "untouched" sections make no per-key deletion claim
      }
      const description = DOCS[section.key].schema[`SettingsFile.${section.key}`];
      expect(
        description,
        `no SettingsFile.${section.key} description in its docs file`,
      ).toBeTruthy();
      for (const problem of defaultClaimProblems(description ?? "", section.undeclaredDefault)) {
        throw new Error(`SettingsFile.${section.key} description: ${problem}`);
      }
    }
  });
});

describe("schema.ts file-header additions claim", () => {
  const schemaSrc = readFileSync(join(ROOT, "src", "schema.ts"), "utf8");
  // URLs removed so a section-key word inside a link (e.g. "repository" in the repository-settings/app URL) cannot match.
  const header = schemaSrc.slice(0, schemaSrc.indexOf("*/")).replace(/https?:\/\/\S+/g, "");

  test("the header defers to PROBOT_PARITY_KEYS", () => {
    // The pointer to the constant IS the derivation; an enumeration would be the copy that drifts.
    expect(
      header.includes("PROBOT_PARITY_KEYS"),
      "the schema.ts file header must define the additions via PROBOT_PARITY_KEYS",
    ).toBe(true);
  });

  test("the header names no addition section", () => {
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

describe("forward-compatibility closed-sections claim", () => {
  test("the guide's prose names exactly the closedSurface sections", () => {
    // closedSurface is the single source of which sections reject unrecognized keys. The page's title is a single `#`, so it is read whole-document.
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
    const word = countWord(closed.length);
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

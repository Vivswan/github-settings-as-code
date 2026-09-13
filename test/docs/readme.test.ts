import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { countWord } from "../../.github/scripts/lib/count-word.js";
import { RUN_RESULTS } from "../../src/engine/outcome.js";
import { DEFAULT_PRIVATE_REPOS, INPUT_DECLS } from "../../src/flows/inputs.js";
import { REDACTED_DETAIL } from "../../src/flows/redact.js";
import { SNAPSHOT_SCHEMA_URL } from "../../src/flows/snapshot.js";
import { ARTIFACT_FILE, ARTIFACT_NAME } from "../../src/report/artifact-report.js";
import { PRIVATE_REPORT_CHANNELS } from "../../src/report/delivery.js";
import { ISSUE_REPORT_PERMISSION } from "../../src/report/issue-report.js";
import { PROBOT_PARITY_KEYS, SECTION_KEYS } from "../../src/schema.js";
import { grantFor } from "../../src/sections/contract/permissions.js";
import { DOCS } from "../../src/sections/docs-registry.js";
import { SECTIONS } from "../../src/sections/registry.js";
import { ROOT } from "../root.js";
import { defaultClaimProblems, deleteEnumerationProblems } from "./claims.js";
import { fencedBlocks, sectionLines } from "./markdown.js";
import { assertValidSettingsExample } from "./settings-examples.js";
import { stalePins } from "./version-pins.js";

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

describe("README quick-start mode", () => {
  test("the workflow step runs in the mode the prose beside it names", () => {
    // The input defaults to apply, so a dropped `mode:` line turns the copied first run into the apply the prose says it is not.
    const prose = sectionLines(readme, "Quick start", "README.md").join("\n");
    const named = prose.match(/Keep `mode: ([a-z]+)` for the first run/)?.[1];
    expect(
      named,
      'the quick start lost its "Keep `mode: ...` for the first run" line',
    ).toBeDefined();
    const workflow = fencedBlocks(readme, "yaml").find((block) => block.includes("uses:"));
    expect(workflow, "README lost its workflow example").toBeDefined();
    const doc = parseYaml(workflow ?? "") as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    const step = Object.values(doc.jobs)
      .flatMap((job) => job.steps)
      .find((candidate) => candidate.uses?.startsWith("Vivswan/github-settings-as-code@"));
    expect(step, "the workflow example has no github-settings-as-code step").toBeDefined();
    expect(step?.with?.mode ?? INPUT_DECLS.mode.default).toBe(named ?? "");
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

describe("schema $schema hints", () => {
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

  test("every yaml-language-server hint in the README and the guides names the schema at the moving major tag", () => {
    expect(id, "lib/settings.schema.json has no $id").toBeTruthy();
    // The $id is version-free (HEAD); the hints are what editors download, so they pin the moving major tag.
    const pins = stalePins([{ label: "README.md", text: readme }]);
    expect(pins, "no release yet, so no major tag for the hints to name").not.toBeNull();
    const idUrl = new URL(id);
    const [owner, repo, , ...rest] = idUrl.pathname.split("/").filter(Boolean);
    const expectedHint = `${idUrl.origin}/${owner}/${repo}/${pins?.major}/${rest.join("/")}`;
    // The hint every snapshot file starts with is the same URL: the file a
    // reader gets from mode: snapshot validates exactly as the quick start's does.
    expect(SNAPSHOT_SCHEMA_URL).toBe(expectedHint);
    // Every line naming the modeline is read; one the strict form cannot parse fails rather than slipping past the URL check.
    const hints: string[] = [];
    const problems: string[] = [];
    for (const page of hintPages()) {
      for (const line of readFileSync(page.path, "utf8").split("\n")) {
        if (!line.includes("yaml-language-server")) {
          continue;
        }
        // The language server reads the modeline only as a comment opening the line (indent aside, for the README's list nesting).
        const url = line.match(/^\s*# yaml-language-server: \$schema=(\S+)/)?.[1];
        if (url === undefined) {
          problems.push(`${page.label}: unreadable modeline "${line.trim()}"`);
        } else if (url !== expectedHint) {
          problems.push(`${page.label} carries ${url}, not the schema at ${pins?.major}`);
        } else {
          hints.push(page.label);
        }
      }
    }
    expect(problems).toEqual([]);
    // Zero matches means the pattern rotted, not that the pages went hint-free.
    expect(hints.length, "no page carries a $schema hint").toBeGreaterThan(0);
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
        section.includes(`\`private-report: ${channel}\``),
        `the private repositories guide does not document the "${channel}" channel`,
      ).toBe(true);
    }
  });

  test("names the redaction default, the redacted-detail placeholder, and the artifact from the code's constants", () => {
    expect(section).toContain(`\`private-repos: ${DEFAULT_PRIVATE_REPOS}\` (the default)`);
    expect(section).toContain(REDACTED_DETAIL);
    expect(section).toContain(ARTIFACT_NAME);
    expect(section).toContain(ARTIFACT_FILE);
  });

  test("the issue-channel PAT advice names the grant the issue report asks for", () => {
    // The same grantFor() call the failed delivery prints (src/report/issue-report.ts): its resource labels and access level.
    const grant = grantFor(ISSUE_REPORT_PERMISSION).match(
      /^grant ("[^"]+"(?: or "[^"]+")*) \(([a-z ]+)\)/,
    );
    expect(grant, "grantFor() no longer opens with the quoted labels and the level").not.toBeNull();
    expect(section).toContain(`the PAT needs \`${grant?.[1]}\` (${grant?.[2]})`);
  });

  test("the overall-result enumeration names exactly the per-target RUN_RESULTS words", () => {
    // A merge has no target, so `merged` never heads a per-target row; every other word can.
    assertBacktickedEnumeration(
      section.replace(/\n/g, " "),
      /the overall result \(([^)]*)\)/,
      RUN_RESULTS.filter((result) => result !== "merged"),
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

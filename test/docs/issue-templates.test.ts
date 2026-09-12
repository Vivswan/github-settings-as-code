/** This repository's issue forms name only labels its own .github/settings.yml roster declares; no claim is made about users' repositories. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const TEMPLATES = join(ROOT, ".github", "ISSUE_TEMPLATE");

interface LabelEntry {
  name: string;
  new_name?: string;
}
interface SettingsFile {
  labels?: LabelEntry[] | { entries?: LabelEntry[] };
}
interface IssueForm {
  labels?: string | string[];
}

/** The names the labels section leaves on the repository: a rename lands under `new_name`, and the wrapped `_undeclared` form nests the entries. */
function rosterNames(): Set<string> {
  const doc = parseYaml(
    readFileSync(join(ROOT, ".github", "settings.yml"), "utf8"),
  ) as SettingsFile;
  const entries = Array.isArray(doc.labels) ? doc.labels : (doc.labels?.entries ?? []);
  if (entries.length === 0) {
    throw new Error(".github/settings.yml declares no labels; the roster read is broken");
  }
  return new Set(entries.map((entry) => entry.new_name ?? entry.name));
}

// config.yml configures the template chooser and names no labels.
const forms = readdirSync(TEMPLATES)
  .filter((name) => /\.ya?ml$/.test(name) && name !== "config.yml")
  .sort();

describe("issue forms name only labels the settings.yml roster declares", () => {
  const roster = rosterNames();
  test.each(forms)("%s", (file) => {
    const form = parseYaml(readFileSync(join(TEMPLATES, file), "utf8")) as IssueForm;
    // GitHub reads a string value as comma-delimited, so `labels: bug, enhancement` names two labels.
    const named =
      typeof form.labels === "string"
        ? form.labels.split(",").map((label) => label.trim())
        : (form.labels ?? []);
    const missing = named.filter((label) => !roster.has(label));
    expect(missing, `${file} names labels absent from the .github/settings.yml roster`).toEqual([]);
  });
});

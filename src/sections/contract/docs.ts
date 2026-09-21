/**
 * Declared beside each section as src/sections/<key>/<key>.docs.yml and loaded by the docs registry.
 * Documentation only: nothing bundled from src/main.ts may import this file or the registry (a unit test walks the import graph).
 */

import { readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";
import { parse } from "yaml";
import { z } from "zod";

/** A role name as the section's ENDPOINTS or graphql dictionary spells it. */
const Role = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, "a role is the declaration's own key");

/** One fact, rendered as one bullet on the coverage page; a line break would end the bullet early. */
const Fact = z.string().regex(/^\S(?:[^\r\n]*\S)?$/, "a fact is one non-blank line");

/**
 * One row of the coverage page's Supported table: the GitHub surface it covers, the calls that serve it, and
 * the facts a reader needs about how the section handles it.
 */
const CoverageRow = z
  .strictObject({
    /** The Area cell: the GitHub feature as a docs link, and nothing else (the fields it spans are facts). */
    area: z.string().min(1),
    /** The settings key or keys this row covers, rendered beside the section key; omitted for a whole-section row. */
    keys: z.string().min(1).optional(),
    /**
     * The roles of the calls this row lists, each declared by the section. Every declared role is listed on at least
     * one row of its section, a shared call on each row it serves; an empty list means the row rides a row above it.
     */
    endpoints: z.array(Role).readonly(),
    /** One fact per bullet, under the table; the renderer caps each at 70 words. */
    notes: z.tuple([Fact], Fact).readonly(),
  })
  .readonly();
export type CoverageRow = z.infer<typeof CoverageRow>;

/**
 * Keyed as .github/scripts/lib/schema-descriptions.ts spells a site (`LabelConfig.color`,
 * `SettingsFile.labels`, `UndeclaredPolicyList<*>.entries`).
 */
const SchemaDescriptions = z.record(z.string().min(1), z.string().min(1)).readonly();

export const SectionDocs = z
  .strictObject({
    /** The section's two authored cells in the Sections table on docs/reference/sections.md. */
    sections_table: z
      .strictObject({
        /** The Endpoints cell: the API surface the section calls, in prose. */
        endpoints: z.string().min(1),
        /** The Notes cell: semantics, caveats, and the knob in passing. */
        notes: z.string().min(1),
      })
      .readonly(),
    // At least one: a section with no coverage row does not exist to the inventory, so the shape refuses [].
    coverage: z.tuple([CoverageRow], CoverageRow).readonly(),
    /** The section's own property on the document root and every definition its slice declares. */
    schema: SchemaDescriptions,
  })
  .readonly();
export type SectionDocs = z.infer<typeof SectionDocs>;

/** A docs file carrying schema descriptions only: the shared factories' and the document root's. */
export const SchemaOnlyDocs = z.strictObject({ schema: SchemaDescriptions }).readonly();

/** A docs file that does not load: the message names the file, and what stopped it. */
export function readDocsYaml<T>(path: string, schema: z.ZodType<T>): Result<T, string> {
  let loaded: unknown;
  try {
    loaded = parse(readFileSync(path, "utf8"));
  } catch (error) {
    return err(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(loaded);
  if (!result.success) {
    return err(`${path} is not a valid docs document:\n${z.prettifyError(result.error)}`);
  }
  return ok(result.data);
}

// The prose a section contributes to the generated README and COVERAGE.md, declared beside its
// module (src/sections/<key>/docs.ts) and aggregated by the docs registry. Documentation only:
// nothing bundled from src/main.ts may import a docs file (a unit test walks the import graph).
export interface SectionDocs {
  /** The section's two authored cells in the README Sections table. */
  readonly readme: {
    /** The Endpoints cell: the API surface the section calls, in prose. */
    readonly endpoints: string;
    /** The Notes cell: semantics, caveats, and the knob in passing. */
    readonly notes: string;
  };
  // The section's rows in the COVERAGE.md Supported table, in display order. At least one: a
  // section with no coverage row does not exist to the inventory, so the type refuses [].
  readonly coverage: readonly [CoverageRow, ...CoverageRow[]];
}

/** One COVERAGE.md Supported row: the GitHub surface it covers and how the section handles it. */
interface CoverageRow {
  /** The Area cell: the GitHub feature, usually a docs link with the fields it spans. */
  readonly area: string;
  /** Settings keys this row covers, rendered as "section (keys)"; omitted for a whole-section row. */
  readonly keys?: string;
  /** The Notes cell: endpoints, semantics, and caveats. */
  readonly notes: string;
}

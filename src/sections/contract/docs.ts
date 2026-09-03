// The prose a section contributes to the generated README, declared beside its module
// (src/sections/<key>/docs.ts) and aggregated by the docs registry. Documentation only: nothing
// bundled from src/main.ts may import a docs file (a unit test walks the import graph).
export interface SectionDocs {
  /** The section's two authored cells in the README Sections table. */
  readonly readme: {
    /** The Endpoints cell: the API surface the section calls, in prose. */
    readonly endpoints: string;
    /** The Notes cell: semantics, caveats, and the knob in passing. */
    readonly notes: string;
  };
  /** The section's COVERAGE.md Supported-table cells, declared where its row renders from here. */
  readonly coverage?: {
    readonly area: string;
    readonly notes: string;
  };
}

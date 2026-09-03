/**
 * The shared pin for the declared source-mirror "setup" sections
 * (code_scanning_default_setup and code_quality_setup): one GET/PATCH
 * surface whose live body is compared declared-keys-only with languages as
 * a set, a 202 that names the configuration run, a 409 busy hint, and a
 * section-specific 403 availability hint. Each section directory keeps a
 * thin test file invoking this, so the diff-aware CI selector still maps
 * the section's tests to its key.
 */

import { describe, expect, test } from "bun:test";
import type { SectionContext, SectionResult } from "../../src/sections/contract/module.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

/** The lockstep tuple on which the two mirrored sections differ. */
export interface SetupSectionFacts {
  section: {
    readonly key: string;
    run(ctx: SectionContext, declared: Record<string, unknown>): Promise<SectionResult>;
  };
  /** The expanded endpoint path ("/repos/o/r/code-quality/setup"). */
  path: string;
  /** A live GET body; must carry a `languages` list for the set compare. */
  live: Record<string, unknown> & { languages: string[] };
  /** A declared document that drifts from `live`, and the exact drift line. */
  driftDeclared: Record<string, unknown>;
  driftLine: string;
  /** A declared document for the verbatim-PATCH case. */
  applyPayload: Record<string, unknown>;
  changeLine: string;
  denied403: RegExp;
}

export function pinSetupSection({
  section,
  path,
  live,
  driftDeclared,
  driftLine,
  applyPayload,
  changeLine,
  denied403,
}: SetupSectionFacts) {
  describe(section.key, () => {
    test("check compares declared keys only, languages as a set", async () => {
      const api = new MockApi({ [`GET ${path}`]: { data: live } });
      const drifted = await section.run(ctx(api, true), driftDeclared);
      expect(drifted.drift).toEqual([driftLine]);
      const reordered = await section.run(ctx(api, true), {
        languages: [...live.languages].reverse(),
      });
      expect(reordered.drift).toEqual([]);
      expect(api.mutations()).toEqual([]);
    });

    test("apply PATCHes the declared payload verbatim", async () => {
      const api = new MockApi({}).allowMutations(`PATCH ${path}`);
      const result = await section.run(ctx(api), applyPayload);
      expect(result.changes).toEqual([changeLine]);
      expect(api.mutations()).toEqual([{ method: "PATCH", path, payload: applyPayload }]);
    });

    test("a 202 configuration run is named in the change line, URL included", async () => {
      const api = new MockApi({
        [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
      });
      const result = await section.run(ctx(api), { state: "configured" });
      expect(result.changes).toEqual([
        `${changeLine}; GitHub started configuration run 42 (https://example.test/runs/42) to roll it out, and the settings take effect when it finishes`,
      ]);
    });

    test("409 gets wait-and-retry advice; 403 names the section's availability", async () => {
      const busy = new MockApi({
        [`PATCH ${path}`]: { error: { status: 409, message: "Conflict", body: "" } },
      });
      await expect(section.run(ctx(busy), { state: "configured" })).rejects.toThrow(
        /already in progress/,
      );
      const denied = new MockApi({
        [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
      });
      await expect(section.run(ctx(denied), { state: "configured" })).rejects.toThrow(denied403);
    });
  });
}

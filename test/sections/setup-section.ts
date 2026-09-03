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
import { executePlan } from "../../src/engine/execute.js";
import type { GithubClient } from "../../src/github/api.js";
import type { PlanSectionModule } from "../../src/sections/contract/module.js";
import { planContext } from "../../src/sections/contract/plan.js";
import { MockApi } from "../mock-api.js";
import { provePlanIdempotent, REPO } from "./plan-idempotence.js";

/** The lockstep tuple on which the two mirrored sections differ. */
export interface SetupSectionFacts<M extends PlanSectionModule> {
  section: M;
  /** The expanded endpoint path ("/repos/o/r/code-quality/setup"). */
  path: string;
  /** A live GET body; must carry a `languages` list for the set compare. */
  live: Record<string, unknown> & { languages: string[] };
  /** A declared document that drifts from `live`, and the exact drift line. */
  driftDeclared: Parameters<M["plan"]>[1];
  driftLine: string;
  /** A declared document for the verbatim-PATCH case. */
  applyPayload: Parameters<M["plan"]>[1];
  changeLine: string;
  denied403: RegExp;
}

/**
 * A stateful fake of a setup endpoint: the GET serves what the PATCH last
 * merged over the seeded body, and the PATCH answers the spec's plain 200,
 * an EMPTY object, so the change thunk sees the real wire shape.
 */
function liveSetup(
  path: string,
  seed: Record<string, unknown>,
): GithubClient & { writes: string[] } {
  let live = seed;
  return {
    writes: [],
    async tryRequest(method, requestPath, payload) {
      if (requestPath !== path) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (method === "PATCH") {
        this.writes.push(`${method} ${requestPath}`);
        live = { ...live, ...(payload as Record<string, unknown>) };
        return { data: {} };
      }
      return { data: live };
    },
    async tryGraphql() {
      throw new Error("the setup sections issue no GraphQL");
    },
  };
}

export function pinSetupSection<M extends PlanSectionModule>({
  section,
  path,
  live,
  driftDeclared,
  driftLine,
  applyPayload,
  changeLine,
  denied403,
}: SetupSectionFacts<M>) {
  const plan = (api: GithubClient, declared: Parameters<M["plan"]>[1]) =>
    section.plan(planContext(section, api, REPO), declared);
  const tools = { resolveSecret: () => "" };

  describe(section.key, () => {
    test("plans the verbatim PATCH on declared-keys-only drift, languages as a set", async () => {
      const api = new MockApi({ [`GET ${path}`]: { data: live } });
      const drifted = await plan(api, driftDeclared);
      expect(drifted.ops).toHaveLength(1);
      expect(drifted.ops[0]?.role).toBe("update");
      expect(drifted.ops[0]?.payload as unknown).toEqual(driftDeclared);
      expect(drifted.ops[0]?.drift).toEqual([driftLine]);
      expect(drifted.notes).toEqual([]);
      expect(drifted.drift).toEqual([]);
      const reordered = await plan(api, {
        languages: [...live.languages].reverse(),
      } as Parameters<M["plan"]>[1]);
      expect(reordered.ops).toEqual([]);
      // Planning reads and never writes.
      expect(api.mutations()).toEqual([]);
    });

    test("executing the plan converges: one PATCH, then nothing", async () => {
      const api = liveSetup(path, live);
      const { changes, second } = await provePlanIdempotent(section, api, applyPayload);
      expect(changes).toEqual([changeLine]);
      expect(api.writes).toEqual([`PATCH ${path}`]);
      expect(second).toEqual({ ops: [], notes: [], drift: [] });
    });

    test("a 202 configuration run is named in the change line, URL included", async () => {
      const api = new MockApi({
        [`GET ${path}`]: { data: live },
        [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
      });
      const planned = await plan(api, driftDeclared);
      const execution = await executePlan(planned, section, api, REPO, tools);
      expect(execution).toEqual({
        status: "applied",
        changes: [
          `${changeLine}; GitHub started configuration run 42 (https://example.test/runs/42) to roll it out, and the settings take effect when it finishes`,
        ],
        notes: [],
        landed: 1,
      });
    });

    test.each([
      [
        "409",
        409,
        "Conflict",
        new RegExp(`${section.key}: PATCH ${path}: 409 Conflict\\. .*already in progress`),
      ],
      ["403", 403, "Forbidden", denied403],
    ])(
      "a %s on the PATCH fails with the section's own advice",
      async (_status, status, message, advice) => {
        // The tolerated 409 carries the wait-and-retry advice; the 403
        // classifies through throwFor and names the section's availability.
        const api = new MockApi({
          [`GET ${path}`]: { data: live },
          [`PATCH ${path}`]: { error: { status, message, body: "" } },
        });
        const execution = await executePlan(
          await plan(api, driftDeclared),
          section,
          api,
          REPO,
          tools,
        );
        expect(execution.status).toBe("failed");
        expect(String((execution as { error: unknown }).error)).toMatch(advice);
      },
    );
  });
}

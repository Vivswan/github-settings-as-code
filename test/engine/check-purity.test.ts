/**
 * The check-is-read-only invariant, enforced across the whole registry:
 * every section handler must issue only GETs when ctx.check is true. The
 * preflight barrier in orchestrate.ts re-runs handlers in check mode as a
 * permission probe before applying, so an impure handler would write to
 * the repo during a phase the engine promises is read-only. The fixtures
 * are a total Record over SectionKey: adding a section without a fixture
 * here is a compile error.
 */

import { describe, expect, test } from "bun:test";
import { runForRepo } from "../../src/engine/orchestrate.js";
import type { Io } from "../../src/io.js";
import type { SectionKey, SettingsFile } from "../../src/schema.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";

/**
 * Declared values chosen to MISMATCH the routed live data below, so every
 * handler walks its drift paths (create/update/delete/replace), not just
 * the clean early returns. The two wrapped declarations exercise the
 * undeclared-policy knob's both settings: labels keeps its undeclared live
 * label under `undeclared: keep` (still drifting on the missing declared
 * label), rulesets walks its DELETE path under `undeclared: delete` - in
 * check mode both must stay read-only like everything else.
 */
const FIXTURES: Record<SectionKey, unknown> = {
  repository: { description: "declared", enable_vulnerability_alerts: true },
  labels: { undeclared: "keep", entries: [{ name: "bug", color: "d73a4a" }] },
  rulesets: { undeclared: "delete", entries: [{ name: "declared-ruleset", target: "branch" }] },
  branches: [{ name: "main", protection: { enforce_admins: true } }],
  environments: [
    {
      name: "prod",
      wait_timer: 5,
      variables: [{ name: "DEPLOY_REGION", value: "eu-west-1" }],
    },
  ],
  autolinks: [{ key_prefix: "NEW-", url_template: "https://x.test/<num>" }],
  actions: { allowed_actions: "all", access_level: "organization" },
  workflows: [{ path: "ci.yml", state: "active" }],
  pages: { build_type: "workflow" },
  code_scanning_default_setup: { state: "configured" },
  collaborators: [{ username: "bob" }],
  teams: [{ name: "devs" }],
  milestones: [{ title: "v1" }],
  interaction_limits: { limit: "contributors_only" },
  actions_variables: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
};

/** Live data that differs from every fixture; unrouted GETs answer 404. */
const ROUTES = {
  "GET /repos/o/r": { data: { description: "live" } },
  "GET /repos/o/r/labels?per_page=100&page=1": {
    data: [{ name: "stale", color: "ffffff", description: null }],
  },
  "GET /repos/o/r/rulesets?per_page=100&page=1": {
    data: [{ id: 1, name: "legacy", source_type: "Repository" }],
  },
  "GET /repos/o/r/autolinks": {
    data: [{ id: 1, key_prefix: "OLD-", url_template: "u", is_alphanumeric: true }],
  },
  // The environment exists but drifts (wait_timer 1 vs the declared 5), so the
  // variables comparison path runs too: a divergent value plus an undeclared
  // live variable exercise the nested drift branches, still read-only.
  "GET /repos/o/r/environments/prod": {
    data: { name: "prod", protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 1 }] },
  },
  "GET /repos/o/r/environments/prod/variables?per_page=30&page=1": {
    data: {
      total_count: 2,
      variables: [
        { name: "DEPLOY_REGION", value: "us-east-1" },
        { name: "STALE", value: "x" },
      ],
    },
  },
  "GET /repos/o/r/actions/permissions": { data: { enabled: true, allowed_actions: "selected" } },
  "GET /repos/o/r/actions/permissions/access": { data: { access_level: "none" } },
  "GET /repos/o/r/actions/workflows?per_page=100&page=1": {
    data: {
      total_count: 1,
      workflows: [{ id: 1, path: ".github/workflows/ci.yml", state: "disabled_manually" }],
    },
  },
  "GET /repos/o/r/code-scanning/default-setup": { data: { state: "not-configured" } },
  "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
    data: [{ login: "alice", role_name: "write" }],
  },
  "GET /orgs/o": { data: { login: "o" } },
  "GET /repos/o/r/milestones?state=all&per_page=100&page=1": {
    data: [{ number: 1, title: "old", description: null, state: "open" }],
  },
  // An empty body means "no live limit", which drifts against the fixture.
  "GET /repos/o/r/interaction-limits": { data: {} },
  // A live variable the fixture does not declare (delete-default -> drift)
  // plus the declared one missing (create-path drift).
  "GET /repos/o/r/actions/variables?per_page=30&page=1": {
    data: {
      total_count: 1,
      variables: [
        {
          name: "STALE_VAR",
          value: "old",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
  },
};

function silentIo(): Io {
  return { annotate: () => {}, log: () => {}, mask: () => {} };
}

describe("check-mode purity", () => {
  test("every registered section stays read-only in check mode, even on its drift paths", async () => {
    const api = new MockApi(ROUTES);
    const result = await runForRepo(
      api,
      {
        repo: "o/r",
        settings: FIXTURES as SettingsFile,
        mode: "check",
        onMissingPermission: "fail",
        requiredSections: new Set(),
        onlySections: new Set(),
      },
      silentIo(),
    );
    // Every section ran and every fixture produced drift: a "failed" or
    // "clean" outcome means a fixture stopped exercising its handler's
    // drift paths, which would silently shrink coverage.
    expect(result.outcomes.map((o) => o.key)).toEqual([...SECTION_KEYS]);
    for (const outcome of result.outcomes) {
      expect(outcome.status).toBe("drift");
    }
    // The invariant itself.
    expect(api.mutations()).toEqual([]);
  });
});

/**
 * The debug trace of a whole run over a redacted target: the flow, the engine, and the real sections over GitHubApi,
 * against the e2e mock server. The owner probe (GET /orgs/<owner>) is the request under watch: it serves the target
 * and carries no repository slug, so only the run's knowledge that the target is redacted keeps it out of the trace.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { parseRepoSlug } from "../../src/discovery/targets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { runMulti } from "../../src/flows/multi.js";
import { runSingle } from "../../src/flows/single.js";
import { runSnapshot } from "../../src/flows/snapshot.js";
import { GitHubApi, type GitHubClient } from "../../src/github/api.js";
import { type Io, silentIo } from "../../src/io.js";
import { E2E_TOKEN } from "../e2e/constants.js";
import type { MockHandle } from "../e2e/mock/server.js";
import { mockServerLifecycle, scenario } from "../e2e/mock/server-test-support.js";
import { withTempDir } from "../temp-dir.js";
import { timeless } from "./stub.js";

const start = mockServerLifecycle();
const PUBLIC = "acme/app";
const PRIVATE = "secret-org/private-repo";
const TEAMS = { teams: [{ name: "reviewers", permission: "push" }] };
const REDACT = { privateRepos: "redact" as const, selfSlug: "acme/admin" };
const CHECK = {
  ...REDACT,
  mode: "check" as const,
  onMissingPermission: "fail" as const,
  sections: SectionSelection.ALL,
  privateReport: "none" as const,
  reportPublicKey: "",
  runUrl: "",
};
const SNAPSHOT = {
  ...REDACT,
  onMissingPermission: "fail" as const,
  sections: SectionSelection.of({ only: ["teams"] })._unsafeUnwrap(),
};
const TARGETS = {
  reposDir: "",
  adminOwner: "acme",
  discoveryFilters: DEFAULT_DISCOVERY_FILTERS,
  discoveryFiltersSet: [],
};

/** What one run shares: the mock GitHub, a client pointed at it, and the Io whose debug trace `lines` keeps. */
interface Run {
  mock: MockHandle;
  client: GitHubClient;
  io: Io;
  lines: string[];
}

/** A run over a mock GitHub holding the public and the private repository, each declaring the same team. */
async function startRun(): Promise<Run> {
  const mock = await start(
    scenario({
      repos: {
        [PUBLIC]: { settings: TEAMS },
        [PRIVATE]: {
          settings: TEAMS,
          live_state: { repo: { private: true, visibility: "private" } },
        },
      },
    }),
  );
  const lines: string[] = [];
  const io: Io = { ...silentIo(), debug: (line) => lines.push(line) };
  const client = new GitHubApi({ token: E2E_TOKEN, io, baseUrl: mock.url, retryBaseMs: 1 });
  return { mock, client, io, lines };
}

/** Whether a request path, or a trace line, is the owner probe: /orgs/<owner> and nothing under it. */
function isOwnerProbe(text: string): boolean {
  return /\/orgs\/[\w-]+( |$)/.test(text);
}

/** The owner probes the mock received, in order. */
function ownerProbes(mock: MockHandle): string[] {
  return mock.requests.map((request) => request.pathname).filter(isOwnerProbe);
}

describe("the debug trace of a run over a redacted target", () => {
  // One row per place a flow hands a target's client to the engine: a flow that handed over the run's own client
  // printed the probe, since nothing in its path says whom it serves.
  test.each<[flow: string, run: (client: GitHubClient, io: Io, dir: string) => Promise<boolean>]>([
    [
      "a single-repo check",
      async (client, io, dir) => {
        const settingsFile = join(dir, "settings.yml");
        writeFileSync(settingsFile, stringifyYaml(TEAMS));
        const repo = parseRepoSlug(PRIVATE)._unsafeUnwrap();
        return (await runSingle(client, { ...CHECK, repo, settingsFile }, io)).isOk();
      },
    ],
    [
      "a multi-repo check",
      async (client, io) => {
        const fleet = { ...CHECK, ...TARGETS, reposInput: PRIVATE, defaultsFile: "" };
        return (await runMulti(client, fleet, io)).isOk();
      },
    ],
    [
      "a snapshot to a file",
      async (client, io, dir) => {
        const repo = parseRepoSlug(PRIVATE)._unsafeUnwrap();
        const snapshotFile = join(dir, "snapshot.yml");
        const file = { ...SNAPSHOT, form: "file" as const, repo, snapshotFile };
        return (await runSnapshot(client, file, io)).isOk();
      },
    ],
    [
      "a snapshot to a directory",
      async (client, io, dir) => {
        const snapshotDir = join(dir, "out");
        const fleet = {
          ...SNAPSHOT,
          ...TARGETS,
          form: "dir" as const,
          reposInput: PRIVATE,
          snapshotDir,
        };
        return (await runSnapshot(client, fleet, io)).isOk();
      },
    ],
  ])("%s of a private target leaves only redacted lines", (_flow, run) =>
    withTempDir("sac-redacted-trace-", async (dir) => {
      const { mock, client, io, lines } = await startRun();
      expect(await run(client, io, dir)).toBe(true);
      // The controls: the probe reached the mock, which answered every request by its contract, so the probe's
      // absence from the trace is redaction, not a request never made.
      expect(ownerProbes(mock)).toEqual(["/orgs/secret-org"]);
      expect(mock.violations).toEqual([]);
      // Every request of the run serves the one redacted target, so the whole trace is the two redacted forms: a
      // plugin's line, and the client's own, which keeps the method and the status.
      const forms = lines.map((line) => line.replace(/-> \d+ \(\d+ms\)/, "-> NNN (Nms)"));
      expect([...new Set(forms)].sort()).toEqual(["<redacted>", "GET <redacted> -> NNN (Nms)"]);
    }),
  );

  test("a multi-repo run prints the public target's owner probe beside the private target's hidden one", async () => {
    // Both targets send the same slug-free probe, so this is the pair a seal left on, or never set, cannot pass.
    const { mock, client, io, lines } = await startRun();
    const fleet = { ...CHECK, ...TARGETS, reposInput: `${PUBLIC},${PRIVATE}`, defaultsFile: "" };
    const run = await runMulti(client, fleet, io);
    expect(run.map((targets) => targets.map((target) => [target.display, target.result]))).toEqual(
      expect.objectContaining({
        value: [
          [PUBLIC, "drift"],
          ["private repository #1", "drift"],
        ],
      }),
    );
    expect(ownerProbes(mock)).toEqual(["/orgs/acme", "/orgs/secret-org"]);
    expect(mock.violations).toEqual([]);
    expect(lines.filter(isOwnerProbe).map(timeless)).toEqual([
      "GET /orgs/acme - 200 with id undefined in Nms",
      "GET /orgs/acme -> 200 (Nms)",
    ]);
    expect(lines.filter((line) => /secret-org|private-repo/.test(line))).toEqual([]);
  });
});

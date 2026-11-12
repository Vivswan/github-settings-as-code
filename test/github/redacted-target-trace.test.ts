/**
 * The debug trace of a whole run over a redacted target: the flow, the engine, and the real sections over GitHubApi.
 * The owner probe (GET /orgs/<owner>) is the request under watch: it serves the target and carries no repository
 * slug, so only the run's knowledge that the target is redacted can keep it out of the trace.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { parseRepoSlug } from "../../src/discovery/targets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { runMulti } from "../../src/flows/multi.js";
import { runSingle } from "../../src/flows/single.js";
import { runSnapshot } from "../../src/flows/snapshot.js";
import type { GitHubClient } from "../../src/github/api.js";
import { type Io, silentIo } from "../../src/io.js";
import { withTempDir } from "../temp-dir.js";
import { api, json, restoreFetch, timeless } from "./stub.js";

afterEach(restoreFetch);

const PRIVATE = "secret-org/private-repo";
const TEAMS = "teams:\n  - name: reviewers\n    permission: push\n";

/** What GitHub answers a run of the teams section on `slug`, private or public. */
function teamsRepo(slug: string, isPrivate: boolean): Record<string, () => Response> {
  const owner = slug.slice(0, slug.indexOf("/"));
  return {
    [`/repos/${slug}`]: json({ private: isPrivate, visibility: isPrivate ? "private" : "public" }),
    [`/repos/${slug}/contents/.github/settings.yml`]: () => new Response(TEAMS),
    [`/orgs/${owner}`]: json({ login: owner }),
    [`/repos/${slug}/teams`]: json([]),
  };
}

/** A fetch stub answering by path, an unrouted path as GitHub's 404; `sent` is every path requested, in order. */
function routeFetch(routes: Record<string, () => Response>): { sent: string[] } {
  const state = { sent: [] as string[] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    state.sent.push(pathname);
    return routes[pathname]?.() ?? new Response('{"message":"Not Found"}', { status: 404 });
  }) as unknown as typeof fetch;
  return state;
}

/** An Io whose debug trace is kept; the flow and the client share it, as the action's run does. */
function tracedIo(): { io: Io; lines: string[] } {
  const lines: string[] = [];
  return { lines, io: { ...silentIo(), debug: (line) => lines.push(line) } };
}

/** Whether a request path, or a trace line, is the owner probe: /orgs/<owner> and nothing under it. */
const isOwnerProbe = (text: string): boolean => /\/orgs\/[\w-]+( |$)/.test(text);

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
const FLEET = {
  reposDir: "",
  adminOwner: "acme",
  discoveryFilters: DEFAULT_DISCOVERY_FILTERS,
  discoveryFiltersSet: [],
};

describe("the debug trace of a run over a redacted target", () => {
  // One row per place a flow hands a target's client to the engine: a flow that handed over the run's own client
  // printed the probe, since nothing in its path says whom it serves.
  test.each<[flow: string, run: (client: GitHubClient, io: Io, dir: string) => Promise<boolean>]>([
    [
      "a single-repo check",
      async (client, io, dir) => {
        const settingsFile = join(dir, "settings.yml");
        writeFileSync(settingsFile, TEAMS);
        const repo = parseRepoSlug(PRIVATE)._unsafeUnwrap();
        return (await runSingle(client, { ...CHECK, repo, settingsFile }, io)).isOk();
      },
    ],
    [
      "a multi-repo check",
      async (client, io) => {
        const fleet = { ...CHECK, ...FLEET, reposInput: PRIVATE, defaultsFile: "" };
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
          ...FLEET,
          form: "dir" as const,
          reposInput: PRIVATE,
          snapshotDir,
        };
        return (await runSnapshot(client, fleet, io)).isOk();
      },
    ],
  ])("%s of a private target leaves only redacted lines", (_flow, run) =>
    withTempDir("sac-redacted-trace-", async (dir) => {
      const { sent } = routeFetch(teamsRepo(PRIVATE, true));
      const trace = tracedIo();
      expect(await run(api(trace.io), trace.io, dir)).toBe(true);
      // The control: the probe was sent, so its absence from the trace is redaction, not a request never made.
      expect(sent.filter(isOwnerProbe)).toEqual(["/orgs/secret-org"]);
      // Every request of the run serves the one redacted target, so the whole trace is the two redacted forms: a
      // plugin's line, and the client's own, which keeps the method and the status.
      const forms = trace.lines.map((line) => line.replace(/-> \d+ \(\d+ms\)/, "-> NNN (Nms)"));
      expect([...new Set(forms)].sort()).toEqual(["<redacted>", "GET <redacted> -> NNN (Nms)"]);
    }),
  );

  test("a multi-repo run prints the public target's owner probe beside the private target's hidden one", async () => {
    // Both targets send the same slug-free probe, so this is the pair a seal left on, or never set, cannot pass.
    const { sent } = routeFetch({ ...teamsRepo("acme/app", false), ...teamsRepo(PRIVATE, true) });
    const trace = tracedIo();
    const run = await runMulti(
      api(trace.io),
      { ...CHECK, ...FLEET, reposInput: `acme/app,${PRIVATE}`, defaultsFile: "" },
      trace.io,
    );
    expect(run.map((targets) => targets.map((target) => [target.display, target.result]))).toEqual(
      expect.objectContaining({
        value: [
          ["acme/app", "drift"],
          ["private repository #1", "drift"],
        ],
      }),
    );
    expect(sent.filter(isOwnerProbe)).toEqual(["/orgs/acme", "/orgs/secret-org"]);
    expect(trace.lines.filter(isOwnerProbe).map(timeless)).toEqual([
      "GET /orgs/acme - 200 with id undefined in Nms",
      "GET /orgs/acme -> 200 (Nms)",
    ]);
    expect(trace.lines.filter((line) => /secret-org|private-repo/.test(line))).toEqual([]);
  });
});

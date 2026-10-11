import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { REDACTED_NOTE } from "../../src/flows/redact.js";
import {
  collectingIo,
  parseRepoSlug,
  runSingle,
  SectionSelection,
  type SingleConfig,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

const cfg = (overrides: Partial<SingleConfig> = {}): SingleConfig => ({
  repo,
  settingsFile: "test/fixtures/single.yml",
  mode: "check",
  onMissingPermission: "fail",
  sections: SectionSelection.ALL,
  privateRepos: "show",
  privateReport: "none",
  reportPublicKey: "",
  selfSlug: "o/r",
  runUrl: "",
  ...overrides,
});

describe("runSingle", () => {
  test("a redacted target ending partial prints its one sealed line: the skipped sections and their codes, no detail", async () => {
    // A private repository under on-missing-permission: warn with one denied section: the shown run prints the
    // section's skipped line; the redacted one must still say partial, or a denied grant goes unnoticed.
    const api = new MockApi({
      "GET /repos/o/r": {
        data: { private: true, visibility: "private", has_wiki: false, has_projects: false },
      },
      "GET /repos/o/r/labels?per_page=100&page=1": {
        error: {
          status: 403,
          message: "Resource not accessible by personal access token",
          body: "",
        },
      },
    });
    const collected = collectingIo();
    const outcome = await runSingle(
      api,
      cfg({
        settingsFile: "test/fixtures/layers/fleet.yml",
        sections: SectionSelection.of({ only: ["repository", "labels"] })._unsafeUnwrap(),
        onMissingPermission: "warn",
        privateRepos: "redact",
        selfSlug: "admin/fleet",
      }),
      collected.io,
    );
    expect(outcome.map((target) => [target.result, target.display])).toEqual(
      ok(["partial", "private repository #1"]),
    );
    expect(collected.lines).toEqual([
      {
        level: "warning",
        line: `private repository #1: partial - labels (403). ${REDACTED_NOTE}`,
      },
    ]);
  });

  test("a clean check returns the one target's outcome and prints nothing", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } });
    const collected = collectingIo();
    expect(await runSingle(api, cfg(), collected.io)).toEqual(
      ok({
        result: "clean",
        display: "o/r",
        detail: {
          slug: "o/r",
          outcomes: [{ key: "repository", status: "clean", detail: [] }],
          note: undefined,
        },
      }),
    );
    expect(collected.lines).toEqual([]);
  });

  test("an unreadable settings file is fatal, carrying the path under the settings-file role", async () => {
    const api = new MockApi({});
    const result = await runSingle(api, cfg({ settingsFile: "missing.yml" }), collectingIo().io);
    expect(result).toEqual(
      err({
        code: "settings-file-unreadable",
        role: "settings-file",
        path: "missing.yml",
        reason: expect.stringContaining("ENOENT"),
      }),
    );
    expect(api.calls).toEqual([]);
  });
});

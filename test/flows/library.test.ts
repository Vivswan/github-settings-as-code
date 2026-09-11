import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { stringify as stringifyYaml } from "yaml";
import {
  applyRepository,
  checkRepository,
  collectingIo,
  describeProblem,
  parseRepoSlug,
  renderMergedYaml,
  type ValidatedSettings,
  validateSettings,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

/** The brand is minted only by validation, so the tests' documents pass through it. */
function branded(doc: unknown): ValidatedSettings {
  return validateSettings(doc).match(
    (validated) => validated.settings,
    (problem) => {
      throw new Error(describeProblem(problem));
    },
  );
}
const settings = branded({ repository: { has_wiki: false } });

describe("validateSettings", () => {
  test("a valid document comes back branded with no warnings", () => {
    expect(validateSettings({ repository: { has_wiki: false } })).toEqual(
      ok({ settings, warnings: [] }),
    );
  });

  test("an unknown key outside the sections allowlist is a returned warning, not a printed one", () => {
    expect(
      validateSettings(
        { repository: { has_wiki: false }, typo: 1 },
        { source: "fleet.yml", sections: new Set(["repository"]) },
      ),
    ).toEqual(
      ok({
        settings,
        warnings: [
          'ignoring unknown top-level section(s) outside the "sections" allowlist: typo. Upgrade the action to a version that knows them, or remove them from fleet.yml',
        ],
      }),
    );
  });

  test("an invalid document comes back as its problem, naming the default source", () => {
    expect(validateSettings([1])).toEqual(
      err({ code: "settings-not-mapping", source: "the settings document", shape: "list" }),
    );
  });
});

describe("checkRepository and applyRepository", () => {
  test("check diffs without writing and returns the lines it printed", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    const result = await checkRepository(api, {
      repo,
      settings,
      onMissingPermission: "fail",
      requiredSections: new Set(),
      onlySections: new Set(),
    });
    expect(api.mutations()).toEqual([]);
    expect(result).toEqual({
      repo: "o/r",
      result: "drift",
      outcomes: [
        { key: "repository", status: "drift", detail: ["repository.has_wiki: false != true"] },
      ],
      preflightDenied: [],
      log: [{ line: "drift: repository.has_wiki: false != true" }],
    });
  });

  test("apply writes the declared keys; a caller-supplied Io receives the lines and the log stays empty", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    const collected = collectingIo();
    const result = await applyRepository(
      api,
      {
        repo,
        settings,
        onMissingPermission: "fail",
        requiredSections: new Set(),
        onlySections: new Set(),
      },
      collected.io,
    );
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
    expect(result).toEqual({
      repo: "o/r",
      result: "applied",
      outcomes: [
        { key: "repository", status: "applied", detail: ["patched repository fields: has_wiki"] },
      ],
      preflightDenied: [],
      log: [],
    });
    expect(collected.lines).toEqual([{ line: "repository: patched repository fields: has_wiki" }]);
  });
});

describe("renderMergedYaml", () => {
  test("is the document's YAML serialization, byte for byte", () => {
    expect(renderMergedYaml(settings)).toBe(stringifyYaml(settings));
    expect(renderMergedYaml(settings)).toBe("repository:\n  has_wiki: false\n");
  });
});
